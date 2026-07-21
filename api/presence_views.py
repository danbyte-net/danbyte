"""Presence endpoints — heartbeat (write+read) and an explicit leave.

The heartbeat returns the current presence list in the same round-trip, so the
SPA polls one endpoint to both announce itself and learn who else is here.
"""
from __future__ import annotations

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
from rest_framework import status as drf_status

from auth_api import object_types as ot_registry
from auth_api import rbac
from core import presence
from .views import _get_active_tenant

VALID_MODES = {"viewing", "editing"}


def _display_name(user) -> str:
    full = (user.get_full_name() or "").strip()
    return full or user.get_username()


def _args(data):
    ot = str(data.get("object_type") or "").strip()
    oid = str(data.get("object_id") or "").strip()
    return ot, oid


def _may_view(user, tenant, object_type: str) -> bool:
    """Whether ``user`` may see presence on ``object_type`` in ``tenant``.

    The SPA sends the bare RBAC slug (``model._meta.model_name`` — e.g.
    ``"device"``, ``"vlan"``); an ``app_label.`` prefix is tolerated. Gate on
    the viewer's ``view`` action for that model so a member with no read access
    to, say, Devices can't harvest which devices are being edited or which
    colleagues are active on them (presence carries display names). Models not
    in the RBAC registry fall through to allowed, matching the DRF enforcement
    layer's legacy "any authenticated tenant member" behaviour for unregistered
    models.
    """
    slug = object_type.rsplit(".", 1)[-1].strip().lower()
    if not slug:
        return False
    if not ot_registry.is_registered(slug):
        return True
    return rbac.has_action(user, tenant, slug, "view")


@extend_schema(
    summary="Announce presence on an object and get who else is present",
    tags=["presence"],
    request=inline_serializer(
        name="PresenceHeartbeatRequest",
        fields={
            "object_type": serializers.CharField(
                help_text="RBAC model slug (e.g. 'device'); app_label. prefix tolerated."
            ),
            "object_id": serializers.CharField(),
            "mode": serializers.ChoiceField(
                choices=["viewing", "editing"], required=False, default="viewing"
            ),
        },
    ),
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="{'present': [...]} — other users currently on the object.",
        ),
        400: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="object_type and object_id are required.",
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def presence_heartbeat(request):
    """Announce presence on an object + get who else is here back."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"present": []})
    data = request.data or {}
    ot, oid = _args(data)
    if not ot or not oid:
        return Response(
            {"detail": "object_type and object_id are required."},
            status=drf_status.HTTP_400_BAD_REQUEST,
        )
    if not _may_view(request.user, tenant, ot):
        return Response({"present": []})
    mode = data.get("mode") if data.get("mode") in VALID_MODES else "viewing"
    presence.heartbeat(
        tenant.id, ot, oid,
        user_id=request.user.id, name=_display_name(request.user), mode=mode,
    )
    return Response(
        {"present": presence.present(tenant.id, ot, oid,
                                     exclude_user_id=request.user.id)}
    )


@extend_schema(
    summary="Read who is present on an object without announcing yourself",
    tags=["presence"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="object_type",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="RBAC model slug (e.g. 'device'); app_label. prefix tolerated.",
        ),
        OpenApiParameter(
            name="object_id",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Target object id.",
        ),
    ],
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="{'present': [...]} — other users currently on the object.",
        )
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def presence_list(request):
    """Read-only: who is present on an object (without announcing yourself)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"present": []})
    ot, oid = _args(request.query_params)
    if not ot or not oid:
        return Response({"present": []})
    if not _may_view(request.user, tenant, ot):
        return Response({"present": []})
    return Response(
        {"present": presence.present(tenant.id, ot, oid,
                                     exclude_user_id=request.user.id)}
    )


@extend_schema(
    summary="Drop your presence on an object (best-effort, on unmount)",
    tags=["presence"],
    request=inline_serializer(
        name="PresenceLeaveRequest",
        fields={
            "object_type": serializers.CharField(
                help_text="RBAC model slug (e.g. 'device'); app_label. prefix tolerated."
            ),
            "object_id": serializers.CharField(),
        },
    ),
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="{'ok': true}.",
        )
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def presence_leave(request):
    """Drop your presence on an object (best-effort, on unmount)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"ok": True})
    ot, oid = _args(request.data or {})
    if ot and oid:
        presence.leave(tenant.id, ot, oid, user_id=request.user.id)
    return Response({"ok": True})
