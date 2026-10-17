"""Automatic node sync per Oxidized connection (#385).

A connection with **Sync automatically** on is re-synced every
``sync_interval_minutes`` (5, 10, 15, 30 or 60). ``oxidized_sync`` runs on
the scheduler every minute and enqueues one RQ job per connection that is
due; the job is the same :func:`oxidized.sync.sync_nodes` that **Sync nodes**
runs, so pinned links are kept, matched links re-decided and links whose
node has gone removed.

Due is measured from ``last_sync_attempt_at`` - a failed pass counts - so a
connection whose Oxidized is down retries once per interval instead of every
minute. A manual sync stamps it too and pushes the next scheduled one back.

Each enqueued connection is claimed in Redis until its job finishes (or the
claim expires), so a slow job or an overlapping tick never enqueues it twice.
The job reloads the connection by id and tenant and re-checks everything the
dispatcher checked: the connection exists, is enabled and has auto sync on,
its tenant is active and the integration is switched on.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

log = logging.getLogger("oxidized.schedule")

#: The scheduler's beat for ``oxidized_sync`` (``core.schedule``).
TICK_SECONDS = 60
#: A sync's RQ timeout. One ``/nodes.json`` read plus the matching.
JOB_TIMEOUT = 10 * 60


def claim_key(connection_id) -> str:
    return f"oxidized-sync:claim:{connection_id}"


def _conn():
    import django_rq

    return django_rq.get_connection("low")


def _queue():
    import django_rq

    return django_rq.get_queue("low")


def next_sync_at(conn, now=None):
    """When the scheduler next syncs ``conn``; None while auto sync is off.
    A connection never synced, or overdue, is due on the next tick."""
    if not (conn.enabled and conn.auto_sync):
        return None
    now = now or timezone.now()
    if conn.last_sync_attempt_at is None:
        return now
    return max(now, conn.last_sync_attempt_at + timedelta(minutes=conn.sync_interval_minutes))


def is_due(conn, now=None) -> bool:
    if not (conn.enabled and conn.auto_sync):
        return False
    if conn.last_sync_attempt_at is None:
        return True
    now = now or timezone.now()
    # Half a tick of slack: a sync stamped just after a tick is due on the
    # tick one interval later, not the one after that.
    cutoff = (
        conn.last_sync_attempt_at
        + timedelta(minutes=conn.sync_interval_minutes)
        - timedelta(seconds=TICK_SECONDS // 2)
    )
    return now >= cutoff


def _claim_ttl(conn) -> int:
    return max(JOB_TIMEOUT, conn.sync_interval_minutes * 60)


def dispatch(now=None) -> dict:
    """Enqueue every due connection's sync for this tick. Returns counts for
    the run log: ``{connections, due, enqueued, claimed}``, plus
    ``enabled: False`` when no connection has auto sync on."""
    from integrations.toggles import integration_enabled

    from .models import OxidizedConnection

    now = now or timezone.now()
    out = {"connections": 0, "due": 0, "enqueued": 0, "claimed": 0}
    rows = list(
        OxidizedConnection.objects.filter(
            enabled=True, auto_sync=True, tenant__is_active=True
        ).select_related("tenant")
    )
    if not rows:
        out["enabled"] = False
        return out
    redis = queue = None
    switched_on: dict = {}
    for conn in rows:
        if conn.tenant_id not in switched_on:
            switched_on[conn.tenant_id] = integration_enabled(conn.tenant, "oxidized")
        if not switched_on[conn.tenant_id]:
            continue
        out["connections"] += 1
        if not is_due(conn, now):
            continue
        out["due"] += 1
        if redis is None:
            redis, queue = _conn(), _queue()
        if not redis.set(claim_key(conn.id), "1", nx=True, ex=_claim_ttl(conn)):
            out["claimed"] += 1
            continue
        queue.enqueue(
            run_scheduled_sync, str(conn.id), str(conn.tenant_id), job_timeout=JOB_TIMEOUT
        )
        out["enqueued"] += 1
    return out


def run_scheduled_sync(connection_id, tenant_id) -> str:
    """The RQ job: one connection's node sync. Returns a status for the
    worker log. Everything is re-read here - the connection may have been
    switched off, deleted or synced by hand since the enqueue."""
    from integrations.toggles import integration_enabled

    from .models import OxidizedConnection
    from .sync import record_sync_failure, sync_nodes

    try:
        conn = (
            OxidizedConnection.objects.filter(pk=connection_id, tenant_id=tenant_id)
            .select_related("tenant")
            .first()
        )
        if conn is None:
            return "gone"
        if not conn.tenant.is_active or not integration_enabled(conn.tenant, "oxidized"):
            return "skipped"
        if not (conn.enabled and conn.auto_sync):
            return "off"
        if not is_due(conn):
            return "not due"  # synced by hand since the enqueue
        try:
            summary = sync_nodes(conn)
        except Exception as exc:  # noqa: BLE001 - recorded on the connection
            log.exception("scheduled Oxidized sync of %s failed", conn.name)
            record_sync_failure(conn, str(exc) or exc.__class__.__name__)
            return "error"
        return "error" if summary.get("error") else "synced"
    finally:
        try:
            _conn().delete(claim_key(connection_id))
        except Exception:  # noqa: BLE001 - the claim expires on its own
            log.warning("oxidized sync %s: could not release the claim", connection_id)
