"""``impact`` and ``dependencies`` on ``/api/devices/<id>/`` (#450).

A mixin of ``DeviceViewSet``, kept apart from ``api.dependency_views`` so the
device viewset can take it without an import cycle. See
``api.dependency_impact`` for the answers.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import dependency_impact as di
from .views import _get_active_tenant


class DeviceDependencyActionsMixin:
    """``impact`` and ``dependencies`` on ``/api/devices/<id>/``. The device
    is the caller's to view (the viewset's ``get_object``); the answers also
    need view on device dependencies."""

    def _dependency_view_or_403(self, request):
        from auth_api import rbac

        tenant = _get_active_tenant(request)
        if tenant is None or not rbac.has_action(
            request.user, tenant, "devicedependency", "view"
        ):
            raise PermissionDenied("You may not view device dependencies.")
        return tenant

    @extend_schema(
        parameters=[OpenApiParameter("limit", OpenApiTypes.INT, OpenApiParameter.QUERY)],
        responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=True, methods=["get"], url_path="impact")
    def impact(self, request, pk=None):
        """What goes down, or loses redundancy, if this device fails."""
        device = self.get_object()
        tenant = self._dependency_view_or_403(request)
        limit = di.clamp(request.query_params.get("limit"), di.DEFAULT_LIMIT, di.MAX_LIMIT)
        return Response(di.impact(request.user, tenant, [device.pk], limit))

    @extend_schema(
        parameters=[
            OpenApiParameter("direction", OpenApiTypes.STR, OpenApiParameter.QUERY,
                             enum=["up", "down", "both"]),
            OpenApiParameter("depth", OpenApiTypes.INT, OpenApiParameter.QUERY),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=True, methods=["get"], url_path="dependencies")
    def dependencies(self, request, pk=None):
        """The dependency tree up and down from this device, and its peers."""
        device = self.get_object()
        tenant = self._dependency_view_or_403(request)
        direction = request.query_params.get("direction") or "both"
        if direction not in ("up", "down", "both"):
            raise ValidationError({"direction": "up, down or both."})
        depth = di.clamp(request.query_params.get("depth"), di.DEFAULT_DEPTH, di.MAX_DEPTH)
        return Response(di.tree(request.user, tenant, device, depth, direction))
