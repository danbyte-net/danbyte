"""Daily upkeep of the tenant side (#451): exception expiry and match
history retention. Run by ``manage.py vuln_maintenance`` (the second command
of the ``danbyte-vuln-refresh`` unit).

* :func:`expire_exceptions` - an exception applies through ``expires_on``.
  The day after, its matches are reopened (``excepted`` re-resolved: another
  exception may still cover them), the tenant's channels get one message
  listing what expired, and each owner one in-app notification. Each
  exception is handled once (``expiry_notified_at``); the reopened matches
  count as told, so the next recompute does not announce them again as new.
  Per tenant, re-read when it runs: an inactive tenant is skipped.
* :func:`purge_resolved` - resolved matches older than 365 days are deleted
  (decision 14); open ones are never touched.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

log = logging.getLogger(__name__)

RETENTION_DAYS = 365
CHUNK = 5000
LINES_MAX = 20


def _subject_name(e) -> str:
    s = e.subject
    return str(s) if s is not None else "the whole tenant"


def expire_exceptions(today=None, now=None) -> dict:
    from core.models import Notification, Tenant

    from . import exceptions
    from .models import VulnerabilityException, VulnerabilityMatch, VulnerabilityPolicy

    today = today or timezone.localdate()
    now = now or timezone.now()
    due = (VulnerabilityException.objects
           .filter(expires_on__lt=today, expiry_notified_at__isnull=True)
           .select_related("cve", "owner", "device", "virtual_machine", "platform",
                           "application"))
    by_tenant: dict = defaultdict(list)
    for e in due:
        by_tenant[e.tenant_id].append(e)
    counts = {"tenants": 0, "exceptions": 0, "reopened": 0}
    for tenant_id, rows in by_tenant.items():
        tenant = Tenant.objects.filter(pk=tenant_id, is_active=True).first()
        if tenant is None:
            continue
        ids = [e.pk for e in rows]
        with transaction.atomic():
            # Claim them: a second run at the same time finds nothing to do.
            claimed = list(VulnerabilityException.objects.select_for_update(skip_locked=True)
                           .filter(pk__in=ids, expiry_notified_at__isnull=True)
                           .values_list("pk", flat=True))
            if not claimed:
                continue
            rows = [e for e in rows if e.pk in set(claimed)]
            covered = defaultdict(list)
            for pk, exc_id in VulnerabilityMatch.objects.filter(
                    tenant=tenant, excepted_id__in=claimed,
                    resolved_at__isnull=True).values_list("pk", "excepted_id"):
                covered[exc_id].append(pk)
            exceptions.apply(tenant.pk, {e.cve_id for e in rows}, today=today)
            all_pks = [pk for pks in covered.values() for pk in pks]
            reopened = set(VulnerabilityMatch.objects.filter(
                pk__in=all_pks, excepted__isnull=True).values_list("pk", flat=True))
            # What the expiry message says need not come round again as new.
            VulnerabilityMatch.objects.filter(
                pk__in=reopened, notified_at__isnull=True, cve__kev_added__isnull=False
            ).update(notified_at=now, notified_kev=True)
            VulnerabilityMatch.objects.filter(
                pk__in=reopened, notified_at__isnull=True).update(notified_at=now)
            VulnerabilityException.objects.filter(pk__in=claimed).update(
                expiry_notified_at=now)
        per = {e.pk: len([m for m in covered.get(e.pk, ()) if m in reopened]) for e in rows}
        counts["tenants"] += 1
        counts["exceptions"] += len(rows)
        counts["reopened"] += len(reopened)
        _tell(tenant, rows, per, VulnerabilityPolicy.objects.filter(tenant=tenant).first(),
              Notification)
    return counts


def _tell(tenant, rows, per, policy, Notification) -> None:
    lines = []
    for e in rows[:LINES_MAX]:
        lines.append(
            f"- {e.cve.vuln_id} {e.get_status_display().lower()} for {_subject_name(e)}, "
            f"until {e.expires_on.isoformat()}, owner {e.owner_name or 'none'}: "
            f"{per.get(e.pk, 0)} match{'' if per.get(e.pk, 0) == 1 else 'es'} reopened")
    if len(rows) > LINES_MAX:
        lines.append(f"- and {len(rows) - LINES_MAX} more")
    n = len(rows)
    subject = f"[Danbyte] {n} vulnerability exception{'' if n == 1 else 's'} expired"
    if policy is None or policy.notify_enabled:
        from monitoring.notify import notify_event

        payload = {
            "event": "vulnerability_exceptions_expired",
            "count": n,
            "exceptions": [{
                "id": str(e.pk), "numid": e.numid, "vuln_id": e.cve.vuln_id,
                "status": e.status, "scope": e.scope, "subject": _subject_name(e),
                "expires_on": e.expires_on.isoformat(), "owner": e.owner_name,
                "reopened": per.get(e.pk, 0),
            } for e in rows[:200]],
        }
        try:
            notify_event(tenant.pk, subject, "\n".join(lines) + "\n", payload)
        except Exception:  # noqa: BLE001
            log.exception("exception expiry message for tenant %s failed", tenant.pk)
    by_owner = defaultdict(list)
    for e in rows:
        if e.owner is not None and e.owner.is_active:
            by_owner[e.owner].append(e)
    for owner, mine in by_owner.items():
        first = mine[0]
        title = (f"Vulnerability exception for {first.cve.vuln_id} expired"
                 if len(mine) == 1 else f"{len(mine)} vulnerability exceptions expired")
        body = "; ".join(f"{e.cve.vuln_id} on {_subject_name(e)}" for e in mine[:10])
        try:
            Notification.push([owner], kind="vulnerability_exception_expired", title=title,
                              body=body, url=f"/vulnerabilities/{first.cve.vuln_id}",
                              tenant=tenant)
        except Exception:  # noqa: BLE001
            log.exception("exception expiry notice for user %s failed", owner.pk)


def purge_resolved(now=None, days: int = RETENTION_DAYS) -> int:
    from .models import VulnerabilityMatch

    cutoff = (now or timezone.now()) - timedelta(days=days)
    total = 0
    while True:
        pks = list(VulnerabilityMatch.objects.filter(resolved_at__lt=cutoff)
                   .values_list("pk", flat=True)[:CHUNK])
        if not pks:
            return total
        total += VulnerabilityMatch.objects.filter(pk__in=pks).delete()[0]
