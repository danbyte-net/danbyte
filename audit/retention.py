"""Change-log retention — delete entries past CHANGELOG_RETENTION_DAYS.

Append-only audit data grows forever otherwise. Default 730 days (2 years);
``CHANGELOG_RETENTION_DAYS=0`` disables pruning. Deletes in bounded batches so a
large backlog never holds one giant transaction.
"""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from .models import ChangeLogEntry

_BATCH = 5000


def _retention_days() -> int:
    """Days to keep audit entries. The admin Deployment setting wins; fall back
    to the CHANGELOG_RETENTION_DAYS env/setting (default 730)."""
    try:
        from core.models import DeploymentSettings

        return int(DeploymentSettings.load().changelog_retention_days)
    except Exception:  # noqa: BLE001 — table missing during early migrate, etc.
        return int(getattr(settings, "CHANGELOG_RETENTION_DAYS", 730))


def prune(now=None) -> dict:
    days = _retention_days()
    if not days:
        return {"deleted": 0, "retention_days": 0}
    now = now or timezone.now()
    cutoff = now - timedelta(days=days)
    total = 0
    while True:
        ids = list(
            ChangeLogEntry.objects.filter(timestamp__lt=cutoff).values_list(
                "id", flat=True
            )[:_BATCH]
        )
        if not ids:
            break
        deleted, _ = ChangeLogEntry.objects.filter(id__in=ids).delete()
        total += deleted
        if len(ids) < _BATCH:
            break
    return {"deleted": total, "retention_days": days}
