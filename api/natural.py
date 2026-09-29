"""Natural ("human") order for names that carry numbers (#244).

``DIMM 2`` sorts before ``DIMM 10`` and ``Ethernet1/2`` before
``Ethernet1/10``, where plain collation reads ``1, 10, 11, 2``. In the
database that is the ``natural_sort`` ICU collation (migration 0099, numeric
ordering on): ``natural("name")`` orders a queryset by it and works across
relations (``natural("device__name")``). A list that is already in memory
sorts with ``natural_key``.
"""
from __future__ import annotations

import re

from django.db.models.functions import Collate

COLLATION = "natural_sort"

_DIGITS = re.compile(r"(\d+)")


def natural(field: str) -> Collate:
    """``field`` under the natural-sort collation, for ``order_by`` and
    ``Meta.ordering``; ``.desc()`` reverses it."""
    return Collate(field, COLLATION)


def natural_key(value) -> list:
    """A sort key that compares digit runs as numbers and the rest without
    case: ``sorted(names, key=natural_key)``."""
    parts = _DIGITS.split("" if value is None else str(value))
    # re.split with one group alternates text, digits, text, ... - so odd
    # positions are always digit runs and the lists compare slot by slot.
    return [int(p) if i % 2 else p.casefold() for i, p in enumerate(parts)]
