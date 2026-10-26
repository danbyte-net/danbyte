"""The PRTG API surface.

Every viewset carries ``integration_keys = ("prtg",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert. The push receiver (:mod:`prtg.hook`) is the one exception: it
has no session and checks the switch itself.
"""
from __future__ import annotations

from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.models import Device, IPAddress
from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled
from monitoring.external.queue import ChangeQueueMixin

from .models import PrtgAdoptionRule, PrtgChange, PrtgConnection, PrtgDeviceLink
from .serializers import (
    PrtgAdoptionRuleSerializer,
    PrtgChangeSerializer,
    PrtgConnectionSerializer,
    PrtgDefaultsSerializer,
    PrtgDeviceLinkSerializer,
)

_TestResult = inline_serializer("PrtgTestResult", fields={
    "ok": serializers.BooleanField(),
    "detail": serializers.CharField(),
    "version": serializers.CharField(),
    "probes": serializers.IntegerField(allow_null=True),
    "sensors": serializers.IntegerField(allow_null=True),
    "v2_available": serializers.BooleanField(allow_null=True),
    "v2_detail": serializers.CharField(),
})

_HookToken = inline_serializer("PrtgHookToken", fields={
    "token": serializers.CharField(),
    "path": serializers.CharField(),
})


class _ByConnection:
    """``?connection=<id>`` narrows a list to one connection."""

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


class PrtgConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    queryset = PrtgConnection.objects.all().order_by("name")
    serializer_class = PrtgConnectionSerializer

    @action(detail=False, methods=["get"])
    def defaults(self, request):
        """Status codes, their default states and the states they may map
        onto, so the form hard-codes neither PRTG's codes nor Danbyte's."""
        return Response(PrtgDefaultsSerializer.payload(_get_active_tenant(request)))

    @extend_schema(request=None, responses={200: _TestResult, 502: _TestResult})
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach PRTG and describe it: version, probes, sensors, API v2.
        Records what it learned on the connection."""
        from .connection import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["post"], url_path="status-now")
    def status_now(self, request, pk=None):
        """Read PRTG now: devices, sensors, links, roll-ups. The same pass the
        beat runs, so the button and the timer cannot drift apart."""
        from .client import PrtgError
        from .reader import _stamp, read_status

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        now = timezone.now()
        try:
            counts = read_status(conn, now)
        except PrtgError as exc:
            _stamp(conn, now, error=str(exc))
            return Response({"detail": str(exc)[:300]}, status=502)
        _stamp(conn, now, summary=counts)
        return Response(counts)

    @extend_schema(request=None, responses={200: _HookToken})
    @action(detail=True, methods=["post"], url_path="rotate-hook-token")
    def rotate_hook_token(self, request, pk=None):
        """Make a new push token and return it - once. Only its hash is kept,
        so the old token stops working and the new one cannot be read back."""
        from .hook import new_token

        conn = self.get_object()
        token = new_token(conn)
        return Response({"token": token, "path": f"/api/prtg/hook/{token}/"})


class PrtgDeviceLinkViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Read-only: a link is made by matching. Deleting one says "that pairing
    is wrong"; the next pass matches the device from scratch."""

    integration_keys = ("prtg",)
    http_method_names = ["get", "delete", "head", "options"]
    queryset = PrtgDeviceLink.objects.select_related("device", "connection").order_by("name")
    serializer_class = PrtgDeviceLinkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        device = self.request.query_params.get("device") if self.request else None
        return qs.filter(device_id=device) if device else qs


class PrtgChangeViewSet(
    IntegrationToggleMixin, ChangeQueueMixin, TenantScopedViewSet
):
    """The review queue: apply, dismiss, restore, apply-all (the shared
    actions). Proposals come from the status pass, never from here."""

    integration_keys = ("prtg",)
    http_method_names = ["get", "post", "head", "options"]
    queryset = (
        PrtgChange.objects.select_related("device", "connection")
        .order_by("kind", "-created_at")
    )
    serializer_class = PrtgChangeSerializer
    change_model = PrtgChange
    connection_model = PrtgConnection

    def apply_change(self, change) -> str:
        from .reader import apply_link

        if change.kind != PrtgChange.LINK:
            raise ValueError("This proposal needs a decision, not an apply.")
        return apply_link(change)

    def apply_pending(self, conn) -> dict:
        from .reader import apply_link

        applied, failed = 0, []
        for change in PrtgChange.applicable(conn).select_related("device", "connection"):
            try:
                apply_link(change)
                applied += 1
            except ValueError as exc:
                failed.append({"id": str(change.id), "detail": str(exc)})
        return {"applied": applied, "failed": failed}

    def remote_errors(self) -> tuple:
        from .client import PrtgError

        return (PrtgError,)


class PrtgAdoptionRuleViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Where an adopted PRTG device lands. First match wins in weight order."""

    integration_keys = ("prtg",)
    queryset = (
        PrtgAdoptionRule.objects.select_related("site", "role", "device_type")
        .order_by("weight", "pattern")
    )
    serializer_class = PrtgAdoptionRuleSerializer


def _visible_devices(request, tenant):
    return rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
    )


class PrtgDeviceStatusView(APIView):
    """What PRTG says about a device - ``?device=<id>`` or ``?ip=<id>``.

    One entry per link. Read access is the device's own: a viewer who may see
    the device may see what PRTG says about it.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        device_id = (request.query_params.get("device") or "").strip()
        ip_id = (request.query_params.get("ip") or "").strip()
        if ip_id and not device_id:
            ip = rbac.restrict_queryset(
                IPAddress.objects.filter(tenant=tenant, id=ip_id),
                request.user, tenant, "ipaddress", "view",
            ).first()
            if ip is None or not ip.assigned_device_id:
                return Response([])
            device_id = str(ip.assigned_device_id)
        if not device_id:
            return Response({"detail": "device or ip is required."}, status=400)
        device = _visible_devices(request, tenant).filter(id=device_id).first()
        if device is None:
            return Response([])
        from .reader import problems_for

        links = (
            PrtgDeviceLink.objects.filter(device=device, connection__enabled=True)
            .select_related("connection").order_by("connection__name")
        )
        return Response([
            {
                "connection": {"id": str(lk.connection_id), "name": lk.connection.name,
                               "url": lk.connection.url},
                "device": {"objid": lk.objid, "name": lk.name, "host": lk.host,
                           "url": lk.connection.device_url(lk.objid)},
                "link": {"matched_by": lk.matched_by, "tagged": lk.tagged},
                "status": {"state": lk.state or None, "counts": lk.sensor_counts,
                           "problems": problems_for(lk), "read_at": lk.status_read_at},
            }
            for lk in links
        ])


class PrtgDeviceStatesView(APIView):
    """Every linked device's roll-up, for the device list's PRTG column:
    ``{device id: {state, down, warning, url, name}}``. Only devices the
    caller may view; one connection per device (the first by name)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        visible = _visible_devices(request, tenant).values("id")
        out: dict = {}
        links = (
            PrtgDeviceLink.objects.filter(
                tenant=tenant, connection__enabled=True, device_id__in=visible,
            ).select_related("connection").order_by("connection__name")
        )
        for lk in links:
            key = str(lk.device_id)
            if key in out:
                continue
            counts = lk.sensor_counts or {}
            out[key] = {
                "state": lk.state or None,
                "down": int(counts.get("down", 0) or 0),
                "warning": int(counts.get("degraded", 0) or 0),
                "name": lk.name,
                "url": lk.connection.device_url(lk.objid),
            }
        return Response(out)
