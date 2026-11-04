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
  running from it to its client), ``circuit`` and ``cable``;
* ``meta.layers`` - which layers the caller may see.

The query is the Diagram's (``/api/topology/``): ``site location role status
tag`` narrow the set, ``devices`` (with ``chassis``) is a hand-picked map and
``device``/``depth`` focuses on one router and its BGP neighbours that many
hops out. ``layers`` names the lines wanted (default every one but
``cables``).

RBAC: ``device.view`` for a card (``virtualmachine.view`` for a VM); a
router shows only the processes the caller may view. A line needs both ends
on the map, plus per layer: ``bgpsession.view`` for eBGP and iBGP, the
circuit, provider network and site grants for circuits, nothing more for
cables. A missing grant hides that layer, never the map. Everything is
inside the active tenant, and the cost is a fixed number of queries
whatever the size of the map.

Extension points: the OSPF, IS-IS and static layers (and a VRF picker)
add a builder next to ``_bgp_lines`` and a name to ``LAYERS``; the
site-to-site circuit lines of the Diagram join ``_circuit_lines``.
"""
from __future__ import annotations

from collections import Counter, deque

from django.db.models import Prefetch, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api import topology_provider
from api.models import ASN, Device, IPAddress, VirtualMachine
from api.topology_views import (
    MAX_CHASSIS_SET,
    MAX_DEPTH,
    _build_graph,
    _csv_param,
    _filter_q,
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
    LDPInstance,
    OSPFInstance,
    RoutingPolicy,
    RPKICache,
    StaticRoute,
    effective_afs,
)
from .topology import merge_sessions

#: The line layers, in legend order. Each is an edge ``type`` too.
LAYERS = ("ebgp", "ibgp", "circuits", "cables")
#: What a map draws unless it names its layers: cables are the Diagram's
#: subject, faint here and off until asked for.
DEFAULT_LAYERS = frozenset({"ebgp", "ibgp", "circuits"})

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
    (querysets of the candidate set), as ``{node id: [process]}``. One query
    per process kind, plus one for static routes."""
    by_node: dict[str, list] = {}
    bgp_rows = []
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
            if kind == "bgp":
                row["asn"] = inst.asn.asn
                row["asn_id"] = str(inst.asn_id)
                row["cluster_id"] = inst.cluster_id or None
                bgp_rows.append((node, inst))
            by_node.setdefault(node, []).append(row)
    static = _viewable(StaticRoute.objects.filter(tenant=tenant), user, tenant, "staticroute")
    if static is not None:
        counts = Counter()
        for dev, vm in static.filter(owner).values_list("device_id", "virtual_machine_id"):
            counts[dev_node(dev) if dev else vm_node(vm)] += 1
        for node, n in counts.items():
            by_node.setdefault(node, []).append(
                {"kind": "static", "id": None, "vrf": None, "router_id": None,
                 "count": n}
            )
    order = {"bgp": 0, "ospf": 1, "isis": 2, "eigrp": 3, "ldp": 4, "static": 5}
    for rows in by_node.values():
        rows.sort(key=lambda r: (order[r["kind"]], r["vrf"] or "", r["id"] or ""))
    return by_node, bgp_rows


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


def _cable_lines(tenant, device_ids, scope_q):
    """The Cables layer: one line per pair of routers cabled together,
    through patch panels, with its cables."""
    if len(device_ids) < 2:
        return []
    g = _build_graph(tenant, device_filter_q=Q(id__in=list(device_ids)),
                     collapse=True, scope_q=scope_q)
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


# ─── The view ───────────────────────────────────────────────────────────────

def _focus(nodes, edges, focus, depth):
    """The nodes within ``depth`` BGP hops of ``focus``."""
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

    processes, bgp_rows = _instances(user, tenant, devices, vms)

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

    wanted = set(processes) | peers
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

    if focus:
        keep = _focus(cards, bgp, dev_node(focus), depth)
        cards = {k: v for k, v in cards.items() if k in keep}
        bgp = [e for e in bgp if e["source"] in keep and e["target"] in keep]

    loops = _loopbacks(user, tenant, list(ids_of("dev:", cards)), list(ids_of("vm:", cards)))
    for node, address in loops.items():
        if node in cards:
            cards[node]["data"]["loopback"] = address

    nodes = sorted(cards.values(), key=lambda n: (n["data"]["name"].lower(), n["id"]))
    graph = {"nodes": nodes, "edges": []}
    bgp_ok = rbac.has_action(user, tenant, "bgpsession", "view")
    grants = {
        "ebgp": bgp_ok,
        "ibgp": bgp_ok,
        "circuits": all(
            rbac.has_action(user, tenant, s, "view")
            for s in ("circuit", "providernetwork", "site")
        ),
        "cables": True,
    }
    for e in bgp:
        if e["type"] in layers:
            graph["edges"].append(e)
    if "circuits" in layers and grants["circuits"]:
        pn_nodes, circuit_edges = _circuit_lines(graph, user, tenant, scope_q)
        graph["nodes"] += pn_nodes
        graph["edges"] += circuit_edges
    if "cables" in layers:
        graph["edges"] += _cable_lines(tenant, ids_of("dev:", cards), scope_q)

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
        ("device", "Focus on one router and its BGP neighbours."),
        ("depth", f"BGP hops around the focus (1-{MAX_DEPTH}, default 1)."),
        ("layers", "Comma-separated lines: ebgp, ibgp, circuits, cables "
                   "(default all but cables)."),
    )
]


@extend_schema(
    summary="The topology map's routing picture",
    description=(
        "Routers (devices and VMs with a routing process), AS groups and "
        "lines per layer (eBGP, iBGP, circuits, cables). Same query as "
        "`/api/topology/`; POST takes it as a JSON body."
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
        return Response({"nodes": [], "edges": [], "as_groups": [],
                         "meta": {"layers": {k: False for k in LAYERS}, "requested": []}})
    graph = build_routing_map(request.user, tenant, _query_params(request))
    if graph is None:
        return Response({"detail": "device.view required."}, status=403)
    return Response(graph)
