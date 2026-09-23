"""Settings -> Backups: what stale files Danbyte holds, and removing them."""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .api_views import DeploymentAdmin


@extend_schema(
    summary="Stale files on disk (GET), or remove them (POST)",
    tags=["backups"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET", "POST"])
@permission_classes([DeploymentAdmin])
def housekeeping_view(request):
    """GET measures - what is stale per kind, and the tracked folders' sizes.
    POST removes what is stale now, instead of at the nightly run."""
    from core import housekeeping

    if request.method == "POST":
        done = housekeeping.run()
        return Response({**done, **housekeeping.report()})
    return Response(housekeeping.report())
