"""Registry endpoints for the custom-fields UI.

``GET /api/customization/meta/`` — what a field can attach to (auto-derived
from CustomFieldsMixin + plugin registrations) and what an object-reference
field can point at (endpoint + labelling info per model, so the SPA needs no
hardcoded lists and picks up plugin models automatically).

``GET /api/customization/object-labels/?model=device&ids=a,b`` — bulk
id → {label, route} resolution for displaying stored object-field values.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant
from .object_registry import (
    customizable_models,
    reference_models,
    resolve_labels,
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


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def object_labels(request):
    slug = request.query_params.get("model", "")
    ids = [
        i for i in request.query_params.get("ids", "").split(",") if i
    ][:200]
    tenant = _get_active_tenant(request)
    return Response({"results": resolve_labels(slug, ids, tenant=tenant)})
