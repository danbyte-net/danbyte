"""Port-utilization counting, shared by the device API and the alert sweep.

Connected = the port terminates a cable, or carries ``mark_connected`` (a
cable is in the port, just not documented yet); reserved = its cable's
status is "planned" (earmarked but not yet patched) OR the uncabled port
holds a PortReservation; free = no cable, no hold.
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
        CableTermination, FrontPort, Interface, PortReservation, RearPort,
    )

    def kind_counts(model, term_field):
        base = model.objects.filter(device__in=devices)
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
