"""Server-driven plugin UI metadata — consumed by the generic React renderer."""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@extend_schema(
    summary="Server-driven UI metadata for the active tenant's enabled plugins",
    tags=["plugins"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Nav items, pages, and dashboard panels contributed by the plugins "
            "enabled for the caller's active tenant."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def plugin_ui(request):
    """Nav items / pages / dashboard panels contributed by the plugins enabled
    for the caller's active tenant.

    Enablement is filtered here; per-object RBAC stays authoritative downstream —
    nav items carry ``object_type``/``perm`` for the frontend's existing
    visibility gate, and each page's data endpoint enforces its own RBAC.
    """
    from api.views import _get_active_tenant

    from .resolve import enabled_plugins
    from .ui_registry import ui_payload

    tenant = _get_active_tenant(request)
    return Response(ui_payload(enabled_plugins(tenant)))
