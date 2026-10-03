"""Port-utilization counting: one rule for every consumer.

The Port utilization page, the device and virtual-chassis cards, the Devices
list Ports column, the cable picker's free-ports bar, spec sheets and the
``PortUtilizationRule`` alert sweep all read their numbers from here, so no
two of them can disagree about what a port is.

States. Connected = the port terminates a cable, or carries
``mark_connected`` (a cable is in the port, just not documented yet);
reserved = its cable's status is "planned" (earmarked but not yet patched) OR
the uncabled port holds a PortReservation; free = no cable, no hold.
``marked`` is the undocumented subset of connected, kept separate so the
number stays honest about documentation debt.

What the headline total counts:

- physical interfaces and front ports, including management-only and
  disabled ones - they are real ports, free or not;
- virtual interfaces (``virtual=True``, or a virtual / bridge / lag type:
  SVIs, LAGs, loopbacks, tunnels, sub-interfaces) only when the deployment's
  "Count virtual interfaces" setting is on
  (``core.effective_settings.port_count_virtual``);
- never rear ports: a panel's rear is the back of the ports its front already
  counts, so a 24-port panel reads /24.

``virtual`` and ``rear_ports`` are still reported, for information.
Interfaces whose status carries ``excludes_capacity`` (Not present,
Decommissioning) leave the math entirely (#105) - a phantom stack port is not
capacity, free or otherwise.

Twelve GROUP BY aggregates total (three port tables x four metrics, the
interface rows grouped by virtual-ness too) - never per-device queries,
however many devices are in scope.
"""
from __future__ import annotations

from django.db.models import BooleanField, Count, Exists, ExpressionWrapper, OuterRef, Q

from .dcim_choices import VIRTUAL_INTERFACE_TYPES

#: Every kind ``port_kinds`` reports. "interfaces" is the physical ones only.
KINDS = ("interfaces", "virtual", "front_ports", "rear_ports")
METRICS = ("total", "connected", "reserved", "marked")


def virtual_interface_q(prefix: str = "") -> Q:
    """Interfaces with no physical port: flagged virtual, or of a virtual
    type even where the flag was never set."""
    return Q(**{f"{prefix}virtual": True}) | Q(
        **{f"{prefix}type__in": VIRTUAL_INTERFACE_TYPES}
    )


def counted_kinds(count_virtual: bool) -> tuple[str, ...]:
    """The kinds the headline total is made of."""
    if count_virtual:
        return ("interfaces", "virtual", "front_ports")
    return ("interfaces", "front_ports")


def _blank() -> dict:
    return dict.fromkeys(METRICS, 0)


def port_kinds(devices, *, rear_ports: bool = True) -> dict:
    """``{device_id: {kind: {"total", "connected", "reserved", "marked"}}}``
    for every device in ``devices`` (a queryset) with at least one port of
    any kind, ``kind`` being each of :data:`KINDS`. ``connected`` includes
    ``marked``. ``rear_ports=False`` leaves rear ports uncounted - they read
    zero - for a caller that never shows them: four queries fewer."""
    from .models import (
        CableTermination,
        FrontPort,
        Interface,
        PortReservation,
        RearPort,
    )

    tables = [(Interface, "interface"), (FrontPort, "front_port")]
    if rear_ports:
        tables.append((RearPort, "rear_port"))
    out: dict = {}
    for model, term_field in tables:
        base = model.objects.filter(device__in=devices)
        keys = ["device_id"]
        if model is Interface:
            # Only Interface carries a lifecycle status today, and only it
            # has virtual rows: the same queries group by both.
            base = base.exclude(status__excludes_capacity=True).annotate(
                _v=ExpressionWrapper(virtual_interface_q(), output_field=BooleanField())
            )
            keys.append("_v")
        term = CableTermination.objects.filter(**{term_field: OuterRef("pk")})
        planned = term.filter(cable__status__slug="planned")
        resv = PortReservation.objects.filter(**{term_field: OuterRef("pk")})
        ann = base.annotate(_c=Exists(term), _p=Exists(planned), _r=Exists(resv))
        for metric, qs in (
            ("total", base),
            ("connected", ann.filter(_c=True, _p=False)),
            # Planned cable, or an uncabled unmarked port held directly.
            ("reserved", ann.filter(
                Q(_p=True) | Q(_c=False, mark_connected=False, _r=True)
            )),
            ("marked", ann.filter(_c=False, mark_connected=True)),
        ):
            for row in qs.values(*keys).annotate(n=Count("id")).order_by():
                if model is Interface:
                    kind = "virtual" if row["_v"] else "interfaces"
                else:
                    kind = "front_ports" if model is FrontPort else "rear_ports"
                kinds = out.get(row["device_id"])
                if kinds is None:
                    kinds = out[row["device_id"]] = {k: _blank() for k in KINDS}
                kinds[kind][metric] += row["n"]
    # Marked ports count as connected - the cable exists, only the row is
    # missing - while `marked` itself stays visible as the documentation gap.
    for kinds in out.values():
        for row in kinds.values():
            row["connected"] += row["marked"]
    return out


def _with_free(row: dict) -> dict:
    return {
        "total": row["total"],
        "connected": row["connected"],
        "reserved": row["reserved"],
        "free": row["total"] - row["connected"] - row["reserved"],
        "marked": row["marked"],
    }


def headline(kinds: dict, *, count_virtual: bool) -> dict:
    """One device's (or one stack's) counted row from its ``port_kinds``
    entry: ``{"total", "connected", "reserved", "free", "marked"}`` over the
    counted kinds, plus the uncounted-for-information ``virtual`` and
    ``rear_ports`` totals."""
    counted = counted_kinds(count_virtual)
    row = _with_free({m: sum(kinds[k][m] for k in counted) for m in METRICS})
    row["virtual"] = kinds["virtual"]["total"]
    row["rear_ports"] = kinds["rear_ports"]["total"]
    return row


def device_port_counts(devices, *, count_virtual: bool) -> dict:
    """``{device_id: headline row}`` for every device in ``devices`` (a
    queryset) that has at least one port of any kind. A device whose ports
    are all uncounted (virtual with the setting off, rear) has a row with a
    ``total`` of 0; a device with no ports at all has none."""
    return {
        device_id: headline(kinds, count_virtual=count_virtual)
        for device_id, kinds in port_kinds(devices).items()
    }


def used_pct(row: dict) -> int | None:
    """Connected plus reserved, as a whole percentage of the counted total;
    ``None`` when nothing is counted."""
    if not row.get("total"):
        return None
    return round((row["connected"] + row["reserved"]) / row["total"] * 100)


def utilization_payload(devices, *, count_virtual: bool) -> dict:
    """Connected / reserved / free / marked per port kind, plus the counted
    ``combined`` row, across ``devices`` (a queryset - one device, or a whole
    stack). ``count_virtual`` is echoed so a reader knows the basis."""
    sums = {k: _blank() for k in KINDS}
    for kinds in port_kinds(devices).values():
        for k in KINDS:
            for m in METRICS:
                sums[k][m] += kinds[k][m]
    out: dict = {k: _with_free(sums[k]) for k in KINDS}
    counted = counted_kinds(count_virtual)
    out["combined"] = _with_free(
        {m: sum(sums[k][m] for k in counted) for m in METRICS}
    )
    out["count_virtual"] = count_virtual
    return out
