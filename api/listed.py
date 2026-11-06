"""Reverse relations prefetched as plain lists (#483).

``prefetch_related("children")`` hands every row a related manager whose
queryset Django builds, filters and clones per row only to hold that row's
cached rows - 7,551 ``QuerySet.clone()`` calls on a 1,000-interface page,
half a second of a 1.2 s request. ``Prefetch("children", to_attr=…)`` runs
the same query and leaves a list: :func:`listed` reads it, and falls back to
``.all()`` on an object that was loaded without it (a detail read, a write
response), so a serializer works either way. :data:`core.tags.TAGS` is the
same idea for tags.

Only list querysets use these: DRF drops ``_prefetched_objects_cache`` after
an update but not a ``to_attr`` list, so a write response must read the
relation fresh.
"""
from __future__ import annotations

from django.db.models import Prefetch
from rest_framework import serializers

PREFIX = "_listed_"


def attr(rel: str) -> str:
    return f"{PREFIX}{rel}"


def prefetch(rel: str, queryset=None) -> Prefetch:
    """``rel`` prefetched into a list :func:`listed` reads. A lookup that
    continues past it names :func:`attr` (``_listed_terminations__cable``)."""
    return Prefetch(rel, queryset=queryset, to_attr=attr(rel))


def listed(obj, rel: str):
    """``obj``'s ``rel`` rows: the prefetched list, else a query."""
    got = obj.__dict__.get(attr(rel))
    return got if got is not None else getattr(obj, rel).all()


class ListedManySerializer(serializers.ListSerializer):
    """``Child(many=True)`` that reads the :func:`prefetch` list of its
    source when the row has one."""

    def get_attribute(self, instance):
        got = instance.__dict__.get(attr(self.source)) if self.source else None
        if got is not None:
            return got
        return super().get_attribute(instance)
