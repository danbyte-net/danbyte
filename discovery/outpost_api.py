"""The Outpost side of discovery: two endpoints under ``/api/outpost/``,
authenticated with the Outpost's Bearer token like every other work channel.

``discovery-work/``     GET: claim this Outpost's next batch (``outposts.claim``)
``discovery-results/``  POST: report what it read (``outposts.ingest``)

The work answer can hold credentials (package inventory logs in), so it is
never cached and is handed out once per item. An agent that predates
discovery never calls either; the core hands it no work and its hosts say
which agent version they need.
"""
from __future__ import annotations

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from monitoring.outpost_views import OutpostAuthentication

from . import outposts


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


@extend_schema(
    summary="Claim this Outpost's next batch of discovery work",
    tags=["outpost"], request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT,
                              description="Jobs: one run's items, credentials included."))
@api_view(["GET"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_discovery_work_view(request):
    eng = request.auth
    eng.last_seen_at = timezone.now()
    eng.save(update_fields=["last_seen_at"])
    return _no_store(Response({"jobs": outposts.claim(eng)}))


@extend_schema(
    summary="Report discovery results for claimed items",
    tags=["outpost"], request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT,
                              description="How many results were accepted and refused."))
@api_view(["POST"])
@authentication_classes([OutpostAuthentication])
@permission_classes([IsAuthenticated])
def outpost_discovery_results_view(request):
    eng = request.auth
    eng.last_seen_at = timezone.now()
    eng.save(update_fields=["last_seen_at"])
    try:
        out = outposts.ingest(eng, request.data)
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(out)
