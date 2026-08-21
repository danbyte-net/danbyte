"""Port-utilization counting, shared by the device API and the alert sweep.

Connected = the port terminates a cable; reserved = that cable's status is
"planned" (earmarked but not yet patched); free = no cable. Nine GROUP BY
aggregates total (three port kinds x three metrics) - never per-device
queries, however many devices are in scope.
"""
from __future__ import annotations

from django.db.models import Count, Exists, OuterRef


def device_port_counts(devices) -> dict:
    """{device_id: {"total", "connected", "reserved"}} for every device in
    ``devices`` (a queryset) that has at least one port."""
    from .models import CableTermination, FrontPort, Interface, RearPort

    def kind_counts(model, term_field):
        base = model.objects.filter(device__in=devices)
        term = CableTermination.objects.filter(**{term_field: OuterRef("pk")})
        planned = term.filter(cable__status__slug="planned")
        ann = base.annotate(_c=Exists(term), _p=Exists(planned))
        group = lambda qs: {  # noqa: E731 - tiny local shaping helper
            r["device_id"]: r["n"]
            for r in qs.values("device_id").annotate(n=Count("id"))
        }
        return (
            group(base),
            group(ann.filter(_c=True, _p=False)),
            group(ann.filter(_p=True)),
        )

    out: dict = {}
    for model, term_field in (
        (Interface, "interface"),
        (FrontPort, "front_port"),
        (RearPort, "rear_port"),
    ):
        totals, connected, reserved = kind_counts(model, term_field)
        for metric, counts in (
            ("total", totals),
            ("connected", connected),
            ("reserved", reserved),
        ):
            for device_id, n in counts.items():
                row = out.setdefault(
                    device_id, {"total": 0, "connected": 0, "reserved": 0}
                )
                row[metric] += n
    return out


def used_pct(row: dict) -> int:
    return round((row["connected"] + row["reserved"]) / row["total"] * 100)
