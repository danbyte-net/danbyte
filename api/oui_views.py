"""MAC vendor endpoints (#141): the IEEE registry import (deployment-wide)
and a tenant's custom OUI ranges.

* ``GET  /api/oui/status/``           registry size + last import
* ``POST /api/oui/import/``           multipart ``file`` or JSON ``{"url"}``
* ``GET  /api/oui/import/<id>/``      poll one run
* ``/api/oui-ranges/``                custom ranges CRUD (macaddress RBAC)
* ``GET  /api/oui-ranges/<id>/next/`` next unused MAC inside the range
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action, api_view, parser_classes, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from auth_api.permissions import can_manage_deployment

from .models import OuiImport, OuiPrefix
from .oui import OuiError, next_free_mac, parse_prefix
from .views import _get_active_tenant


def _run_dict(run: OuiImport) -> dict:
    return {
        "id": str(run.id),
        "source": run.source,
        "source_url": run.source_url,
        "status": run.status,
        "progress": run.progress or {},
        "error": run.error,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
    }


@extend_schema(
    summary="OUI registry status: how many prefixes are loaded and the last import",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def oui_status(request):
    if not can_manage_deployment(request.user):
        return Response({"detail": "users.manage required."}, status=403)
    last = OuiImport.objects.order_by("-created_at").first()
    return Response(
        {
            "prefixes": OuiPrefix.objects.filter(tenant__isnull=True).count(),
            "last_import": _run_dict(last) if last else None,
        }
    )


@extend_schema(
    summary="Import the IEEE OUI registry from an uploaded CSV or a URL (background)",
    tags=["mac-addresses"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="The queued run."),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def oui_import(request):
    """Accepts the maclookup.app CSV or IEEE ``oui.csv`` / ``mam.csv`` /
    ``oui36.csv``. Deployment-admin only: the registry is shared by every
    tenant. One run at a time."""
    if not can_manage_deployment(request.user):
        return Response({"detail": "users.manage required."}, status=403)
    if OuiImport.objects.filter(status__in=["queued", "running"]).exists():
        return Response({"detail": "An OUI import is already running."}, status=409)
    from .oui_tasks import enqueue_oui_import

    upload = request.FILES.get("file")
    url = str((request.data or {}).get("url") or "").strip()
    if upload is not None:
        if upload.size > 64 * 1024 * 1024:
            return Response({"detail": "The file is larger than 64 MB."}, status=400)
        run = OuiImport.objects.create(source="upload", file=upload, created_by=request.user)
    elif url:
        if not url.lower().startswith("https://"):
            return Response({"detail": "The URL must use https."}, status=400)
        run = OuiImport.objects.create(source="url", source_url=url, created_by=request.user)
    else:
        return Response({"detail": "Upload a CSV as `file` or give a `url`."}, status=400)
    enqueue_oui_import(run)
    run.refresh_from_db()
    return Response(_run_dict(run), status=201)


@extend_schema(
    summary="Poll one OUI import run",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def oui_import_run(request, run_id):
    if not can_manage_deployment(request.user):
        return Response({"detail": "users.manage required."}, status=403)
    run = OuiImport.objects.filter(pk=run_id).first()
    if run is None:
        return Response({"detail": "Not found."}, status=404)
    return Response(_run_dict(run))


class OuiRangeSerializer(serializers.ModelSerializer):
    prefix = serializers.CharField(max_length=32)

    class Meta:
        model = OuiPrefix
        fields = ["id", "prefix", "bits", "vendor", "description", "created_at", "updated_at"]
        read_only_fields = ["id", "bits", "created_at", "updated_at"]

    def validate_prefix(self, value):
        try:
            return parse_prefix(value)
        except OuiError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["prefix"] = instance.display_prefix
        return data


class OuiRangeViewSet(viewsets.ModelViewSet):
    """A tenant's custom OUI ranges. Gated on the ``macaddress`` object type:
    a range only ever annotates MACs, so the MAC permissions govern it."""

    serializer_class = OuiRangeSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "post", "patch", "delete"]

    def _tenant(self, action_name: str):
        tenant = _get_active_tenant(self.request)
        if tenant is None or not rbac.has_action(
            self.request.user, tenant, "macaddress", action_name
        ):
            raise PermissionDenied(f"macaddress.{action_name} required.")
        return tenant

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return OuiPrefix.objects.none()
        return OuiPrefix.objects.filter(tenant=tenant, source="custom").order_by("prefix")

    def perform_create(self, serializer):
        tenant = self._tenant("change")
        prefix = serializer.validated_data["prefix"]
        if OuiPrefix.objects.filter(tenant=tenant, prefix=prefix).exists():
            raise ValidationError({"prefix": "That range already exists."})
        serializer.save(tenant=tenant, source="custom", bits=len(prefix) * 4)

    def perform_update(self, serializer):
        self._tenant("change")
        serializer.save()

    def perform_destroy(self, instance):
        self._tenant("change")
        instance.delete()

    @extend_schema(
        summary="The lowest MAC in this range not used anywhere in the tenant",
        request=None,
        responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
    )
    @action(detail=True, methods=["get"])
    def next(self, request, pk=None):
        tenant = self._tenant("view")
        rng = self.get_object()
        mac = next_free_mac(rng, tenant)
        if mac is None:
            return Response({"detail": "No free address left in this range."}, status=409)
        return Response({"mac": mac})
