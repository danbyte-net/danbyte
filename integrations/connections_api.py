"""External-sync connections API: Windows servers (DHCP/DNS) + virtualization
sources, plus the per-tenant Settings → Integrations toggles.

Credentials are write-only everywhere; reads expose ``*_set`` booleans only.
The connection viewsets sit behind :class:`IntegrationToggleMixin`, so a tenant
with every toggle off sees plain 404s. The toggles endpoint itself is
tenant-admin-only and always reachable — it's how you turn things on.
"""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from auth_api.permissions import can_manage_admin

from .models import IntegrationSettings, VirtualizationSource, WindowsServerConnection
from .toggles import IntegrationToggleMixin

# ─── Settings → Integrations toggles ─────────────────────────────────────────


class IntegrationSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = IntegrationSettings
        fields = ["dhcp_sync_enabled", "dns_sync_enabled", "virtualization_enabled"]


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def integration_settings(request):
    """The active tenant's integration toggles (tenant-admin only, both verbs)."""
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=400)
    if not can_manage_admin(request.user, tenant):
        return Response({"detail": "Tenant admin required."}, status=403)
    obj, _ = IntegrationSettings.objects.get_or_create(tenant=tenant)
    if request.method == "PUT":
        ser = IntegrationSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    return Response(IntegrationSettingsSerializer(obj).data)


# ─── Windows server connections (WinRM) ──────────────────────────────────────


class WindowsServerConnectionSerializer(serializers.ModelSerializer):
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    password_set = serializers.SerializerMethodField()

    def get_password_set(self, obj) -> bool:
        return bool((obj.credentials or {}).get("password"))

    def validate(self, attrs):
        pw = attrs.pop("password", None)
        if pw:
            attrs["credentials"] = {"password": pw}
        elif self.instance is None:
            raise serializers.ValidationError({"password": "A password is required."})
        # blank/missing on update = keep the stored one
        return attrs

    class Meta:
        model = WindowsServerConnection
        fields = ["id", "name", "host", "port", "use_tls", "verify_ssl",
                  "auth_mode", "username", "password", "password_set",
                  "dhcp_enabled", "dns_enabled", "poll_interval_minutes",
                  "enabled", "last_sync_at", "last_sync_status",
                  "last_sync_error", "created_at", "updated_at"]
        read_only_fields = ["id", "password_set", "last_sync_at",
                            "last_sync_status", "last_sync_error",
                            "created_at", "updated_at"]


class WindowsServerConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("dhcp", "dns")
    queryset = WindowsServerConnection.objects.all().order_by("name")
    serializer_class = WindowsServerConnectionSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(host__icontains=s)
        return qs

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reachability + per-role probe: PS version, scope/zone counts."""
        from .winrm_client import WinRMError, run_json

        conn = self.get_object()
        parts = ["$r = [ordered]@{ ps_version = $PSVersionTable.PSVersion.ToString() }"]
        if conn.dhcp_enabled:
            parts.append(
                "try { $r.dhcp_scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop).Count }"
                " catch { $r.dhcp_error = $_.Exception.Message }"
            )
        if conn.dns_enabled:
            parts.append(
                "try { $r.dns_zones = @(Get-DnsServerZone -ErrorAction Stop).Count }"
                " catch { $r.dns_error = $_.Exception.Message }"
            )
        parts.append("$r | ConvertTo-Json")
        try:
            data = run_json(conn, "\n".join(parts)) or {}
        except WinRMError as exc:
            return Response({"ok": False, "error": str(exc)}, status=502)
        data["ok"] = "dhcp_error" not in data and "dns_error" not in data
        return Response(data)


# ─── Virtualization sources ──────────────────────────────────────────────────


class VirtualizationSourceSerializer(serializers.ModelSerializer):
    token_id = serializers.CharField(write_only=True, required=False, allow_blank=True)
    secret = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    credentials_set = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)

    def get_credentials_set(self, obj) -> bool:
        return bool((obj.credentials or {}).get("secret"))

    def validate_kind(self, value):
        if value == "vcenter":
            raise serializers.ValidationError(
                "vCenter support is not implemented yet — Proxmox only for now."
            )
        return value

    def validate(self, attrs):
        token_id = attrs.pop("token_id", None)
        secret = attrs.pop("secret", None)
        if secret:
            existing = (self.instance.credentials or {}) if self.instance else {}
            attrs["credentials"] = {
                "token_id": token_id or existing.get("token_id", ""),
                "secret": secret,
            }
        elif token_id and self.instance is not None:
            creds = dict(self.instance.credentials or {})
            creds["token_id"] = token_id
            attrs["credentials"] = creds
        elif self.instance is None:
            raise serializers.ValidationError(
                {"secret": "An API token (id + secret) is required."}
            )
        return attrs

    class Meta:
        model = VirtualizationSource
        fields = ["id", "name", "kind", "kind_display", "host", "port",
                  "verify_ssl", "token_id", "secret", "credentials_set",
                  "poll_interval_minutes", "enabled", "last_sync_at",
                  "last_sync_status", "last_sync_error",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "kind_display", "credentials_set",
                            "last_sync_at", "last_sync_status",
                            "last_sync_error", "created_at", "updated_at"]


class VirtualizationSourceViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("virtualization",)
    queryset = VirtualizationSource.objects.all().order_by("name")
    serializer_class = VirtualizationSourceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(host__icontains=s)
        return qs

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """API reachability: version + node count."""
        from .virt_client import VirtAPIError, proxmox_get

        source = self.get_object()
        try:
            version = proxmox_get(source, "version") or {}
            nodes = proxmox_get(source, "nodes") or []
        except VirtAPIError as exc:
            return Response({"ok": False, "error": str(exc)}, status=502)
        return Response({
            "ok": True,
            "version": version.get("version", ""),
            "nodes": len(nodes),
            "online_nodes": sum(1 for n in nodes if n.get("status") == "online"),
        })
