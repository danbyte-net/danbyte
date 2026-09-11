"""Danbyte's maintenance calendar, mirrored into Zabbix (#162 phase 5).

A confirmed window in Danbyte already owns a :class:`~monitoring.models.Silence`;
this writes the same window into Zabbix as a maintenance period over the hosts
this connection has linked, so scheduling it once quiets both systems.

Reconciled, not event-sourced: a pass derives what should exist from the
events, compares it with what was written, and creates, updates or deletes the
difference. That is what makes it safe to run on a timer, after an outage of
either side, and twice.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import django_rq
from django.db import transaction
from django.utils import timezone

from integrations.toggles import integration_enabled
from monitoring.models import MaintenanceEvent

from .client import ZabbixClient, ZabbixError
from .models import ZabbixConnection, ZabbixHostLink, ZabbixMaintenance

log = logging.getLogger("zabbix.maintenance")

#: Zabbix refuses a period shorter than this.
MIN_PERIOD = timedelta(minutes=5)


def _client(conn) -> ZabbixClient:
    return ZabbixClient(
        conn.api_url, (conn.credentials or {}).get("token", ""),
        verify_tls=conn.verify_tls,
    )


def period_name(event) -> str:
    """Unique in Zabbix and recognisable in both: the event's name plus a stub
    of its id, because two windows may share a name and Zabbix will not."""
    stub = str(event.id)[:8]
    return f"{event.name[: 128 - len(stub) - 3]} · {stub}"


def maintenance_payload(conn, *, name, since, till, hostids, description="") -> dict:
    """The write shape for one period.

    Hosts are objects from 6.4 and plain ids before, and a write with the
    wrong name is refused - so this is the one place the version is consulted,
    exactly as for proxies. ``maintenance_type`` 0 keeps data collection on:
    Zabbix goes on reading the host and suppresses the problems, which is what
    lets Danbyte keep showing a status through the window.
    """
    since_ts = int(since.timestamp())
    till_ts = int(max(till, since + MIN_PERIOD).timestamp())
    payload = {
        "name": name,
        "active_since": since_ts,
        "active_till": till_ts,
        "maintenance_type": 0,
        "description": (description or "")[:65535],
        "timeperiods": [
            {"timeperiod_type": 0, "start_date": since_ts, "period": till_ts - since_ts}
        ],
    }
    if conn.version_tuple() >= (6, 4):
        payload["hosts"] = [{"hostid": h} for h in hostids]
    else:
        payload["hostids"] = list(hostids)
    return payload


def desired(conn) -> dict:
    """event id -> (event, hostids) for every window this connection should
    hold.

    A window is wanted exactly when Danbyte silences for it. The silence's
    existence is that decision, already made once by the status and the
    impacts; its window is the one Danbyte itself honours, an open outage's
    rolling day included. Devices Zabbix does not know are simply not in the
    period - there is nothing to quiet.
    """
    links = dict(
        ZabbixHostLink.objects.filter(connection=conn).values_list("device_id", "hostid")
    )
    out: dict = {}
    if not links:
        return out
    events = (
        MaintenanceEvent.objects.filter(tenant=conn.tenant, silence__isnull=False)
        .select_related("silence", "status")
        .prefetch_related("silence__match_devices")
    )
    for event in events:
        if event.status.is_closed:
            continue
        hostids = sorted(
            {links[d.id] for d in event.silence.match_devices.all() if d.id in links}
        )
        if hostids:
            out[event.id] = (event, hostids)
    return out


def reconcile(conn, *, client=None) -> dict:
    """Make Zabbix's periods match Danbyte's windows for this connection.

    Compares against what Danbyte last wrote, not against Zabbix's current
    shape: a period somebody adjusted by hand in Zabbix stands until the
    Danbyte window itself changes. One somebody *deleted* by hand is noticed
    and written again, because the window still wants it.
    """
    client = client or _client(conn)
    counts = {"created": 0, "updated": 0, "deleted": 0, "failed": 0}
    now = timezone.now()
    wanted = desired(conn)
    rows = {r.event_id: r for r in ZabbixMaintenance.objects.filter(connection=conn)}

    try:
        existing = client.maintenances([r.maintenanceid for r in rows.values()])
    except ZabbixError as exc:
        # Nothing can be compared, so nothing is written. Say so on every row
        # rather than on none.
        ZabbixMaintenance.objects.filter(connection=conn).update(last_error=str(exc)[:500])
        _stamp(conn, now)
        return {**counts, "error": str(exc)[:500]}

    for event_id, (event, hostids) in wanted.items():
        row = rows.pop(event_id, None)
        since, till = event.silence.starts_at, event.silence.ends_at
        name = period_name(event)
        payload = maintenance_payload(
            conn, name=name, since=since, till=till, hostids=hostids,
            description=event.description,
        )
        try:
            if row is not None and row.maintenanceid in existing:
                if (
                    row.name == name and row.starts_at == since and row.ends_at == till
                    and list(row.hostids) == hostids and not row.last_error
                ):
                    continue
                client.update_maintenance(row.maintenanceid, payload)
                counts["updated"] += 1
            else:
                maintenanceid = client.create_maintenance(payload)
                if row is None:
                    row = ZabbixMaintenance(tenant=conn.tenant, connection=conn, event=event)
                row.maintenanceid = maintenanceid
                counts["created"] += 1
            row.name, row.starts_at, row.ends_at, row.hostids = name, since, till, hostids
            row.synced_at, row.last_error = now, ""
            row.save()
        except ZabbixError as exc:
            counts["failed"] += 1
            if row is None:
                row = ZabbixMaintenance(
                    tenant=conn.tenant, connection=conn, event=event, maintenanceid="",
                    name=name, starts_at=since, ends_at=till, hostids=hostids,
                )
            row.last_error = str(exc)[:500]
            row.save()

    # Whatever is left was written for a window that no longer wants it: the
    # event closed, was deleted, or lost every linked device.
    for row in rows.values():
        try:
            if row.maintenanceid in existing:
                client.delete_maintenances([row.maintenanceid])
                counts["deleted"] += 1
            row.delete()
        except ZabbixError as exc:
            counts["failed"] += 1
            row.last_error = str(exc)[:500]
            row.save(update_fields=["last_error"])

    _stamp(conn, now)
    return counts


def _stamp(conn, now) -> None:
    conn.last_maintenance_sync_at = now
    conn.save(update_fields=["last_maintenance_sync_at"])


def run_maintenance_sync(connection_id: str) -> dict:
    """One connection's reconcile, as an RQ job. The switches are re-checked
    here, at run time, for the same reason the provisioning pass does."""
    conn = (
        ZabbixConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    )
    if conn is None:
        return {"skipped": "gone"}
    if not integration_enabled(conn.tenant, "zabbix"):
        return {"skipped": "integration off"}
    if not (conn.enabled and conn.sync_maintenance and conn.token_set):
        return {"skipped": "maintenance sync off"}
    try:
        counts = reconcile(conn)
    except Exception:
        # Stamp the attempt so a broken connection backs off to its interval
        # instead of being re-queued every minute.
        log.exception("zabbix maintenance sync %s failed", conn.name)
        _stamp(conn, timezone.now())
        raise
    log.info("zabbix maintenance sync %s: %s", conn.name, counts)
    return counts


def schedule_for_tenant(tenant_id) -> int:
    """Queue a reconcile for every connection of the tenant that mirrors
    windows - after the surrounding transaction commits, so the job reads the
    window as saved and never a half-written one."""
    ids = list(
        ZabbixConnection.objects.filter(
            tenant_id=tenant_id, enabled=True, sync_maintenance=True
        ).values_list("id", flat=True)
    )
    if not ids:
        return 0

    def _go():
        queue = django_rq.get_queue("low")
        for cid in ids:
            queue.enqueue(run_maintenance_sync, str(cid), job_timeout=300)

    transaction.on_commit(_go)
    return len(ids)
