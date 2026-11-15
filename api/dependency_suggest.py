"""Suggest device dependencies from cables and LLDP (#450).

Cables and LLDP say which devices are adjacent, never which one depends on
the other. :func:`suggest` reads that direction from a core device the
caller picks: a breadth-first walk outward from it over the cabled links
between devices (through patch panels, as the topology map collapses them,
``topology_views._physical_links`` + ``_collapse``) and, with ``use_lldp``,
the LLDP neighbours with no cable (``monitoring.snmp_topology.ghost_edges``,
which reads ``_neighbor_rows``). A device depends on its neighbours one hop
closer to the core. Two neighbours at the same distance are ordered by
their uplinks instead: a link whose port is an uplink on one side only
(``Interface.is_uplink``, or the MAC-table classification of
``monitoring.mac_location.UplinkContext`` - LLDP switch neighbour, LAG,
learned-MAC count; *Never* wins over the automatic rules) runs from that
side up to the other. Neither or both: no proposal.

Each proposal carries a medium guessed from the cable type (fibre and AOC
types are Fibre, anything else Ethernet, an LLDP-only link Ethernet), and a
device with two or more upstreams at one distance gets them in one
redundancy group, ``auto-<core>``. Pairs that are already related (either
way, either kind) are skipped.

Only data-port links count: two interfaces, never a console or power cable.
The walk covers only the devices the caller may view (and, with ``site``,
that site's devices and the core), over the cables they may view, in the
active tenant. Nothing is saved: the caller confirms the proposals it wants
through the ordinary create, which refuses a cycle per row.
"""
from __future__ import annotations

import uuid as _uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field

from django.db.models import Q

from auth_api import rbac

from .dependency_impact import _medium
from .fiber_colors import is_fiber_type
from .models import DependencyMedium, Device, DeviceDependency, Interface

DEFAULT_DEPTH = 8
MAX_DEPTH = 20
#: Proposals one answer lists; ``truncated`` says there were more.
MAX_PROPOSALS = 2000
#: Port pairs one proposal names.
MAX_PORTS = 4

FIBRE = "fibre"
ETHERNET = "ethernet"


@dataclass
class _Hop:
    """One link between two devices, seen from ``here``."""

    here: str
    there: str
    here_port: str
    there_port: str
    here_iface: object
    there_iface: object
    evidence: str  # cable | lldp
    cable_type: str = ""


@dataclass
class _Pair:
    hops: list = field(default_factory=list)


def _devices(user, tenant, core, site):
    qs = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), user, tenant, "device", "view",
    )
    if site is not None:
        qs = qs.filter(Q(site_id=site) | Q(pk=core.pk))
    return {str(d.pk): d for d in qs.select_related("site")}


def _cable_hops(user, tenant, devices) -> list[_Hop]:
    from .site_map_views import _viewable_links
    from .topology_views import _collapse, _physical_links, _preloaded_strand

    if rbac.row_filter(user, tenant, "cable", "view") is None:
        return []
    links = _viewable_links(user, tenant, _physical_links(tenant))
    ends, _panels = _collapse(links, _preloaded_strand(links))
    hops = []
    for cab, da, pa, ka, db, pb, kb, _via in ends:
        if ka != "interface" or kb != "interface":
            continue
        a, b = str(da.id), str(db.id)
        if a == b or a not in devices or b not in devices:
            continue
        hops.append(_Hop(a, b, pa.name, pb.name, pa.id, pb.id, "cable", cab.type or ""))
    return hops


def _lldp_hops(tenant, devices) -> list[_Hop]:
    from monitoring.snmp_topology import ghost_edges

    edges = ghost_edges(tenant, list(devices.values()))
    names = set()
    for e in edges:
        for p in e["data"]["pairs"]:
            names.update((p.get("a") or "", p.get("b") or ""))
    iface = {}
    if edges:
        for pk, dev, name in Interface.objects.filter(
            device_id__in=list(devices), name__in=[n for n in names if n],
        ).values_list("pk", "device_id", "name"):
            iface[(str(dev), name)] = pk
    hops = []
    for e in edges:
        a, b = e["data"]["source_device"], e["data"]["target_device"]
        if a not in devices or b not in devices:
            continue
        for p in e["data"]["pairs"]:
            pa, pb = p.get("a") or "", p.get("b") or ""
            hops.append(_Hop(a, b, pa, pb, iface.get((a, pa)), iface.get((b, pb)), "lldp"))
    return hops


def _bfs(adj, core, max_depth) -> dict:
    dist = {core: 0}
    queue = deque([core])
    while queue:
        node = queue.popleft()
        if dist[node] >= max_depth:
            continue
        for nxt in sorted(adj.get(node, ())):
            if nxt not in dist:
                dist[nxt] = dist[node] + 1
                queue.append(nxt)
    return dist


class _Uplinks:
    """Whether a device's port is an uplink: its interface's Always/Never
    setting first, then the MAC-table rules on the port's last poll."""

    def __init__(self, tenant, hops):
        from monitoring.mac_location import UplinkContext

        devices = {_as_uuid(h.here) for h in hops} | {_as_uuid(h.there) for h in hops}
        ifaces = {h.here_iface for h in hops} | {h.there_iface for h in hops}
        self.ctx = UplinkContext(tenant).load(devices, ifaces)
        self.memo: dict = {}

    def is_uplink(self, device_id, port, iface) -> bool:
        from monitoring.mac_tables import port_key_of

        key = (device_id, port, iface)
        if key not in self.memo:
            self.memo[key] = self.ctx.classify(
                _as_uuid(device_id), port_key_of({"name": port}), iface,
            ).is_uplink
        return self.memo[key]


def _as_uuid(value):
    try:
        return _uuid.UUID(str(value))
    except ValueError:
        return value


def _medium_slug(hops) -> str:
    for h in hops:
        if h.evidence == "cable" and (is_fiber_type(h.cable_type) or h.cable_type == "aoc"):
            return FIBRE
    return ETHERNET


def _ref(d) -> dict:
    return {"id": str(d.pk), "name": d.name,
            "site": {"id": str(d.site_id), "name": d.site.name} if d.site_id else None}


def suggest(user, tenant, core, *, max_depth: int = DEFAULT_DEPTH, use_lldp: bool = True,
            site=None) -> dict:
    """Proposed dependencies towards ``core`` (a device the caller may
    view). Reads only; see the module docstring."""
    devices = _devices(user, tenant, core, site)
    root = str(core.pk)
    hops = _cable_hops(user, tenant, devices)
    if use_lldp:
        hops += _lldp_hops(tenant, devices)

    # Undirected: every hop seen from both ends.
    pairs: dict = defaultdict(_Pair)
    adj: dict = defaultdict(set)
    for h in hops:
        pairs[(h.here, h.there)].hops.append(h)
        pairs[(h.there, h.here)].hops.append(_Hop(
            h.there, h.here, h.there_port, h.here_port, h.there_iface, h.here_iface,
            h.evidence, h.cable_type,
        ))
        adj[h.here].add(h.there)
        adj[h.there].add(h.here)
    dist = _bfs(adj, root, max_depth)

    related = set()
    for u, d in DeviceDependency.objects.filter(tenant=tenant).values_list(
        "upstream_id", "downstream_id",
    ):
        related.add(frozenset((str(u), str(d))))

    uplinks = _Uplinks(tenant, hops) if hops else None
    found: dict = {}  # (up, down) -> direction
    skipped = 0
    for (a, b), _pair in pairs.items():
        if a not in dist or b not in dist or a > b:
            continue
        if dist[a] != dist[b]:
            up, down = (a, b) if dist[a] < dist[b] else (b, a)
            direction = "distance"
        else:
            # Same distance: the side whose port is an uplink depends on
            # the other.
            a_up = any(uplinks.is_uplink(h.here, h.here_port, h.here_iface)
                       for h in pairs[(a, b)].hops)
            b_up = any(uplinks.is_uplink(h.here, h.here_port, h.here_iface)
                       for h in pairs[(b, a)].hops)
            if a_up == b_up:
                continue
            up, down = (b, a) if a_up else (a, b)
            direction = "uplink"
        if frozenset((up, down)) in related:
            skipped += 1
            continue
        found[(up, down)] = direction

    # Two or more upstreams of one device at one distance back each other.
    buckets: dict = defaultdict(list)
    for up, down in found:
        buckets[(down, dist[up])].append(up)
    group = f"auto-{core.name}"[:64]
    media = {
        m.slug: m for m in rbac.restrict_queryset(
            DependencyMedium.objects.filter(tenant=tenant, slug__in=[FIBRE, ETHERNET]),
            user, tenant, "dependencymedium", "view",
        )
    }
    proposals = []
    for (up, down), direction in found.items():
        hs = pairs[(down, up)].hops
        slug = _medium_slug(hs)
        cable = any(h.evidence == "cable" for h in hs)
        proposals.append({
            "key": f"{up}:{down}",
            "upstream": _ref(devices[up]),
            "downstream": _ref(devices[down]),
            "distance": dist[down],
            "direction": direction,
            "evidence": "cable" if cable else "lldp",
            "medium_guess": slug,
            "medium": _medium(media.get(slug)),
            "redundancy_group": group if len(buckets[(down, dist[up])]) >= 2 else "",
            "ports": [
                {"downstream": h.here_port, "upstream": h.there_port, "evidence": h.evidence}
                for h in hs[:MAX_PORTS]
            ],
        })
    proposals.sort(key=lambda p: (p["distance"], p["downstream"]["name"].lower(),
                                  p["upstream"]["name"].lower()))
    return {
        "core": _ref(core),
        "max_depth": max_depth,
        "reached": len(dist),
        "skipped_existing": skipped,
        "truncated": len(proposals) > MAX_PROPOSALS,
        "proposals": proposals[:MAX_PROPOSALS],
    }
