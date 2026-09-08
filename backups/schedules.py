"""Which schedules are due, and firing one - shared by the tick command and
the "Run now" button."""
from __future__ import annotations

from django.utils import timezone

from core.cadence import Cadence, CadenceError

from .engine import create_backup, enqueue_backup
from .models import Backup, BackupSchedule


def is_due(schedule: BackupSchedule, now=None) -> bool:
    """Due when the latest occurrence is later than the last run - a never-run
    schedule waits for its first occurrence after it was created, and a tick
    that slept still fires each missed occurrence exactly once."""
    now = now or timezone.localtime()
    try:
        cad = Cadence.from_dict(schedule.cadence)
    except CadenceError:
        return False
    last = schedule.last_run_at or schedule.created_at
    return cad.is_due(now, timezone.localtime(last))


def next_run(schedule: BackupSchedule, now=None):
    try:
        cad = Cadence.from_dict(schedule.cadence)
    except CadenceError:
        return None
    return cad.next_occurrence(now or timezone.localtime())


def due_schedules(now=None) -> list[BackupSchedule]:
    return [s for s in BackupSchedule.objects.filter(enabled=True).select_related("target")
            if is_due(s, now)]


def fire_schedule(schedule: BackupSchedule, now=None, *, user=None, kind: str = "scheduled") -> Backup:
    """Create and enqueue one backup for the schedule and stamp last_run_at,
    so a second tick in the same occurrence does nothing."""
    now = now or timezone.now()
    backup = create_backup(kind=kind, components=schedule.components, target=schedule.target,
                           schedule=schedule, user=user)
    BackupSchedule.objects.filter(pk=schedule.pk).update(last_run_at=now)
    enqueue_backup(backup)
    return backup
