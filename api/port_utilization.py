"""Port-utilization counting, shared by the device API and the alert sweep.

Connected = the port terminates a cable, or carries ``mark_connected`` (a
cable is in the port, just not documented yet); reserved = its cable's
status is "planned" (earmarked but not yet patched) OR the uncabled port
holds a PortReservation; free = no cable, no hold. Interfaces whose status
carries ``excludes_capacity`` (Not present, Decommissioning) leave the math
entirely (#105) - a phantom stack port is not capacity, free or otherwise.
Twelve GROUP BY aggregates total (three port kinds x four metrics) - never
per-device queries, however many devices are in scope. ``marked`` is the
undocumented subset of connected, kept separate so the number stays honest
about documentation debt.
"""
from __future__ import annotations

from django.db.models import Count, Exists, OuterRef, Q


def device_port_counts(devices) -> dict:
    """{device_id: {"total", "connected", "reserved", "marked"}} for every
    device in ``devices`` (a queryset) that has at least one port."""
    from .models import (
        CableTermination,
        FrontPort,
        Interface,
        PortReservation,
        RearPort,
    )

    def kind_counts(model, term_field):
        base = model.objects.filter(device__in=devices)
        # Only Interface carries a lifecycle status today; front/rear ports
        # have no status field, so the exclusion is a no-op for them.
        if model is Interface:
            base = base.exclude(status__excludes_capacity=True)
        term = CableTermination.objects.filter(**{term_field: OuterRef("pk")})
        planned = term.filter(cable__status__slug="planned")
        resv = PortReservation.objects.filter(**{term_field: OuterRef("pk")})
        ann = base.annotate(
            _c=Exists(term), _p=Exists(planned), _r=Exists(resv)
        )
        group = lambda qs: {  # noqa: E731 - tiny local shaping helper
            r["device_id"]: r["n"]
            for r in qs.values("device_id").annotate(n=Count("id"))
        }
        return (
            group(base),
            group(ann.filter(_c=True, _p=False)),
            # Planned cable, or an uncabled unmarked port held directly.
            group(ann.filter(
                Q(_p=True) | Q(_c=False, mark_connected=False, _r=True)
            )),
            group(ann.filter(_c=False, mark_connected=True)),
        )

    out: dict = {}
    for model, term_field in (
        (Interface, "interface"),
        (FrontPort, "front_port"),
        (RearPort, "rear_port"),
    ):
        totals, connected, reserved, marked = kind_counts(model, term_field)
        for metric, counts in (
            ("total", totals),
            ("connected", connected),
            ("reserved", reserved),
            ("marked", marked),
        ):
            for device_id, n in counts.items():
                row = out.setdefault(
                    device_id,
                    {"total": 0, "connected": 0, "reserved": 0, "marked": 0},
                )
                row[metric] += n
    # Marked ports count as connected - the cable exists, only the row is
    # missing - while `marked` itself stays visible as the documentation gap.
    for row in out.values():
        row["connected"] += row["marked"]
    return out


def used_pct(row: dict) -> int:
    return round((row["connected"] + row["reserved"]) / row["total"] * 100)


def utilization_payload(devices) -> dict:
    """Connected / reserved / free / marked per port kind, plus a combined
    row, across ``devices`` (a queryset - one device, or a whole stack).

    Connected = the port terminates a cable or carries mark_connected
    (undocumented cable); reserved = its cable's status is "planned" or the
    uncabled port holds a PortReservation; free = the rest. ``marked`` is the
    undocumented subset of connected.
    """
    from .models import (
        CableTermination,
        FrontPort,
        Interface,
        PortReservation,
        RearPort,
    )

    kinds = {
        "interfaces": (Interface, "interface"),
        "front_ports": (FrontPort, "front_port"),
        "rear_ports": (RearPort, "rear_port"),
    }
    out: dict = {}
    combined = {"total": 0, "connected": 0, "reserved": 0, "free": 0, "marked": 0}
    for key, (model, term_field) in kinds.items():
        rel = model.objects.filter(device__in=devices)
        if model is Interface:
            rel = rel.exclude(status__excludes_capacity=True)
        cabled = CableTermination.objects.filter(**{term_field: OuterRef("pk")})
        planned = cabled.filter(cable__status__slug="planned")
        resv = PortReservation.objects.filter(**{term_field: OuterRef("pk")})
        qs = rel.annotate(_cabled=Exists(cabled), _planned=Exists(planned), _resv=Exists(resv))
        total = rel.count()
        reserved = qs.filter(
            Q(_planned=True) | Q(_cabled=False, mark_connected=False, _resv=True)
        ).count()
        marked = qs.filter(_cabled=False, mark_connected=True).count()
        connected = qs.filter(_cabled=True, _planned=False).count() + marked
        row = {
            "total": total, "connected": connected, "reserved": reserved,
            "free": total - connected - reserved, "marked": marked,
        }
        out[key] = row
        for k in combined:
            combined[k] += row[k]
    out["combined"] = combined
    return out

