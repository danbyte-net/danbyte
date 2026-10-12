"""Pair Oxidized nodes with Danbyte devices and virtual machines.

Oxidized knows a node by a name, an address and a model - no serial. So the
ladder is shorter than Zabbix's (:mod:`zabbix.matching`), with the same rule
at every rung: **one candidate or none**.

1. **A pinned link.** Set by an admin, kept across every pass.
2. **An address.** The node's ``ip`` is an address Danbyte has recorded on the
   device or VM - its primary or any assigned address.
3. **The name.** Case-insensitive, the full name first, then the host part of
   an FQDN (``core1.example.net`` finds a device called ``core1``).

Devices and virtual machines are one candidate pool (#384): a virtual router
(CHR, VyOS, a virtual firewall) is a VM, and a name or address held by both a
device and a VM is as ambiguous as one held by two devices.

The connection's ``match_by`` turns rung 2 or 3 off. Where a rung finds two
candidates, or two nodes land on one, nothing is linked and the node is
listed as unmatched with the reason - a node paired with the wrong device
shows one box's configuration under another's name, and nothing downstream
would notice.

A link, once matched, is kept (#400): when the node's current target is among
a rung's candidates, or the current holder is among the nodes landing on one
target, the link stays and the namesakes are reported as a warning. A new
object sharing a linked device's name cannot unlink it.

A new match for a node the connection had already seen - unmatched, or
linked elsewhere - is *proposed* (#399): it serves no config until a
connection manager confirms it, because whoever created or renamed the
object it matched may not be allowed to read that node. A node seen for the
first time (every node, on a connection's first sync) links straight away,
and so does a node matched back to the object its last confirmed link
pointed at.

A target is a ``(kind, id)`` pair, kind being :data:`DEVICE` or :data:`VM`.
"""
from __future__ import annotations

import ipaddress

from django.db import models, transaction
from django.utils import timezone

from api.models import Device, IPAddress, VirtualMachine

from .client import OxidizedClient, OxidizedError
from .models import OxidizedConnection, OxidizedNode, OxidizedNodeLink

#: How many unmatched nodes (and warnings) the summary keeps for the
#: mapping page.
UNMATCHED_LIMIT = 1000

DEVICE, VM = "device", "vm"


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


def _target_index(tenant):
    """Lookup tables over the tenant's devices and virtual machines, keyed to
    ``(kind, id)`` targets. Nothing outside ``tenant`` is ever a candidate."""
    by_addr: dict[str, set] = {}
    by_name: dict[str, set] = {}
    by_short: dict[str, set] = {}
    names: dict[tuple, str] = {}

    def add_name(target, raw):
        names[target] = raw or ""
        name = (raw or "").strip().lower()
        if name:
            by_name.setdefault(name, set()).add(target)
            short = _short(name)
            if short:
                by_short.setdefault(short, set()).add(target)

    def add_addr(target, addr):
        ip = _ip(addr)
        if ip:
            by_addr.setdefault(ip, set()).add(target)

    for dev_id, name in Device.objects.filter(tenant=tenant).values_list("id", "name"):
        add_name((DEVICE, dev_id), name)
    for vm_id, name in VirtualMachine.objects.filter(tenant=tenant).values_list("id", "name"):
        add_name((VM, vm_id), name)

    for dev_id, vm_id, nic_vm_id, addr in IPAddress.objects.filter(tenant=tenant).filter(
        models.Q(assigned_device__isnull=False)
        | models.Q(assigned_vm__isnull=False)
        | models.Q(assigned_vm_interface__isnull=False)
    ).values_list("assigned_device_id", "assigned_vm_id", "assigned_vm_interface__vm_id",
                  "ip_address"):
        if dev_id:
            add_addr((DEVICE, dev_id), addr)
        # An address on a VM's interface belongs to that VM even where the
        # row's assigned_vm was never filled in.
        for vid in {vm_id, nic_vm_id} - {None}:
            add_addr((VM, vid), addr)
    # A primary address is normally one of the assigned ones; adding it again
    # covers the odd row where it is not.
    for dev_id, addr in Device.objects.filter(
        tenant=tenant, primary_ip__isnull=False
    ).values_list("id", "primary_ip__ip_address"):
        add_addr((DEVICE, dev_id), addr)
    for vm_id, addr in VirtualMachine.objects.filter(
        tenant=tenant, primary_ip__isnull=False
    ).values_list("id", "primary_ip__ip_address"):
        add_addr((VM, vm_id), addr)
    return names, by_addr, by_name, by_short


def _noun(hits) -> str:
    kinds = {kind for kind, _ in hits}
    if kinds == {DEVICE}:
        return "devices"
    if kinds == {VM}:
        return "virtual machines"
    return "devices and virtual machines"


def match_node(
    node: dict, index, match_by: str, current=None
) -> tuple[object, str, str]:
    """``(target | None, how, reason)`` for one node; a target is
    ``(kind, id)``.

    ``current`` is the target the node's matched link points at now. Where a
    rung finds several candidates and ``current`` is one of them, the link is
    kept: the result is ``current``, with the namesakes described in
    ``reason`` as a warning (#400)."""
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
                shared = f"{len(hits)} {_noun(hits)} share the {how} '{key}'"
                if current is not None and current in hits:
                    return current, how, f"{shared}; the existing link is kept."
                return None, "ambiguous", f"{shared}."
            if hits:
                return next(iter(hits)), how, ""
    return None, "none", "No device or virtual machine matches."


def sync_nodes(conn: OxidizedConnection) -> dict:
    """Read the node list and bring the links up to date.

    Pinned links are never touched beyond ``last_seen_at``. Matched links are
    re-decided every pass, so a renamed device or a moved address follows -
    as a proposed link when the node was seen before (see the module notes).
    """
    now = timezone.now()
    summary = {
        "nodes": 0, "linked": 0, "pinned": 0, "proposed": 0, "unmatched": [],
        "unmatched_count": 0, "warnings": [], "warning_count": 0,
        "missing_pinned": 0, "error": "",
    }
    try:
        nodes = OxidizedClient.for_connection(conn).nodes()
    except OxidizedError as exc:
        summary["error"] = record_sync_failure(conn, str(exc), now)
        return summary

    index = _target_index(conn.tenant)
    names = index[0]
    links = list(OxidizedNodeLink.objects.filter(connection=conn))
    pinned = [lk for lk in links if lk.matched_by == OxidizedNodeLink.HOW_MANUAL]
    pinned_nodes = {lk.full_name for lk in pinned}
    pinned_targets = {_target_of(lk) for lk in pinned}
    current = {
        lk.full_name: lk for lk in links if lk.matched_by != OxidizedNodeLink.HOW_MANUAL
    }
    # What the connection knew before this pass: the nodes it has seen, and
    # where each one's last confirmed link pointed.
    known: dict[str, tuple | None] = {}
    for full, dev_id, vm_id in OxidizedNode.objects.filter(connection=conn).values_list(
        "full_name", "last_device_id", "last_virtual_machine_id"
    ):
        known[full] = (DEVICE, dev_id) if dev_id else (VM, vm_id) if vm_id else None

    seen: dict[str, dict] = {}
    for node in nodes:
        full, _name, _group = split_full_name(node)
        if full and full not in seen:
            seen[full] = node
    summary["nodes"] = len(seen)

    # First pass: decide. Second: drop every target two nodes claimed.
    decided: dict[str, tuple] = {}
    unmatched: list[dict] = []
    warnings: list[dict] = []
    claims: dict = {}
    for full, node in seen.items():
        if full in pinned_nodes:
            continue
        held = _target_of(current[full]) if full in current else None
        target, how, reason = match_node(node, index, conn.match_by, current=held)
        if target is not None and target in pinned_targets:
            what = "device" if target[0] == DEVICE else "virtual machine"
            target, how, reason = None, "ambiguous", f"The {what} is pinned to another node."
        if target is None:
            unmatched.append(_unmatched_row(full, node, reason))
            continue
        if reason:
            warnings.append(_unmatched_row(full, node, reason))
        decided[full] = (target, how)
        claims.setdefault(target, []).append(full)
    for target, fulls in claims.items():
        if len(fulls) < 2:
            continue
        # The node already linked to the target keeps it (#400).
        holder = next(
            (f for f in fulls if f in current and _target_of(current[f]) == target), None
        )
        for full in fulls:
            if full == holder:
                warnings.append(_unmatched_row(
                    full, seen[full],
                    f"{len(fulls)} nodes match {names.get(target, '')}; "
                    "the existing link is kept.",
                ))
                continue
            decided.pop(full, None)
            unmatched.append(_unmatched_row(
                full, seen[full],
                f"{names.get(target, '')} is linked to node {holder}." if holder
                else f"{len(fulls)} nodes match {names.get(target, '')}.",
            ))

    with transaction.atomic():
        for lk in pinned:
            if lk.full_name in seen:
                _refresh(lk, seen[lk.full_name], now)
                lk.save()
            else:
                summary["missing_pinned"] += 1
        # Free every target whose matched link moves to another node first, so
        # the (connection, device|vm) constraints never see two rows at once.
        stale = [
            lk.id for full, lk in current.items()
            if full not in decided or decided[full][0] != _target_of(lk)
        ]
        remember_unlinked(lk for lk in current.values() if lk.id in stale)
        OxidizedNodeLink.objects.filter(id__in=stale).delete()
        proposed = 0
        for full, (target, how) in decided.items():
            kind, obj_id = target
            lk = current.get(full)
            if lk is None or lk.id in stale:
                lk = OxidizedNodeLink(
                    tenant=conn.tenant, connection=conn, full_name=full,
                    device_id=obj_id if kind == DEVICE else None,
                    virtual_machine_id=obj_id if kind == VM else None,
                    # A node seen before follows to a new object only once
                    # someone confirms it (#399).
                    proposed=full in known and known[full] != target,
                )
            lk.matched_by = how
            _refresh(lk, seen[full], now)
            lk.save()
            proposed += lk.proposed
        OxidizedNode.objects.bulk_create(
            [OxidizedNode(tenant=conn.tenant, connection=conn, full_name=full)
             for full in seen if full not in known],
            ignore_conflicts=True,
        )

        summary["linked"] = len(decided)
        summary["pinned"] = len(pinned)
        summary["proposed"] = proposed
        unmatched.sort(key=lambda r: r["full_name"].lower())
        summary["unmatched_count"] = len(unmatched)
        summary["unmatched"] = unmatched[:UNMATCHED_LIMIT]
        warnings.sort(key=lambda r: r["full_name"].lower())
        summary["warning_count"] = len(warnings)
        summary["warnings"] = warnings[:UNMATCHED_LIMIT]
        conn.node_count = len(seen)
        conn.last_sync_at = now
        conn.last_sync_attempt_at = now
        conn.last_checked_at = now
        conn.last_error = ""
        conn.last_sync_summary = summary
        conn.save(update_fields=[
            "node_count", "last_sync_at", "last_sync_attempt_at", "last_checked_at",
            "last_error", "last_sync_summary", "updated_at",
        ])
    return summary


def record_sync_failure(conn: OxidizedConnection, message: str, now=None) -> str:
    """Stamp a failed sync on the connection and return the stored message.

    ``last_sync_at`` stays the last *successful* sync, and the summary keeps
    that sync's counts and unmatched nodes, with ``error`` set (#385). The
    attempt is stamped too, so the scheduler retries once per interval rather
    than every tick.
    """
    now = now or timezone.now()
    message = (message or "Sync failed.")[:500]
    conn.last_error = message
    conn.last_checked_at = now
    conn.last_sync_attempt_at = now
    conn.last_sync_summary = {**(conn.last_sync_summary or {}), "error": message}
    conn.save(update_fields=[
        "last_error", "last_checked_at", "last_sync_attempt_at", "last_sync_summary",
        "updated_at",
    ])
    return message


def remember_unlinked(links) -> None:
    """Note on each link's node where it pointed, before the links are
    deleted (#398). A proposed link was never confirmed, so it leaves the
    node's memory as it was."""
    for lk in links:
        if lk.proposed:
            OxidizedNode.objects.get_or_create(
                connection_id=lk.connection_id, full_name=lk.full_name,
                defaults={"tenant_id": lk.tenant_id},
            )
            continue
        OxidizedNode.objects.update_or_create(
            connection_id=lk.connection_id, full_name=lk.full_name,
            defaults={
                "tenant_id": lk.tenant_id, "last_device_id": lk.device_id,
                "last_virtual_machine_id": lk.virtual_machine_id,
            },
        )


def last_target(conn: OxidizedConnection, full_name: str):
    """The device or VM the node's last confirmed link pointed at, while it
    still exists."""
    row = (
        OxidizedNode.objects.filter(connection=conn, full_name=full_name)
        .select_related("last_device", "last_virtual_machine")
        .first()
    )
    return row.last_target if row is not None else None


def _target_of(link: OxidizedNodeLink) -> tuple:
    if link.device_id:
        return (DEVICE, link.device_id)
    return (VM, link.virtual_machine_id)


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
