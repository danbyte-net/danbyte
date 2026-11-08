"""The topology map's Routing tab: ``GET/POST /api/topology/routing/``.

The routers of the map's device set - devices and VMs that run a routing
process (BGP, OSPF, IS-IS, EIGRP, LDP, a static route), and the devices at
the far end of a line drawn from one - with the lines between them, one
payload:

* ``nodes`` - ``type: "router"`` cards (router ID, local ASNs, loopback,
  the processes it runs) and, on the Circuits layer, the provider networks
  their circuits meet at (``type: "provider_network"``, as on the Diagram);
* ``as_groups`` - one per local AS (an iBGP domain): the cards whose
  global-table BGP instance runs it. The page draws them as AS boxes;
* ``edges`` - per layer, its ``type`` the layer's name: ``ebgp`` and
  ``ibgp`` (one line per node pair and table, a route reflector's iBGP line
  running from it to its client), ``ospf`` and ``isis`` (one line per
  router pair, table and area or level: interfaces of the process joined
  by a cable, through patch panels, else sharing a subnet), ``static``
  (from a route's owner to the router its next hop is on, one line per
  pair and table), ``circuit`` and ``cable``;
* ``checks`` - what looks wrong on the lines drawn: a BGP session defined
  on one side only, an AS mismatch, an OSPF area or IS-IS level mismatch
  across a cable, OSPF hello/dead or MTU that differ. Each names its line,
  whose ``data.problems`` lists the same kinds;
* ``meta.layers`` - which layers the caller may see; ``meta.vrfs`` - the
  VRFs the map's processes and routes run in (the VRF picker's list);
  ``meta.vrf`` - the table drawn.

The query is the Diagram's (``/api/topology/``): ``site location role status
tag`` narrow the set, ``devices`` (with ``chassis``) is a hand-picked map and
``device``/``depth`` focuses on one router and its routing neighbours that
many hops out. ``layers`` names the lines wanted (default every one but
``cables``). ``vrf`` is the table the routing lines are drawn for:
``all`` (every table, the default), ``global`` or a VRF id. A VRF keeps, besides its own
lines, the global table's VPNv4/VPNv6 BGP lines between two routers that
run it. Circuits and cables belong to no table.

RBAC: ``device.view`` for a card (``virtualmachine.view`` for a VM); a
router shows only the processes the caller may view. A line needs both ends
on the map, plus per layer: ``bgpsession.view`` for eBGP and iBGP,
``ospfinstance.view`` and ``ospfinterface.view`` for OSPF,
``isisinstance.view`` and ``isisinterface.view`` for IS-IS,
``staticroute.view`` for static routes, the circuit, provider network and
site grants for circuits, nothing more for cables. A missing grant hides
that layer, never the map. A keychain, BFD profile or OSPF area is named
only with its own grant, and a key never. Everything is inside the active
tenant, and the cost is a fixed number of queries whatever the size of the
map.
"""
from __future__ import annotations

import ipaddress
from collections import Counter, deque

from django.db.models import Prefetch, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api import topology_provider
from api.models import ASN, Device, Interface, IPAddress, VirtualMachine
from api.topology_views import (
    MAX_CHASSIS_SET,
    MAX_DEPTH,
    _build_graph,
    _csv_param,
    _filter_q,
    _parse_uuid,
    _placed_chassis_q,
    _query_params,
    _status_mini,
    _uuid_list_param,
    _uuid_param,
)
from api.views import _get_active_tenant
from auth_api import rbac

from .models import (
    BFDProfile,
    BGPInstance,
    BGPNeighborAF,
    BGPPeerGroup,
    BGPSession,
    EIGRPInstance,
    ISISInstance,
    ISISInterface,
    LDPInstance,
    OSPFArea,
    OSPFInstance,
    OSPFInterface,
    RoutingKeychain,
    RoutingPolicy,
    RPKICache,
    StaticRoute,
    effective_afs,
)
from .topology import merge_sessions

#: The line layers, in legend order. Each is an edge ``type`` too (the
#: Circuits layer's lines are ``circuit``, the Cables layer's ``cable``).
LAYERS = ("ebgp", "ibgp", "ospf", "isis", "static", "circuits", "cables")
#: What a map draws unless it names its layers: cables are the Diagram's
#: subject, faint here and off until asked for.
DEFAULT_LAYERS = frozenset(LAYERS) - {"cables"}
#: The layers whose lines belong to one routing table (the VRF picker's).
TABLE_LAYERS = frozenset({"ebgp", "ibgp", "ospf", "isis", "static"})
#: ``vrf``: every table (the default), the global table, or a VRF id.
VRF_GLOBAL = "global"
VRF_ALL = "all"
#: The global-table families that carry a VRF's routes between its PEs.
VPN_AFS = frozenset({"vpnv4-unicast", "vpnv6-unicast"})
#: The routes a static line lists; the rest it counts.
STATIC_ROUTES_SHOWN = 25

#: The processes that make a box a router: model, RBAC slug, kind.
INSTANCE_KINDS = (
    (BGPInstance, "bgpinstance", "bgp"),
    (OSPFInstance, "ospfinstance", "ospf"),
    (ISISInstance, "isisinstance", "isis"),
    (EIGRPInstance, "eigrpinstance", "eigrp"),
    (LDPInstance, "ldpinstance", "ldp"),
)

#: Interface names a loopback goes by, when its address has no role saying so.
_LOOPBACK_NAMES = r"^(lo|loopback)[0-9./-]*$"


def dev_node(pk) -> str:
    return f"dev:{pk}"


def vm_node(pk) -> str:
    return f"vm:{pk}"


def _layers_param(params):
    raw = _csv_param(params, "layers")
    if raw is None:
        return DEFAULT_LAYERS
    unknown = sorted(set(raw) - set(LAYERS))
    if unknown:
        raise ParseError(f"layers: unknown layer(s) {', '.join(unknown)}")
    return frozenset(raw)


def _vrf_param(params):
    """``all`` (absent too), ``global`` or a VRF id (a 400 for anything else)."""
    raw = params.get("vrf")
    text = "" if raw is None else str(raw).strip()
    if text in ("", VRF_ALL):
        return VRF_ALL
    if text == VRF_GLOBAL:
        return VRF_GLOBAL
    return _parse_uuid(text, "vrf")


def _depth_param(params):
    try:
        return max(1, min(MAX_DEPTH, int(params.get("depth", 1))))
    except (TypeError, ValueError, OverflowError):
        return 1


def _viewable(qs, user, tenant, slug):
    """``qs`` narrowed to the caller's ``slug.view`` rows, or None when the
    grant is missing altogether."""
    if not rbac.has_action(user, tenant, slug, "view"):
        return None
    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def _viewable_ids(model, user, tenant, slug, ids):
    """The ids among ``ids`` of ``model`` rows the caller may view."""
    if not ids:
        return set()
    qs = _viewable(model.objects.filter(tenant=tenant, id__in=ids), user, tenant, slug)
    return set() if qs is None else set(qs.values_list("id", flat=True))


def _ref(obj, allowed):
    """``{id, name}`` of a catalog row the caller may view, else None."""
    if obj is None or obj.id not in allowed:
        return None
    return {"id": str(obj.id), "name": obj.name}


# ─── The cards ──────────────────────────────────────────────────────────────

def _router_card(kind, obj):
    """A card's base: a device's or a VM's own fields."""
    role = obj.role if obj.role_id else None
    return {
        "id": dev_node(obj.id) if kind == "device" else vm_node(obj.id),
        "type": "router",
        "data": {
            "kind": kind,
            "device_id": str(obj.id) if kind == "device" else None,
            "vm_id": str(obj.id) if kind == "vm" else None,
            "name": obj.name,
            "role": (
                {"id": str(role.id), "name": role.name, "slug": role.slug,
                 "color": role.color}
                if role else None
            ),
            "status_mini": _status_mini(obj.status if obj.status_id else None,
                                        "device" if kind == "device" else "virtualmachine"),
            "site": obj.site.name if obj.site_id else None,
            "site_id": str(obj.site_id) if obj.site_id else None,
            "primary_ip": (
                obj.primary_ip.ip_address
                if kind == "device" and obj.primary_ip_id else None
            ),
            # Filled from its processes below.
            "router": False,
            "router_id": None,
            "asns": [],
            "as_group": None,
            "loopback": None,
            "instances": [],
        },
    }


def _instances(user, tenant, devices, vms):
    """Every routing process the caller may view on ``devices`` / ``vms``
    (querysets of the candidate set), as ``{node id: [process]}``, with the
    BGP instances and ``tables``: the VRFs seen (``vrfs``, id to name), each
    node's VRFs (``node_vrfs``) and the OSPF and IS-IS instance ids
    (``ids``). One query per process kind, plus one for static routes."""
    by_node: dict[str, list] = {}
    bgp_rows = []
    tables = {"vrfs": {}, "node_vrfs": {}, "ids": {"ospf": [], "isis": []}}
    owner = Q(device__in=devices.values("id"))
    if vms is not None:
        owner |= Q(virtual_machine__in=vms.values("id"))
    for model, slug, kind in INSTANCE_KINDS:
        qs = _viewable(model.objects.filter(tenant=tenant), user, tenant, slug)
        if qs is None:
            continue
        if model is LDPInstance:
            qs = qs.filter(device__in=devices.values("id"))
        else:
            qs = qs.filter(owner)
        related = ["vrf"] + (["asn"] if model is BGPInstance else [])
        for inst in qs.select_related(*related).order_by("id"):
            node = (dev_node(inst.device_id) if inst.device_id
                    else vm_node(inst.virtual_machine_id))
            row = {
                "kind": kind,
                "id": str(inst.id),
                "vrf": inst.vrf.name if inst.vrf_id else None,
                "router_id": inst.router_id or None,
            }
            if inst.vrf_id:
                tables["vrfs"][str(inst.vrf_id)] = (inst.vrf.name, inst.vrf.color)
                tables["node_vrfs"].setdefault(node, set()).add(str(inst.vrf_id))
            if kind in tables["ids"]:
                tables["ids"][kind].append(inst.id)
            if kind == "bgp":
                row["asn"] = inst.asn.asn
                row["asn_id"] = str(inst.asn_id)
                row["cluster_id"] = inst.cluster_id or None
                bgp_rows.append((node, inst))
            by_node.setdefault(node, []).append(row)
    static = _viewable(StaticRoute.objects.filter(tenant=tenant), user, tenant, "staticroute")
    if static is not None:
        counts = Counter()
        rows = static.filter(owner).values_list(
            "device_id", "virtual_machine_id", "vrf_id", "vrf__name", "vrf__color"
        )
        for dev, vm, vrf_id, vrf_name, vrf_color in rows:
            counts[dev_node(dev) if dev else vm_node(vm)] += 1
            if vrf_id:
                tables["vrfs"][str(vrf_id)] = (vrf_name, vrf_color)
        for node, n in counts.items():
            by_node.setdefault(node, []).append(
                {"kind": "static", "id": None, "vrf": None, "router_id": None,
                 "count": n}
            )
    order = {"bgp": 0, "ospf": 1, "isis": 2, "eigrp": 3, "ldp": 4, "static": 5}
    for rows in by_node.values():
        rows.sort(key=lambda r: (order[r["kind"]], r["vrf"] or "", r["id"] or ""))
    return by_node, bgp_rows, tables


def _fill_card(card, processes):
    """A card's router ID, local ASNs and AS box from its processes. The
    global table's BGP instance names the box; a box with BGP in VRFs only
    sits in its lowest AS."""
    d = card["data"]
    d["router"] = bool(processes)
    d["instances"] = processes
    bgp = [p for p in processes if p["kind"] == "bgp"]
    asns = []
    for p in bgp:
        entry = {"asn": p["asn"], "vrf": p["vrf"]}
        if entry not in asns:
            asns.append(entry)
    d["asns"] = asns
    glob = next((p for p in bgp if p["vrf"] is None), None)
    if glob is not None:
        d["as_group"] = glob["asn"]
    elif bgp:
        d["as_group"] = min(p["asn"] for p in bgp)
    # The global table's router ID, BGP's first.
    for p in sorted(processes, key=lambda r: (r["vrf"] is not None, r["kind"] != "bgp")):
        if p.get("router_id"):
            d["router_id"] = p["router_id"]
            break


def _loopbacks(user, tenant, dev_ids, vm_ids):
    """``{node id: address}`` - each router's loopback in the global table:
    an address whose role is Loopback, or on an interface named like one.
    One query."""
    if not dev_ids and not vm_ids:
        return {}
    qs = _viewable(IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress")
    if qs is None:
        return {}
    on = Q(assigned_device_id__in=dev_ids) | Q(assigned_vm_id__in=vm_ids)
    looks = (
        Q(role__slug="loopback")
        | Q(assigned_interface__name__iregex=_LOOPBACK_NAMES)
        | Q(assigned_vm_interface__kind="loopback")
        | Q(assigned_vm_interface__name__iregex=_LOOPBACK_NAMES)
    )
    out: dict[str, str] = {}
    rows = (
        qs.filter(on).filter(looks).filter(vrf__isnull=True)
        .values_list("assigned_device_id", "assigned_vm_id", "ip_address")
        .order_by("ip_address")
    )
    for dev, vm, address in rows:
        node = dev_node(dev) if dev else vm_node(vm)
        text = str(address)
        # A v4 loopback reads before a v6 one.
        if node not in out or (":" in out[node] and ":" not in text):
            out[node] = text
    return out


# ─── BGP ────────────────────────────────────────────────────────────────────

def _sessions(user, tenant, instance_ids):
    """The caller's viewable sessions of these BGP instances, with
    everything their panel reads joined or prefetched."""
    qs = _viewable(BGPSession.objects.filter(tenant=tenant), user, tenant, "bgpsession")
    if qs is None:
        return None
    af_rows = BGPNeighborAF.objects.select_related(
        "import_policy", "export_policy", "prefix_list_in", "prefix_list_out",
    )
    return list(
        qs.filter(instance_id__in=instance_ids)
        .select_related(
            "instance__asn", "instance__vrf", "instance__bfd_profile", "status",
            "peer_group__local_asn", "peer_group__bfd_profile",
            "peer_group__import_policy", "peer_group__export_policy",
            "local_asn", "local_address__assigned_interface", "remote_address_obj",
            "import_policy", "export_policy", "bfd_profile", "interface", "vm_interface",
        )
        .prefetch_related(
            Prefetch("afs", queryset=af_rows),
            Prefetch("peer_group__afs", queryset=af_rows),
            "instance__rpki_caches",
        )
        .order_by("id")
    )


def _peer_node(s):
    """The node at the far end of a session: the peer device, else the
    device or VM its remote address is on."""
    if s.peer_device_id:
        return dev_node(s.peer_device_id)
    ip = s.remote_address_obj if s.remote_address_obj_id else None
    if ip is not None:
        if ip.assigned_device_id:
            return dev_node(ip.assigned_device_id)
        if ip.assigned_vm_id:
            return vm_node(ip.assigned_vm_id)
    return None


def _own_node(s):
    inst = s.instance
    return dev_node(inst.device_id) if inst.device_id else vm_node(inst.virtual_machine_id)


def _session_row(s, eff, allowed):
    """One session as its line's panel lists it. Catalog rows (peer group,
    policies, BFD profile, RPKI caches) show only when the caller may view
    them."""
    inst = s.instance
    afs = []
    for af in effective_afs(s):
        afs.append({
            "afi_safi": af["afi_safi"],
            "activate": af["activate"],
            "import_policy": _ref(af["import_policy"], allowed["policy"]),
            "export_policy": _ref(af["export_policy"], allowed["policy"]),
            "maximum_prefix": af["maximum_prefix"],
            "maximum_prefix_threshold": af["maximum_prefix_threshold"],
            "maximum_prefix_restart": af["maximum_prefix_restart"],
            "maximum_prefix_warning_only": bool(af["maximum_prefix_warning_only"]),
            "route_reflector_client": af["route_reflector_client"],
        })
    port = s.port
    return {
        "id": str(s.id),
        "numid": s.numid,
        "name": s.name or None,
        "node": _own_node(s),
        "vrf": inst.vrf.name if inst.vrf_id else None,
        "local_asn": eff["local_asn"],
        "remote_asn": eff["remote_asn"],
        "local_address": (
            s.local_address.ip_address if s.local_address_id else None
        ),
        "remote_address": s.remote_address or None,
        "interface": port.name if port is not None else None,
        "status_mini": _status_mini(s.status if s.status_id else None, "bgpsession"),
        "peer_group": _ref(s.peer_group if s.peer_group_id else None, allowed["peer_group"]),
        "import_policy": _ref(eff["import_policy"], allowed["policy"]),
        "export_policy": _ref(eff["export_policy"], allowed["policy"]),
        "address_families": afs,
        "maximum_prefix": eff["maximum_prefix"],
        "maximum_prefix_threshold": eff["maximum_prefix_threshold"],
        "maximum_prefix_restart": eff["maximum_prefix_restart"],
        "maximum_prefix_warning_only": bool(eff["maximum_prefix_warning_only"]),
        "bfd": bool(eff["bfd"]),
        "bfd_profile": _ref(eff["bfd_profile"], allowed["bfd"]),
        "keepalive": eff["keepalive"],
        "hold_time": eff["hold_time"],
        "route_reflector_client": bool(eff["route_reflector_client"])
        or any(a["route_reflector_client"] for a in afs),
        "cluster_id": inst.cluster_id or None,
        "rpki_caches": [
            {"id": str(c.id), "name": c.name}
            for c in sorted(inst.rpki_caches.all(), key=lambda c: c.name.lower())
            if c.id in allowed["rpki"]
        ],
    }


def _catalog_grants(user, tenant, sessions):
    """The peer groups, policies, BFD profiles and RPKI caches these
    sessions name that the caller may view. One query a catalog."""
    groups, policies, bfds, caches = set(), set(), set(), set()
    for s in sessions:
        for owner in (s, s.peer_group if s.peer_group_id else None):
            if owner is None:
                continue
            policies.update(x for x in (owner.import_policy_id, owner.export_policy_id) if x)
            if owner.bfd_profile_id:
                bfds.add(owner.bfd_profile_id)
            for af in owner.afs.all():
                policies.update(x for x in (af.import_policy_id, af.export_policy_id) if x)
        if s.peer_group_id:
            groups.add(s.peer_group_id)
        if s.instance.bfd_profile_id:
            bfds.add(s.instance.bfd_profile_id)
        caches.update(c.id for c in s.instance.rpki_caches.all())
    return {
        "peer_group": _viewable_ids(BGPPeerGroup, user, tenant, "bgppeergroup", groups),
        "policy": _viewable_ids(RoutingPolicy, user, tenant, "routingpolicy", policies),
        "bfd": _viewable_ids(BFDProfile, user, tenant, "bfdprofile", bfds),
        "rpki": _viewable_ids(RPKICache, user, tenant, "rpkicache", caches),
    }


def _bgp_lines(sessions, on_map, allowed):
    """eBGP and iBGP lines between nodes on the map (``merge_sessions``),
    each with its sessions' panel rows. An iBGP line with a route reflector
    at one end runs from it to its client (``rr``)."""

    def ends(s):
        a, b = _own_node(s), _peer_node(s)
        if a not in on_map or b not in on_map:
            return None
        return a, b

    out = []
    for e, members in merge_sessions(sessions, ends):
        d = e["data"]
        rows = [_session_row(s, s.effective(), allowed) for s in members]
        d["sessions"] = rows
        vrf_id = members[0].instance.vrf_id
        d["vrf_id"] = str(vrf_id) if vrf_id else None
        kind = d["kind"] or "ebgp"
        e["type"] = kind
        e["id"] = f"{kind}:{e['source']}|{e['target']}|{d['vrf'] or ''}"
        # A route reflector marks its clients: the line runs from it.
        reflectors = {r["node"] for r in rows if r["route_reflector_client"]}
        d["rr"] = None
        if kind == "ibgp" and len(reflectors) == 1:
            rr = reflectors.pop()
            client = e["target"] if rr == e["source"] else e["source"]
            if rr == e["target"]:
                e["source"], e["target"] = e["target"], e["source"]
                d["a_asn"], d["b_asn"] = d["b_asn"], d["a_asn"]
            d["rr"] = {"reflector": rr, "client": client,
                       "cluster_id": next((r["cluster_id"] for r in rows
                                           if r["node"] == rr and r["cluster_id"]), None)}
        d["pairs"] = [{"a": f"AS{d['a_asn']}" if d["a_asn"] is not None else "AS?",
                       "b": f"AS{d['b_asn']}" if d["b_asn"] is not None else "AS?"}]
        # One-sided: only one end defines the session.
        d["one_sided"] = len({r["node"] for r in rows}) == 1
        out.append(e)
    return out


# ─── Circuits and cables ────────────────────────────────────────────────────

def _circuit_lines(graph, user, tenant, scope_q):
    """The Circuits layer, as the Diagram draws it: provider networks with the
    circuits the map's routers are cabled to them by (#466), and circuits
    cabled to two of its routers at both ends. The shim cards carry the
    routing map's own ids (``dev:<id>``, the Diagram's), which the
    site-to-site edges are drawn between."""
    shim = {
        "nodes": [
            {"id": n["id"], "type": "device",
             "data": {"device_id": n["data"]["device_id"]}}
            for n in graph["nodes"] if n["data"].get("device_id")
        ],
        "edges": [],
    }
    topology_provider.add_to_device_graph(shim, user, tenant, scope_q=scope_q)
    nodes = [n for n in shim["nodes"] if n.get("type") == topology_provider.NODE_TYPE]
    return nodes, shim["edges"]


def _cable_graph(tenant, device_ids, scope_q):
    """The cables between these routers, through patch panels (the
    Diagram's collapsed graph), or None for fewer than two."""
    if len(device_ids) < 2:
        return None
    return _build_graph(tenant, device_filter_q=Q(id__in=list(device_ids)),
                        collapse=True, scope_q=scope_q)


def _cable_lines(g, device_ids):
    """The Cables layer: one line per pair of routers cabled together,
    through patch panels, with its cables."""
    if g is None:
        return []
    wanted = {dev_node(i) for i in device_ids}
    pairs: dict[tuple, dict] = {}
    for e in g["edges"]:
        if e.get("type") != "cable" or e["source"] not in wanted or e["target"] not in wanted:
            continue
        key = tuple(sorted((e["source"], e["target"])))
        line = pairs.setdefault(key, {
            "id": f"cable:{key[0]}|{key[1]}",
            "source": key[0],
            "target": key[1],
            "type": "cable",
            "data": {"cables": []},
        })
        data = e["data"]
        pair = (data.get("pairs") or [{}])[0]
        line["data"]["cables"].append({
            "id": data["cable_id"],
            "numid": data.get("cable_numid"),
            "label": data.get("cable_label") or None,
            "a": pair.get("a"),
            "b": pair.get("b"),
        })
    return [pairs[k] for k in sorted(pairs)]


# ─── OSPF and IS-IS ─────────────────────────────────────────────────────────

#: Per IGP: its interface model and RBAC slug.
_IGP = {
    "ospf": (OSPFInterface, "ospfinterface"),
    "isis": (ISISInterface, "isisinterface"),
}


def _igp_ports(kind, user, tenant, instance_ids):
    """The caller's viewable interface rows of these OSPF or IS-IS
    instances, with what their ends read joined. None without the grant."""
    model, slug = _IGP[kind]
    qs = _viewable(model.objects.filter(instance__tenant=tenant), user, tenant, slug)
    if qs is None:
        return None
    if not instance_ids:
        return []
    related = ["instance__vrf", "instance__bfd_profile", "interface", "vm_interface",
               "keychain", "bfd_profile"]
    if kind == "ospf":
        related.append("area")
    return list(qs.filter(instance_id__in=instance_ids).select_related(*related)
                .order_by("id"))


def _port_key(row):
    return ("i", str(row.interface_id)) if row.interface_id else ("v", str(row.vm_interface_id))


def _port_node(row):
    inst = row.instance
    return dev_node(inst.device_id) if inst.device_id else vm_node(inst.virtual_machine_id)


def _cabled_ports(g):
    """``{(interface id, interface id): cable id}`` - the interfaces the
    cable graph joins end to end, through patch panels."""
    out = {}
    for e in (g or {}).get("edges", ()):
        if e.get("type") != "cable":
            continue
        for p in e["data"].get("pairs") or ():
            if p.get("a_kind") == "interface" and p.get("b_kind") == "interface":
                out[tuple(sorted((p["a_id"], p["b_id"])))] = e["data"]["cable_id"]
    return out


def _lags_of(iface_ids):
    """``{member id: its aggregate's id}`` for the cabled interfaces in a
    bundle: an IGP runs on the aggregate, its members carry the cables. One
    query."""
    if not iface_ids:
        return {}
    rows = Interface.objects.filter(id__in=iface_ids, lag__isnull=False)
    return {str(i): str(lag) for i, lag in rows.values_list("id", "lag_id")}


def _port_subnets(tenant, ports):
    """``{port key: {(vrf id, network)}}`` - the subnets each IGP port's
    addresses sit in (host routes left out). One query."""
    ifaces = {r.interface_id for r in ports if r.interface_id}
    vm_ifaces = {r.vm_interface_id for r in ports if r.vm_interface_id}
    if not ifaces and not vm_ifaces:
        return {}
    rows = (
        IPAddress.objects.filter(tenant=tenant)
        .filter(Q(assigned_interface_id__in=ifaces) | Q(assigned_vm_interface_id__in=vm_ifaces))
        .values_list("assigned_interface_id", "assigned_vm_interface_id", "vrf_id",
                     "ip_address", "mask_length", "prefix__cidr")
    )
    out: dict[tuple, set] = {}
    for iface, vm_iface, vrf, address, mask, cidr in rows:
        length = mask
        if length is None and cidr and "/" in cidr:
            length = cidr.rsplit("/", 1)[1]
        try:
            net = ipaddress.ip_network(f"{address}/{length}", strict=False)
        except (TypeError, ValueError):
            continue
        if net.num_addresses <= 1:
            continue
        key = ("i", str(iface)) if iface else ("v", str(vm_iface))
        out.setdefault(key, set()).add((str(vrf) if vrf else "", str(net)))
    return out


def _pair_ports(kind, ports, cabled, lag_of, subnets):
    """The adjacencies among ``ports``: ``(a, b, via, ref)``, ``via`` being
    ``cable`` (``ref`` the cable id) for two ports cabled together (or two
    aggregates whose members are), else ``subnet`` (``ref`` the network) for
    ports of different routers in one subnet. Both ends in one table (and,
    for OSPF, one version)."""
    by_port: dict[tuple, list] = {}
    for r in ports:
        by_port.setdefault(_port_key(r), []).append(r)
    out, seen, taken = [], set(), set()

    def fits(ra, rb):
        if _port_node(ra) == _port_node(rb):
            return False
        if ra.instance.vrf_id != rb.instance.vrf_id:
            return False
        return kind != "ospf" or ra.instance.version == rb.instance.version

    def add(ra, rb, via, ref):
        key = frozenset((ra.id, rb.id))
        if key in seen:
            return
        seen.add(key)
        taken.update((ra.id, rb.id))
        out.append((ra, rb, via, ref))

    for pair in sorted(cabled):
        ends = [pair]
        la, lb = lag_of.get(pair[0]), lag_of.get(pair[1])
        if la and lb and la != lb:
            ends.append((la, lb))
        for x, y in ends:
            for ra in by_port.get(("i", x), ()):
                for rb in by_port.get(("i", y), ()):
                    if fits(ra, rb):
                        add(ra, rb, "cable", cabled[pair])
    # Not cabled to a port of the process: the subnet its addresses share.
    nets: dict[tuple, list] = {}
    for r in ports:
        if r.id in taken:
            continue
        for net in subnets.get(_port_key(r), ()):
            nets.setdefault(net, []).append(r)
    for net in sorted(nets):
        rows = nets[net]
        for i, ra in enumerate(rows):
            for rb in rows[i + 1:]:
                if fits(ra, rb):
                    add(ra, rb, "subnet", net[1])
    return out


def _igp_grants(user, tenant, ports):
    """The keychains, BFD profiles and OSPF areas these ports name that the
    caller may view. One query a catalog."""
    keychains, bfds, areas = set(), set(), set()
    for r in ports:
        if r.keychain_id:
            keychains.add(r.keychain_id)
        if r.bfd_profile_id:
            bfds.add(r.bfd_profile_id)
        if r.instance.bfd_profile_id:
            bfds.add(r.instance.bfd_profile_id)
        if getattr(r, "area_id", None):
            areas.add(r.area_id)
    return {
        "keychain": _viewable_ids(RoutingKeychain, user, tenant, "routingkeychain", keychains),
        "bfd": _viewable_ids(BFDProfile, user, tenant, "bfdprofile", bfds),
        "area": _viewable_ids(OSPFArea, user, tenant, "ospfarea", areas),
    }


def _igp_end(kind, r, allowed):
    """One end of an adjacency as its panel lists it: the interface, its
    costs or metrics, BFD and authentication (the keychain's name, never
    its key)."""
    inst = r.instance
    port = r.port
    bfd_profile = r.bfd_profile if r.bfd_profile_id else (
        inst.bfd_profile if inst.bfd_profile_id else None)
    end = {
        "node": _port_node(r),
        "id": str(r.id),
        "instance_id": str(inst.id),
        "interface": port.name if port is not None else None,
        "interface_id": str(r.interface_id) if r.interface_id else None,
        "vm_interface_id": str(r.vm_interface_id) if r.vm_interface_id else None,
        "network_type": r.network_type or None,
        "bfd": bool(r.bfd or inst.bfd),
        "bfd_profile": _ref(bfd_profile, allowed["bfd"]),
        "authentication": r.authentication if r.authentication != "none" else None,
        "keychain": _ref(r.keychain if r.keychain_id else None, allowed["keychain"]),
    }
    if kind == "ospf":
        passive = r.passive if r.passive is not None else inst.passive_by_default
        end.update({
            "process": inst.process_id or None,
            "area": r.area.area_id,
            "area_ref": _ref(r.area, allowed["area"]),
            "cost": r.cost,
            "priority": r.priority,
            "hello": r.hello,
            "dead": r.dead,
            "mtu": getattr(port, "mtu", None),
            "mtu_ignore": r.mtu_ignore,
            "passive": bool(passive),
        })
    else:
        end.update({
            "process": inst.process or None,
            "level": r.level or inst.level,
            "metric": r.metric,
            "metric_l2": r.metric_l2,
            "hello_interval": r.hello_interval,
            "hello_multiplier": r.hello_multiplier,
            "passive": bool(r.passive),
        })
    return end


_LEVELS = {"1": {"1"}, "2": {"2"}, "1-2": {"1", "2"}}


def isis_adjacency_level(a, b):
    """The level two IS-IS ends meet at - ``1``, ``2`` or ``1-2`` - or None
    when they share none."""
    both = _LEVELS.get(a or "1-2", set()) & _LEVELS.get(b or "1-2", set())
    if not both:
        return None
    return "1-2" if len(both) == 2 else next(iter(both))


def _igp_lines(kind, pairs, allowed):
    """One line per router pair, table and area (OSPF, and version) or
    level (IS-IS), with each adjacency on it as a link."""
    lines: dict[str, dict] = {}
    for ra, rb, via, ref in pairs:
        na, nb = _port_node(ra), _port_node(rb)
        if nb < na:
            ra, rb, na, nb = rb, ra, nb, na
        inst = ra.instance
        vrf_id = str(inst.vrf_id) if inst.vrf_id else None
        a, b = _igp_end(kind, ra, allowed), _igp_end(kind, rb, allowed)
        if kind == "ospf":
            areas = sorted({a["area"], b["area"]})
            sub = f"{'+'.join(areas)}|v{inst.version}"
        else:
            level = isis_adjacency_level(a["level"], b["level"])
            sub = level or "none"
        lid = f"{kind}:{na}|{nb}|{vrf_id or ''}|{sub}"
        line = lines.get(lid)
        if line is None:
            data = {"vrf": inst.vrf.name if inst.vrf_id else None, "vrf_id": vrf_id,
                    "links": []}
            if kind == "ospf":
                data.update({
                    "version": inst.version,
                    "area": areas[0] if len(areas) == 1 else None,
                    "areas": [a["area"], b["area"]],
                    "cost": [a["cost"], b["cost"]],
                })
            else:
                data.update({
                    "level": level,
                    "levels": [a["level"], b["level"]],
                    "metric": [a["metric"], b["metric"]],
                })
            line = lines[lid] = {"id": lid, "source": na, "target": nb, "type": kind,
                                 "data": data}
        line["data"]["links"].append({
            "via": via,
            "cable_id": ref if via == "cable" else None,
            "subnet": ref if via == "subnet" else None,
            "a": a,
            "b": b,
        })
    return [lines[k] for k in sorted(lines)]


# ─── Static routes ──────────────────────────────────────────────────────────

def _static_lines(user, tenant, dev_ids, vm_ids, devices, vms):
    """The Static layer: a route of ``dev_ids`` / ``vm_ids`` whose next hop
    is an address of another box of the candidate set (``devices``,
    ``vms``) - looked up in the route's next-hop table, else its own -
    draws a line from its owner to that box (a card from then on), one per
    pair and table, listing the routes. Two queries; None without the
    grant."""
    qs = _viewable(StaticRoute.objects.filter(tenant=tenant), user, tenant, "staticroute")
    if qs is None:
        return None
    if not dev_ids and not vm_ids:
        return []
    owners = Q(device_id__in=dev_ids) | Q(virtual_machine_id__in=vm_ids)
    rows = list(
        qs.filter(owners).exclude(next_hop="")
        .values_list("id", "numid", "device_id", "virtual_machine_id", "vrf_id",
                     "vrf__name", "next_hop_vrf_id", "prefix", "next_hop", "distance")
        .order_by("prefix", "id")
    )
    if not rows:
        return []
    on = Q(assigned_device__in=devices.values("id"))
    if vms is not None:
        on |= Q(assigned_vm__in=vms.values("id"))
    where: dict[tuple, set] = {}
    hops = IPAddress.objects.filter(tenant=tenant, ip_address__in={r[8] for r in rows})
    for address, vrf, dev, vm in hops.filter(on).values_list(
        "ip_address", "vrf_id", "assigned_device_id", "assigned_vm_id"
    ):
        node = dev_node(dev) if dev else vm_node(vm)
        where.setdefault((str(address), str(vrf) if vrf else ""), set()).add(node)
    lines: dict[tuple, dict] = {}
    for rid, numid, dev, vm, vrf, vrf_name, nh_vrf, prefix, hop, distance in rows:
        own = dev_node(dev) if dev else vm_node(vm)
        table = nh_vrf or vrf
        to = where.get((hop, str(table) if table else ""), set()) - {own}
        if len(to) != 1:
            continue  # off the map, or not one router
        to = to.pop()
        vid = str(vrf) if vrf else ""
        line = lines.get((own, to, vid))
        if line is None:
            line = lines[(own, to, vid)] = {
                "id": f"static:{own}|{to}|{vid}",
                "source": own,
                "target": to,
                "type": "static",
                "data": {"vrf": vrf_name, "vrf_id": vid or None, "count": 0, "routes": []},
            }
        d = line["data"]
        d["count"] += 1
        if len(d["routes"]) < STATIC_ROUTES_SHOWN:
            d["routes"].append({"id": str(rid), "numid": numid, "prefix": prefix,
                                "next_hop": hop, "distance": distance})
    return [lines[k] for k in sorted(lines)]


# ─── VRF and checks ─────────────────────────────────────────────────────────

def _in_table(e, vrf, node_vrfs):
    """Is a routing line in the table drawn? A VRF keeps the global table's
    VPN BGP lines between two routers that run it."""
    if vrf == VRF_ALL:
        return True
    vid = e["data"].get("vrf_id")
    if vrf == VRF_GLOBAL:
        return vid is None
    if vid == vrf:
        return True
    return (
        vid is None
        and e["type"] in ("ebgp", "ibgp")
        and bool(VPN_AFS & set(e["data"].get("address_families") or ()))
        and vrf in node_vrfs.get(e["source"], ())
        and vrf in node_vrfs.get(e["target"], ())
    )


def _as_mismatches(e, cards, name):
    """A BGP line's sessions whose remote AS is not the peer's own: the
    peer's local AS on the line, else the AS its card runs in that table."""
    d = e["data"]
    local: dict[str, set] = {}
    for r in d["sessions"]:
        if r["local_asn"] is not None:
            local.setdefault(r["node"], set()).add(r["local_asn"])
    out = []
    for r in d["sessions"]:
        peer = e["target"] if r["node"] == e["source"] else e["source"]
        known = local.get(peer)
        if not known and peer in cards:
            known = {a["asn"] for a in cards[peer]["data"]["asns"] if a["vrf"] == d["vrf"]}
        if known and r["remote_asn"] is not None and r["remote_asn"] not in known:
            have = "/".join(f"AS{x}" for x in sorted(known))
            out.append(f"{name(r['node'])} expects AS{r['remote_asn']}, "
                       f"{name(peer)} is {have}")
    return out


def _line_problems(e, cards, name):
    """``[(kind, text)]`` - what looks wrong on one line."""
    d = e["data"]
    t = e["type"]
    out = []
    if t in ("ebgp", "ibgp"):
        if d["one_sided"]:
            owner = d["sessions"][0]["node"] if d["sessions"] else e["source"]
            out.append(("bgp_one_sided", f"Session on {name(owner)} only"))
        out += [("bgp_as_mismatch", text) for text in _as_mismatches(e, cards, name)]
    elif t == "ospf":
        for link in d["links"]:
            a, b = link["a"], link["b"]
            ports = f"{name(a['node'])} {a['interface']} ⇄ {name(b['node'])} {b['interface']}"
            if link["via"] == "cable" and a["area"] != b["area"]:
                out.append(("ospf_area", f"Area {a['area']} ⇄ {b['area']} on {ports}"))
            for field, label in (("hello", "Hello"), ("dead", "Dead")):
                if a[field] is not None and b[field] is not None and a[field] != b[field]:
                    out.append(("ospf_timers",
                                f"{label} {a[field]} ⇄ {b[field]} s on {ports}"))
            if (a["mtu"] and b["mtu"] and a["mtu"] != b["mtu"]
                    and not (a["mtu_ignore"] or b["mtu_ignore"])):
                out.append(("ospf_mtu", f"MTU {a['mtu']} ⇄ {b['mtu']} on {ports}"))
    elif t == "isis":
        for link in d["links"]:
            a, b = link["a"], link["b"]
            if link["via"] == "cable" and isis_adjacency_level(a["level"], b["level"]) is None:
                out.append(("isis_level",
                            f"Level {a['level']} ⇄ {b['level']} on {name(a['node'])} "
                            f"{a['interface']} ⇄ {name(b['node'])} {b['interface']}"))
    return out


def _checks(edges, cards):
    """The Checks list over the routing lines drawn; each line's
    ``problems`` lists its kinds."""
    def name(node):
        card = cards.get(node)
        return card["data"]["name"] if card else "?"

    out = []
    for e in edges:
        if e["type"] not in TABLE_LAYERS:
            continue
        found = list(dict.fromkeys(_line_problems(e, cards, name)))
        e["data"]["problems"] = list(dict.fromkeys(k for k, _ in found))
        for i, (kind, text) in enumerate(found):
            out.append({
                "id": f"{e['id']}#{i}",
                "kind": kind,
                "edge": e["id"],
                "layer": e["type"],
                "title": f"{name(e['source'])} ⇄ {name(e['target'])}",
                "text": text,
            })
    return out


# ─── The view ───────────────────────────────────────────────────────────────

def _focus(nodes, edges, focus, depth):
    """The nodes within ``depth`` routing hops of ``focus``."""
    adj: dict[str, set] = {}
    for e in edges:
        adj.setdefault(e["source"], set()).add(e["target"])
        adj.setdefault(e["target"], set()).add(e["source"])
    keep = {focus}
    queue = deque([(focus, 0)])
    while queue:
        n, d = queue.popleft()
        if d >= depth:
            continue
        for m in adj.get(n, ()):
            if m not in keep:
                keep.add(m)
                queue.append((m, d + 1))
    return keep


def build_routing_map(user, tenant, params):
    """The payload; ``params`` is the map's query (a dict or QueryDict)."""
    dev_q = rbac.row_filter(user, tenant, "device", "view")
    if dev_q is None:
        return None
    scope_q = None if dev_q is True else dev_q
    focus = _uuid_param(params, "device")
    device_ids = _uuid_list_param(params, "devices")
    chassis_ids = _uuid_list_param(params, "chassis", limit=MAX_CHASSIS_SET)
    filter_q = _filter_q(params)
    depth = _depth_param(params)
    layers = _layers_param(params)
    vrf = _vrf_param(params)
    custom_set = "devices" in params and params.get("devices") is not None

    # The candidate set: what the map's filters (or its hand-picked set)
    # let in, within the caller's scope. A focus starts from all of it.
    devices = Device.objects.filter(tenant=tenant)
    if scope_q is not None:
        devices = devices.filter(scope_q)
    vms = _viewable(VirtualMachine.objects.filter(tenant=tenant), user, tenant,
                    "virtualmachine")
    if custom_set:
        set_q = Q(id__in=device_ids)
        placed = _placed_chassis_q(user, tenant, chassis_ids)
        if placed is not None:
            set_q |= placed
        devices = devices.filter(set_q)
        vms = None  # a hand-picked set names devices
    elif not focus:
        devices = devices.filter(filter_q)
        if vms is not None:
            if params.get("location"):
                vms = None  # a VM has no location
            else:
                vms = vms.filter(filter_q)

    processes, bgp_rows, tables = _instances(user, tenant, devices, vms)

    # BGP before the cards: a peer at the far end of a session is a card
    # too, routing process or not.
    want_bgp = bool(layers & {"ebgp", "ibgp"})
    sessions = (
        (_sessions(user, tenant, [inst.id for _, inst in bgp_rows]) or [])
        if want_bgp and bgp_rows else []
    )
    peers = {_peer_node(s) for s in sessions} - {None}

    def ids_of(prefix, nodes):
        return {n[len(prefix):] for n in nodes if n.startswith(prefix)}

    def can(*slugs):
        return all(rbac.has_action(user, tenant, s, "view") for s in slugs)

    bgp_ok = can("bgpsession")
    grants = {
        "ebgp": bgp_ok,
        "ibgp": bgp_ok,
        "ospf": can("ospfinstance", "ospfinterface"),
        "isis": can("isisinstance", "isisinterface"),
        "static": can("staticroute"),
        "circuits": can("circuit", "providernetwork", "site"),
        "cables": True,
    }

    # Static routes before the cards too: the box a next hop is on is a
    # card while a line in the table drawn runs to it.
    static = []
    if "static" in layers and grants["static"]:
        owners = {n for n, rows in processes.items()
                  if any(p["kind"] == "static" for p in rows)}
        static = [
            e for e in _static_lines(user, tenant, list(ids_of("dev:", owners)),
                                     list(ids_of("vm:", owners)), devices, vms) or []
            if _in_table(e, vrf, tables["node_vrfs"])
        ]

    wanted = set(processes) | peers | {e["target"] for e in static}
    dev_rows = list(
        devices.filter(id__in=ids_of("dev:", wanted))
        .select_related("role", "status", "site", "primary_ip")
    )
    vm_rows = list(
        vms.filter(id__in=ids_of("vm:", wanted)).select_related("role", "status", "site")
    ) if vms is not None else []
    cards = {}
    for kind, rows in (("device", dev_rows), ("vm", vm_rows)):
        for obj in rows:
            card = _router_card(kind, obj)
            _fill_card(card, processes.get(card["id"], []))
            cards[card["id"]] = card

    allowed = _catalog_grants(user, tenant, sessions) if sessions else None
    bgp = _bgp_lines(sessions, set(cards), allowed) if sessions else []

    # A box with no process of its own sits in the AS its peers name.
    named = Counter()
    for e in bgp:
        for node, asn in ((e["source"], e["data"]["a_asn"]), (e["target"], e["data"]["b_asn"])):
            if asn is not None and not cards[node]["data"]["as_group"]:
                named[(node, asn)] += 1
    for (node, asn), _n in sorted(named.items(), key=lambda kv: (-kv[1], kv[0])):
        d = cards[node]["data"]
        if d["as_group"] is None:
            d["as_group"] = asn

    # The IGPs: their ports paired by the cables between the routers
    # (through patch panels), else by a shared subnet.
    card_devs = ids_of("dev:", cards)
    want_igp = [k for k in ("ospf", "isis") if k in layers and grants[k]]
    cable_graph = (
        _cable_graph(tenant, card_devs, scope_q)
        if want_igp or "cables" in layers else None
    )
    ports = {}
    for kind in want_igp:
        rows = _igp_ports(kind, user, tenant, tables["ids"][kind])
        if rows:
            ports[kind] = rows
    igp = []
    if ports:
        every = [r for rows in ports.values() for r in rows]
        cabled = _cabled_ports(cable_graph)
        lag_of = _lags_of({i for pair in cabled for i in pair})
        subnets = _port_subnets(tenant, every)
        igp_allowed = _igp_grants(user, tenant, every)
        for kind, rows in ports.items():
            pairs = [
                p for p in _pair_ports(kind, rows, cabled, lag_of, subnets)
                if _port_node(p[0]) in cards and _port_node(p[1]) in cards
            ]
            igp += _igp_lines(kind, pairs, igp_allowed)
    static = [e for e in static if e["source"] in cards and e["target"] in cards]

    # The routing lines asked for, in the table drawn.
    routed = [
        e for e in [*bgp, *igp, *static]
        if e["type"] in layers and grants[e["type"]]
        and _in_table(e, vrf, tables["node_vrfs"])
    ]

    if focus:
        keep = _focus(cards, routed, dev_node(focus), depth)
        cards = {k: v for k, v in cards.items() if k in keep}
        routed = [e for e in routed if e["source"] in keep and e["target"] in keep]

    loops = _loopbacks(user, tenant, list(ids_of("dev:", cards)), list(ids_of("vm:", cards)))
    for node, address in loops.items():
        if node in cards:
            cards[node]["data"]["loopback"] = address

    nodes = sorted(cards.values(), key=lambda n: (n["data"]["name"].lower(), n["id"]))
    graph = {"nodes": nodes, "edges": list(routed)}
    if "circuits" in layers and grants["circuits"]:
        pn_nodes, circuit_edges = _circuit_lines(graph, user, tenant, scope_q)
        graph["nodes"] += pn_nodes
        graph["edges"] += circuit_edges
    if "cables" in layers:
        graph["edges"] += _cable_lines(cable_graph, ids_of("dev:", cards))
    graph["checks"] = _checks(routed, cards)

    # The AS boxes: one per local AS, its cards and the ASN's own row.
    members: dict[int, list] = {}
    for n in cards.values():
        asn = n["data"]["as_group"]
        if asn is not None:
            members.setdefault(asn, []).append(n["id"])
    asn_rows = {}
    if members:
        qs = _viewable(ASN.objects.filter(tenant=tenant, asn__in=list(members)),
                       user, tenant, "asn")
        if qs is not None:
            asn_rows = {a.asn: a for a in qs}
    graph["as_groups"] = [
        {
            "id": f"as:{asn}",
            "asn": asn,
            "asn_id": str(asn_rows[asn].id) if asn in asn_rows else None,
            "name": (
                (asn_rows[asn].description or "").strip().splitlines()[0][:120]
                if asn in asn_rows and (asn_rows[asn].description or "").strip()
                else None
            ),
            "nodes": ids,
        }
        for asn, ids in sorted(members.items())
    ]
    graph["meta"] = {
        "layers": {k: bool(grants[k]) for k in LAYERS},
        "requested": sorted(layers),
        "vrf": vrf,
        "vrfs": [
            {"id": vid, "name": name, "color": color or None}
            for vid, (name, color) in sorted(tables["vrfs"].items(),
                                             key=lambda kv: (kv[1][0].lower(), kv[0]))
        ],
    }
    return graph


_PARAMS = [
    OpenApiParameter(name=n, type=OpenApiTypes.STR, location=OpenApiParameter.QUERY,
                     description=d)
    for n, d in (
        ("site", "Filter by site id."),
        ("location", "Filter by location id (devices only)."),
        ("role", "Filter by role id."),
        ("status", "Filter by status id."),
        ("tag", "Filter by tag slug."),
        ("devices", "Comma-separated device ids: a hand-picked map."),
        ("chassis", "With `devices`: virtual chassis whose members join it."),
        ("device", "Focus on one router and its routing neighbours."),
        ("depth", f"Routing hops around the focus (1-{MAX_DEPTH}, default 1)."),
        ("layers", "Comma-separated lines: ebgp, ibgp, ospf, isis, static, "
                   "circuits, cables (default all but cables)."),
        ("vrf", "The table the routing lines are drawn for: all (default), global, "
                "or a VRF id."),
    )
]


@extend_schema(
    summary="The topology map's routing picture",
    description=(
        "Routers (devices and VMs with a routing process), AS groups, lines "
        "per layer (eBGP, iBGP, OSPF, IS-IS, static, circuits, cables) and "
        "the checks over them. Same query as `/api/topology/`; POST takes it "
        "as a JSON body."
    ),
    parameters=_PARAMS,
    request=OpenApiTypes.OBJECT,
    responses=OpenApiTypes.OBJECT,
    tags=["topology"],
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def routing_topology_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"nodes": [], "edges": [], "as_groups": [], "checks": [],
                         "meta": {"layers": {k: False for k in LAYERS}, "requested": [],
                                  "vrf": VRF_ALL, "vrfs": []}})
    graph = build_routing_map(request.user, tenant, _query_params(request))
    if graph is None:
        return Response({"detail": "device.view required."}, status=403)
    return Response(graph)
