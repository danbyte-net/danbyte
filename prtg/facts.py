"""What PRTG's system information says about a linked device, offered to the
drift inbox.

PRTG reads a device's system information (over WMI, SNMP or SSH, about once
a day, where it has credentials) and serves it as
``table.json?content=sysinfo``. The ``system`` category is a list of
key/value rows - "Bios Serial Number", "Windows Version", and for SNMP kit
the system group. This module reads it for a batch of linked devices per
pass, oldest first, into :class:`~prtg.models.PrtgHostFacts`; the drift
engine reads those through the ``prtg`` observation source, below Danbyte's
own poll. Name and serial are offered as drift; vendor, model and OS are
recorded for context. A device PRTG has no system information for is
recorded as looked-at with nothing to say.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db.models import F, Q
from django.utils import timezone

from monitoring.external.beat import skip_reason

from .client import PrtgClient, PrtgError
from .models import PrtgConnection, PrtgDeviceLink, PrtgHostFacts

log = logging.getLogger("prtg.facts")

#: Links read per pass: one call each against PRTG's web server.
BATCH = 50
#: How old a link's facts must be before the pass reads them again. PRTG
#: itself refreshes system information about once a day.
REFRESH_HOURS = 12

#: Lower-cased sysinfo key (trailing colon dropped) -> the observation key.
KEYS = {
    "bios serial number": "serial",
    "serial number": "serial",
    "serialnumber": "serial",
    "serial": "serial",
    "system serial number": "serial",
    "chassis serial number": "serial",
    "sysname": "sys_name",
    "host name": "sys_name",
    "hostname": "sys_name",
    "computer name": "sys_name",
    "dns host name": "sys_name",
    "system name": "sys_name",
    "vendor": "vendor",
    "manufacturer": "vendor",
    "system manufacturer": "vendor",
    "model": "model",
    "system model": "model",
    "product name": "model",
    "windows version": "os",
    "operating system": "os",
    "os": "os",
    "sysdescr": "os",
}


def facts_from_sysinfo(rows) -> dict:
    """The observation PRTG's ``system`` rows amount to. The first value for
    a key wins; empty values say nothing."""
    out: dict = {}
    for row in rows or ():
        key = KEYS.get((row.get("key") or "").strip().rstrip(":").strip().lower())
        value = (row.get("value") or "").strip()
        if key and value and key not in out:
            out[key] = value[:255]
    return out


def record(conn, link, rows, now=None) -> PrtgHostFacts:
    """Store what PRTG says about the link's device. Never touches it."""
    now = now or timezone.now()
    facts, _ = PrtgHostFacts.objects.update_or_create(
        link=link,
        defaults={
            "tenant": conn.tenant, "connection": conn,
            "device_id": link.device_id, "virtual_machine_id": link.virtual_machine_id,
            "data": facts_from_sysinfo(rows), "polled_at": now,
            # A paused device is not being read; what it said is not now.
            "reachable": not link.paused,
        },
    )
    return facts


def due_links(conn, now, limit=BATCH) -> list:
    """The links whose facts are missing or oldest, up to ``limit``."""
    cutoff = now - timedelta(hours=REFRESH_HOURS)
    stale = (
        Q(facts__isnull=True) | Q(facts__polled_at__isnull=True)
        | Q(facts__polled_at__lt=cutoff)
    )
    return list(
        PrtgDeviceLink.objects.filter(connection=conn).filter(stale)
        .order_by(F("facts__polled_at").asc(nulls_first=True), "name")[:limit]
    )


def read_inventory(conn, *, client=None, now=None, limit=BATCH) -> dict:
    """One inventory pass: system information for the stalest links."""
    now = now or timezone.now()
    client = client or PrtgClient.for_connection(conn)
    counts = {"read": 0, "empty": 0, "failed": 0}
    for link in due_links(conn, now, limit):
        try:
            rows = client.sysinfo(int(link.objid))
        except PrtgError as exc:
            counts["failed"] += 1
            log.info("prtg sysinfo %s on %s: %s", conn.name, link.objid, exc)
            continue
        facts = record(conn, link, rows, now)
        counts["read" if facts.data else "empty"] += 1
    return counts


def _stamp(conn, now) -> None:
    conn.last_inventory_at = now
    conn.save(update_fields=["last_inventory_at"])


def run_inventory_read(connection_id: str) -> dict:
    """The inventory pass as an RQ job; the switches are re-checked here."""
    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.read_inventory and conn.api_key_set):
        return {"skipped": "inventory off"}
    now = timezone.now()
    try:
        counts = read_inventory(conn, now=now)
    except Exception:
        log.exception("prtg inventory %s failed", conn.name)
        _stamp(conn, now)
        raise
    _stamp(conn, now)
    return counts


def observed_state(device, tenant):
    """The drift engine's loader: the newest facts for the device from a
    connection still asking for them, or None. Turning the switch off stops
    the opinions rather than leaving the last ones standing."""
    return (
        PrtgHostFacts.objects.filter(
            device=device, tenant=tenant, connection__read_inventory=True,
            connection__enabled=True,
        )
        .order_by("-polled_at")
        .first()
    )
