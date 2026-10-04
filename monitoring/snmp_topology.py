"""LLDP-derived "ghost" topology edges (#84).

The cabling graph (``/api/topology/``) shows physical cables. SNMP/LLDP also
tells us which devices are *actually* adjacent - so where two devices are LLDP
neighbours but have **no cable** between them, we surface a dashed **ghost** edge.
An operator can then materialise a ghost into a real ``Cable`` (picking the cable
type, since SNMP can't report the physical connector).

Matching an LLDP neighbour (a remote ``sysName``) to a Danbyte device is by name
*or* the device's observed ``sys_name`` - so it still lines up before you accept
any name drift.

A virtual chassis answers SNMP as one box, so every polled member's table - and
the owner's, which stands for the stack - lists the whole stack's neighbours,
and a neighbour names the stack, not a member. Each row goes to the member that
owns its port (#283), by :mod:`monitoring.vc_stack`'s rules: an interface the
member has, else the slot number in the port's name, else the stack's owner.
"""
from __future__ import annotations

from collections import defaultdict

from api.models import Cable, Device, Interface
from api.topology_views import _status_mini

from .models import DeviceSnmp
from .vc_stack import position_from_name, stacks


def _norm(s) -> str:
    return (s or "").strip().lower()


class _Stacks:
    """The stacks among some devices: their members, the ports each member
    owns, and which member a port name belongs to. A few queries whatever
    the count."""

    def __init__(self, tenant, devices):
        self.members = stacks({d.virtual_chassis_id for d in devices}, tenant.id)
        self.of = {m.id: vc for vc, ms in self.members.items() for m in ms}
        self.keys: dict = defaultdict(set)
        for device_id, name, snmp_name in Interface.objects.filter(
            device_id__in=list(self.of)
        ).values_list("device_id", "name", "snmp_name"):
            self.keys[device_id].update(k for k in (_norm(name), _norm(snmp_name)) if k)

    def member(self, vc, port):
        """The member of stack ``vc`` that owns ``port``."""
        members = self.members[vc]
        name = _norm(port)
        for m in members:
            if name and name in self.keys[m.id]:
                return m
        pos = position_from_name(port or "")
        by_pos = {m.vc_position: m for m in members if m.vc_position is not None}
        return by_pos.get(pos, members[0]) if pos is not None else members[0]


def _neighbor_rows(tenant, devices, st: _Stacks, snmp: dict) -> dict:
    """``{device id: [LLDP rows]}`` for ``devices``: a standalone device's own
    table; a stack's rows, from every member polled and each counted once,
    on the member that owns the local port."""
    out: dict = {}
    in_scope = {d.id for d in devices}
    for d in devices:
        if d.id not in st.of:
            s = snmp.get(d.id)
            out[d.id] = list(s.neighbors or []) if s else []
    for vc, members in st.members.items():
        seen = set()
        for m in members:
            s = snmp.get(m.id)
            for n in (s.neighbors or []) if s else []:
                key = (_norm(n.get("local_port")), _norm(n.get("remote_device")),
                       _norm(n.get("remote_port")))
                if key in seen:
                    continue
                seen.add(key)
                owner = st.member(vc, n.get("local_port"))
                if owner.id in in_scope:
                    out.setdefault(owner.id, []).append(n)
    return out


def _snmp_rows(tenant, device_ids) -> dict:
    return {
        s.device_id: s
        for s in DeviceSnmp.objects.filter(tenant=tenant, device_id__in=list(device_ids))
    }


def _cabled_pairs(tenant, device_ids) -> set:
    """Set of ``frozenset({device_id, device_id})`` that already share a cable -
    so we never draw a ghost over a real one."""
    pairs: set = set()
    cables = Cable.objects.filter(tenant=tenant).prefetch_related(
        "terminations__interface__device",
        "terminations__front_port__device",
        "terminations__rear_port__device",
    )
    for cab in cables:
        devs = set()
        for t in cab.terminations.all():
            p = t.interface or t.front_port or t.rear_port
            if p is not None and p.device_id in device_ids:
                devs.add(str(p.device_id))
        for a in devs:
            for b in devs:
                if a != b:
                    pairs.add(frozenset((a, b)))
    return pairs


def _topo_node(d) -> dict:
    """A device node in the topology-graph shape (mirrors api.topology_views)."""
    return {
        "id": f"dev:{d.id}",
        "type": "device",
        "data": {
            "device_id": str(d.id),
            "name": d.name,
            "status": d.status.slug if d.status_id else None,
            "status_display": d.status.name if d.status_id else "",
            "status_mini": _status_mini(d.status if d.status_id else None, "device"),
            "site": d.site.name if d.site_id else None,
        },
    }


def ghost_graph_for_device(tenant, device, candidates_qs=None) -> dict:
    """``{nodes, edges}`` for one device's LLDP ghost links: the device + its
    LLDP-neighbour devices, with dashed ghost edges between them (no cable). Used
    by the device-detail mini-map so it isn't empty when nothing is cabled yet.

    ``candidates_qs`` bounds which devices a neighbour can resolve to - pass the
    caller's RBAC-viewable Device queryset so a Site-A user's ghost graph never
    surfaces a Site-B neighbour node. Defaults to every device in the tenant."""
    st = _Stacks(tenant, [device])
    rows = _neighbor_rows(tenant, [device], st, _snmp_rows(tenant, {device.id, *st.of}))
    names = {
        _norm(n.get("remote_device"))
        for n in rows.get(device.id, []) if n.get("remote_device")
    }
    if not names:
        return {"nodes": [], "edges": []}
    if candidates_qs is None:
        candidates_qs = Device.objects.filter(tenant=tenant)
    candidates = list(candidates_qs.select_related("status", "site"))
    cand_snmp = {
        s.device_id: s
        for s in DeviceSnmp.objects.filter(
            tenant=tenant, device_id__in=[c.id for c in candidates]
        )
    }
    matched = []
    for c in candidates:
        if c.id == device.id:
            continue
        keys = {_norm(c.name)}
        s = cand_snmp.get(c.id)
        sys_name = (s.data or {}).get("sys_name") if s else None
        if sys_name:
            keys.add(_norm(sys_name))
        if keys & names:
            matched.append(c)
    # A neighbour names a stack, and its port says which member: every member
    # of a matched stack may be the peer, and the ones an edge reaches are
    # drawn - the matched one too when no member got an edge.
    stack_ids = {c.virtual_chassis_id for c in matched if c.virtual_chassis_id}
    seen = {c.id for c in matched}
    extra = [c for c in candidates if c.virtual_chassis_id in stack_ids
             and c.id not in seen and c.id != device.id]
    edges = ghost_edges(tenant, [device, *matched, *extra])
    linked = {e["source"] for e in edges} | {e["target"] for e in edges}
    reached = {c.virtual_chassis_id for c in matched + extra
               if c.virtual_chassis_id and f"dev:{c.id}" in linked}
    neighbours = [c for c in matched + extra if f"dev:{c.id}" in linked
                  or (c.id in seen and c.virtual_chassis_id not in reached)]
    return {
        "nodes": [_topo_node(d) for d in [device, *neighbours]],
        "edges": edges,
    }


def ghost_edges(tenant, devices) -> list[dict]:
    """LLDP-adjacency edges with no backing cable, in the topology edge shape
    (``type="ghost"``). ``devices`` is the in-scope device list."""
    device_ids = {d.id for d in devices}
    st = _Stacks(tenant, devices)
    snmp = _snmp_rows(tenant, device_ids | set(st.of))
    rows = _neighbor_rows(tenant, devices, st, snmp)
    # name / observed-sysName → device, for resolving LLDP remote names.
    by_key: dict[str, Device] = {}
    for d in devices:
        by_key.setdefault(_norm(d.name), d)
    for d in devices:  # sysName is a fallback key (don't override a real name)
        s = snmp.get(d.id)
        sys_name = (s.data or {}).get("sys_name") if s else None
        if sys_name:
            by_key.setdefault(_norm(sys_name), d)
    for members in st.members.values():  # a stack's, whichever member was polled
        here = next((m for m in members if m.id in device_ids), None)
        for m in members:
            s = snmp.get(m.id)
            sys_name = (s.data or {}).get("sys_name") if s else None
            if here is not None and sys_name:
                by_key.setdefault(_norm(sys_name), here)

    cabled = _cabled_pairs(tenant, device_ids)
    edges: dict = {}
    for d in devices:
        for n in rows.get(d.id, []):
            peer = by_key.get(_norm(n.get("remote_device")))
            if peer is not None and peer.id in st.of:
                # The neighbour names the stack: its port says which member.
                peer = st.member(st.of[peer.id], n.get("remote_port"))
                if peer.id not in device_ids:
                    continue
            if peer is None or peer.id == d.id:
                continue
            pair = frozenset((str(d.id), str(peer.id)))
            if pair in cabled:
                continue
            key = tuple(sorted((str(d.id), str(peer.id))))
            pair_ports = {"a": n.get("local_port", ""), "b": n.get("remote_port", "")}
            if key in edges:
                edges[key]["data"]["pairs"].append(pair_ports)
                continue
            edges[key] = {
                "id": f"ghost:{key[0]}:{key[1]}",
                "source": f"dev:{d.id}",
                "target": f"dev:{peer.id}",
                "type": "ghost",
                "data": {
                    "source_device": str(d.id),
                    "target_device": str(peer.id),
                    "local_port": n.get("local_port", ""),
                    "remote_port": n.get("remote_port", ""),
                    "pairs": [pair_ports],
                },
            }
    return list(edges.values())
