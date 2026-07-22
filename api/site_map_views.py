"""Site map — the geographic analog of a floor plan.

One GET returns everything the map page needs: the effective tile-layer
config (deployment setting, defaulting to OpenStreetMap's standard tiles
with the attribution their usage policy requires) plus the RBAC-scoped
sites and devices that carry coordinates. Sites *without* coordinates are
included too — the edit mode lists them so they can be placed by clicking
the map.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from core.models import DeploymentSettings

from .models import CableRoute, Device, Site, SiteMarker
from .views import _get_active_tenant

# The exact URL the OSM tile usage policy mandates for their servers, and the
# attribution + "report a map issue" link it requires/recommends. Only used
# when the deployment hasn't configured its own tile server.
OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
OSM_ATTRIBUTION = (
    '&copy; <a href="https://www.openstreetmap.org/copyright" '
    'target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
    ' &middot; <a href="https://www.openstreetmap.org/fixthemap" '
    'target="_blank" rel="noreferrer">Report a map issue</a>'
)


# Esri World Imagery — free to use with this attribution. Note {z}/{y}/{x}.
ESRI_SAT_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/"
    "World_Imagery/MapServer/tile/{z}/{y}/{x}"
)
ESRI_SAT_ATTRIBUTION = (
    "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, "
    "and the GIS User Community"
)


def effective_tiles() -> dict:
    ds = DeploymentSettings.load()
    url = (ds.map_tile_url or "").strip()
    sat_url = (ds.map_satellite_url or "").strip()
    satellite = {
        "url": sat_url or ESRI_SAT_URL,
        "attribution": (ds.map_satellite_attribution or "")
        if sat_url else ESRI_SAT_ATTRIBUTION,
    }
    if url:
        return {
            "url": url,
            "attribution": ds.map_tile_attribution or "",
            "osm_default": False,
            "satellite": satellite,
        }
    return {"url": OSM_TILE_URL, "attribution": OSM_ATTRIBUTION,
            "osm_default": True, "satellite": satellite}


@extend_schema(
    summary="Site map payload — tile config, placed sites, devices, and markers",
    tags=["site-map"],
    request=None,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Map bundle: effective tile-layer config plus RBAC-scoped "
                "sites, devices, and free markers with coordinates and health."
            ),
        )
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def site_map(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)

    from django.db.models import Count

    sites_qs = (
        rbac.restrict_queryset(
            Site.objects.filter(tenant=tenant),
            request.user, tenant, "site", "view",
        )
        .annotate(
            _devices=Count("device", distinct=True),
            _floor_plans=Count("locations__floor_plans", distinct=True),
        )
        .order_by("name")
    )
    # One editable-set query for the whole map instead of a per-row check.
    filt = rbac.row_filter(request.user, tenant, "site", "change")
    if filt is None:
        editable: set = set()
    elif filt is True:
        editable = {s.id for s in sites_qs}
    else:
        editable = set(
            Site.objects.filter(tenant=tenant).filter(filt)
            .values_list("id", flat=True)
        )
    from .models import FloorPlan

    # Worst monitoring status per site / per device — one pass over
    # CheckState, reduced with the monitoring roll-up's severity order, so a
    # site pin can wear its health (red beats amber beats green).
    from monitoring.models import CheckState
    from monitoring.rollup import worst_status

    site_checks: dict = {}
    device_checks: dict = {}
    for site_id, device_id, status in CheckState.objects.filter(
        tenant=tenant, target_ip__assigned_device__isnull=False
    ).values_list(
        "target_ip__assigned_device__site_id",
        "target_ip__assigned_device_id",
        "status",
    ):
        if site_id is not None:
            site_checks.setdefault(site_id, []).append(status)
        device_checks.setdefault(device_id, []).append(status)

    # First few floor plans per site — the popover offers them as direct
    # jump-offs (the map → floorplan drill-down, like the plugin's
    # floorplan_link tiles).
    plans_by_site: dict = {}
    for fp in (
        FloorPlan.objects.filter(tenant=tenant)
        .select_related("location")
        .order_by("name")
    ):
        plans_by_site.setdefault(fp.location.site_id, [])
        if len(plans_by_site[fp.location.site_id]) < 5:
            plans_by_site[fp.location.site_id].append(
                {"id": str(fp.id), "name": fp.name}
            )

    sites = [
        {
            "id": str(s.id),
            "name": s.name,
            "latitude": float(s.latitude) if s.latitude is not None else None,
            "longitude": float(s.longitude) if s.longitude is not None else None,
            "device_count": s._devices,
            "floor_plan_count": s._floor_plans,
            "floor_plans": plans_by_site.get(s.id, []),
            "check": worst_status(site_checks.get(s.id, [])),
            "can_edit": s.id in editable,
        }
        for s in sites_qs
    ]

    devices_qs = (
        rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant),
            request.user, tenant, "device", "view",
        )
        .filter(latitude__isnull=False, longitude__isnull=False)
        .select_related("role", "site", "status", "device_type", "primary_ip")
        .prefetch_related("tags")
    )
    dev_filt = rbac.row_filter(request.user, tenant, "device", "change")
    if dev_filt is None:
        dev_editable: set = set()
    elif dev_filt is True:
        dev_editable = {d.id for d in devices_qs}
    else:
        dev_editable = set(
            Device.objects.filter(tenant=tenant).filter(dev_filt)
            .values_list("id", flat=True)
        )
    def device_info(d):
        """The display fields a device contributes to the map — shared by a
        placed device pin and a marker's linked device, so both popovers show
        the same detail set (driven by the shared floor-plan popover config)."""
        return {
            "id": str(d.id),
            "name": d.name,
            "site": {"id": str(d.site_id), "name": d.site.name}
            if d.site_id else None,
            "role": {"name": d.role.name, "color": d.role.color}
            if d.role_id else None,
            "status": {"name": d.status.name, "color": d.status.color}
            if d.status_id else None,
            "device_type": d.device_type.name if d.device_type_id else None,
            "numid": d.numid,
            "description": d.description or "",
            "serial_number": d.serial_number or "",
            "asset_tag": d.asset_tag or "",
            "primary_ip": {
                "id": str(d.primary_ip_id),
                "ip_address": d.primary_ip.ip_address,
                "dns_name": d.primary_ip.dns_name,
            }
            if d.primary_ip_id else None,
            "tags": [
                {"id": t.id, "name": t.name, "slug": t.slug,
                 "color": t.color, "text_color": t.text_color}
                for t in d.tags.all()
            ],
            "custom_fields": d.custom_fields or {},
            "front_image": (
                request.build_absolute_uri(d.device_type.front_image.url)
                if d.device_type_id and d.device_type.front_image
                else None
            ),
            "check": worst_status(device_checks.get(d.id, [])),
        }

    devices = [
        {
            **device_info(d),
            "latitude": float(d.latitude),
            "longitude": float(d.longitude),
            "fov": {
                "direction": d.fov_direction,
                "deg": d.fov_deg,
                "distance_m": d.fov_distance_m,
                "ptz": d.fov_ptz,
            }
            if (d.fov_distance_m and (d.fov_ptz or d.fov_deg)) else None,
            "has_fov": bool(d.role_id and d.role.has_fov),
            "can_edit": d.id in dev_editable,
        }
        for d in devices_qs
    ]

    # Free markers — the whole tenant's; the marker vocabulary (tile types /
    # device roles) is tenant data, so no per-row RBAC beyond tenancy (the
    # same contract as floor-plan tiles).
    markers = [
        {
            "id": str(m.id),
            "latitude": float(m.latitude),
            "longitude": float(m.longitude),
            "label": m.label,
            "description": m.description,
            "device": device_info(m.device) if m.device_id else None,
            "type": {
                "id": str(m.type_obj.id),
                "name": m.type_obj.name,
                "color": getattr(m.type_obj, "color", "") or "",
                "icon": getattr(m.type_obj, "icon", "") or "",
                "has_fov": bool(getattr(m.type_obj, "has_fov", False)),
            } if m.type_obj else None,
            "fov": {
                "direction": m.fov_direction,
                "deg": m.fov_deg,
                "distance_m": m.fov_distance_m,
                "ptz": m.fov_ptz,
            }
            if (m.fov_distance_m and (m.fov_ptz or m.fov_deg)) else None,
        }
        for m in SiteMarker.objects.filter(tenant=tenant)
        .select_related(
            "tile_type", "role_type", "device",
            "device__role", "device__site", "device__status",
            "device__device_type", "device__primary_ip",
        )
        .prefetch_related("device__tags")
    ]

    return Response({
        "tiles": effective_tiles(),
        "sites": sites,
        "devices": devices,
        "markers": markers,
    })


@extend_schema(
    summary="Derived site-to-site connection edges (circuits, tunnels, cables)",
    tags=["site-map"],
    request=None,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Connection edges between placed sites, derived from circuits, "
                "tunnels, and cross-site cables; each independently RBAC-scoped."
            ),
        )
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def site_map_connections(request):
    """Site-to-site connection edges for the map — derived, never modeled:

    - **circuits**: both A/Z terminations at placed sites;
    - **tunnels**: terminations resolved interface → device → site (two
      distinct placed sites → one edge; a hub termination → a star, one edge
      per spoke; wider peer meshes are skipped in v1);
    - **cables**: physical links whose endpoint devices sit at different
      placed sites, aggregated per site pair (a bundle is one edge).

    Each kind is independently RBAC-scoped, and the embedded sites are
    intersected with the caller's site-view set.
    """
    from .models import Circuit, Tunnel
    from .topology_views import _physical_links

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)

    visible_sites = {
        s.id: s
        for s in rbac.restrict_queryset(
            Site.objects.filter(tenant=tenant),
            request.user, tenant, "site", "view",
        ).filter(latitude__isnull=False, longitude__isnull=False)
    }

    def site_ref(site):
        return {
            "id": str(site.id),
            "name": site.name,
            "latitude": float(site.latitude),
            "longitude": float(site.longitude),
        }

    def status_ref(status):
        return {"name": status.name, "color": status.color} if status else None

    edges = []

    # ── circuits ─────────────────────────────────────────────────────────
    circuits = (
        rbac.restrict_queryset(
            Circuit.objects.filter(tenant=tenant),
            request.user, tenant, "circuit", "view",
        )
        .select_related("provider", "type", "status")
        .prefetch_related("terminations__site")
    )
    for c in circuits:
        ends = {t.term_side: t for t in c.terminations.all()}
        a, z = ends.get("A"), ends.get("Z")
        if not (a and z and a.site_id and z.site_id):
            continue
        if a.site_id == z.site_id:
            continue
        sa, sz = visible_sites.get(a.site_id), visible_sites.get(z.site_id)
        if not (sa and sz):
            continue
        edges.append({
            "id": f"circuit:{c.id}",
            "kind": "circuit",
            "name": c.cid,
            "site_a": site_ref(sa),
            "site_z": site_ref(sz),
            "color": (c.type.color if c.type_id and c.type.color else "")
            or (c.status.color if c.status_id else ""),
            "status": status_ref(c.status if c.status_id else None),
            "meta": {
                "provider": c.provider.name if c.provider_id else None,
                "type": c.type.name if c.type_id else None,
                "commit_rate_kbps": c.commit_rate_kbps,
            },
        })

    # ── tunnels ──────────────────────────────────────────────────────────
    tunnels = (
        rbac.restrict_queryset(
            Tunnel.objects.filter(tenant=tenant),
            request.user, tenant, "tunnel", "view",
        )
        .select_related("status", "group")
        .prefetch_related("terminations__interface__device")
    )
    for t in tunnels:
        by_site: dict = {}
        hub_site = None
        for term in t.terminations.all():
            iface = term.interface
            if iface is None or iface.device is None:
                continue
            sid = iface.device.site_id
            if sid is None or sid not in visible_sites:
                continue
            by_site.setdefault(sid, term.role)
            if term.role == "hub":
                hub_site = sid
        sids = list(by_site)
        pairs = []
        if hub_site is not None:
            pairs = [(hub_site, s) for s in sids if s != hub_site]
        elif len(sids) == 2:
            pairs = [(sids[0], sids[1])]
        # >2 peer sites without a hub: ambiguous mesh — skipped in v1.
        for i, (sa_id, sz_id) in enumerate(pairs):
            edges.append({
                "id": f"tunnel:{t.id}" + (f":{i}" if len(pairs) > 1 else ""),
                "kind": "tunnel",
                "name": t.name,
                "site_a": site_ref(visible_sites[sa_id]),
                "site_z": site_ref(visible_sites[sz_id]),
                "color": t.status.color if t.status_id else "",
                "status": status_ref(t.status if t.status_id else None),
                "meta": {
                    "encapsulation": t.encapsulation,
                    "group": t.group.name if t.group_id else None,
                },
            })

    # ── cross-site cables, aggregated per site pair ─────────────────────
    cable_view = rbac.row_filter(request.user, tenant, "cable", "view")
    if cable_view is not None:
        # Which geographic routes each cable follows — so a bundle can draw
        # along real geometry.
        routes_by_cable = _routes_by_cable(tenant)
        pair_cables: dict = {}
        for cab, dev_a, _pa, _ka, dev_b, _pb, _kb in _physical_links(tenant):
            sa_id, sz_id = dev_a.site_id, dev_b.site_id
            if not sa_id or not sz_id or sa_id == sz_id:
                continue
            if sa_id not in visible_sites or sz_id not in visible_sites:
                continue
            key = tuple(sorted((str(sa_id), str(sz_id))))
            pair_cables.setdefault(key, {"a": sa_id, "z": sz_id, "cables": {}})
            pair_cables[key]["cables"][str(cab.id)] = cab
        for key, entry in pair_cables.items():
            cables = list(entry["cables"].values())
            edges.append({
                "id": f"cable:{key[0]}:{key[1]}",
                "kind": "cable",
                "name": (
                    cables[0].label or cables[0].type or "cable"
                    if len(cables) == 1
                    else f"{len(cables)} cables"
                ),
                "site_a": site_ref(visible_sites[entry["a"]]),
                "site_z": site_ref(visible_sites[entry["z"]]),
                "color": cables[0].color if len(cables) == 1 else "",
                "status": None,
                "meta": {
                    "count": len(cables),
                    "cables": [
                        {
                            "id": str(c.id),
                            "label": c.label,
                            "type": c.type,
                            "route_ids": routes_by_cable.get(str(c.id), []),
                        }
                        for c in cables[:10]
                    ],
                },
            })

    return Response({"connections": edges})


def _routes_by_cable(tenant) -> dict:
    """{cable_id: [route_id, …]} for every tenant cable on a route."""
    out: dict = {}
    for cid, rid in CableRoute.cables.through.objects.filter(
        cableroute__tenant=tenant
    ).values_list("cable_id", "cableroute_id"):
        out.setdefault(str(cid), []).append(str(rid))
    return out


@extend_schema(
    summary="Cables drawable on the map, each resolved to two map points",
    tags=["site-map"],
    request=None,
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Every cable with both endpoints resolvable to a coordinate "
                "(device coords, else site coords), as a drawable segment; "
                "RBAC: cable/view and both endpoint devices viewable."
            ),
        )
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def site_map_cables(request):
    """Every cable with BOTH ends resolvable to a map point, as a drawable
    segment. A cable draws whether or not it's on a route — a device→device
    run between two placed devices is a line on its own; ``route_ids`` lets
    the client draw it along real geometry when it has one.

    Endpoint resolution per side: the device's own lat/lng if set, else its
    site's lat/lng (campus OSP within one site still draws). A cable is
    dropped when either side can't resolve. RBAC: ``cable``/``view``.
    """
    from .topology_views import _physical_links

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)

    if rbac.row_filter(request.user, tenant, "cable", "view") is None:
        return Response({"cables": []})

    # A cable is only drawn when the caller may view BOTH endpoint devices —
    # otherwise the map would leak a Site-B device (name/coords) to a Site-A
    # user via the cable line. (cable.view has no site path of its own.)
    viewable_devs = set(
        rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant),
            request.user, tenant, "device", "view",
        ).values_list("id", flat=True)
    )

    # Sites the caller may see, with coordinates — the fallback anchor.
    site_pt = {}
    for s in rbac.restrict_queryset(
        Site.objects.filter(tenant=tenant),
        request.user, tenant, "site", "view",
    ).filter(latitude__isnull=False, longitude__isnull=False):
        site_pt[s.id] = (float(s.latitude), float(s.longitude), s.name)

    def resolve(dev):
        """(lat, lng) for a device — its own coords, else its site's."""
        if dev.latitude is not None and dev.longitude is not None:
            return (float(dev.latitude), float(dev.longitude))
        sp = site_pt.get(dev.site_id)
        return (sp[0], sp[1]) if sp else None

    routes_by_cable = _routes_by_cable(tenant)
    out = []
    seen = set()
    for cab, dev_a, pa, ka, dev_b, pb, kb in _physical_links(tenant):
        if cab.id in seen:
            continue  # one segment per cable (first resolvable hop wins)
        if dev_a.id not in viewable_devs or dev_b.id not in viewable_devs:
            continue  # an endpoint outside the caller's site scope → drop
        a_pt = resolve(dev_a)
        b_pt = resolve(dev_b)
        if not a_pt or not b_pt:
            continue
        seen.add(cab.id)
        out.append({
            "id": str(cab.id),
            "label": cab.label or cab.type or "cable",
            "type": cab.type,
            "color": cab.color,
            "status": (
                {"name": cab.status.name, "color": cab.status.color}
                if cab.status_id else None
            ),
            "fiber_count": cab.fiber_count,
            "a": {
                "lat": a_pt[0], "lng": a_pt[1],
                "device_id": str(dev_a.id), "device_name": dev_a.name,
                "port": pa.name, "kind": ka,
            },
            "z": {
                "lat": b_pt[0], "lng": b_pt[1],
                "device_id": str(dev_b.id), "device_name": dev_b.name,
                "port": pb.name, "kind": kb,
            },
            "route_ids": routes_by_cable.get(str(cab.id), []),
            "same_point": a_pt == b_pt,
        })
    return Response({"cables": out})
