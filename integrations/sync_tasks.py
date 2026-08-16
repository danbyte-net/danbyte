"""Scheduling glue for the external syncs (Windows DHCP/DNS, virtualization).

The beat (``manage.py external_sync``, driven by ``danbyte-external-sync.timer``)
selects due, enabled connections whose tenant has the matching toggle on and
enqueues one RQ job each on the ``low`` queue. Jobs re-check enablement at run
time — a toggle flipped between enqueue and execution wins.
"""
from __future__ import annotations

import logging

import django_rq
from django.utils import timezone

from .toggles import integration_enabled

logger = logging.getLogger("danbyte.external_sync")


def run_windows_sync(conn_id: str) -> dict:
    """RQ job: full sync of one Windows connection (DHCP now, DNS when on)."""
    from .dhcp_sync import record_sync_failure, sync_dhcp
    from .models import WindowsServerConnection

    conn = WindowsServerConnection.objects.filter(id=conn_id).first()
    if conn is None or not conn.enabled:
        return {"skipped": "gone-or-disabled"}
    result: dict = {}
    try:
        if conn.dhcp_enabled and integration_enabled(conn.tenant, "dhcp"):
            result["dhcp"] = sync_dhcp(conn)
        if conn.dns_enabled and integration_enabled(conn.tenant, "dns"):
            from .dns_sync import sync_dns

            result["dns"] = sync_dns(conn)
    except Exception as exc:  # noqa: BLE001 — the row carries the error
        record_sync_failure(conn, exc)
        logger.warning("windows sync %s failed: %s", conn.name, exc)
        return {"error": str(exc)}
    return result


def _due(row, now) -> bool:
    if row.last_sync_at is None:
        return True
    interval = max(int(row.poll_interval_minutes or 5), 1)
    return (now - row.last_sync_at).total_seconds() >= interval * 60


def enqueue_due_syncs() -> dict:
    """Called by the beat: enqueue every due connection. Returns counts."""
    from .models import WindowsServerConnection

    now = timezone.now()
    queued = 0
    q = django_rq.get_queue("low")
    for conn in WindowsServerConnection.objects.filter(enabled=True).select_related(
        "tenant"
    ):
        wants = (
            (conn.dhcp_enabled and integration_enabled(conn.tenant, "dhcp"))
            or (conn.dns_enabled and integration_enabled(conn.tenant, "dns"))
        )
        if wants and _due(conn, now):
            q.enqueue(run_windows_sync, str(conn.id), job_timeout=600)
            queued += 1
    return {"windows_queued": queued, "virt_queued": enqueue_due_virt_syncs()}


def run_virt_sync(source_id: str) -> dict:
    """RQ job: sync one virtualization source (Proxmox for now)."""
    from .models import VirtualizationSource
    from .virt_sync import record_virt_failure, sync_proxmox

    source = VirtualizationSource.objects.filter(id=source_id).first()
    if source is None or not source.enabled:
        return {"skipped": "gone-or-disabled"}
    if not integration_enabled(source.tenant, "virtualization"):
        return {"skipped": "toggle-off"}
    try:
        return sync_proxmox(source)
    except Exception as exc:  # noqa: BLE001 — the row carries the error
        record_virt_failure(source, exc)
        logger.warning("virt sync %s failed: %s", source.name, exc)
        return {"error": str(exc)}


def enqueue_due_virt_syncs() -> int:
    from .models import VirtualizationSource

    now = timezone.now()
    queued = 0
    q = django_rq.get_queue("low")
    for source in VirtualizationSource.objects.filter(enabled=True).select_related(
        "tenant"
    ):
        # manual sources only sync on demand — the beat leaves them alone.
        if source.sync_mode == "manual":
            continue
        if integration_enabled(source.tenant, "virtualization") and _due(source, now):
            q.enqueue(run_virt_sync, str(source.id), job_timeout=600)
            queued += 1
    return queued
