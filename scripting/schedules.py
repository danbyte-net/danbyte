"""When a script runs by itself, and how many runs are kept.

Mirrors ``backups/schedules.py``: the shared ``core.cadence`` decides due-
ness, and a schedule fires once per occurrence even if a tick was missed.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from core.cadence import Cadence, CadenceError, Retention

from .models import Script, ScriptRun
from .runner import create_run, enqueue

logger = logging.getLogger(__name__)


def is_due(script: Script, now=None) -> bool:
    # An empty cadence would fall back to the dataclass default (daily at
    # 02:00), so a script with no cadence set simply never fires.
    if not (script.enabled and script.schedule_enabled and script.cadence):
        return False
    now = now or timezone.localtime()
    try:
        cad = Cadence.from_dict(script.cadence)
    except CadenceError:
        return False
    last = script.last_run_at or script.created_at
    return cad.is_due(now, timezone.localtime(last))


def next_run(script: Script, now=None):
    try:
        cad = Cadence.from_dict(script.cadence)
    except CadenceError:
        return None
    return cad.next_occurrence(now or timezone.localtime())


def due_scripts(now=None) -> list[Script]:
    now = now or timezone.localtime()
    qs = Script.objects.filter(enabled=True, schedule_enabled=True).select_related("owner")
    return [s for s in qs if is_due(s, now)]


def fire(script: Script, now=None) -> ScriptRun | None:
    """Queue one scheduled run. A script with no owner cannot run itself -
    there would be nobody to run as."""
    now = now or timezone.now()
    if script.owner_id is None:
        logger.warning("script %s is scheduled but has no owner; skipping", script.pk)
        return None
    run = create_run(script, user=script.owner, params=script.schedule_params or {},
                     scheduled=True)
    Script.objects.filter(pk=script.pk).update(last_run_at=now)
    enqueue(run)
    return run


def prune(script: Script, now=None) -> int:
    """Apply the script's retention to its finished runs, deleting their
    output files with them."""
    try:
        rule = Retention.from_dict(script.retention)
    except CadenceError:
        return 0
    if rule.max_count is None and rule.max_age_days is None:
        return 0
    finished = list(
        script.runs.exclude(status__in=("queued", "running")).order_by("-created_at")
    )
    stale = rule.expired(finished, when=lambda r: r.created_at, now=now or timezone.now())
    removed = 0
    for run in stale:
        for out in run.outputs.all():
            out.file.delete(save=False)
        run.delete()
        removed += 1
    return removed
