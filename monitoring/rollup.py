"""Status roll-up helpers — collapse many check statuses into one.

Severity order (worst wins): ``down`` > ``degraded`` > ``stale`` > ``unknown``
> ``up``. So a target with one down check rolls up to ``down``; an all-``up``
target rolls up to ``up``; an unmonitored target rolls up to ``None``.
"""
from __future__ import annotations

from collections import Counter

# Worst wins. 'skipped' ranks below 'up' so a prefix with some skipped and some
# up IPs rolls up to 'up' (healthy); an all-skipped prefix rolls up to skipped.
# 'stale' (chronic down) ranks just under fresh 'down'.
_SEVERITY = {
    "skipped": 0,
    "up": 1,
    "unknown": 2,
    "degraded": 3,
    "stale": 4,
    "down": 5,
}


def worst_status(statuses) -> str | None:
    """The most severe status in an iterable, or ``None`` if empty."""
    worst = None
    worst_sev = -1
    for s in statuses:
        sev = _SEVERITY.get(s, 1)
        if sev > worst_sev:
            worst_sev = sev
            worst = s
    return worst


def status_counts(statuses) -> dict:
    """A ``{status: count}`` breakdown (only present statuses)."""
    return dict(Counter(statuses))
