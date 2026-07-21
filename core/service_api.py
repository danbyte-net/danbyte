"""Service-control API — superuser only.

Restarting production services is high-stakes, so these endpoints require
``is_superuser`` regardless of RBAC grants. They never touch the database
service itself.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import services


def _require_superuser(request):
    return bool(getattr(request.user, "is_superuser", False))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def services_list(request):
    """Manageable systemd user units + live state (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    return Response({"services": services.list_services()})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def service_restart(request, key: str):
    """Restart one service by key (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    result = services.restart_services([key])
    return Response(result, status=200 if result["ok"] else 400)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def restart_danbyte(request):
    """Restart the core Danbyte units together (superuser only)."""
    if not _require_superuser(request):
        return Response({"detail": "Superuser required."}, status=403)
    result = services.restart_danbyte()
    return Response(result, status=200 if result["ok"] else 400)
