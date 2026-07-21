"""Service-control API — superuser only.

Restarting production services is high-stakes, so these endpoints require
``is_superuser`` regardless of RBAC grants. They never touch the database
service itself.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import services


def _require_superuser(request):
    return bool(getattr(request.user, "is_superuser", False))


@extend_schema(
    summary="List manageable systemd user units and their live state (superuser only)",
    tags=["services"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Object with a `services` list of manageable units and their live state.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def services_list(request):
    """Manageable systemd user units + live state (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    return Response({"services": services.list_services()})


@extend_schema(
    summary="Restart one service by key (superuser only)",
    tags=["services"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Restart result with an `ok` flag and per-unit details.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def service_restart(request, key: str):
    """Restart one service by key (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    result = services.restart_services([key])
    return Response(result, status=200 if result["ok"] else 400)


@extend_schema(
    summary="Restart the core Danbyte units together (superuser only)",
    tags=["services"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Restart result with an `ok` flag and per-unit details.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def restart_danbyte(request):
    """Restart the core Danbyte units together (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    result = services.restart_danbyte()
    return Response(result, status=200 if result["ok"] else 400)
