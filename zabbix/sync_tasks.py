"""The Zabbix sync beat.

Runs every minute from ``danbyte-zabbix-sync.timer`` and enqueues the
connections that are actually due, rather than syncing on the timer's cadence -
a Zabbix API is single-threaded per frontend node, and a minute is far too
often to be walking somebody's whole host list.

The tenant switch is re-checked **here, at run time**, not only when the job was
enqueued: a toggle flipped in between has to win, or Danbyte writes hosts into
a Zabbix somebody just switched off. A deactivated tenant is skipped the same
way, at both ends.

The loop and the re-check are shared with every external monitor
(:mod:`monitoring.external.beat`); Zabbix is registered on that beat with its
own timer, so ``extmon_sync`` never doubles it.
"""
from __future__ import annotations

import logging

import django_rq
from django.utils import timezone

from monitoring.external.beat import BeatTask, enqueue_due, skip_reason

from .models import ZabbixConnection

log = logging.getLogger("zabbix.sync")


def run_sync(connection_id: str) -> dict:
    """One connection's pass, as an RQ job."""
    from .provision import sync

    conn = ZabbixConnection.objects.filter(pk=connection_id).select_related(
        "tenant"
    ).first()
    # Re-checked at run time on purpose - see the module docstring.
    reason = skip_reason(conn, "zabbix")
    if reason:
        return {"skipped": reason}
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
    tasks = (
        BeatTask("queued", lambda c, at: c.auto_sync and c.sync_due(at), run_sync, 900),
        BeatTask("maintenance", lambda c, at: c.maintenance_due(at), run_maintenance_sync),
        BeatTask("status", lambda c, at: c.status_due(at), run_status_sync),
    )
    return enqueue_due(
        ZabbixConnection.objects.filter(
            enabled=True, tenant__is_active=True
        ).select_related("tenant"),
        "zabbix",
        tasks,
        queue=django_rq.get_queue("low"),
        now=now,
    )
