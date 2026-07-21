"""Registry endpoints for the custom-fields UI.

``GET /api/customization/meta/`` — what a field can attach to (auto-derived
from CustomFieldsMixin + plugin registrations) and what an object-reference
field can point at (endpoint + labelling info per model, so the SPA needs no
hardcoded lists and picks up plugin models automatically).

``GET /api/customization/object-labels/?model=device&ids=a,b`` — bulk
id → {label, route} resolution for displaying stored object-field values.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
)
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant
from .object_registry import (
    customizable_models,
    reference_models,
    resolve_labels,
)


@extend_schema(
    summary="Custom-field registry: customizable models and reference targets",
    tags=["customization"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "The models a field can attach to and the reference_models an "
            "object-reference field can point at (with endpoint/labelling info)."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def customization_meta(request):
    return Response({
        "models": [
            {"value": slug, "label": label}
            for slug, label in customizable_models()
        ],
        "reference_models": [
            {
                "value": r.slug,
                "label": r.label,
                "endpoint": r.endpoint,
                "label_field": r.label_field,
                "picker": r.picker,
                "route": r.route,
            }
            for r in sorted(
                reference_models().values(), key=lambda r: r.label.lower()
            )
        ],
    })


@extend_schema(
    summary="Bulk id → {label, route} resolution for object-field values",
    tags=["customization"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="model",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="The reference model slug (e.g. 'device').",
        ),
        OpenApiParameter(
            name="ids",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated object ids (capped at 200).",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="A results map of id → {label, route}.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def object_labels(request):
    slug = request.query_params.get("model", "")
    ids = [
        i for i in request.query_params.get("ids", "").split(",") if i
    ][:200]
    tenant = _get_active_tenant(request)
    return Response({"results": resolve_labels(slug, ids, tenant=tenant)})
