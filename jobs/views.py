"""DRF endpoints for the Jobs (background queue) admin page.

Gated on the flat ``jobs.manage`` permission — admins hold it by default, and it
can be granted to any custom-role user from the user edit form. Jobs are global
infrastructure (shared across tenants), so there is no tenant scoping here.
"""
from __future__ import annotations

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


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def job_cancel_view(request, job_id):
    denied = _denied(request)
    if denied is not None:
        return denied
    if not rq.cancel_job(job_id):
        return Response({"detail": "Job not found (it may have expired)."}, status=404)
    return Response(status=204)
