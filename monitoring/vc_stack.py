"""A virtual chassis answers SNMP as one box (#148).

Whichever member you poll, the agent reports every port of every member plus
the stack's logical interfaces. Left alone, that meant each member's drift
compared its own intent against the whole stack and proposed every other
member's ports as "new". This module gives the stack one owner to poll and
splits the observed rows back onto the members they belong to:

1. an observed name that matches an interface a member already has (or that
   its device-type / module templates render for its position) belongs to
   that member;
2. otherwise the first number after the leading letters names the member
   slot (``Gi2/0/1``, ``Ten-GigabitEthernet2/0/1``, ``ge-1/0/0``, ``1/1/1``);
3. everything else - Port-channel, Bridge-Aggregation, Vlan, Loopback, the
   management port - goes to the owner (the master).

Vendor-neutral on purpose: no interface vocabulary to maintain. Where the
naming defeats rule 2, a port lands on the master and "move to member" on the
interface form fixes it by hand.
"""
from __future__ import annotations

import re

from api.models import Device, Interface, _module_interface_names, render_component_name

# "Gi2/0/1", "Ten-GigabitEthernet2/0/1", "ge-1/0/0", "xe-0/1/2", "Ethernet1/1"
_POS_RE = re.compile(r"^[A-Za-z][A-Za-z-]*\s*(\d+)/\d+")
# Aruba / Dell "1/1/1"
_POS_BARE_RE = re.compile(r"^(\d+)/\d+/\d+")


def _norm(value) -> str:
    return (value or "").strip().lower()


def stack_members(device) -> list | None:
    """Every member of ``device``'s stack in position order, or ``None`` when
    the device is not in a virtual chassis."""
    if not device.virtual_chassis_id:
        return None
    return list(
        Device.objects.filter(virtual_chassis_id=device.virtual_chassis_id)
        .select_related("device_type")
        .order_by("vc_position", "name")
    )


def stack_owner(device):
    """The member that is polled for the whole stack: the designated master,
    else the lowest-positioned member. A standalone device owns itself."""
    if not device.virtual_chassis_id:
        return device
    vc = device.virtual_chassis
    if vc.master_id and vc.master.virtual_chassis_id == vc.id:
        return vc.master
    members = stack_members(device)
    return members[0] if members else device


def stack_state(device, tenant):
    """The observed SNMP state that describes ``device``: its own row when it
    has been polled, else the stack owner's."""
    from .models import DeviceSnmp

    own = DeviceSnmp.objects.filter(device=device, tenant=tenant).first()
    if own is not None and own.polled_at:
        return own
    owner = stack_owner(device)
    if owner.id == device.id:
        return own
    return DeviceSnmp.objects.filter(device=owner, tenant=tenant).first() or own


def position_from_name(name: str) -> int | None:
    m = _POS_RE.match(name or "") or _POS_BARE_RE.match(name or "")
    return int(m.group(1)) if m else None


def member_name_keys(member) -> set[str]:
    """Every observed name that identifies a port as ``member``'s: its current
    interfaces (and their SNMP links), plus what its device-type and module
    templates render for its stack position."""
    keys: set[str] = set()
    for name, snmp_name in Interface.objects.filter(device=member).values_list(
        "name", "snmp_name"
    ):
        keys.add(_norm(name))
        if snmp_name:
            keys.add(_norm(snmp_name))
    dt = member.device_type
    if dt is not None:
        for t in dt.interface_templates.all():
            keys.add(_norm(render_component_name(t.name, member.vc_position)))
    for module in member.modules.select_related("module_bay", "module_type").all():
        for n in _module_interface_names(module):
            keys.add(_norm(n))
    keys.discard("")
    return keys


def partition_observed(observed: list[dict], members: list, owner) -> dict:
    """``{member id: [observed rows]}`` - every row lands on exactly one member."""
    by_member: dict = {m.id: [] for m in members}
    keys = {m.id: member_name_keys(m) for m in members}
    by_pos = {m.vc_position: m for m in members if m.vc_position is not None}
    for o in observed:
        cands = [_norm(o.get("name")), _norm(o.get("descr"))]
        target = next(
            (m for m in members if any(c and c in keys[m.id] for c in cands)), None
        )
        if target is None:
            pos = position_from_name(o.get("name") or "")
            if pos is None:
                pos = position_from_name(o.get("descr") or "")
            target = by_pos.get(pos) if pos is not None else None
        by_member[(target or owner).id].append(o)
    return by_member


def observed_for(device, observed: list[dict]) -> list[dict]:
    """The rows of a stack-wide observation that belong to ``device``; the
    whole list for a standalone device."""
    members = stack_members(device)
    if not members:
        return observed
    if not any(m.id == device.id for m in members):  # pragma: no cover - defensive
        return observed
    return partition_observed(observed, members, stack_owner(device)).get(device.id, [])
