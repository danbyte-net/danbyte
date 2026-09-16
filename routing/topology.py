"""BGP sessions as lines on the topology map.

One edge per device pair and table, ``type="bgp"``, the shape the map's
LLDP ghosts have: the page merges them into the cabled graph and draws the
ones whose ends are on screen, and they hide as their own link family.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Device
from api.views import _get_active_tenant
from auth_api import rbac

from .models import BGPSession


@extend_schema(
    summary="BGP sessions as topology edges",
    responses=OpenApiTypes.OBJECT,
    tags=["routing"],
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def bgp_topology_view(request):
    """``?site=`` narrows the device set the way the topology page does. A
    session shows only when both devices are viewable, so a site-scoped
    viewer never learns of a peer outside their scope."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"edges": []})
    devices = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
    )
    site = request.query_params.get("site")
    if site:
        devices = devices.filter(site_id=site)
    ids = {str(i) for i in devices.values_list("id", flat=True)}
    sessions = rbac.restrict_queryset(
        BGPSession.objects.filter(tenant=tenant, peer_device__isnull=False),
        request.user, tenant, "bgpsession", "view",
    ).select_related(
        "instance__device", "instance__vrf", "instance__asn", "peer_device",
        "peer_group__local_asn", "local_asn", "local_address__assigned_interface",
    )
    edges: dict[tuple, dict] = {}
    for s in sessions:
        a, b = str(s.instance.device_id), str(s.peer_device_id)
        if a not in ids or b not in ids or a == b:
            continue
        vrf = s.instance.vrf.name if s.instance.vrf_id else ""
        key = (*sorted((a, b)), vrf)
        eff = s.effective()
        e = edges.get(key)
        if e is None:
            e = edges[key] = {
                "id": f"bgp:{key[0]}:{key[1]}:{vrf}",
                "source": f"dev:{key[0]}",
                "target": f"dev:{key[1]}",
                "type": "bgp",
                "data": {
                    "sessions": [], "kind": eff["kind"], "vrf": vrf or None,
                    "address_families": set(), "a_asn": None, "b_asn": None,
                },
            }
        d = e["data"]
        d["sessions"].append(str(s.id))
        d["address_families"].update(eff["address_families"] or [])
        mine, theirs = ("a_asn", "b_asn") if a == key[0] else ("b_asn", "a_asn")
        d[mine] = eff["local_asn"]
        if d[theirs] is None and eff["remote_asn"] is not None:
            d[theirs] = eff["remote_asn"]
        if d["kind"] is None:
            d["kind"] = eff["kind"]
    out = []
    for e in sorted(edges.values(), key=lambda x: x["id"]):
        d = e["data"]
        d["address_families"] = sorted(d["address_families"])
        asn = lambda v: f"AS{v}" if v is not None else "AS?"  # noqa: E731
        d["pairs"] = [{"a": asn(d["a_asn"]), "b": asn(d["b_asn"])}]
        out.append(e)
    return Response({"edges": out})
