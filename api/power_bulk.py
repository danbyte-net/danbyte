"""The parts of the power panel and power feed bulk actions (#313) - and the
cooling source and feed ones that mirror them (#434) - that the
shared bulk machinery does not already cover: what a feed is cabled to, a
panel deleted together with its feeds, and names that stay unique when rows
move to another parent."""
from __future__ import annotations

from collections import Counter

from django.db import DEFAULT_DB_ALIAS
from django.db.models.deletion import Collector
from rest_framework.exceptions import ValidationError

from .models import CableTermination, PowerFeed

# How a cabled feed's note is grouped: the delete removes the whole cable when
# the feed was the last port on its end (#378), else only the feed's leg.
CABLE_REMOVED_LABEL = "Cable removed"
CABLE_KEPT_LABEL = "Cable kept"


def cabled_feed_notes(feeds) -> list[dict]:
    """The feeds among ``feeds`` (a queryset of the feeds that go) with a
    cable on them, each named with what is at the far end - a device's power
    port, as a rule - and grouped by what happens to the cable: removed with
    its far-end terminations when no port is left on the feed's end, else
    kept without the feed's leg (#391)."""
    near = list(
        CableTermination.objects.filter(power_feed__in=feeds)
        .values_list("pk", "cable_id", "end", "power_feed_id", "power_feed__name")
    )
    if not near:
        return []
    cable_ids = {c for _, c, *_ in near}
    kept_ends = set(
        CableTermination.objects.filter(cable_id__in=cable_ids)
        .exclude(pk__in=[pk for pk, *_ in near])
        .values_list("cable_id", "end")
    )
    far: dict = {}
    for t in (
        CableTermination.objects.filter(cable_id__in=cable_ids)
        .exclude(power_feed__isnull=False)
        .select_related("power_port__device")
    ):
        far.setdefault((t.cable_id, t.end), []).append(t)
    notes = []
    for _, cable_id, end, feed_id, feed_name in sorted(near, key=lambda r: r[4]):
        other = "B" if end == "A" else "A"
        ends = [
            f"{t.power_port.device.name} {t.power_port.name}" if t.power_port_id
            else str(t.point)
            for t in far.get((cable_id, other), [])
        ]
        notes.append({
            "id": str(feed_id),
            "name": feed_name,
            "label": CABLE_KEPT_LABEL if (cable_id, end) in kept_ends
            else CABLE_REMOVED_LABEL,
            "detail": ", ".join(ends) or "No far end",
        })
    return notes


class FeedsFirstCollector(Collector):
    """Works out a panel delete that takes its feeds along: once the feeds
    are collected, their ``PROTECT`` reference no longer holds the panel.
    ``feed_model`` is the feeds' model - :class:`PowerFeed` for a power
    panel, ``CoolingFeed`` for a cooling source (#434)."""

    def __init__(self, using=DEFAULT_DB_ALIAS, feed_model=PowerFeed, **kwargs):
        super().__init__(using=using, **kwargs)
        self.feed_model = feed_model

    def related_objects(self, related_model, related_fields, objs):
        qs = super().related_objects(related_model, related_fields, objs)
        going = self.data.get(self.feed_model)
        if related_model is self.feed_model and going:
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
