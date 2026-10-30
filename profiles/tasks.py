"""Background work for device profiles: bulk assign and unassign above the
inline limit. The job re-reads the tenant, the user, the profile and every
object by id, re-checks the user's permissions object by object, and writes
as that user."""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def enqueue_bulk(tenant_id, user_id, profile_id, act, kind, ids, *, via="",
                 request_id="") -> str:
    """Queue :func:`run_bulk`; returns the job id shown on /jobs."""
    import django_rq

    job = django_rq.get_queue("default").enqueue(
        run_bulk, str(tenant_id), user_id, str(profile_id), act, kind, list(ids),
        via=via, request_id=request_id, job_timeout=3600,
        description=f"Device profile bulk {act} ({len(ids)} objects)",
    )
    return job.id


def run_bulk(tenant_id, user_id, profile_id, act, kind, ids, via="", request_id="") -> dict:
    """The RQ job: one profile assigned to or taken off many objects.
    Returns the outcome counts."""
    from django.contrib.auth import get_user_model

    from api.models import Device, VirtualMachine
    from audit.context import clear_context, set_context
    from core.models import Tenant

    from .api import bulk_one
    from .models import DeviceProfile

    tally: dict = {}
    tenant = Tenant.objects.filter(pk=tenant_id, is_active=True).first()
    user = get_user_model().objects.filter(pk=user_id, is_active=True).first()
    profile = (DeviceProfile.objects.filter(pk=profile_id, tenant=tenant).first()
               if tenant is not None else None)
    if tenant is None or user is None or profile is None:
        return {"skipped": len(ids)}
    model = Device if kind == "device" else VirtualMachine
    hosts = {str(h.pk): h for h in model.objects.filter(tenant=tenant, pk__in=ids)}
    set_context(user, request_id or "", via if via in ("ui", "api") else "")
    try:
        for i in ids:
            host = hosts.get(str(i))
            if host is None:
                outcome = "gone"
            else:
                try:
                    outcome = bulk_one(user, tenant, profile, host, act)
                except Exception:  # noqa: BLE001 - one object must not stop the run
                    log.exception("device profile bulk %s on %s failed", act, i)
                    outcome = "failed"
            tally[outcome] = tally.get(outcome, 0) + 1
    finally:
        clear_context()
    return tally
