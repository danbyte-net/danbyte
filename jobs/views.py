"""DRF endpoints for the Jobs (background queue) admin page.

Gated on the flat ``jobs.manage`` permission — admins hold it by default, and it
can be granted to any custom-role user from the user edit form. Jobs are global
infrastructure (shared across tenants), so there is no tenant scoping here.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import user_has_perm

from . import rq_introspect as rq

PERM = "jobs.manage"


def _denied(request):
    """Return a 403 Response if the caller lacks jobs.manage, else None."""
    if not user_has_perm(request.user, PERM):
        return Response({"detail": "You don't have permission to manage jobs."}, status=403)
    return None


@extend_schema(
    summary="List background jobs with live worker and count summary",
    tags=["jobs"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="state",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by job state (e.g. queued, started, finished, failed, deferred, scheduled) or 'all'.",
        ),
        OpenApiParameter(
            name="queue",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter by RQ queue name, or 'all'.",
        ),
        OpenApiParameter(
            name="limit",
            type=OpenApiTypes.INT,
            location=OpenApiParameter.QUERY,
            description="Max jobs to return (1-200, default 50).",
        ),
        OpenApiParameter(
            name="offset",
            type=OpenApiTypes.INT,
            location=OpenApiParameter.QUERY,
            description="Pagination offset (default 0).",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Jobs page payload: jobs list plus counts, workers, queues, states, and system upgrade status.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def jobs_list_view(request):
    """List jobs filtered by ?state= and ?queue=, plus live worker + count summary."""
    denied = _denied(request)
    if denied is not None:
        return denied

    state = request.GET.get("state", "all")
    queue = request.GET.get("queue", "all")
    try:
        limit = max(1, min(int(request.GET.get("limit", 50)), 200))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(request.GET.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0

    payload = rq.list_jobs(state=state, queue=queue, limit=limit, offset=offset)
    payload["counts"] = rq.counts()
    payload["workers"] = rq.list_workers()
    payload["queues"] = rq.queue_names()
    payload["states"] = rq.STATES
    # A self-upgrade isn't an RQ job (it restarts the workers), so surface its
    # progress + the next auto-update check here as a system entry.
    from core.upgrade import system_status

    payload["system"] = system_status()
    return Response(payload)


# Known periodic tasks (systemd-timer oneshots) + cadence, so the page shows the
# whole beat — including a task that has never run yet (its row stays empty).
SCHEDULED_TASKS = [
    {"name": "dispatch", "label": "Check engine (dispatch)", "cadence": "every minute"},
    {"name": "drift", "label": "Config-drift dispatch", "cadence": "every minute"},
    {"name": "outposts", "label": "Drive Outposts", "cadence": "every minute"},
    {"name": "alert-maintenance", "label": "Alert maintenance", "cadence": "every minute"},
    {"name": "materialise", "label": "Materialise checks", "cadence": "every 5 min"},
    {"name": "discover", "label": "Subnet discovery", "cadence": "every 5 min"},
    {"name": "utilization", "label": "Interface utilization", "cadence": "every 15 min"},
    {"name": "auto-upgrade", "label": "Auto-upgrade check", "cadence": "every 20 min"},
    {"name": "digest", "label": "Email digest", "cadence": "daily 07:00"},
    {"name": "cleanup-ips", "label": "Stale-IP cleanup", "cadence": "daily"},
    {"name": "prune-changelog", "label": "Prune changelog", "cadence": "daily"},
    {"name": "prune-results", "label": "Prune check results", "cadence": "daily"},
]


def _run_dict(run):
    return {
        "id": str(run.id),
        "status": run.status,
        "summary": run.summary,
        "detail": run.detail,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "duration_seconds": run.duration_seconds,
    }


@extend_schema(
    summary="Scheduled/background task run-log + engine & Outpost heartbeats",
    tags=["jobs"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Per-task last run + recent history for the periodic beat, "
        "plus the active tenant's monitoring engines/Outposts with heartbeats.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def scheduled_runs_view(request):
    """The periodic beat (digest, discovery, drift, Outpost driver, cleanup, …)
    that runs outside RQ, so admins can see each task ran and when."""
    denied = _denied(request)
    if denied is not None:
        return denied

    from api.views import _get_active_tenant
    from core.models import ScheduledRun
    from monitoring.models import MonitoringEngine

    catalog = {
        t["name"]: {**t, "last_run": None, "recent": []} for t in SCHEDULED_TASKS
    }
    # Surface any logged task not in the static catalog (e.g. a plugin's beat).
    for name in (
        ScheduledRun.objects.exclude(name__in=list(catalog))
        .values_list("name", flat=True)
        .distinct()
    ):
        catalog[name] = {
            "name": name, "label": name, "cadence": "", "last_run": None, "recent": []
        }

    for name, entry in catalog.items():
        runs = list(
            ScheduledRun.objects.filter(name=name).order_by("-started_at")[:10]
        )
        if runs:
            entry["last_run"] = _run_dict(runs[0])
            entry["recent"] = [_run_dict(r) for r in runs]

    def _key(t):
        lr = t["last_run"]
        failed = bool(lr and lr["status"] == "failed")
        ts = lr["started_at"].timestamp() if lr else 0
        return (0 if failed else 1, -ts)  # failed first, then most-recent, never-run last

    tasks = sorted(catalog.values(), key=_key)

    tenant = _get_active_tenant(request)
    engines = []
    if tenant is not None:
        for e in MonitoringEngine.objects.filter(tenant=tenant).order_by("kind", "name"):
            engines.append({
                "id": str(e.id),
                "name": e.name,
                "kind": e.kind,
                "transport": e.transport,
                "enabled": e.enabled,
                "last_seen_at": e.last_seen_at,
                "stale_since": e.stale_since,
                "poll_interval_seconds": e.poll_interval_seconds,
            })

    return Response({"tasks": tasks, "engines": engines})


@extend_schema(
    summary="Retrieve detail for a single background job by ID",
    tags=["jobs"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Job detail (status, timings, args, result/exception). 404 if the job expired.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def job_detail_view(request, job_id):
    denied = _denied(request)
    if denied is not None:
        return denied
    res = rq.fetch_one(job_id)
    if res is None:
        return Response({"detail": "Job not found (it may have expired)."}, status=404)
    job, state = res
    return Response(rq.job_detail(job, state))


@extend_schema(
    summary="Requeue a failed background job",
    tags=["jobs"],
    request=None,
    responses=OpenApiResponse(
        response=inline_serializer(
            name="JobRequeueResponse",
            fields={
                "requeued": serializers.BooleanField(),
                "id": serializers.CharField(),
            },
        ),
        description="Job requeued. 409 if the job is not in a failed state.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def job_requeue_view(request, job_id):
    denied = _denied(request)
    if denied is not None:
        return denied
    if not rq.requeue_job(job_id):
        return Response(
            {"detail": "Job can't be requeued (only failed jobs can be)."}, status=409
        )
    return Response({"requeued": True, "id": job_id})


@extend_schema(
    summary="Cancel a background job",
    tags=["jobs"],
    request=None,
    responses={
        204: OpenApiResponse(description="Job cancelled."),
        404: OpenApiResponse(description="Job not found (it may have expired)."),
    },
)
@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def job_cancel_view(request, job_id):
    denied = _denied(request)
    if denied is not None:
        return denied
    if not rq.cancel_job(job_id):
        return Response({"detail": "Job not found (it may have expired)."}, status=404)
    return Response(status=204)
