"""Run-log helper for periodic/background tasks (the Jobs page's "Scheduled
tasks" section).

Wrap a periodic command's work in ``record_run`` so admins can see it ran::

    from core.scheduled_runs import record_run

    with record_run("digest", "Email digest") as run:
        n = run_scheduled_digests()
        run.note(f"{n} digest(s) sent", count=n)

On a clean exit the run is marked ``ok``; if the body raises, it's marked
``failed`` (with the exception text as the summary) and the exception
re-raises so the command still errors as before. Old rows are pruned per task,
so the log can't grow without bound.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager

from django.utils import timezone

logger = logging.getLogger("danbyte.scheduled")

# How many runs to keep per task name.
_KEEP_PER_TASK = 50


class _RunHandle:
    """Handed to the ``with`` body so it can attach a summary / detail."""

    def __init__(self, run):
        self._run = run

    def note(self, summary: str = "", **detail) -> None:
        if summary:
            self._run.summary = summary[:500]
        if detail:
            self._run.detail = {**(self._run.detail or {}), **detail}

    def skip(self, summary: str = "") -> None:
        """Mark this run as skipped (nothing to do) rather than a plain OK."""
        self._run.status = self._run.SKIPPED
        if summary:
            self._run.summary = summary[:500]


def _prune(name: str) -> None:
    from core.models import ScheduledRun

    stale_ids = list(
        ScheduledRun.objects.filter(name=name)
        .order_by("-started_at")
        .values_list("id", flat=True)[_KEEP_PER_TASK:]
    )
    if stale_ids:
        ScheduledRun.objects.filter(id__in=stale_ids).delete()


@contextmanager
def record_run(name: str, label: str | None = None):
    """Context manager that logs one execution of task ``name``.

    Never masks the wrapped work: a failure is recorded then re-raised. Logging
    failures are swallowed so the run-log can never break the actual task.
    """
    from core.models import ScheduledRun

    run = None
    try:
        run = ScheduledRun.objects.create(
            name=name, label=label or name, status=ScheduledRun.RUNNING,
            started_at=timezone.now(),
        )
    except Exception:  # noqa: BLE001 — logging must never break the task
        logger.exception("scheduled-run: could not open a run row for %s", name)

    handle = _RunHandle(run) if run is not None else _NULL_HANDLE
    try:
        yield handle
    except Exception as exc:
        if run is not None:
            _finish(run, run.FAILED if run.status != run.SKIPPED else run.status,
                    summary=run.summary or str(exc)[:500])
        raise
    else:
        if run is not None:
            _finish(run, run.status if run.status == run.SKIPPED else run.OK)


def _finish(run, status, summary: str | None = None) -> None:
    from core.models import ScheduledRun

    try:
        run.status = status
        if summary is not None:
            run.summary = summary[:500]
        run.finished_at = timezone.now()
        run.save(update_fields=["status", "summary", "detail", "finished_at"])
        _prune(run.name)
    except Exception:  # noqa: BLE001
        logger.exception("scheduled-run: could not finalise run %s", run.name)


class _NullHandle:
    def note(self, *a, **k) -> None: ...
    def skip(self, *a, **k) -> None: ...


_NULL_HANDLE = _NullHandle()
