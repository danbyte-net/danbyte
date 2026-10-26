"""Danbyte's maintenance calendar, mirrored into PRTG as pauses.

A confirmed maintenance or outage window in Danbyte already owns a
:class:`~monitoring.models.Silence`; this pauses each PRTG device the
connection has linked to a device (or VM) the window covers, for the rest of
the window (``pauseobjectfor.htm``), so scheduling it once quiets both
systems. PRTG pauses the device's sensors with it ("paused by parent"), and
Danbyte reads paused as unknown while its own silence holds the alerts.

PRTG keeps one pause per object, so overlapping windows on one device are
written as their union: the earliest start, the latest end of every window
that overlaps the one open now. A window that has not started yet is not
written early - the reconcile runs on the status cadence and when a window
changes, and pauses the device once its window opens.

Reconciled, not event-sourced, and compared against what Danbyte last wrote
(on the link), never against PRTG's current shape. A device that is already
paused when its window opens - somebody paused it in PRTG - is left alone and
not recorded, so Danbyte never resumes a pause it did not make; and a resume
is only sent while the device is still paused with Danbyte's own message.
"""
from __future__ import annotations

import logging
import math

import django_rq
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from monitoring.external.beat import skip_reason
from monitoring.external.maintenance import desired_windows

from . import status as st
from .acks import MARKER, is_ours
from .client import PrtgClient, PrtgError
from .models import PrtgConnection, PrtgDeviceLink

log = logging.getLogger("prtg.maintenance")


def windows(conn) -> dict:
    """link id -> list of ``(start, end, event)`` for every open window that
    covers a device or VM the connection has linked."""
    links = list(PrtgDeviceLink.objects.filter(connection=conn))
    by_device = {lk.device_id: lk for lk in links if lk.device_id}
    by_vm = {lk.virtual_machine_id: lk for lk in links if lk.virtual_machine_id}
    out: dict = {}
    if not links:
        return out
    for event, device_ids in desired_windows(conn.tenant):
        start, end = event.silence.starts_at, event.silence.ends_at
        covered = [by_device[d] for d in device_ids if d in by_device]
        vm_ids = {
            str(v) for v in event.impacts.filter(
                object_type="api.virtualmachine"
            ).values_list("object_id", flat=True)
        }
        covered += [lk for vid, lk in by_vm.items() if str(vid) in vm_ids]
        for link in covered:
            out.setdefault(link.id, []).append((start, end, event))
    return out


def merged(spans, now):
    """The union of the windows that overlap the one open at ``now``:
    ``(start, end, events)``, or None when none is open. Chained overlaps
    count - 10-12 and 11-14 open at 10:30 pause until 14:00."""
    spans = sorted(spans, key=lambda s: s[0])
    group: list = []
    g_start = g_end = None
    for start, end, event in spans:
        if group and start <= g_end:
            g_end = max(g_end, end)
            group.append(event)
            continue
        if group and g_start <= now < g_end:
            break
        group, g_start, g_end = [event], start, end
    if group and g_start <= now < g_end:
        return g_start, g_end, group
    return None


def _minutes(until, now) -> int:
    return max(1, math.ceil((until - now).total_seconds() / 60))


def _pause_message(events) -> str:
    names = ", ".join(e.name for e in events)
    return f"{MARKER} Maintenance: {names}"[:255]


def _clear(link, note: str = "") -> None:
    link.maintenance_paused_at = None
    link.maintenance_paused_until = None
    link.maintenance_events = []
    link.maintenance_note = note[:255]
    link.save(update_fields=[
        "maintenance_paused_at", "maintenance_paused_until", "maintenance_events",
        "maintenance_note",
    ])


def reconcile(conn, *, client=None, now=None) -> dict:
    """Make PRTG's pauses match Danbyte's open windows for this connection."""
    now = now or timezone.now()
    client = client or PrtgClient.for_connection(conn)
    counts = {"paused": 0, "extended": 0, "resumed": 0, "left": 0, "failed": 0}
    wanted = {}
    for link_id, spans in windows(conn).items():
        window = merged(spans, now)
        if window is not None:
            wanted[link_id] = window

    # The links a window wants paused, and the ones Danbyte paused before.
    links = {
        lk.id: lk for lk in PrtgDeviceLink.objects.filter(connection=conn).filter(
            Q(id__in=list(wanted)) | Q(maintenance_paused_until__isnull=False)
        )
    }
    if not links:
        _stamp(conn, now)
        return counts
    # What PRTG says about each of them now: whether somebody paused it by
    # hand is a question about the present, not about the last read.
    try:
        live = {
            str(r["objid"]): r for r in client.devices(
                {"objid": sorted({lk.objid for lk in links.values()})}
            ).rows
        }
    except PrtgError as exc:
        # Nothing can be compared, so nothing is written.
        _stamp(conn, now)
        return {**counts, "error": str(exc)[:300]}

    for link in links.values():
        window = wanted.get(link.id)
        remote = live.get(link.objid)
        try:
            if window is None:
                _end(client, link, remote, now, counts)
            else:
                _hold(client, link, remote, window, now, counts)
        except PrtgError as exc:
            counts["failed"] += 1
            link.maintenance_note = str(exc)[:255]
            link.save(update_fields=["maintenance_note"])
            log.warning("prtg maintenance %s on %s failed: %s", conn.name, link.objid, exc)
    _stamp(conn, now)
    return counts


def _hold(client, link, remote, window, now, counts) -> None:
    """Keep the device paused until the merged window's end."""
    _start, end, events = window
    refs = [{"id": str(e.id), "name": e.name} for e in events]
    if link.maintenance_paused_until is None:
        if remote is None:
            link.maintenance_note = "PRTG no longer has this device."
            link.save(update_fields=["maintenance_note"])
            counts["left"] += 1
            return
        if remote.get("status_raw") in st.PAUSED:
            # Somebody else's pause. Not touched now, and - because nothing
            # is recorded - never resumed by Danbyte either.
            note = "Already paused in PRTG; left as it is."
            if link.maintenance_note != note:
                link.maintenance_note = note
                link.save(update_fields=["maintenance_note"])
            counts["left"] += 1
            return
        client.pause(int(link.objid), _pause_message(events), minutes=_minutes(end, now))
        link.maintenance_paused_at = now
        counts["paused"] += 1
    elif link.maintenance_paused_until == end and link.maintenance_events == refs:
        return
    else:
        # The window moved or another joined it. Only a pause that is still
        # Danbyte's is rewritten.
        if remote is not None and remote.get("status_raw") in st.PAUSED and not is_ours(
            remote.get("message", "")
        ):
            _clear(link, "Paused by somebody else in PRTG; left as it is.")
            counts["left"] += 1
            return
        client.pause(int(link.objid), _pause_message(events), minutes=_minutes(end, now))
        counts["extended"] += 1
    link.maintenance_paused_until = end
    link.maintenance_events = refs
    link.maintenance_note = ""
    link.save(update_fields=[
        "maintenance_paused_at", "maintenance_paused_until", "maintenance_events",
        "maintenance_note",
    ])


def _end(client, link, remote, now, counts) -> None:
    """No window wants the device paused any more."""
    if link.maintenance_paused_until <= now:
        # PRTG lifted a timed pause by itself at the end.
        _clear(link)
        return
    if remote is None:
        _clear(link, "PRTG no longer has this device.")
        return
    if remote.get("status_raw") in st.PAUSED and is_ours(remote.get("message", "")):
        client.resume(int(link.objid))
        counts["resumed"] += 1
        _clear(link)
        return
    # Resumed by hand, or paused again with somebody else's message: either
    # way it is no longer Danbyte's pause to lift.
    _clear(link, "" if remote.get("status_raw") not in st.PAUSED
           else "Paused by somebody else in PRTG; left as it is.")
    counts["left"] += 1


def _stamp(conn, now) -> None:
    conn.last_maintenance_sync_at = now
    conn.save(update_fields=["last_maintenance_sync_at"])


def run_maintenance_sync(connection_id: str) -> dict:
    """One connection's reconcile, as an RQ job. The switches are re-checked
    here, at run time."""
    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.sync_maintenance and conn.api_key_set):
        return {"skipped": "maintenance sync off"}
    try:
        counts = reconcile(conn)
    except Exception:
        # Stamp the attempt so a broken connection backs off to its interval
        # instead of being queued every minute.
        log.exception("prtg maintenance sync %s failed", conn.name)
        _stamp(conn, timezone.now())
        raise
    log.info("prtg maintenance sync %s: %s", conn.name, counts)
    return counts


def schedule_for_tenant(tenant_id) -> int:
    """Queue a reconcile for every connection of the tenant that mirrors
    windows - after commit, so the job reads the window as saved."""
    ids = list(
        PrtgConnection.objects.filter(
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


def window_changed(tenant_id) -> None:
    """Registered as the ``prtg`` window listener."""
    schedule_for_tenant(tenant_id)

