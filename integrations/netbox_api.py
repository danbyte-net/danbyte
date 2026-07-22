"""NetBox import — SPA JSON endpoints (tenant-admin gated).

Test a connection, launch an import (queued on the RQ ``low`` queue), and poll
its progress. The NetBox URL is SSRF-guarded on every fetch (a tenant admin
supplies it), and the API token is never echoed back.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_admin

from .models import NetBoxImportRun

# Object counts shown in the connection-test preview — the biggest, most
# telling types. Each is a NetBox list path.
PREVIEW_COUNTS = [
    ("sites", "dcim/sites"),
    ("devices", "dcim/devices"),
    ("interfaces", "dcim/interfaces"),
    ("prefixes", "ipam/prefixes"),
    ("ip_addresses", "ipam/ip-addresses"),
    ("vlans", "ipam/vlans"),
    ("cables", "dcim/cables"),
    ("virtual_machines", "virtualization/virtual-machines"),
    # netbox-map plugin — optional; a missing plugin just omits the count.
    ("floor_plans", "plugins/map/floorplans"),
]


class NetBoxImportRunSerializer(serializers.ModelSerializer):
    class Meta:
        model = NetBoxImportRun
        fields = [
            "id", "url", "status", "dry_run", "update_existing", "insecure",
            "with_images", "only", "skip", "progress", "report", "error",
            "started_at", "finished_at", "created_at",
        ]
        read_only_fields = fields  # everything is server-managed


def _tenant_or_403(request):
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, Response({"detail": "No active tenant."}, status=400)
    if not can_manage_admin(request.user, tenant):
        return None, Response({"detail": "Tenant admin required."}, status=403)
    return tenant, None


@extend_schema(
    summary="Probe a NetBox instance for version and object counts",
    tags=["integrations"],
    request=inline_serializer(
        name="NetBoxTestRequest",
        fields={
            "url": serializers.URLField(),
            "token": serializers.CharField(),
            "insecure": serializers.BooleanField(required=False, default=False),
        },
    ),
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Connection ok: NetBox version and per-type object counts.",
        ),
        400: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Missing URL/token or SSRF-refused URL.",
        ),
        502: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Connection to the NetBox instance failed.",
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def netbox_test(request):
    """Probe a NetBox instance: version + object counts, so the UI can show
    what an import would pull. SSRF-guarded."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err
    from core.ssrf import SSRFError
    from .management.commands.import_netbox import NetBoxClient

    data = request.data or {}
    url = (data.get("url") or "").strip()
    token = (data.get("token") or "").strip()
    if not url or not token:
        return Response({"ok": False, "error": "URL and token are required."},
                        status=400)
    try:
        client = NetBoxClient(
            url, token, verify=not data.get("insecure"), guard=True
        )
        status = client.status()
        counts = {}
        for key, path in PREVIEW_COUNTS:
            try:
                counts[key] = client.count(path)
            except Exception:  # noqa: BLE001 — a missing type just omits its count
                pass
    except SSRFError as exc:
        return Response({"ok": False, "error": f"Refused: {exc}"}, status=400)
    except Exception as exc:  # noqa: BLE001 — surface the connection error
        return Response({"ok": False, "error": str(exc)}, status=502)
    return Response({
        "ok": True,
        "netbox_version": status.get("netbox-version") or status.get("version"),
        "counts": counts,
    })


@extend_schema(
    methods=["GET"],
    summary="List recent NetBox import runs for the active tenant",
    tags=["integrations"],
    request=None,
    responses={200: NetBoxImportRunSerializer(many=True)},
)
@extend_schema(
    methods=["POST"],
    summary="Launch a new NetBox import run",
    tags=["integrations"],
    request=inline_serializer(
        name="NetBoxImportRequest",
        fields={
            "url": serializers.URLField(),
            "token": serializers.CharField(),
            "dry_run": serializers.BooleanField(required=False, default=True),
            "update_existing": serializers.BooleanField(required=False, default=False),
            "insecure": serializers.BooleanField(required=False, default=False),
            "with_images": serializers.BooleanField(required=False, default=False),
            "only": serializers.ListField(
                child=serializers.CharField(), required=False
            ),
            "skip": serializers.ListField(
                child=serializers.CharField(), required=False
            ),
        },
    ),
    responses={201: NetBoxImportRunSerializer},
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def netbox_imports(request):
    """GET: recent runs for this tenant. POST: launch a new import."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err

    if request.method == "GET":
        runs = NetBoxImportRun.objects.filter(tenant=tenant)[:25]
        return Response(NetBoxImportRunSerializer(runs, many=True).data)

    from core.ssrf import SSRFError, assert_public_url

    from .netbox_tasks import enqueue_netbox_import

    data = request.data or {}
    url = (data.get("url") or "").strip()
    token = (data.get("token") or "").strip()
    if not url or not token:
        return Response({"detail": "URL and token are required."}, status=400)
    # Fail fast on an obviously-bad URL before creating a run row (the client
    # re-checks every fetch too).
    try:
        assert_public_url(url)
    except SSRFError as exc:
        return Response({"detail": f"Refused: {exc}"}, status=400)

    run = enqueue_netbox_import(
        tenant, url, token,
        dry_run=bool(data.get("dry_run", True)),
        update_existing=bool(data.get("update_existing")),
        insecure=bool(data.get("insecure")),
        with_images=bool(data.get("with_images")),
        only=data.get("only") or [],
        skip=data.get("skip") or [],
        user=request.user,
    )
    return Response(NetBoxImportRunSerializer(run).data, status=201)


@extend_schema(
    summary="Poll one NetBox import run's status, progress, and report",
    tags=["integrations"],
    request=None,
    responses={
        200: NetBoxImportRunSerializer,
        404: OpenApiResponse(
            response=OpenApiTypes.OBJECT, description="Run not found for this tenant."
        ),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def netbox_import_detail(request, run_id):
    """Poll one run's status / progress / report."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err
    run = NetBoxImportRun.objects.filter(tenant=tenant, pk=run_id).first()
    if run is None:
        return Response({"detail": "Not found."}, status=404)
    return Response(NetBoxImportRunSerializer(run).data)
