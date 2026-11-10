"""The running software version, read out of Oxidized backups (#451).

A configuration is never stored in Danbyte, so the version is read whenever
one passes through:

* **A config read** - opening the Configuration tab (or a diff against the
  current config) fetches the config from Oxidized; the version in it is
  recorded on the device or VM (:func:`oxidized.configs.current`).
* **A node sync** - after a connection's node sync, every confirmed link
  whose node Oxidized has backed up since the last read has its config
  fetched and read (:func:`read_versions`). The node's backup time comes
  from ``/nodes.json``; the last one read is remembered in the cache, so an
  unchanged backup is not fetched again.
* **The re-read** - ``manage.py extract_software_versions`` (and a platform's
  version pattern changing) fetches every confirmed link's config again
  (:func:`reextract_configs`).

The writer is :func:`api.software_versions.apply_config`: source
``oxidized``, never over a value a person typed or imported. A proposed link
serves nothing (#399), so it is never read either. The version change itself
starts the vulnerability recompute through the device/VM signals.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from django.core.cache import cache
from django.utils import timezone

log = logging.getLogger("oxidized.versions")

#: How long the backup time last read for a link is remembered.
MARK_TTL = 7 * 24 * 3600


def _mark_key(link) -> str:
    return f"oxidized:verread:v1:{link.tenant_id}:{link.id}"


def backup_time(node: dict) -> datetime | None:
    """When Oxidized last backed ``node`` up, from its ``/nodes.json`` row
    (``time``, else ``last.end``); None when it never has or it is unreadable."""
    last = node.get("last") if isinstance(node.get("last"), dict) else {}
    for raw in (node.get("time"), last.get("end")):
        when = _parse(raw)
        if when is not None and when.year > 1970:
            return when
    return None


def _parse(value) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if text.endswith(" UTC"):
        text = text[:-4] + " +0000"
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def note_config(link, text: str, now=None) -> bool:
    """Record the version in ``text`` (the link's current config) on the
    link's device or VM. Never raises: a config read must not fail on it."""
    from api.software_versions import apply_config
    from audit.context import cause

    if link is None or link.proposed:
        return False
    try:
        obj = link.target
        if obj is None or obj.tenant_id != link.tenant_id:
            return False
        with cause(f"Software version read from Oxidized node {link.full_name}"[:255]):
            return bool(apply_config(obj, text, now))
    except Exception:  # noqa: BLE001 - the config itself was served fine
        log.exception("oxidized: reading the version from %s failed", link.full_name)
        return False


def _links(conn, platform_id=None):
    from django.db.models import Q

    from .models import OxidizedNodeLink

    qs = OxidizedNodeLink.objects.filter(
        connection=conn, tenant_id=conn.tenant_id, proposed=False
    ).filter(
        Q(device__tenant_id=conn.tenant_id) | Q(virtual_machine__tenant_id=conn.tenant_id)
    ).select_related("connection", "device", "virtual_machine")
    if platform_id:
        qs = qs.filter(
            Q(device__platform_id=platform_id)
            | Q(device__platform__isnull=True, device__device_type__platform_id=platform_id)
            | Q(virtual_machine__platform_id=platform_id)
        )
    return qs


def read_versions(conn, *, force=False, platform_id=None, now=None) -> int:
    """Read the version from the config of every confirmed link of ``conn``
    that has a new backup (every one with ``force``). Returns the objects
    changed. A node Oxidized cannot serve is skipped, not fatal."""
    from api.software_versions import owned_by_person

    from .client import OxidizedClient, OxidizedError

    if not conn.enabled:
        return 0
    client = OxidizedClient.for_connection(conn)
    backups: dict[str, datetime | None] = {}
    if not force:
        try:
            for node in client.nodes():
                full = str(node.get("full_name") or node.get("name") or "").strip()
                if full:
                    backups[full] = backup_time(node)
        except OxidizedError as exc:
            log.warning("oxidized %s: no node list for the version read: %s", conn.name, exc)
            return 0
    now = now or timezone.now()
    changed = 0
    for link in _links(conn, platform_id):
        obj = link.target
        if obj is None or owned_by_person(obj):
            continue
        mark = None
        if not force:
            if link.full_name not in backups:
                continue  # the node has gone from Oxidized
            when = backups[link.full_name]
            mark = when.astimezone(UTC).isoformat() if when else ""
            try:
                if mark and cache.get(_mark_key(link)) == mark:
                    continue  # this backup was read already
            except Exception:  # noqa: BLE001 - Redis down: read it again
                pass
        try:
            text = client.fetch(link.node_name, link.node_group)
        except OxidizedError as exc:
            log.info("oxidized %s: %s not read: %s", conn.name, link.full_name, exc)
            continue
        if note_config(link, text, now):
            changed += 1
        if mark:
            try:
                cache.set(_mark_key(link), mark, MARK_TTL)
            except Exception:  # noqa: BLE001
                pass
    return changed


def _connections(tenant_id=None):
    from integrations.toggles import integration_enabled

    from .models import OxidizedConnection

    qs = OxidizedConnection.objects.filter(enabled=True, tenant__is_active=True).select_related(
        "tenant"
    )
    if tenant_id:
        qs = qs.filter(tenant_id=tenant_id)
    on: dict = {}
    for conn in qs:
        if conn.tenant_id not in on:
            on[conn.tenant_id] = integration_enabled(conn.tenant, "oxidized")
        if on[conn.tenant_id]:
            yield conn


def reextract_configs(tenant_id=None, platform_id=None) -> int:
    """Fetch and read every confirmed link's config again, for every enabled
    connection whose tenant has Oxidized switched on (all tenants, or one)."""
    n = 0
    for conn in _connections(tenant_id):
        n += read_versions(conn, force=True, platform_id=platform_id)
    return n


def run_read_versions(connection_id, tenant_id) -> int:
    """RQ job: the version read after a manual node sync. Re-checks the
    connection, its tenant and the integration switch."""
    for conn in _connections(tenant_id):
        if str(conn.id) == str(connection_id):
            return read_versions(conn)
    return 0


def enqueue_read_versions(conn) -> None:
    """Queue :func:`run_read_versions` once the transaction commits. Skipped
    when the queue is down: the next scheduled sync reads them."""
    from django.db import transaction

    conn_id, tenant_id = str(conn.id), str(conn.tenant_id)

    def push():
        from .schedule import _queue

        try:
            _queue().enqueue(run_read_versions, conn_id, tenant_id, job_timeout=1800)
        except Exception:  # noqa: BLE001 - Redis down
            log.warning("RQ unavailable; version read for connection %s skipped", conn_id)

    transaction.on_commit(push)
