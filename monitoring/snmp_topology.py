"""LLDP-derived "ghost" topology edges (#84).

The cabling graph (``/api/topology/``) shows physical cables. SNMP/LLDP also
tells us which devices are *actually* adjacent — so where two devices are LLDP
neighbours but have **no cable** between them, we surface a dashed **ghost** edge.
An operator can then materialise a ghost into a real ``Cable`` (picking the cable
type, since SNMP can't report the physical connector).

Matching an LLDP neighbour (a remote ``sysName``) to a Danbyte device is by name
*or* the device's observed ``sys_name`` — so it still lines up before you accept
any name drift.
"""
from __future__ import annotations

from api.models import Cable, Device

from .models import DeviceSnmp


def _norm(s) -> str:
    return (s or "").strip().lower()


def _cabled_pairs(tenant, device_ids) -> set:
    """Set of ``frozenset({device_id, device_id})`` that already share a cable —
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
            "site": d.site.name if d.site_id else None,
        },
    }


def ghost_graph_for_device(tenant, device, candidates_qs=None) -> dict:
    """``{nodes, edges}`` for one device's LLDP ghost links: the device + its
    LLDP-neighbour devices, with dashed ghost edges between them (no cable). Used
    by the device-detail mini-map so it isn't empty when nothing is cabled yet.

    ``candidates_qs`` bounds which devices a neighbour can resolve to — pass the
    caller's RBAC-viewable Device queryset so a Site-A user's ghost graph never
    surfaces a Site-B neighbour node. Defaults to every device in the tenant."""
    snmp = DeviceSnmp.objects.filter(tenant=tenant, device=device).first()
    if snmp is None or not snmp.neighbors:
        return {"nodes": [], "edges": []}
    names = {
        _norm(n.get("remote_device"))
        for n in snmp.neighbors if n.get("remote_device")
    }
    if candidates_qs is None:
        candidates_qs = Device.objects.filter(tenant=tenant)
    candidates = list(candidates_qs.select_related("status", "site"))
    cand_snmp = {
        s.device_id: s
        for s in DeviceSnmp.objects.filter(
            tenant=tenant, device_id__in=[c.id for c in candidates]
        )
    }
    neighbours = []
    for c in candidates:
        if c.id == device.id:
            continue
        keys = {_norm(c.name)}
        s = cand_snmp.get(c.id)
        sys_name = (s.data or {}).get("sys_name") if s else None
        if sys_name:
            keys.add(_norm(sys_name))
        if keys & names:
            neighbours.append(c)
    device_list = [device, *neighbours]
    return {
        "nodes": [_topo_node(d) for d in device_list],
        "edges": ghost_edges(tenant, device_list),
    }


def ghost_edges(tenant, devices) -> list[dict]:
    """LLDP-adjacency edges with no backing cable, in the topology edge shape
    (``type="ghost"``). ``devices`` is the in-scope device list."""
    device_ids = {d.id for d in devices}
    # name / observed-sysName → device, for resolving LLDP remote names.
    snmp = {
        s.device_id: s
        for s in DeviceSnmp.objects.filter(tenant=tenant, device_id__in=device_ids)
    }
    by_key: dict[str, Device] = {}
    for d in devices:
        by_key.setdefault(_norm(d.name), d)
    for d in devices:  # sysName is a fallback key (don't override a real name)
        s = snmp.get(d.id)
        sys_name = (s.data or {}).get("sys_name") if s else None
        if sys_name:
            by_key.setdefault(_norm(sys_name), d)

    cabled = _cabled_pairs(tenant, device_ids)
    edges: dict = {}
    for d in devices:
        s = snmp.get(d.id)
        if s is None or not s.neighbors:
            continue
        for n in s.neighbors:
            peer = by_key.get(_norm(n.get("remote_device")))
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
