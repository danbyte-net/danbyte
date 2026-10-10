"""``GET /api/monitoring/interfaces/live/`` - live traffic for many ports.

``?ids=<uuid>,<uuid>,…`` (up to ``MAX_IDS``). The tenant comes first, then
the caller's interface view scope; an id outside either is simply absent
from the answer, never an error that confirms it exists.
"""
from __future__ import annotations

import uuid

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Interface
from api.views import _get_active_tenant

from .iface_live import live_rates
from .mac_location import restrict

MAX_IDS = 500


def _ids(raw: str) -> list | None:
    out = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(uuid.UUID(part))
        except ValueError:
            return None
    return out


@extend_schema(
    summary="Live bps rates for interfaces, from the stored SNMP samples",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter(
            "ids", OpenApiTypes.STR, required=True,
            description=f"Comma-separated interface ids, at most {MAX_IDS}.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="`{as_of, interfaces: {id: {in_bps, out_bps, speed_mbps, at, "
        "interval_s} | null}}` - null where no live rate is known.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def interfaces_live_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    ids = _ids(request.query_params.get("ids", ""))
    if ids is None:
        return Response({"ids": "Comma-separated interface ids."}, status=400)
    if len(ids) > MAX_IDS:
        return Response({"ids": f"At most {MAX_IDS} ids."}, status=400)
    if not ids:
        return Response({"as_of": None, "interfaces": {}})
    ifaces = restrict(
        Interface.objects.filter(device__tenant=tenant, pk__in=ids).select_related("device"),
        request.user, tenant, "interface",
    )
    rates = live_rates(tenant, ifaces)
    stamps = [r["at"] for r in rates.values() if r]
    return Response({
        "as_of": max(stamps) if stamps else None,
        "now": timezone.now(),
        "interfaces": {str(k): v for k, v in rates.items()},
    })
