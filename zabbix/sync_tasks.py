"""The Zabbix sync beat.

Runs every minute from ``danbyte-zabbix-sync.timer`` and enqueues the
connections that are actually due, rather than syncing on the timer's cadence -
a Zabbix API is single-threaded per frontend node, and a minute is far too
often to be walking somebody's whole host list.

The tenant switch is re-checked **here, at run time**, not only when the job was
enqueued: a toggle flipped in between has to win, or Danbyte writes hosts into
a Zabbix somebody just switched off.
"""
from __future__ import annotations

import logging

import django_rq
from django.utils import timezone

from integrations.toggles import integration_enabled

from .models import ZabbixConnection

log = logging.getLogger("zabbix.sync")


def run_sync(connection_id: str) -> dict:
    """One connection's pass, as an RQ job."""
    from .provision import sync

    conn = ZabbixConnection.objects.filter(pk=connection_id).select_related(
        "tenant"
    ).first()
    if conn is None:
        return {"skipped": "gone"}
    # Re-checked at run time on purpose - see the module docstring.
    if not integration_enabled(conn.tenant, "zabbix"):
        return {"skipped": "integration off"}
    if conn.provision_mode == ZabbixConnection.OFF:
        return {"skipped": "provisioning off"}
    try:
        counts = sync(conn)
    except Exception as exc:
        # Stamp the attempt anyway. Without this a connection that fails for
        # any reason stays permanently due, and the every-minute beat re-queues
        # it forever - so one broken connection becomes a queue full of the
        # same broken job. Backing off to its own interval is the whole point
        # of having one.
        log.exception("zabbix sync %s failed", conn.name)
        conn.last_sync_at = timezone.now()
        conn.last_sync_summary = {"error": str(exc)[:500]}
        conn.save(update_fields=["last_sync_at", "last_sync_summary"])
        raise
    log.info("zabbix sync %s: %s", conn.name, counts)
    return counts


def enqueue_due_syncs(now=None) -> dict:
    """Queue every connection whose interval has elapsed - the provisioning
    pass, the maintenance reconcile and the host-status read, each on its
    own stamp."""
    from .maintenance import run_maintenance_sync
    from .status import run_status_sync

    now = now or timezone.now()
    queue = django_rq.get_queue("low")
    queued = maintenance = status = 0
    for conn in ZabbixConnection.objects.filter(enabled=True).select_related("tenant"):
        if not integration_enabled(conn.tenant, "zabbix"):
            continue
        if conn.auto_sync and conn.sync_due(now):
            queue.enqueue(run_sync, str(conn.id), job_timeout=900)
            queued += 1
        if conn.maintenance_due(now):
            queue.enqueue(run_maintenance_sync, str(conn.id), job_timeout=300)
            maintenance += 1
        if conn.status_due(now):
            queue.enqueue(run_status_sync, str(conn.id), job_timeout=300)
            status += 1
    return {"queued": queued, "maintenance": maintenance, "status": status}
