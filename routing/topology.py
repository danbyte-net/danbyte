"""BGP sessions as lines on the topology map.

One edge per device pair and table, ``type="bgp"``, the shape the map's
LLDP ghosts have: the page merges them into the cabled graph and draws the
ones whose ends are on screen, and they hide as their own link family.
``merge_sessions`` is shared with the Routing tab (``topology_map.py``).
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


def _asn_text(v):
    return f"AS{v}" if v is not None else "AS?"


def merge_sessions(sessions, ends):
    """BGP sessions as map lines: one per node pair and table, both
    directions of a session folded into it. ``ends(session)`` gives the
    session's two node ids (its own end first), or None to leave it out.
    Yields ``(edge, sessions)`` sorted by edge id; the edge carries the
    kind, VRF, address families and each end's AS (``a_asn`` for the
    ``source``), the shape the Diagram's overlay and the Routing tab share.
    Reads only what ``effective()`` reads - select those relations."""
    edges: dict[tuple, tuple[dict, list]] = {}
    for s in sessions:
        pair = ends(s)
        if pair is None or pair[0] == pair[1]:
            continue
        a, b = pair
        vrf = s.instance.vrf.name if s.instance.vrf_id else ""
        key = (*sorted((a, b)), vrf)
        eff = s.effective()
        got = edges.get(key)
        if got is None:
            got = edges[key] = ({
                "id": f"bgp:{key[0][4:]}:{key[1][4:]}:{vrf}"
                if key[0].startswith("dev:") and key[1].startswith("dev:")
                else f"bgp:{key[0]}:{key[1]}:{vrf}",
                "source": key[0],
                "target": key[1],
                "type": "bgp",
                "data": {
                    "kind": eff["kind"], "vrf": vrf or None,
                    "address_families": set(), "a_asn": None, "b_asn": None,
                },
            }, [])
        e, members = got
        members.append(s)
        d = e["data"]
        d["address_families"].update(eff["address_families"] or [])
        mine, theirs = ("a_asn", "b_asn") if a == key[0] else ("b_asn", "a_asn")
        d[mine] = eff["local_asn"]
        if d[theirs] is None and eff["remote_asn"] is not None:
            d[theirs] = eff["remote_asn"]
        if d["kind"] is None:
            d["kind"] = eff["kind"]
    for e, members in sorted(edges.values(), key=lambda x: x[0]["id"]):
        d = e["data"]
        d["address_families"] = sorted(d["address_families"])
        d["pairs"] = [{"a": _asn_text(d["a_asn"]), "b": _asn_text(d["b_asn"])}]
        yield e, members


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

    def ends(s):
        a, b = str(s.instance.device_id), str(s.peer_device_id)
        if a not in ids or b not in ids:
            return None
        return f"dev:{a}", f"dev:{b}"

    out = []
    for e, _sessions in merge_sessions(sessions, ends):
        d = e["data"]
        d["sessions"] = [str(s.id) for s in _sessions]
        out.append(e)
    return Response({"edges": out})
