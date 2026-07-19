"""Retention / pruning for the time-series tables.

``CheckResult`` grows fast (one row per check per run), so old rows are deleted
on a schedule. ``StateTransition`` is the audit timeline and is kept much
longer. Both windows are settings (``MONITORING_RESULT_RETENTION_DAYS`` /
``MONITORING_TRANSITION_RETENTION_DAYS``).

Deletes run in bounded batches so pruning a huge backlog never holds one giant
transaction or blocks writers. A native monthly RANGE partition on
``CheckResult.timestamp`` is the next scaling step (then pruning becomes a cheap
``DROP PARTITION`` instead of a bulk delete) — see the model docstring.
"""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from .models import CheckResult, StateTransition

_BATCH = 5000


def _prune_older_than(model, field: str, cutoff, batch: int = _BATCH) -> int:
    """Delete rows where ``field < cutoff`` in batches; return the count."""
    total = 0
    while True:
        ids = list(
            model.objects.filter(**{f"{field}__lt": cutoff}).values_list(
                "pk", flat=True
            )[:batch]
        )
        if not ids:
            break
        deleted, _ = model.objects.filter(pk__in=ids).delete()
        total += deleted
        if len(ids) < batch:
            break
    return total


def prune(now=None) -> dict:
    now = now or timezone.now()
    result_days = int(getattr(settings, "MONITORING_RESULT_RETENTION_DAYS", 90))
    transition_days = int(getattr(settings, "MONITORING_TRANSITION_RETENTION_DAYS", 365))

    results_deleted = _prune_older_than(
        CheckResult, "timestamp", now - timedelta(days=result_days)
    )
    transitions_deleted = _prune_older_than(
        StateTransition, "at", now - timedelta(days=transition_days)
    )
    return {
        "results_deleted": results_deleted,
        "transitions_deleted": transitions_deleted,
        "result_retention_days": result_days,
        "transition_retention_days": transition_days,
    }
