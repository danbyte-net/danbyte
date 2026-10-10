"""Pair Oxidized nodes with Danbyte devices.

Oxidized knows a node by a name, an address and a model - no serial. So the
ladder is shorter than Zabbix's (:mod:`zabbix.matching`), with the same rule
at every rung: **one candidate or none**.

1. **A pinned link.** Set by an admin, kept across every pass.
2. **An address.** The node's ``ip`` is an address Danbyte has recorded on the
   device - its primary or any assigned address.
3. **The name.** Case-insensitive, the full name first, then the host part of
   an FQDN (``core1.example.net`` finds a device called ``core1``).

The connection's ``match_by`` turns rung 2 or 3 off. Where a rung finds two
devices, or two nodes land on one device, nothing is linked and the node is
listed as unmatched with the reason - a node paired with the wrong device
shows one box's configuration under another's name, and nothing downstream
would notice.
"""
from __future__ import annotations

import ipaddress

from django.db import transaction
from django.utils import timezone

from api.models import Device, IPAddress

from .client import OxidizedClient, OxidizedError
from .models import OxidizedConnection, OxidizedNodeLink

#: How many unmatched nodes the summary keeps for the mapping page.
UNMATCHED_LIMIT = 1000


def split_full_name(node: dict) -> tuple[str, str, str]:
    """``(full_name, name, group)`` from a ``/nodes.json`` row.

    ``group`` comes from ``full_name`` rather than the ``group`` key, because
    oxidized-web fills a missing group in as ``"default"`` for display, and
    asking for ``default/<name>`` would not find a node that has no group.
    """
    name = str(node.get("name") or "").strip()
    full = str(node.get("full_name") or name).strip()
    group = full.rpartition("/")[0] if "/" in full else ""
    return full, name, group


def _ip(value) -> str:
    text = str(value or "").split("/")[0].strip()
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return ""


def _short(name: str) -> str:
    """The host part of an FQDN; '' when there is none or it is an address."""
    if "." not in name or _ip(name):
        return ""
    return name.split(".", 1)[0]


def _device_index(tenant):
    by_addr: dict[str, set] = {}
    by_name: dict[str, set] = {}
    by_short: dict[str, set] = {}
    devices = {}
    for dev in Device.objects.filter(tenant=tenant).only("id", "name"):
        devices[dev.id] = dev
        name = (dev.name or "").strip().lower()
        if name:
            by_name.setdefault(name, set()).add(dev.id)
            short = _short(name)
            if short:
                by_short.setdefault(short, set()).add(dev.id)
    rows = IPAddress.objects.filter(
        tenant=tenant, assigned_device__isnull=False
    ).values_list("assigned_device_id", "ip_address")
    for dev_id, addr in rows:
        ip = _ip(addr)
        if ip:
            by_addr.setdefault(ip, set()).add(dev_id)
    # A primary address is normally one of the assigned ones; adding it again
    # covers the odd row where it is not.
    for dev_id, addr in Device.objects.filter(
        tenant=tenant, primary_ip__isnull=False
    ).values_list("id", "primary_ip__ip_address"):
        ip = _ip(addr)
        if ip:
            by_addr.setdefault(ip, set()).add(dev_id)
    return devices, by_addr, by_name, by_short


def match_node(node: dict, index, match_by: str) -> tuple[object, str, str]:
    """``(device_id | None, how, reason)`` for one node."""
    _, by_addr, by_name, by_short = index
    full, name, _group = split_full_name(node)
    rungs = []
    if match_by in (OxidizedConnection.MATCH_ADDRESS_NAME, OxidizedConnection.MATCH_ADDRESS):
        ip = _ip(node.get("ip"))
        # A node defined by address alone has its address as its name.
        rungs.append(("address", [ip or _ip(name)], by_addr))
    if match_by in (OxidizedConnection.MATCH_ADDRESS_NAME, OxidizedConnection.MATCH_NAME):
        lname = name.lower()
        rungs.append(("name", [lname], by_name))
        rungs.append(("name", [_short(lname)], by_name))
        rungs.append(("name", [lname], by_short))
    for how, keys, table in rungs:
        for key in keys:
            if not key:
                continue
            hits = table.get(key) or set()
            if len(hits) > 1:
                return None, "ambiguous", f"{len(hits)} devices share the {how} '{key}'."
            if hits:
                return next(iter(hits)), how, ""
    return None, "none", "No device matches."


def sync_nodes(conn: OxidizedConnection) -> dict:
    """Read the node list and bring the links up to date.

    Pinned links are never touched beyond ``last_seen_at``. Matched links are
    re-decided every pass, so a renamed device or a moved address follows.
    """
    now = timezone.now()
    summary = {
        "nodes": 0, "linked": 0, "pinned": 0, "unmatched": [], "unmatched_count": 0,
        "missing_pinned": 0, "error": "",
    }
    try:
        nodes = OxidizedClient.for_connection(conn).nodes()
    except OxidizedError as exc:
        conn.last_error = str(exc)[:500]
        conn.last_checked_at = now
        conn.save(update_fields=["last_error", "last_checked_at", "updated_at"])
        summary["error"] = conn.last_error
        return summary

    index = _device_index(conn.tenant)
    devices = index[0]
    links = list(OxidizedNodeLink.objects.filter(connection=conn))
    pinned = [lk for lk in links if lk.matched_by == OxidizedNodeLink.HOW_MANUAL]
    pinned_nodes = {lk.full_name for lk in pinned}
    pinned_devices = {lk.device_id for lk in pinned}

    seen: dict[str, dict] = {}
    for node in nodes:
        full, _name, _group = split_full_name(node)
        if full and full not in seen:
            seen[full] = node
    summary["nodes"] = len(seen)

    # First pass: decide. Second: drop every device two nodes claimed.
    decided: dict[str, tuple] = {}
    unmatched: list[dict] = []
    claims: dict = {}
    for full, node in seen.items():
        if full in pinned_nodes:
            continue
        dev_id, how, reason = match_node(node, index, conn.match_by)
        if dev_id is not None and dev_id in pinned_devices:
            dev_id, how, reason = None, "ambiguous", "The device is pinned to another node."
        if dev_id is None:
            unmatched.append(_unmatched_row(full, node, reason))
            continue
        decided[full] = (dev_id, how)
        claims.setdefault(dev_id, []).append(full)
    for dev_id, fulls in claims.items():
        if len(fulls) > 1:
            for full in fulls:
                decided.pop(full, None)
                unmatched.append(_unmatched_row(
                    full, seen[full],
                    f"{len(fulls)} nodes match {devices[dev_id].name}.",
                ))

    with transaction.atomic():
        for lk in pinned:
            if lk.full_name in seen:
                _refresh(lk, seen[lk.full_name], now)
                lk.save()
            else:
                summary["missing_pinned"] += 1
        current = {lk.full_name: lk for lk in links if lk.matched_by != OxidizedNodeLink.HOW_MANUAL}
        # Free every device whose matched link moves to another node first, so
        # the (connection, device) constraint never sees two rows at once.
        stale = [
            lk.id for full, lk in current.items()
            if full not in decided or decided[full][0] != lk.device_id
        ]
        OxidizedNodeLink.objects.filter(id__in=stale).delete()
        for full, (dev_id, how) in decided.items():
            lk = current.get(full)
            if lk is None or lk.id in stale:
                lk = OxidizedNodeLink(
                    tenant=conn.tenant, connection=conn, device_id=dev_id, full_name=full,
                )
            lk.matched_by = how
            _refresh(lk, seen[full], now)
            lk.save()

        summary["linked"] = len(decided)
        summary["pinned"] = len(pinned)
        unmatched.sort(key=lambda r: r["full_name"].lower())
        summary["unmatched_count"] = len(unmatched)
        summary["unmatched"] = unmatched[:UNMATCHED_LIMIT]
        conn.node_count = len(seen)
        conn.last_sync_at = now
        conn.last_checked_at = now
        conn.last_error = ""
        conn.last_sync_summary = summary
        conn.save(update_fields=[
            "node_count", "last_sync_at", "last_checked_at", "last_error",
            "last_sync_summary", "updated_at",
        ])
    return summary


def _refresh(link: OxidizedNodeLink, node: dict, now) -> None:
    _full, name, group = split_full_name(node)
    link.node_name = name[:255]
    link.node_group = group[:255]
    link.node_ip = str(node.get("ip") or "")[:64]
    link.node_model = str(node.get("model") or "")[:64]
    link.last_seen_at = now


def _unmatched_row(full: str, node: dict, reason: str) -> dict:
    return {
        "full_name": full,
        "name": str(node.get("name") or ""),
        "ip": str(node.get("ip") or ""),
        "model": str(node.get("model") or ""),
        "reason": reason,
    }
