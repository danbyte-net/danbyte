"""What Zabbix says about the hosts Danbyte has linked (#162 phase 7).

A Zabbix *check* answers for an address on a schedule and folds into
Danbyte's own status. This is the other thing an operator asked for: "if it
is in Zabbix, show it" - on the device page, beside Danbyte's status, whether
or not a check exists, whether or not provisioning is on. Read-only, on its
own cadence, behind its own switch. Nothing here changes a Danbyte status;
the panel is a window onto the other system, not a second opinion folded
into the first.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from integrations.toggles import integration_enabled

from . import facts
from .client import ZabbixClient, ZabbixError
from .models import ZabbixConnection, ZabbixHostLink

log = logging.getLogger("zabbix.status")

#: ``host.get`` with a thousand ids in one filter is fine for Zabbix but not
#: for the request size some proxies allow in front of it.
CHUNK = 500


def _client(conn) -> ZabbixClient:
    return ZabbixClient(
        conn.api_url, (conn.credentials or {}).get("token", ""),
        verify_tls=conn.verify_tls,
    )


def refresh_host_status(conn: ZabbixConnection, now=None) -> dict:
    """One pass: every link's host in chunks, every host's problems in one
    call, one facts row per link. A host Zabbix no longer has gets its
    counts cleared and its link left standing."""
    now = now or timezone.now()
    links = list(
        ZabbixHostLink.objects.filter(connection=conn).select_related("device")
    )
    if not links:
        _stamp(conn, now)
        return {"hosts": 0, "gone": 0, "problems": 0}
    client = _client(conn)
    hosts: dict = {}
    ids = [link.hostid for link in links]
    for i in range(0, len(ids), CHUNK):
        hosts.update(client.hosts_by_id(ids[i:i + CHUNK]))
    problems = client.problems_by_host(list(hosts)) if hosts else {}

    seen = gone = total = 0
    for link in links:
        host = hosts.get(str(link.hostid))
        if host is None:
            facts.clear_status(conn, link.device, now)
            gone += 1
            continue
        open_problems = problems.get(str(link.hostid)) or []
        facts.record_status(conn, link.device, host, open_problems, now)
        seen += 1
        total += len(open_problems)
    _stamp(conn, now)
    return {"hosts": seen, "gone": gone, "problems": total}


def _stamp(conn, now) -> None:
    conn.last_status_sync_at = now
    conn.save(update_fields=["last_status_sync_at"])


def run_status_sync(connection_id: str) -> dict:
    """One connection's read, as an RQ job. The switches are re-checked here,
    at run time, like every other Zabbix job."""
    conn = (
        ZabbixConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    )
    if conn is None:
        return {"skipped": "gone"}
    if not integration_enabled(conn.tenant, "zabbix"):
        return {"skipped": "integration off"}
    if not (conn.enabled and conn.read_host_status and conn.token_set):
        return {"skipped": "host status off"}
    try:
        counts = refresh_host_status(conn)
    except ZabbixError as exc:
        # Stamp the attempt so a broken connection backs off to its interval
        # instead of being re-queued every minute.
        log.warning("zabbix host status %s failed: %s", conn.name, exc)
        _stamp(conn, timezone.now())
        return {"error": str(exc)[:300]}
    except Exception:
        log.exception("zabbix host status %s failed", conn.name)
        _stamp(conn, timezone.now())
        raise
    log.info("zabbix host status %s: %s", conn.name, counts)
    return counts
