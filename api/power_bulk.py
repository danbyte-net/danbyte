"""The parts of the power panel and power feed bulk actions (#313) that the
shared bulk machinery does not already cover: what a feed is cabled to, a
panel deleted together with its feeds, and names that stay unique when rows
move to another parent."""
from __future__ import annotations

from collections import Counter

from django.db import DEFAULT_DB_ALIAS
from django.db.models.deletion import Collector
from rest_framework.exceptions import ValidationError

from .models import CableTermination, PowerFeed

CABLED_LABEL = "Cabled"


def cabled_feed_notes(feeds) -> list[dict]:
    """The feeds among ``feeds`` (a queryset) with a cable on them, each
    named with what is at the far end - a device's power port, as a rule.
    Deleting the feed removes that cable's end on the feed."""
    near = list(
        CableTermination.objects.filter(power_feed__in=feeds)
        .values_list("cable_id", "end", "power_feed_id", "power_feed__name")
    )
    if not near:
        return []
    far: dict = {}
    for t in (
        CableTermination.objects.filter(cable_id__in={c for c, *_ in near})
        .exclude(power_feed__isnull=False)
        .select_related("power_port__device")
    ):
        far.setdefault((t.cable_id, t.end), []).append(t)
    notes = []
    for cable_id, end, feed_id, feed_name in sorted(near, key=lambda r: r[3]):
        other = "B" if end == "A" else "A"
        ends = [
            f"{t.power_port.device.name} {t.power_port.name}" if t.power_port_id
            else str(t.point)
            for t in far.get((cable_id, other), [])
        ]
        notes.append({
            "id": str(feed_id),
            "name": feed_name,
            "label": CABLED_LABEL,
            "detail": ", ".join(ends) or "No far end",
        })
    return notes


class FeedsFirstCollector(Collector):
    """Works out a panel delete that takes its feeds along: once the feeds
    are collected, their ``PROTECT`` reference no longer holds the panel."""

    def __init__(self, using=DEFAULT_DB_ALIAS, **kwargs):
        super().__init__(using=using, **kwargs)

    def related_objects(self, related_model, related_fields, objs):
        qs = super().related_objects(related_model, related_fields, objs)
        going = self.data.get(PowerFeed)
        if related_model is PowerFeed and going:
            qs = qs.exclude(pk__in=[f.pk for f in going])
        return qs


def names_free_after_move(rows, scope_field: str, target, key: str) -> None:
    """A move of ``rows`` under one parent (``scope_field`` = ``target``)
    keeps names unique there: no two of them share a name, and none takes a
    name the parent already uses. Raises a field error under ``key``."""
    if not rows or target is None:
        return
    model = type(rows[0])
    names = Counter(r.name for r in rows)
    clash = {n for n, c in names.items() if c > 1}
    clash |= set(
        model.objects.filter(**{scope_field: target}, name__in=list(names))
        .exclude(pk__in=[r.pk for r in rows])
        .values_list("name", flat=True)
    )
    if clash:
        listed = ", ".join(sorted(clash)[:10]) + (" …" if len(clash) > 10 else "")
        raise ValidationError({key: f"Names already used there: {listed}."})
