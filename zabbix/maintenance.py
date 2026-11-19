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
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import django_rq
from django.db import connection as db_connection
from django.db import transaction
from django.utils import timezone

from monitoring.external.beat import skip_reason
from monitoring.external.maintenance import desired_for_links

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


#: ``active_till`` for a repeating window with no end: Zabbix keeps it as a
#: 32-bit timestamp.
OPEN_END = datetime(2038, 1, 1, tzinfo=UTC)


def _server_start(rule, zone, now) -> tuple[int, int]:
    """``(start_time seconds, day shift)`` of a rule's start in the server's
    ``zone``, read off the next occurrence from ``now``.

    A Zabbix period is a fixed wall-clock time in the server's zone, while the
    event's start is fixed in its own. Where the two zones change clocks on
    different dates (or one has none), the converted time is right for the
    occurrences around ``now`` and off by the difference for the rest of that
    stretch; each pass converts again, so a pass after a clock change writes
    the new time.
    """
    from datetime import timedelta as td

    ref = max(now, rule.valid_from)
    starts = [s for s, _e in rule._raw(ref, ref + td(days=8)) if s >= ref]
    if not starts:
        starts = [s for s, _e in rule._raw(ref - td(days=8), ref + td(days=1))] or [
            rule._start_on(ref.astimezone(rule.zone).date())]
        start = starts[-1]
    else:
        start = starts[0]
    here = start.astimezone(rule.zone)
    there = start.astimezone(zone)
    shift = (there.date() - here.date()).days
    return there.hour * 3600 + there.minute * 60, shift


def recurring_timeperiods(event, *, server_zone: str = "", now=None) -> list:
    """The Zabbix ``timeperiods`` for a repeating event: one daily (type 2)
    or weekly (type 3, ``dayofweek`` bits) period at the start time, in
    seconds. Empty for a one-off window.

    Zabbix reads ``start_time`` in its own server's time zone. Without
    ``server_zone`` (the connection's *Server time zone* left blank) the
    event's zone is taken to be that one. With it, the start is converted to
    the server's zone at the offset of the next occurrence from ``now``, and
    a weekly period's days move with it when the conversion crosses midnight.
    """
    from zoneinfo import ZoneInfo

    from monitoring.recurrence import DAILY, weekday_mask

    rule = event.rule
    if rule is None:
        return []
    start_time = rule.start_time.hour * 3600 + rule.start_time.minute * 60
    shift = 0
    try:
        zone = ZoneInfo(server_zone) if server_zone else None
    except (ValueError, KeyError, OSError):
        zone = None  # validated on write; a zone the host lost reads as blank
    if zone is not None:
        if zone.key != getattr(rule.zone, "key", None):
            start_time, shift = _server_start(rule, zone, now or timezone.now())
    period = {
        "timeperiod_type": 2 if rule.freq == DAILY else 3,
        "every": 1,
        "start_time": start_time,
        "period": int(rule.duration.total_seconds()),
    }
    if rule.freq != DAILY:
        period["dayofweek"] = weekday_mask((int(d) + shift) % 7 for d in rule.weekdays)
    return [period]


def maintenance_payload(
    conn, *, name, since, till, hostids, description="", timeperiods=None
) -> dict:
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
        "timeperiods": timeperiods or [
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
    period - there is nothing to quiet. The selection is shared
    (:func:`monitoring.external.maintenance.desired_for_links`).
    """
    links = dict(
        ZabbixHostLink.objects.filter(connection=conn).values_list("device_id", "hostid")
    )
    return desired_for_links(conn.tenant, links)


def _already_exists(exc) -> bool:
    return "already exists" in str(exc).lower()


def reconcile(conn, *, client=None, dry_run=False, report=None) -> dict:
    """Make Zabbix's periods match Danbyte's windows for this connection.

    Compares against what Danbyte last wrote, not against Zabbix's current
    shape: a period somebody adjusted by hand in Zabbix stands until the
    Danbyte window itself changes. One somebody *deleted* by hand is noticed
    and written again, because the window still wants it.

    A row whose id is missing or no longer exists is matched by name before
    anything is created: the name carries the event id and Zabbix keeps names
    unique, so a period an earlier pass wrote but never recorded (a lost
    response, a second pass racing the first) is adopted and updated rather
    than created twice - and taken out when the window is gone.

    ``dry_run`` reads only and writes nothing on either side; ``report``, a
    list, collects one ``(verb, name, detail)`` per row touched. Callers that
    write go through :func:`reconcile_locked`.
    """
    client = client or _client(conn)
    counts = {"created": 0, "updated": 0, "deleted": 0, "adopted": 0, "failed": 0}
    now = timezone.now()
    wanted = desired(conn)
    rows = {r.event_id: r for r in ZabbixMaintenance.objects.filter(connection=conn)}

    def note(verb, name, detail=""):
        if report is not None:
            report.append((verb, name, detail))

    try:
        existing = client.maintenances([r.maintenanceid for r in rows.values()])
        # Every name that has no live id: the windows about to be created and
        # the rows that lost theirs. One read for all of them.
        orphans = [r.name for r in rows.values() if r.maintenanceid not in existing]
        fresh = [
            period_name(event) for event_id, (event, _h) in wanted.items()
            if event_id not in rows or rows[event_id].maintenanceid not in existing
        ]
        by_name = client.maintenances_by_name(orphans + fresh)
    except ZabbixError as exc:
        # Nothing can be compared, so nothing is written. Say so on every row
        # rather than on none.
        if not dry_run:
            ZabbixMaintenance.objects.filter(connection=conn).update(
                last_error=str(exc)[:500]
            )
            _stamp(conn, now)
        return {**counts, "error": str(exc)[:500]}

    for event_id, (event, hostids) in wanted.items():
        row = rows.pop(event_id, None)
        # A one-off window is its silence; a repeating one is a single period
        # over its whole validity, repeating on Zabbix's side, while its
        # silence moves from occurrence to occurrence.
        periods = recurring_timeperiods(
            event, server_zone=conn.server_timezone, now=now
        )
        if periods:
            since, till = event.starts_at, event.ends_at or OPEN_END
        else:
            since, till = event.silence.starts_at, event.silence.ends_at
        name = period_name(event)
        payload = maintenance_payload(
            conn, name=name, since=since, till=till, hostids=hostids,
            description=event.description, timeperiods=periods,
        )
        try:
            if row is not None and row.maintenanceid in existing:
                if (
                    row.name == name and row.starts_at == since and row.ends_at == till
                    and list(row.hostids) == hostids and not row.last_error
                    and list(row.timeperiods or []) == periods
                ):
                    continue
                if not dry_run:
                    client.update_maintenance(row.maintenanceid, payload)
                maintenanceid, verb = row.maintenanceid, "updated"
            else:
                found = by_name.get(name) or (row is not None and by_name.get(row.name))
                if found:
                    maintenanceid, verb = str(found["maintenanceid"]), "adopted"
                    if not dry_run:
                        client.update_maintenance(maintenanceid, payload)
                elif dry_run:
                    maintenanceid, verb = "", "created"
                else:
                    maintenanceid, adopted = _create(client, payload, name)
                    verb = "adopted" if adopted else "created"
            counts[verb] += 1
            note(verb, name, maintenanceid)
            if dry_run:
                continue
            if row is None:
                row = ZabbixMaintenance(tenant=conn.tenant, connection=conn, event=event)
            row.maintenanceid = maintenanceid
            row.name, row.starts_at, row.ends_at, row.hostids = name, since, till, hostids
            row.timeperiods = periods
            row.synced_at, row.last_error = now, ""
            row.save()
        except ZabbixError as exc:
            counts["failed"] += 1
            note("failed", name, str(exc)[:500])
            if dry_run:
                continue
            # The row records the refusal for the table. Its id stays empty,
            # which never blocks a later pass: that pass looks the name up
            # first.
            if row is None:
                row = ZabbixMaintenance(
                    tenant=conn.tenant, connection=conn, event=event, maintenanceid="",
                    name=name, starts_at=since, ends_at=till, hostids=hostids,
                    timeperiods=periods,
                )
            row.last_error = str(exc)[:500]
            row.save()

    # Whatever is left was written for a window that no longer wants it: the
    # event closed, was deleted, or lost every linked device. A row without a
    # live id still takes its period out if one of that name exists.
    for row in rows.values():
        try:
            if row.maintenanceid in existing:
                target = row.maintenanceid
            elif row.name in by_name:
                target = str(by_name[row.name]["maintenanceid"])
                counts["adopted"] += 1
                note("adopted", row.name, target)
            else:
                target = ""
            if target:
                if not dry_run:
                    client.delete_maintenances([target])
                counts["deleted"] += 1
                note("deleted", row.name, target)
            if not dry_run:
                row.delete()
        except ZabbixError as exc:
            counts["failed"] += 1
            note("failed", row.name, str(exc)[:500])
            if not dry_run:
                row.last_error = str(exc)[:500]
                row.save(update_fields=["last_error"])

    if not dry_run:
        _stamp(conn, now)
    return counts


def _create(client, payload, name) -> tuple[str, bool]:
    """Create the period - or, when Zabbix says one of that name already
    exists (the answer a pass gets when another wrote it first), adopt and
    update that one. ``(id, adopted)``."""
    try:
        maintenanceid = client.create_maintenance(payload)
    except ZabbixError as exc:
        if not _already_exists(exc):
            raise
        found = client.maintenances_by_name([name]).get(name)
        if not found:
            raise
        maintenanceid = str(found["maintenanceid"])
        client.update_maintenance(maintenanceid, payload)
        return maintenanceid, True
    if not maintenanceid:
        raise ZabbixError("Zabbix created the period but returned no id.")
    return maintenanceid, False


def _stamp(conn, now) -> None:
    conn.last_maintenance_sync_at = now
    conn.save(update_fields=["last_maintenance_sync_at"])


# ── one pass at a time ─────────────────────────────────────────────────
#
# Two passes over one connection both see a window without a period and both
# create it; Zabbix keeps one and refuses the other. So a pass holds a
# Postgres advisory lock keyed by the connection - shared by the web process,
# every RQ worker and the repair command, and released by Postgres itself if
# the process holding it dies. It is a session lock rather than a
# transaction's: a pass talks to Zabbix for a while and must not hold a
# transaction open for it.

#: Advisory-lock class for the maintenance pass (the key is the connection).
LOCK_CLASS = 0x5A4D  # "ZM"
#: How long a queued pass waits for a running one before it re-queues.
LOCK_WAIT = 120
#: Marker that a pass is queued and not started, so a second is not queued.
QUEUED_KEY = "zabbix:maintenance-queued:{}"
QUEUED_TTL = 900


def _lock_key(connection_id) -> int:
    # Signed 32-bit: what the two-int form takes. Two connections sharing a
    # key merely take turns.
    v = uuid.UUID(str(connection_id)).int & 0xFFFFFFFF
    return v - (1 << 32) if v >= (1 << 31) else v


@contextmanager
def connection_lock(connection_id, *, wait: float = 0):
    """Hold the pass lock for a connection; yields whether it was taken.

    ``wait`` is how long to keep trying; 0 tries once.
    """
    key = _lock_key(connection_id)
    deadline = time.monotonic() + wait
    with db_connection.cursor() as cur:
        while True:
            cur.execute("SELECT pg_try_advisory_lock(%s, %s)", [LOCK_CLASS, key])
            got = bool(cur.fetchone()[0])
            if got or time.monotonic() >= deadline:
                break
            time.sleep(0.5)
    try:
        yield got
    finally:
        if got:
            try:
                with db_connection.cursor() as cur:
                    cur.execute("SELECT pg_advisory_unlock(%s, %s)", [LOCK_CLASS, key])
            except Exception:  # noqa: BLE001 - a dropped connection already released it
                log.warning("could not release the maintenance lock for %s", connection_id)


def is_running(connection_id) -> bool:
    """Whether a pass holds the lock right now (from any process)."""
    with connection_lock(connection_id) as got:
        return not got


def reconcile_locked(conn, *, client=None, wait: float = 0, **kwargs) -> dict | None:
    """:func:`reconcile` under the connection's lock; None if another pass
    held it for longer than ``wait``."""
    with connection_lock(conn.pk, wait=wait) as got:
        if not got:
            return None
        return reconcile(conn, client=client, **kwargs)


def _queue():
    return django_rq.get_queue("low")


def is_queued(connection_id, queue=None) -> bool:
    try:
        return bool((queue or _queue()).connection.exists(QUEUED_KEY.format(connection_id)))
    except Exception:  # noqa: BLE001 - Redis down: nothing is queued either
        return False


def enqueue_maintenance_sync(connection_id, *, queue=None, timeout=300) -> bool:
    """Queue a pass unless one is already queued and not started. True when
    this call queued it.

    A pass that is *running* does not stop another being queued: the window
    may have changed after it read it, and the queued one waits for it.
    """
    queue = queue or _queue()
    key = QUEUED_KEY.format(connection_id)
    try:
        if not queue.connection.set(key, "1", nx=True, ex=QUEUED_TTL):
            return False
    except Exception:  # noqa: BLE001 - without the marker, queue anyway
        log.warning("could not mark the maintenance sync of %s queued", connection_id)
    queue.enqueue(run_maintenance_sync, str(connection_id), job_timeout=timeout)
    return True


def _clear_queued(connection_id) -> None:
    try:
        _queue().connection.delete(QUEUED_KEY.format(connection_id))
    except Exception:  # noqa: BLE001
        pass


def run_maintenance_sync(connection_id: str) -> dict:
    """One connection's reconcile, as an RQ job. The switches are re-checked
    here, at run time, for the same reason the provisioning pass does."""
    # Started: a change from here on needs a pass of its own.
    _clear_queued(connection_id)
    conn = (
        ZabbixConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    )
    reason = skip_reason(conn, "zabbix")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.sync_maintenance and conn.token_set):
        return {"skipped": "maintenance sync off"}
    try:
        counts = reconcile_locked(conn, wait=LOCK_WAIT)
    except Exception:
        # Stamp the attempt so a broken connection backs off to its interval
        # instead of being re-queued every minute.
        log.exception("zabbix maintenance sync %s failed", conn.name)
        _stamp(conn, timezone.now())
        raise
    if counts is None:
        # Another pass is still going. It may have read the windows before
        # the change that queued this one, so go again after it.
        enqueue_maintenance_sync(connection_id)
        return {"skipped": "already running"}
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
        queue = _queue()
        for cid in ids:
            enqueue_maintenance_sync(cid, queue=queue)

    transaction.on_commit(_go)
    return len(ids)
