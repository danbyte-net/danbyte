"""Device dependencies on the maps (#450).

``GET|POST /api/topology/dependencies/`` - the Topology map's Dependencies
layer: one edge per dependency row, ``type="dependency"``, in the shape the
map's LLDP ghosts and BGP sessions have, so the page merges them into the
cabled graph and draws the ones whose ends are on screen. ``source`` is the
upstream card, ``target`` the downstream one (for a peer, the pair as
stored). ``?site=`` narrows to dependencies with an end at that site; a list
of ``device`` ids (query, or a JSON body ``{"device": [...]}`` for long
sets) to dependencies between those devices.

:func:`site_map_lines` is ``?include=dependencies`` on
``/api/site-map/connections/``: a line per dependency whose two devices
carry their own coordinates, and the rest aggregated per placed site pair,
medium and kind.

Both list only dependency rows the caller may view whose two devices they
may view; a row with a hidden end is left out, never drawn to "Hidden".
"""
from __future__ import annotations

import uuid as _uuid

from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .dependency_impact import _medium
from .models import Device, DeviceDependency
from .views import _get_active_tenant

#: Device ids one layer request takes.
MAX_DEVICES = 10_000
#: The device pairs one aggregated site-map line lists.
MAX_PAIRS = 20


def _rows(user, tenant):
    """The dependency rows ``user`` may view, both ends viewable devices,
    with their ends and medium loaded."""
    rows = rbac.restrict_queryset(
        DeviceDependency.objects.filter(tenant=tenant),
        user, tenant, "devicedependency", "view",
    )
    devices = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), user, tenant, "device", "view",
    )
    if not getattr(user, "is_superuser", False):
        rows = rows.filter(upstream__in=devices.values("pk"),
                           downstream__in=devices.values("pk"))
    return rows.select_related("upstream", "downstream", "medium").order_by("pk")


def _uuids(values, key) -> list:
    out = []
    for v in values:
        for part in str(v).split(","):
            part = part.strip()
            if not part:
                continue
            try:
                out.append(_uuid.UUID(part))
            except ValueError:
                raise ValidationError({key: "Not a valid id."}) from None
    if len(out) > MAX_DEVICES:
        raise ValidationError({key: f"At most {MAX_DEVICES} devices."})
    return out


def topology_edge(r) -> dict:
    return {
        "id": f"dep:{r.pk}",
        "source": f"dev:{r.upstream_id}",
        "target": f"dev:{r.downstream_id}",
        "type": "dependency",
        "data": {
            "dependency_id": str(r.pk),
            "kind": r.kind,
            "medium": _medium(r.medium),
            "redundancy_group": r.redundancy_group,
            "description": r.description,
            "upstream": r.upstream.name,
            "downstream": r.downstream.name,
        },
    }


@extend_schema(
    summary="Device dependencies as topology edges",
    parameters=[
        OpenApiParameter("site", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter("device", OpenApiTypes.UUID, OpenApiParameter.QUERY, many=True),
    ],
    responses=OpenApiTypes.OBJECT,
    tags=["dcim"],
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def topology_dependencies_view(request):
    """The Topology map's Dependencies layer. POST is a read too: the same
    query as a JSON body, for device sets too long for a URL."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"edges": []})
    if not rbac.has_action(request.user, tenant, "devicedependency", "view"):
        return Response({"detail": "devicedependency.view required."}, status=403)
    if request.method == "POST":
        body = request.data if isinstance(request.data, dict) else {}
        raw_site = body.get("site")
        raw_devices = body.get("device") or []
        if not isinstance(raw_devices, list):
            raw_devices = [raw_devices]
    else:
        raw_site = request.query_params.get("site")
        raw_devices = request.query_params.getlist("device")
    rows = _rows(request.user, tenant)
    if raw_site:
        site = _uuids([raw_site], "site")[0]
        rows = rows.filter(Q(upstream__site_id=site) | Q(downstream__site_id=site))
    devices = _uuids(raw_devices, "device")
    if devices:
        rows = rows.filter(upstream_id__in=devices, downstream_id__in=devices)
    return Response({"edges": [topology_edge(r) for r in rows]})


# ─── site map ───────────────────────────────────────────────────────────────

def _placed(d) -> bool:
    return d.latitude is not None and d.longitude is not None


def _end(d) -> dict:
    return {
        "lat": float(d.latitude), "lng": float(d.longitude),
        "device_id": str(d.pk), "device_name": d.name,
        "site_id": str(d.site_id) if d.site_id else None,
    }


def site_map_lines(user, tenant, visible_sites: dict, site_ref) -> list[dict]:
    """The dependency lines of the site map. ``visible_sites`` is the
    placed sites the caller may view (``{id: Site}``), ``site_ref`` the
    connections endpoint's own site shape.

    * ``kind="devices"``: a dependency whose two devices carry their own
      coordinates, upstream at ``a``, downstream at ``z``.
    * ``kind="sites"``: the others between two placed sites, one line per
      site pair, medium and dependency kind; ``site_a`` is the upstreams'
      site (a peer's pair is sorted), ``pairs`` the first device pairs and
      ``count`` all of them.
    """
    if not rbac.has_action(user, tenant, "devicedependency", "view"):
        return []
    rows = _rows(user, tenant).select_related("upstream__site", "downstream__site")
    out: list[dict] = []
    sites: dict = {}
    for r in rows:
        up, down = r.upstream, r.downstream
        medium = _medium(r.medium)
        if _placed(up) and _placed(down):
            out.append({
                "id": f"dep:{r.pk}",
                "kind": "devices",
                "dependency_kind": r.kind,
                "medium": medium,
                "redundancy_group": r.redundancy_group,
                "a": _end(up),
                "z": _end(down),
            })
            continue
        sa, sz = up.site_id, down.site_id
        if not sa or not sz or sa == sz:
            continue
        if sa not in visible_sites or sz not in visible_sites:
            continue
        if r.kind == DeviceDependency.KIND_PEER and str(sz) < str(sa):
            sa, sz, up, down = sz, sa, down, up
        key = (str(sa), str(sz), str(r.medium_id or ""), r.kind)
        line = sites.get(key)
        if line is None:
            line = sites[key] = {
                "id": "depsites:" + ":".join(k or "none" for k in key),
                "kind": "sites",
                "dependency_kind": r.kind,
                "medium": medium,
                "site_a": site_ref(visible_sites[sa]),
                "site_z": site_ref(visible_sites[sz]),
                "count": 0,
                "pairs": [],
            }
        line["count"] += 1
        if len(line["pairs"]) < MAX_PAIRS:
            line["pairs"].append({
                "upstream": {"id": str(up.pk), "name": up.name},
                "downstream": {"id": str(down.pk), "name": down.name},
                "redundancy_group": r.redundancy_group,
            })
    return out + sorted(sites.values(), key=lambda line: line["id"])
