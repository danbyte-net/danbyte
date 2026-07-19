"""Read-only introspection of RQ queues, jobs and workers.

RQ already stores everything we need in Redis — queued job ids live on the queue,
and the started/finished/failed/deferred/scheduled job ids live in per-queue
registries. This module turns that raw state into plain dicts the SPA can render,
and provides the few mutating helpers the Jobs detail page needs (requeue/cancel).

Everything here is best-effort: Redis being down or a job hash having expired
mid-read must never 500 the page, so reads swallow per-job errors and skip.
"""
from __future__ import annotations

from datetime import timezone as _tz

from django.conf import settings
from django.utils import timezone

import django_rq
from rq.job import Job
from rq.queue import Queue
from rq.registry import (
    DeferredJobRegistry,
    FailedJobRegistry,
    FinishedJobRegistry,
    ScheduledJobRegistry,
    StartedJobRegistry,
)
from rq.worker import Worker

# States we surface, in display order. "queued" lives on the queue itself; the
# rest each map to a registry class.
_REGISTRIES = {
    "started": StartedJobRegistry,
    "deferred": DeferredJobRegistry,
    "finished": FinishedJobRegistry,
    "failed": FailedJobRegistry,
    "scheduled": ScheduledJobRegistry,
}
STATES = ["queued", "started", "deferred", "scheduled", "finished", "failed"]

# Hard cap on how many job hashes a single list request will fetch, so a huge
# finished/failed backlog can't blow up the response. Reported as `truncated`.
MAX_SCAN = 1000


def queue_names() -> list[str]:
    return list(getattr(settings, "RQ_QUEUES", {}).keys()) or ["default"]


def _conn():
    # All three queues share one Redis DB, so a single connection covers them.
    return django_rq.get_connection("default")


def _queue(name: str) -> Queue:
    return django_rq.get_queue(name)


def _iso(dt):
    """RQ datetimes are UTC (sometimes naive). Emit a stable ISO-8601 string."""
    if dt is None:
        return None
    if timezone.is_naive(dt):
        dt = dt.replace(tzinfo=_tz.utc)
    return dt.isoformat()


def _duration(started, ended):
    """Seconds between two datetimes; for a running job, started→now."""
    if started is None:
        return None
    end = ended or timezone.now()
    if timezone.is_naive(started):
        started = started.replace(tzinfo=_tz.utc)
    if timezone.is_naive(end):
        end = end.replace(tzinfo=_tz.utc)
    return max((end - started).total_seconds(), 0.0)


# ----- counts & ids ---------------------------------------------------------


def _state_count(queue: Queue, state: str) -> int:
    try:
        if state == "queued":
            return queue.count
        reg = _REGISTRIES[state](queue=queue)
        return reg.count
    except Exception:  # noqa: BLE001 — a missing registry just means zero
        return 0


def counts(only_queue: str | None = None) -> dict:
    """Per-state totals (summed across queues, or one queue), plus per-queue rollups."""
    names = [only_queue] if only_queue else queue_names()
    per_state = {s: 0 for s in STATES}
    per_queue = {}
    for name in names:
        q = _queue(name)
        row = {s: _state_count(q, s) for s in STATES}
        per_queue[name] = row
        for s in STATES:
            per_state[s] += row[s]
    per_state["total"] = sum(per_state[s] for s in STATES)
    return {"by_state": per_state, "by_queue": per_queue}


def _state_ids(queue: Queue, state: str) -> list[str]:
    try:
        if state == "queued":
            return list(queue.get_job_ids())
        return list(_REGISTRIES[state](queue=queue).get_job_ids())
    except Exception:  # noqa: BLE001
        return []


# ----- serialisation --------------------------------------------------------


def _safe_func_name(job: Job):
    """func_name lazily deserialises the pickled payload, which fails for jobs
    enqueued by code/modules that no longer exist. Timestamps + description live
    in the hash and survive, so degrade to those instead of raising."""
    try:
        return job.func_name or "", False
    except Exception:  # noqa: BLE001 — DeserializationError, ModuleNotFoundError, …
        return None, True


def job_brief(job: Job, state: str) -> dict:
    """Compact row for the list table."""
    func, corrupt = _safe_func_name(job)
    desc = getattr(job, "description", None) or ""
    return {
        "id": job.id,
        "state": state,
        "queue": job.origin,
        "func_name": func,
        "func_short": (func.rsplit(".", 1)[-1] if func else None)
        or (desc.split("(", 1)[0] if desc else None)
        or ("(unreadable)" if corrupt else "(unknown)"),
        "description": desc[:240],
        "corrupt": corrupt,
        "enqueued_at": _iso(job.enqueued_at),
        "started_at": _iso(job.started_at),
        "ended_at": _iso(job.ended_at),
        "duration": _duration(job.started_at, job.ended_at),
        "worker_name": getattr(job, "worker_name", None),
    }


def _truncate(value, limit: int = 4000) -> str:
    text = value if isinstance(value, str) else repr(value)
    if len(text) > limit:
        return text[:limit] + f"\n… (+{len(text) - limit} more chars)"
    return text


def job_detail(job: Job, state: str) -> dict:
    """Everything the detail page shows for one job."""
    base = job_brief(job, state)
    try:
        result = job.return_value()
    except Exception:  # noqa: BLE001 — result hash may have expired
        result = None
    # args/kwargs also deserialise the payload — guard like func_name.
    try:
        args = [_truncate(a, 500) for a in (job.args or ())]
        kwargs = {k: _truncate(v, 500) for k, v in (job.kwargs or {}).items()}
    except Exception:  # noqa: BLE001
        args, kwargs = [], {}
    base.update(
        {
            "args": args,
            "kwargs": kwargs,
            "meta": {k: _truncate(v, 500) for k, v in (job.meta or {}).items()},
            "timeout": job.timeout,
            "result_ttl": job.result_ttl,
            "result": _truncate(result) if result is not None else None,
            "exc_info": job.exc_info or None,
            "created_at": _iso(getattr(job, "created_at", None)),
        }
    )
    return base


# ----- workers --------------------------------------------------------------


def list_workers() -> list[dict]:
    conn = _conn()
    out = []
    try:
        workers = Worker.all(connection=conn)
    except Exception:  # noqa: BLE001
        return out
    for w in workers:
        try:
            state = w.get_state()
        except Exception:  # noqa: BLE001
            state = "?"
        try:
            current = w.get_current_job_id()
        except Exception:  # noqa: BLE001
            current = None
        out.append(
            {
                "name": w.name,
                "hostname": getattr(w, "hostname", None),
                "pid": getattr(w, "pid", None),
                "state": state,
                "queues": w.queue_names(),
                "current_job_id": current,
                "successful_jobs": getattr(w, "successful_job_count", None),
                "failed_jobs": getattr(w, "failed_job_count", None),
                "last_heartbeat": _iso(getattr(w, "last_heartbeat", None)),
                "birth_date": _iso(getattr(w, "birth_date", None)),
            }
        )
    return out


# ----- list & fetch ---------------------------------------------------------


def list_jobs(state: str = "all", queue: str = "all", limit: int = 50, offset: int = 0) -> dict:
    """Sorted, paginated job list for the given state/queue filter."""
    names = queue_names() if queue in ("all", "") else [queue]
    states = STATES if state in ("all", "") else [state]

    candidates: list[tuple[str, str]] = []  # (job_id, state)
    truncated = False
    for name in names:
        q = _queue(name)
        for st in states:
            for jid in _state_ids(q, st):
                candidates.append((jid, st))
                if len(candidates) >= MAX_SCAN:
                    truncated = True
                    break
            if truncated:
                break
        if truncated:
            break

    conn = _conn()
    ids = [c[0] for c in candidates]
    state_by_id = {jid: st for jid, st in candidates}
    jobs = Job.fetch_many(ids, connection=conn) if ids else []
    briefs = [job_brief(j, state_by_id.get(j.id, "?")) for j in jobs if j is not None]

    # Most-recent activity first. Running/queued (no end yet) float to the top.
    def _sort_key(b):
        return b["ended_at"] or b["started_at"] or b["enqueued_at"] or ""

    briefs.sort(key=_sort_key, reverse=True)
    total = len(briefs)
    page = briefs[offset : offset + limit]
    return {
        "jobs": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "truncated": truncated,
    }


def fetch_one(job_id: str):
    try:
        job = Job.fetch(job_id, connection=_conn())
    except Exception:  # noqa: BLE001 — NoSuchJobError or expired hash
        return None
    try:
        state = job.get_status()
    except Exception:  # noqa: BLE001
        state = "?"
    return job, state


# ----- mutations ------------------------------------------------------------


def requeue_job(job_id: str) -> bool:
    """Move a failed job back onto its queue. Returns False if it isn't failed."""
    res = fetch_one(job_id)
    if res is None:
        return False
    job, _ = res
    try:
        job.requeue()
        return True
    except Exception:  # noqa: BLE001 — only failed jobs can be requeued
        return False


def cancel_job(job_id: str) -> bool:
    """Cancel (if queued/started) and delete the job hash. Returns False if gone."""
    res = fetch_one(job_id)
    if res is None:
        return False
    job, _ = res
    try:
        job.cancel()
    except Exception:  # noqa: BLE001 — already finished/cancelled is fine
        pass
    try:
        job.delete()
    except Exception:  # noqa: BLE001
        pass
    return True
