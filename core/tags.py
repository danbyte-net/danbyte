"""Loading a page's tags as plain lists (#296).

``prefetch_related("tags")`` hands every row a django-taggit queryset of its
own - built, filtered and ordered per row only to hold that row's tags - and
that costs about 0.2 ms a row: a third of a second on 1,600 interfaces. The
:data:`TAGS` prefetch runs the same single query but leaves each row a list
in ``prefetched_tags``; :func:`tags_of` reads it, and falls back to
``obj.tags.all()`` for an object that was loaded without it.

A tag write through the manager (``obj.tags.add/remove/set/clear``) drops the
list, as taggit drops its own prefetch cache, so the next read sees the change.
"""
from __future__ import annotations

from django.db.models import Prefetch

TAGS_ATTR = "prefetched_tags"

# Shared by the list querysets. Without a queryset of its own a Prefetch is
# safe to reuse, and naming it twice on one queryset runs it once.
TAGS = Prefetch("tags", to_attr=TAGS_ATTR)


def tags_of(obj):
    """The object's tags: the list a :data:`TAGS` prefetch left, else a query."""
    got = obj.__dict__.get(TAGS_ATTR)
    return got if got is not None else obj.tags.all()


def forget_prefetched_tags(sender, instance, action, **kwargs):
    """``m2m_changed`` on the tag through model: drop the stale list."""
    if action.startswith("post_"):
        instance.__dict__.pop(TAGS_ATTR, None)
