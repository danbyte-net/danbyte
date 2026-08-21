"""Network topology graph v2 for the React Flow map.

``GET /api/topology/`` → ``{nodes, edges}``.

Nodes are devices rendered as *stencil cards*: each carries its cabled ports
(so edges anchor port-to-port, like a wiring diagram), role color, primary IP
and a ``panel`` flag (pass-through-only device).

Edges are cables. Two modes:

* ``collapse_panels=1`` (default) - patch panels are walked *through*
  (front→rear strand→cable→…) so an edge runs interface-to-interface
  end-to-end, annotated with the panels it passed (``via``). Panel-only
  devices drop off the map.
* ``collapse_panels=0`` - raw physical hops; panels appear as nodes.

Filters: ``site`` ``location`` ``role`` ``status`` ``tag`` narrow the device
set. ``device=<id>&depth=N`` focuses the graph on one device's neighbourhood
(BFS over the edge list, default depth 1, neighbours pulled in even when
outside the filter scope).
"""
from __future__ import annotations

from collections import deque

from django.db.models import Count, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Cable, Device
from .views import _get_active_tenant
from auth_api import rbac

MAX_DEPTH = 6


# ─── Node payload ────────────────────────────────────────────────────────────

def _devices_qs(tenant):
    return (
        Device.objects.filter(tenant=tenant)
        .select_related("device_type", "site", "location", "role",
                        "status", "primary_ip")
        .annotate(ic=Count("interfaces", distinct=True))
    )


def _device_node(d, ports, panel=False):
    """``ports`` = ordered [{name, kind, pair?}] of this device's cabled ends
    - ``pair`` names the rear port sharing the row (front ⇄ rear strand)."""
    # Faceplate-photo view inputs: the device type's front image and the
    # image-port markers matching this node's cabled ports, so a cable can
    # plug into its true position on the photo.
    dt = d.device_type if d.device_type_id else None
    front_image = None
    markers = []
    if dt is not None and dt.front_image:
        try:
            front_image = dt.front_image.url
        except ValueError:
            front_image = None
    if front_image:
        cabled = {p["name"] for p in ports}
        cabled |= {p["pair"] for p in ports if p.get("pair")}
        markers = [
            m for m in (dt.image_ports or {}).get("front", []) or []
            if m.get("name") in cabled
        ]
    return {
        "id": f"dev:{d.id}",
        "type": "device",
        "data": {
            "device_id": str(d.id),
            "name": d.name,
            "status": d.status.slug if d.status_id else None,
            "status_display": d.status.name if d.status_id else "",
            "device_type": d.device_type.name if d.device_type_id else None,
            "role": (
                {"name": d.role.name, "color": d.role.color,
                 "is_patch_panel": d.role.is_patch_panel}
                if d.role_id else None
            ),
            "site": d.site.name if d.site_id else None,
            "location": d.location.name if d.location_id else None,
            "primary_ip": d.primary_ip.ip_address if d.primary_ip_id else None,
            "interface_count": getattr(d, "ic", 0),
            "panel": panel,
            "ports": ports,
            "u_height": dt.u_height if dt is not None else 1,
            "front_image": front_image,
            "image_ports": markers,
        },
    }


# ─── Cable endpoints ─────────────────────────────────────────────────────────

# Point classification + the pass-through walk live in the shared module so
# this builder and api/trace.py can't drift (they did once - see plan A1).
from .cable_points import (  # noqa: E402
    KIND_OF as _KIND_OF,
    POINT_ATTRS as _POINT_ATTRS,
    strand_of as _shared_strand_of,
    term_point as _term_point,
)


# A power feed terminates on a PowerPanel, not a device - it has no `device`
# relation to prefetch and no place in device↔device topology. Prefetch the
# device chain only for the device-bearing points; pull the power feed itself
# without a device lookup (an invalid `power_feed__device` prefetch 500s the
# paths endpoint for any cable that terminates on a power feed).
_DEVICE_POINT_ATTRS = tuple(a for a in _POINT_ATTRS if a != "power_feed")


def _cables_qs(tenant):
    return (
        Cable.objects.filter(tenant=tenant)
        .select_related("status")
        .prefetch_related(
            *[f"terminations__{a}__device" for a in _DEVICE_POINT_ATTRS],
            "terminations__power_feed",
            "terminations__front_port__rear_port",
        )
    )


def _physical_links(tenant):
    """Every device↔device hop a cable makes, with its port names/kinds.

    Returns ``[(cable, dev_a, port_a, kind_a, dev_b, port_b, kind_b)]``.
    """
    links = []
    for cab in _cables_qs(tenant):
        a_ends, b_ends = [], []
        for t in cab.terminations.all():
            kind, obj = _term_point(t)
            # Only device-bearing endpoints form device↔device links; skip a
            # power feed (it terminates on a PowerPanel, which has no device_id).
            if obj is None or getattr(obj, "device_id", None) is None:
                continue
            (a_ends if t.end == "A" else b_ends).append((kind, obj))
        for ka, pa in a_ends:
            for kb, pb in b_ends:
                if pa.device_id == pb.device_id:
                    continue
                links.append((cab, pa.device, pa, ka, pb.device, pb, kb))
    return links


# ─── Panel collapse ─────────────────────────────────────────────────────────

def _strand_of(port, kind, position=1):
    """The opposite side of an internal pass-through, or None for a leaf.
    Front↔rear (patch panel) and outlet→inlet (PDU) - see cable_points.
    A returned partner with ``obj is None`` means the mapping exists but the
    far port is missing (dangling strand); the collapse walk treats that as
    "stop here, keep the node"."""
    strand = _shared_strand_of(kind, port, position)
    if strand is None:
        return None
    pk, obj, pos = strand
    return None if obj is None else (pk, obj, pos)


def _is_splitter_side(kind, port):
    """True when the port belongs to a splitter (the rear input or any front
    output). Splitters are real endpoints in every linear walk - one input
    fans out to N outputs, so 'walking through' with a single partner would
    silently pick one branch and fabricate a path."""
    if kind == "rear_port":
        return port.is_splitter
    if kind == "front_port":
        return port.rear_port.is_splitter
    return False


def _collapse(links):
    """Walk each link that lands on a panel port through the panel until it
    reaches a non-pass-through endpoint. Emits end-to-end links + the set of
    panel device ids that were consumed."""
    # Index cables by (port kind, port id) for the walk.
    by_port = {}
    for link in links:
        cab, da, pa, ka, db, pb, kb = link
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    def walk(kind, port, device, position=1, seen=None):
        """From a panel-side endpoint, cross the panel + next cable until a
        non-panel end. Returns (device, port, kind, [panel names]) or None."""
        seen = seen or set()
        vias = []
        while kind in ("front_port", "rear_port"):
            if _is_splitter_side(kind, port):
                # A splitter reached through panels is the walk's endpoint -
                # its fan-out is drawn as its own edges, never collapsed.
                return (device, port, kind, vias)
            if port.id in seen:
                return None  # loop guard
            seen.add(port.id)
            vias.append(device.name)
            strand = _strand_of(port, kind, position)
            if strand is None:
                return (device, port, kind, vias[:-1])  # dangling panel port
            skind, sport, spos = strand
            hops = by_port.get((skind, sport.id), [])
            if not hops:
                # Pass-through wired but the far side of the panel is uncabled
                # - the path ends *at the panel*.
                return (device, sport, skind, vias[:-1])
            _, device, port, kind = hops[0]
            position = spos
        return (device, port, kind, vias)

    out = []
    consumed_panels = set()
    emitted = set()
    for cab, da, pa, ka, db, pb, kb in links:
        a_panel = ka in ("front_port", "rear_port") and not _is_splitter_side(ka, pa)
        b_panel = kb in ("front_port", "rear_port") and not _is_splitter_side(kb, pb)
        if not a_panel and not b_panel:
            out.append((cab, da, pa, ka, db, pb, kb, []))
            continue
        if a_panel and b_panel:
            continue  # panel-to-panel mid-segments are covered by the walks
        # One end is a real component, the other a panel - walk through.
        if a_panel:
            da, pa, ka, db, pb, kb = db, pb, kb, da, pa, ka
        res = walk(kb, pb, db)
        if res is None:
            continue
        end_dev, end_port, end_kind, vias = res
        if end_dev.id == da.id:
            continue
        key = tuple(sorted((f"{ka}:{pa.id}", f"{end_kind}:{end_port.id}")))
        if key in emitted:
            continue
        emitted.add(key)
        consumed_panels.update(vias)
        out.append((cab, da, pa, ka, end_dev, end_port, end_kind, vias))
    return out, consumed_panels


# ─── Graph assembly ─────────────────────────────────────────────────────────

def device_scope_q(user, tenant):
    """A ``Q`` bounding devices to the caller's ``device.view`` row/site scope,
    or ``None`` when unrestricted (superuser / unscoped grant). Feed into the
    graph builders' ``scope_q``."""
    from auth_api import rbac

    q = rbac.row_filter(user, tenant, "device", "view")
    return q if (q is not None and q is not True) else None


def viewable_device_ids(user, tenant):
    """Set of device pks the caller may view (for redaction in device_paths)."""
    from auth_api import rbac

    return set(
        rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant), user, tenant, "device", "view"
        ).values_list("id", flat=True)
    )


def _build_graph(tenant, device_filter_q=None, focus_id=None, depth=1,
                 collapse=True, scope_q=None):
    links = _physical_links(tenant)
    # Remove hidden devices before panel-collapse walks are assembled. Filtering
    # only final endpoints allowed an otherwise visible edge to retain a hidden
    # patch panel's name in via.
    if scope_q is not None:
        allowed_ids = set(
            _devices_qs(tenant).filter(scope_q).values_list("id", flat=True)
        )
        links = [
            link for link in links
            if link[1].id in allowed_ids and link[4].id in allowed_ids
        ]
    # Pre-collapse: which devices are pure pass-throughs (only front/rear
    # ports cabled)? When their strands are consumed by the collapse they'd
    # otherwise linger as portless, disconnected cards.
    raw_kinds: dict = {}
    for _cab, da, _pa, ka, db, _pb, kb in links:
        raw_kinds.setdefault(str(da.id), set()).add(ka)
        raw_kinds.setdefault(str(db.id), set()).add(kb)
    passthrough_ids = {
        did for did, kinds in raw_kinds.items()
        if kinds <= {"front_port", "rear_port"}
    }
    # Focusing the map ON a patch panel: collapse walks it *through* and then
    # drops the portless husk, leaving an empty graph even though the panel has
    # cables. Show its raw front/rear hops so the panel and the devices cabled
    # to it appear (the device page's Map tab and ?device=<panel>).
    if focus_id and collapse and focus_id in passthrough_ids:
        collapse = False
    if collapse:
        links, _ = _collapse(links)
    else:
        links = [link + ([],) for link in links]

    # Aggregate hops → device-pair edges (one edge per cable per pair).
    edges = {}
    # device id → ordered {port name: (kind, port object)}
    port_sets: dict[str, dict] = {}

    def note_port(dev, port, kind):
        d = port_sets.setdefault(str(dev.id), {})
        if port.name not in d:
            d[port.name] = (_KIND_OF.get(kind, "interface"), port)

    for cab, da, pa, ka, db, pb, kb, vias in links:
        note_port(da, pa, ka)
        note_port(db, pb, kb)
        ids = sorted((str(da.id), str(db.id)))
        key = (ids[0], ids[1], str(cab.id))
        if key not in edges:
            src, dst = (da, db) if str(da.id) == ids[0] else (db, da)
            edges[key] = {
                "id": f"e:{cab.id}:{ids[0]}:{ids[1]}",
                "source": f"dev:{src.id}",
                "target": f"dev:{dst.id}",
                "type": "cable",
                "data": {
                    "cable_id": str(cab.id),
                    "cable_numid": cab.numid,
                    "cable_type": cab.type,
                    "cable_label": cab.label,
                    "color": cab.color,
                    "status": cab.status.slug if cab.status_id else None,
                    "length": str(cab.length) if cab.length is not None else None,
                    "length_unit": cab.length_unit,
                    "speed": None,
                    "via": vias,
                    "pairs": [],
                },
            }
        e = edges[key]
        src_is_a = e["source"] == f"dev:{da.id}"
        a_port, b_port = (pa.name, pb.name) if src_is_a else (pb.name, pa.name)
        e["data"]["pairs"].append({
            "a": f"{da.name if src_is_a else db.name}:{a_port}",
            "b": f"{db.name if src_is_a else da.name}:{b_port}",
            "a_port": a_port,
            "b_port": b_port,
        })
        # Link speed from either endpoint interface (first non-empty wins) -
        # front/rear panel ports have no speed.
        if not e["data"].get("speed"):
            spd = getattr(pa, "speed", "") or getattr(pb, "speed", "")
            if spd:
                e["data"]["speed"] = spd

    edge_list = list(edges.values())

    # Scope: filtered devices, or the focus device's N-hop neighbourhood.
    base = _devices_qs(tenant)
    if device_filter_q is not None:
        base = base.filter(device_filter_q)
    # RBAC row/site scope - a Site-A viewer's graph must contain only devices
    # they may view (applied to *both* the filtered and focus paths).
    if scope_q is not None:
        base = base.filter(scope_q)
    in_scope = {str(d.id): d for d in base}

    if focus_id:
        adj: dict[str, set] = {}
        for e in edge_list:
            s = e["source"][4:]
            t = e["target"][4:]
            adj.setdefault(s, set()).add(t)
            adj.setdefault(t, set()).add(s)
        keep = {focus_id}
        frontier = deque([(focus_id, 0)])
        while frontier:
            nid, d = frontier.popleft()
            if d >= depth:
                continue
            for nb in adj.get(nid, ()):
                if nb not in keep:
                    keep.add(nb)
                    frontier.append((nb, d + 1))
        focus_qs = _devices_qs(tenant).filter(id__in=keep)
        # The focus path rebuilds the device set from the BFS neighbourhood -
        # re-apply the RBAC row/site scope here too, or a Site-A viewer could
        # focus a known Site-B UUID and pull it + its neighbours.
        if scope_q is not None:
            focus_qs = focus_qs.filter(scope_q)
        in_scope = {str(d.id): d for d in focus_qs}

    edge_list = [
        e for e in edge_list
        if e["source"][4:] in in_scope and e["target"][4:] in in_scope
    ]

    # Panel flag: a device is a "panel" when every cabled end on it is a
    # front/rear port (pure pass-through). Uncabled devices aren't panels.
    # In collapse mode, panels whose runs were fully walked through carry no
    # ports anymore - drop them instead of showing disconnected husks
    # (panels that remain endpoints of dangling runs keep their node).
    nodes = []
    for did, d in in_scope.items():
        if collapse and did in passthrough_ids and did not in port_sets:
            continue
        by_name = port_sets.get(did, {})
        role_panel = bool(d.role_id and d.role.is_patch_panel)
        panel = role_panel or (
            bool(by_name) and all(
                k in ("front", "rear") for k, _ in by_name.values()
            )
        )
        # Merge a cabled front port with its strand's cabled rear port into
        # one continuous pass-through row (front ⇄ rear). A rear trunk pairs
        # with its first front; the rest render solo.
        consumed_rears: set[str] = set()
        ports = []
        for name, (kind, obj) in by_name.items():
            if kind != "front":
                continue
            rname = obj.rear_port.name if obj.rear_port_id else None
            if rname and rname in by_name and rname not in consumed_rears                     and by_name[rname][0] == "rear":
                consumed_rears.add(rname)
                ports.append({"name": name, "kind": kind, "pair": rname})
            else:
                ports.append({"name": name, "kind": kind})
        for name, (kind, obj) in by_name.items():
            if kind == "front" or name in consumed_rears:
                continue
            ports.append({"name": name, "kind": kind})
        nodes.append(_device_node(d, ports, panel=panel))

    return {"nodes": nodes, "edges": edge_list}


@extend_schema(
    summary="Logical (VLAN-rail) topology - devices and VMs on their VLANs",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(name="site", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit physical devices to a site id."),
        OpenApiParameter(name="role", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit physical devices to a role id."),
        OpenApiParameter(name="vlan_group", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit rails to one VLAN group id."),
        OpenApiParameter(name="include_vms", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="'0' hides virtual machines (default on)."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "`{rails, nodes}` - VLANs as rails (id, vlan_id, name, effective "
            "color, group) and attached devices/VMs with per-interface "
            "attachments ({rail, iface, tagged}). Hybrid physical + virtual, "
            "RBAC-scoped."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_logical_view(request):
    """The L2 picture: VLANs as rails, everything attached to them - physical
    devices via Interface.vlan/tagged_vlans, VMs via VMInterface -
    on one hybrid diagram. Rail color = the VLAN's own color, else its
    zone's."""
    from .models import VLAN, Device, Interface, VirtualMachine, VMInterface

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"rails": [], "nodes": []})
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)

    p = request.query_params
    devs = Device.objects.filter(tenant=tenant)
    if dev_q is not True:
        devs = devs.filter(dev_q)
    if p.get("site"):
        devs = devs.filter(site_id=p["site"])
    if p.get("role"):
        devs = devs.filter(role_id=p["role"])

    nodes: dict = {}
    rail_ids: set = set()

    def add(kind, obj_id, name, status, sub, vlan_id, iface, tagged):
        key = f"{kind}:{obj_id}"
        n = nodes.setdefault(key, {
            "kind": kind, "id": str(obj_id), "name": name,
            "status": status, "sub": sub, "attachments": [],
        })
        n["attachments"].append(
            {"rail": str(vlan_id), "iface": iface, "tagged": tagged}
        )
        rail_ids.add(vlan_id)

    ifaces = (
        Interface.objects.filter(device__in=devs)
        .filter(Q(vlan__isnull=False) | Q(tagged_vlans__isnull=False))
        .select_related("device__role", "device__status")
        .prefetch_related("tagged_vlans")
        .distinct()
    )
    for i in ifaces:
        d = i.device
        status = d.status.name if d.status_id else None
        sub = d.role.name if d.role_id else None
        if i.vlan_id:
            add("device", d.id, d.name, status, sub, i.vlan_id, i.name, False)
        for v in i.tagged_vlans.all():
            add("device", d.id, d.name, status, sub, v.id, i.name, True)

    if p.get("include_vms", "1") != "0":
        vms = rbac.restrict_queryset(
            VirtualMachine.objects.filter(tenant=tenant),
            request.user, tenant, "virtualmachine", "view",
        )
        # A site filter bounds VMs too - and a VM with no site is NOT "every
        # site", it's unknown, so it drops out of a site-scoped view.
        if p.get("site"):
            vms = vms.filter(site_id=p["site"])
        vifs = (
            VMInterface.objects.filter(vm__in=vms)
            .filter(Q(vlan__isnull=False) | Q(tagged_vlans__isnull=False))
            .select_related("vm__status", "vm__cluster")
            .prefetch_related("tagged_vlans")
            .distinct()
        )
        for i in vifs:
            vm = i.vm
            status = vm.status.name if vm.status_id else None
            sub = vm.cluster.name if vm.cluster_id else None
            if i.vlan_id:
                add("vm", vm.id, vm.name, status, sub, i.vlan_id, i.name, False)
            for v in i.tagged_vlans.all():
                add("vm", vm.id, vm.name, status, sub, v.id, i.name, True)

    vlans = (
        VLAN.objects.filter(id__in=rail_ids)
        .select_related("zone", "group")
        .order_by("vlan_id")
    )
    if p.get("vlan_group"):
        vlans = vlans.filter(group_id=p["vlan_group"])
    kept = {str(v.id) for v in vlans}
    rails = [
        {
            "id": str(v.id),
            "vlan_id": v.vlan_id,
            "name": v.name,
            "color": v.color or (v.zone.color if v.zone_id else ""),
            "group": v.group.name if v.group_id else None,
        }
        for v in vlans
    ]
    out_nodes = []
    for n in nodes.values():
        n["attachments"] = [a for a in n["attachments"] if a["rail"] in kept]
        if n["attachments"]:
            out_nodes.append(n)
    out_nodes.sort(key=lambda n: (n["kind"], n["name"].lower()))
    return Response({"rails": rails, "nodes": out_nodes})


@extend_schema(
    summary="Compact topology summary (adjacency, site rollups) for programmatic/AI use",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(name="site", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by site id."),
        OpenApiParameter(name="role", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by role id."),
        OpenApiParameter(name="status", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by status id."),
        OpenApiParameter(name="tag", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by tag slug."),
        OpenApiParameter(name="collapse_panels", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Walk patch panels through (default '1')."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "`{device_count, cable_count, sites, inter_site_links, adjacency}` "
            "- the cabling graph without port-level noise, sized for an LLM "
            "context or scripted analysis. Same filters and RBAC scope as "
            "`/api/topology/`."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_summary_view(request):
    """The topology as plain facts: per-device neighbor lists (cable counts,
    media types, panels crossed) plus site rollups and inter-site link
    aggregates. Built from the same collapse walk as the graph endpoint, so
    an AI reading this sees exactly what the map shows."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"device_count": 0, "cable_count": 0, "sites": [],
                         "inter_site_links": [], "adjacency": []})
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)
    scope_q = None if dev_q is True else dev_q

    p = request.query_params
    collapse = p.get("collapse_panels", "1") != "0"
    g = _build_graph(tenant, device_filter_q=_filter_q(p),
                     collapse=collapse, scope_q=scope_q)

    name_of, site_of, role_of = {}, {}, {}
    for n in g["nodes"]:
        d = n["data"]
        name_of[n["id"]] = d["name"]
        site_of[n["id"]] = d["site"] or "Unassigned"
        role_of[n["id"]] = d["role"]["name"] if d.get("role") else None

    # One entry per device pair, whatever the cable count.
    pairs: dict = {}
    for e in g["edges"]:
        key = tuple(sorted((e["source"], e["target"])))
        ent = pairs.setdefault(key, {"cables": 0, "types": set(), "via": set()})
        ent["cables"] += 1
        t = e["data"].get("cable_type")
        if t:
            ent["types"].add(t)
        for v in e["data"].get("via") or []:
            ent["via"].add(v)

    neighbors: dict = {nid: [] for nid in name_of}
    site_links: dict = {}
    for (a, b), ent in pairs.items():
        row = {"cables": ent["cables"], "types": sorted(ent["types"]),
               "via_panels": sorted(ent["via"])}
        neighbors[a].append({"device": name_of[b], **row})
        neighbors[b].append({"device": name_of[a], **row})
        sa, sb = site_of[a], site_of[b]
        if sa != sb:
            skey = tuple(sorted((sa, sb)))
            site_links[skey] = site_links.get(skey, 0) + ent["cables"]

    site_counts: dict = {}
    for s in site_of.values():
        site_counts[s] = site_counts.get(s, 0) + 1

    adjacency = [
        {
            "device": name_of[nid],
            "role": role_of[nid],
            "site": site_of[nid],
            "neighbors": sorted(nbrs, key=lambda r: r["device"]),
        }
        for nid, nbrs in neighbors.items()
    ]
    adjacency.sort(key=lambda r: r["device"])
    return Response({
        "device_count": len(name_of),
        "cable_count": len(g["edges"]),
        "sites": [
            {"name": s, "devices": c}
            for s, c in sorted(site_counts.items())
        ],
        "inter_site_links": [
            {"a": a, "b": b, "cables": c}
            for (a, b), c in sorted(site_links.items())
        ],
        "adjacency": adjacency,
    })


def _grouped_graph(tenant, group_by, device_filter_q=None, collapse=True,
                   scope_q=None):
    """The device graph aggregated by site or location: one node per group
    (device count + role breakdown), one edge per group pair carrying the
    cable count and media types. Built on the same RBAC-scoped device graph,
    so hidden devices never leak into counts."""
    g = _build_graph(tenant, device_filter_q=device_filter_q,
                     collapse=collapse, scope_q=scope_q)
    base = _devices_qs(tenant)
    if device_filter_q is not None:
        base = base.filter(device_filter_q)
    if scope_q is not None:
        base = base.filter(scope_q)
    attr = "site" if group_by == "site" else "location"
    info = {}
    for d in base:
        obj = getattr(d, attr)
        info[str(d.id)] = (
            (str(obj.id), obj.name) if obj is not None else ("none", "Unassigned")
        )

    groups: dict = {}
    for n in g["nodes"]:
        did = n["data"]["device_id"]
        gid, gname = info.get(did, ("none", "Unassigned"))
        grp = groups.setdefault(
            gid, {"name": gname, "device_count": 0, "roles": {}}
        )
        grp["device_count"] += 1
        role = n["data"].get("role")
        if role:
            r = grp["roles"].setdefault(
                role["name"],
                {"name": role["name"], "color": role["color"], "count": 0},
            )
            r["count"] += 1

    agg: dict = {}
    for e in g["edges"]:
        a = info.get(e["source"][4:], ("none", ""))[0]
        b = info.get(e["target"][4:], ("none", ""))[0]
        if a == b:
            continue  # intra-group cabling stays inside the group card
        key = tuple(sorted((a, b)))
        ent = agg.setdefault(key, {"cable_count": 0, "types": set()})
        ent["cable_count"] += 1
        t = e["data"].get("cable_type")
        if t:
            ent["types"].add(t)

    nodes = [
        {
            "id": f"grp:{gid}",
            "type": "group",
            "data": {
                "group_id": gid if gid != "none" else None,
                "kind": group_by,
                "name": v["name"],
                "device_count": v["device_count"],
                "roles": sorted(
                    v["roles"].values(), key=lambda r: (-r["count"], r["name"])
                ),
            },
        }
        for gid, v in sorted(groups.items(), key=lambda kv: kv[1]["name"])
    ]
    edges = [
        {
            "id": f"ge:{a}:{b}",
            "source": f"grp:{a}",
            "target": f"grp:{b}",
            "type": "group",
            "data": {"cable_count": v["cable_count"], "types": sorted(v["types"])},
        }
        for (a, b), v in agg.items()
    ]
    return {"nodes": nodes, "edges": edges}


def _filter_q(params):
    q = Q()
    if params.get("site"):
        q &= Q(site_id=params["site"])
    if params.get("location"):
        q &= Q(location_id=params["location"])
    if params.get("role"):
        q &= Q(role_id=params["role"])
    if params.get("status"):
        q &= Q(status_id=params["status"])
    if params.get("tag"):
        q &= Q(tags__slug=params["tag"])
    return q


@extend_schema(
    summary="Network topology graph (devices as nodes, cables as edges)",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="collapse_panels",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Walk patch panels through end-to-end (default '1'); '0' shows "
                "raw physical hops with panels as nodes."
            ),
        ),
        OpenApiParameter(
            name="device",
            type=OpenApiTypes.UUID,
            location=OpenApiParameter.QUERY,
            description="Focus the graph on one device's neighbourhood (by id).",
        ),
        OpenApiParameter(
            name="depth",
            type=OpenApiTypes.INT,
            location=OpenApiParameter.QUERY,
            description=f"BFS depth around the focus device (1–{MAX_DEPTH}, default 1).",
        ),
        OpenApiParameter(
            name="site",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by site id.",
        ),
        OpenApiParameter(
            name="location",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by location id.",
        ),
        OpenApiParameter(
            name="role",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by role id.",
        ),
        OpenApiParameter(
            name="status",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by status id.",
        ),
        OpenApiParameter(
            name="tag",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by tag slug.",
        ),
        OpenApiParameter(
            name="group_by",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "'site' or 'location': aggregate to one node per group "
                "(device count + role breakdown) with cable-count edges "
                "between groups. Ignores device/depth focus."
            ),
        ),
        OpenApiParameter(
            name="devices",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Comma-separated device ids: the induced subgraph on exactly "
                "this set (the custom-map builder). Overrides focus/filters."
            ),
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "`{nodes, edges}` for the React Flow map - device stencil-card nodes "
            "with cabled ports and cable edges (port-to-port pairs, via panels), "
            "scoped to the caller's device.view grant."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"nodes": [], "edges": []})
    # Row/site scope: a scoped grant limits the graph to viewable devices;
    # None (denied) → 403, True (unscoped) → no extra filter.
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)
    scope_q = None if dev_q is True else dev_q

    p = request.query_params
    collapse = p.get("collapse_panels", "1") != "0"
    focus = p.get("device") or None
    try:
        depth = max(1, min(MAX_DEPTH, int(p.get("depth", 1))))
    except (TypeError, ValueError):
        depth = 1

    # Aggregated mode: one node per site/location. Focus is device-level and
    # doesn't apply here.
    group_by = p.get("group_by")
    if group_by in ("site", "location"):
        return Response(_grouped_graph(
            tenant, group_by,
            device_filter_q=_filter_q(p),
            collapse=collapse,
            scope_q=scope_q,
        ))

    # Explicit device set - the custom-map builder's induced subgraph. The
    # parameter's PRESENCE selects the mode: an empty value is an empty map
    # (a builder you just opened), never a fall-through to the full graph.
    custom_set = "devices" in p
    device_ids = [x for x in (p.get("devices") or "").split(",") if x]
    if custom_set:
        focus = None

    graph = _build_graph(
        tenant,
        device_filter_q=(
            Q(id__in=device_ids) if custom_set
            else (_filter_q(p) if not focus else None)
        ),
        focus_id=focus,
        depth=depth,
        collapse=collapse,
        scope_q=scope_q,
    )
    return Response(graph)


def device_paths(device, viewable_ids=None):
    """Flat end-to-end runs for every cabled port on a device - the cable
    page's path-strip design, one strip per port. Each run alternates
    ``seg`` (a cable) and ``chip`` (a device + the ports the run used on it);
    panels are crossed front⇄rear like the topology collapse.

    ``viewable_ids`` (a set of device pks, or None = unrestricted) bounds which
    devices' names/ids are revealed - a run that crosses into a device the
    caller can't view renders a redacted ``(restricted)`` chip instead of
    leaking its name/ports (site-scope safe)."""
    from .fiber_colors import fiber_color, is_fiber_type
    from .models import FiberSettings

    links = _physical_links(device.tenant)
    palette = FiberSettings.for_tenant(device.tenant).colors
    by_port = {}
    for cab, da, pa, ka, db, pb, kb in links:
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    def seg(cab, strand=None):
        s = {
            "t": "seg",
            "cable_id": str(cab.id),
            "cable_numid": cab.numid,
            "label": cab.type or "cable",
            "cable_label": cab.label or None,
            "color": cab.color or None,
            "fiber": is_fiber_type(cab.type),
            "fiber_count": cab.fiber_count or None,
        }
        # On a strand-bearing fibre trunk, tag which strand this run threads
        # through (its colour). Skip 2-strand duplex patch cords - the strand
        # there is just TX/RX, not informative on the path.
        if strand and is_fiber_type(cab.type) and (cab.fiber_count or 0) > 2:
            col = fiber_color(strand, palette)
            s["strand"] = strand
            s["strand_color"] = {"name": col["name"], "hex": col["hex"]}
        return s

    def chip(dev, port_pairs, panel):
        """``port_pairs`` = [(port_obj, kind)] - interface ports carry their
        id so the frontend can make the name itself a click target."""
        # Redact devices outside the caller's view scope - a physical run can
        # cross into another site's device; show that a hop exists without
        # leaking its identity.
        if viewable_ids is not None and dev.id not in viewable_ids:
            return {"t": "chip", "device_id": None, "device": "(restricted)",
                    "ports": [], "panel": panel, "restricted": True}
        return {
            "t": "chip",
            "device_id": str(dev.id),
            "device": dev.name,
            "ports": [
                {
                    "name": p.name,
                    "interface_id": str(p.id) if k == "interface" else None,
                }
                for p, k in port_pairs
            ],
            "panel": panel,
        }

    def trace_outward(dev, port, kind, position, seen):
        """Follow front⇄rear pass-throughs outward from a cabled hop until a real
        endpoint (or a dead-end). Returns ``(steps, complete)`` - steps starts
        with a chip and alternates chip/seg, always ending on a chip."""
        steps = []
        complete = True
        while True:
            if kind not in ("front_port", "rear_port"):
                steps.append(chip(dev, [(port, kind)], False))
                break
            if _is_splitter_side(kind, port):
                # A splitter legitimately ends the run - its N outputs are
                # separate runs, not a continuation.
                steps.append(chip(dev, [(port, kind)], False))
                break
            if port.id in seen:
                complete = False
                steps.append(chip(dev, [(port, kind)], True))
                break
            seen.add(port.id)
            strand = _strand_of(port, kind, position)
            if strand is None:
                complete = False
                steps.append(chip(dev, [(port, kind)], True))
                break
            skind, sport, spos = strand
            hops = by_port.get((skind, sport.id), [])
            steps.append(chip(dev, [(port, kind), (sport, skind)], True))
            if not hops:
                complete = False  # the strand's far side is uncabled
                break
            cab2, dev, port, kind = hops[0]
            steps.append(seg(cab2, strand=spos))
            position = spos
        return steps, complete

    runs = []
    seen_runs = set()  # frozenset(cable_ids) → drop mirror-image duplicates
    for cab, da, pa, ka, db, pb, kb in links:
        # Orient so this device is the origin; a cable touching it on both
        # ends yields two runs (one per port), which is what you'd expect.
        for (odev, oport, okind, fdev, fport, fkind) in (
            (da, pa, ka, db, pb, kb),
            (db, pb, kb, da, pa, ka),
        ):
            if odev.id != device.id:
                continue

            is_panel = okind in ("front_port", "rear_port") and not _is_splitter_side(
                okind, oport
            )
            seen = {oport.id}

            if is_panel:
                # This device IS a patch panel: draw the whole run *through* it -
                # the panel sits mid-path (highlighted), with the far endpoints on
                # each side - instead of a fragment that starts at the panel.
                right, a_complete = trace_outward(fdev, fport, fkind, 1, seen)
                left = []
                b_complete = True
                ports_here = [(oport, okind)]
                partner = _strand_of(oport, okind, 1)
                if partner is not None:
                    skind, sport, spos = partner
                    ports_here.append((sport, skind))
                    seen.add(sport.id)
                    bhops = by_port.get((skind, sport.id), [])
                    if bhops:
                        cabB, bdev, bport, bkind = bhops[0]
                        bsteps, b_complete = trace_outward(bdev, bport, bkind, spos, seen)
                        # Reverse so the far end reads left→panel.
                        left = list(reversed([seg(cabB, strand=spos), *bsteps]))
                    else:
                        b_complete = False  # partner side uncabled
                panel_chip = chip(odev, ports_here, True)
                panel_chip["origin"] = True
                steps = [*left, panel_chip, seg(cab), *right]
                complete = a_complete and b_complete
            else:
                # Endpoint origin (interface / console / power / splitter): start
                # at this device's port and trace one way to the far end.
                origin_chip = chip(odev, [(oport, okind)], False)
                origin_chip["origin"] = True
                right, complete = trace_outward(fdev, fport, fkind, 1, seen)
                steps = [origin_chip, seg(cab), *right]

            # A panel's run is discovered from both its front and rear port (and
            # both cable orientations) - collapse those to one by cable set.
            cable_ids = frozenset(
                s["cable_id"] for s in steps if s["t"] == "seg" and s.get("cable_id")
            )
            if cable_ids and cable_ids in seen_runs:
                continue
            seen_runs.add(cable_ids)

            runs.append({
                "origin": {"name": oport.name,
                           "kind": _KIND_OF.get(okind, "interface")},
                "steps": steps,
                "complete": complete,
            })
    runs.sort(key=lambda r: r["origin"]["name"])
    return {"runs": runs}


def cable_strand_path(cable, strand):
    """End-to-end path of ONE fibre strand of a (trunk) cable. Strand k maps to
    position k on each rear-port end; we walk that position out through the
    panels on both sides to the far devices, so the run reads
    device-A ═ panel ═ TRUNK (strand k) ═ panel ═ device-B, coloured by the
    strand's TIA-598-C colour. Same seg/chip shape as ``device_paths`` so the
    frontend renders it with the existing path strip."""
    from .fiber_colors import fiber_color
    from .models import FiberSettings

    tenant = cable.tenant
    links = _physical_links(tenant)
    by_port = {}
    for cab, da, pa, ka, db, pb, kb in links:
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    palette = FiberSettings.for_tenant(tenant).colors
    col = fiber_color(strand, palette)

    def seg(cab, trunk=False):
        s = {
            "t": "seg",
            "cable_id": str(cab.id),
            "cable_numid": cab.numid,
            "label": cab.type or "cable",
            "cable_label": cab.label or None,
            "color": cab.color or None,
        }
        if trunk:
            s["strand"] = strand
            s["strand_color"] = {"name": col["name"], "hex": col["hex"]}
        return s

    def dev_chip(dev, port, kind):
        return {
            "t": "chip", "device_id": str(dev.id), "device": dev.name,
            "panel": False,
            "ports": [{
                "name": port.name,
                "interface_id": str(port.id) if kind == "interface" else None,
            }],
        }

    def panel_chip(dev, inp, outp):
        ports = [{"name": inp.name, "interface_id": None}]
        if outp is not None:
            ports.append({"name": outp.name, "interface_id": None})
        return {
            "t": "chip", "device_id": str(dev.id), "device": dev.name,
            "panel": True, "ports": ports,
        }

    def walk_out(kind, port):
        """Steps from the cable end outward (crossing panels at `strand`) to the
        far endpoint, ordered cable→far. Returns (steps, complete)."""
        steps, seen, position = [], set(), strand
        dev = port.device
        while True:
            if kind not in ("front_port", "rear_port"):
                steps.append(dev_chip(dev, port, kind))
                return steps, True
            if _is_splitter_side(kind, port):
                # The cable's far end is a splitter - a real endpoint.
                steps.append(dev_chip(dev, port, kind))
                return steps, True
            if port.id in seen:
                steps.append(panel_chip(dev, port, None))
                return steps, False
            seen.add(port.id)
            s = _strand_of(port, kind, position)
            if s is None:  # dangling strand - ends at the panel
                steps.append(panel_chip(dev, port, None))
                return steps, False
            skind, sport, spos = s
            steps.append(panel_chip(dev, port, sport))
            hops = [
                h for h in by_port.get((skind, sport.id), [])
                if h[0].id != cable.id
            ]
            if not hops:  # panel's far side uncabled
                return steps, False
            _, dev, port, kind = hops[0]
            steps.append(seg(hops[0][0]))
            position = spos

    a = b = None
    for t in cable.terminations.all():
        k, o = _term_point(t)
        if o is None:
            continue
        if t.end == "A" and a is None:
            a = (k, o)
        elif t.end == "B" and b is None:
            b = (k, o)

    a_steps, a_ok = walk_out(*a) if a else ([], False)
    b_steps, b_ok = walk_out(*b) if b else ([], False)
    steps = list(reversed(a_steps)) + [seg(cable, trunk=True)] + b_steps
    return {
        "strand": strand,
        "color": {"name": col["name"], "hex": col["hex"]},
        "cable": {
            "id": str(cable.id),
            "label": cable.label or None,
            "type": cable.type,
        },
        "steps": steps,
        "complete": a_ok and b_ok,
    }


def trace_device_graph(tenant, trace_graph, scope_q=None):
    """A device-level graph (the same adaptive stencil cards as the main map)
    for the devices a trace passes through, with the traced cables marked.
    Panels are shown (collapse off) so the full physical path renders.
    ``scope_q`` bounds nodes to the caller's viewable devices (site scope)."""
    from django.db.models import Q

    dev_ids = {
        n["data"]["device_id"]
        for n in trace_graph["nodes"]
        if n.get("type") == "device" and n["data"].get("device_id")
    }
    cable_ids = {
        e["data"].get("cable_id")
        for e in trace_graph["edges"]
        if e.get("type") == "cable" and e["data"].get("cable_id")
    }
    if not dev_ids:
        return {"nodes": [], "edges": []}
    g = _build_graph(tenant, device_filter_q=Q(id__in=dev_ids), collapse=False,
                     scope_q=scope_q)
    for e in g["edges"]:
        e["data"]["marked"] = e["data"].get("cable_id") in cable_ids
    return g


def device_trace_map(device, scope_q=None):
    """Device-page mini map: the device's 1-hop neighbourhood with panels
    collapsed. Kept as the DeviceViewSet ``map`` action's implementation.
    ``scope_q`` bounds the graph to the caller's viewable devices (site scope)."""
    return _build_graph(
        device.tenant, focus_id=str(device.id), depth=1, collapse=True,
        scope_q=scope_q,
    )
