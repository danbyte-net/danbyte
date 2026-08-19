"""External-sync connections API: Windows servers (DHCP/DNS) + virtualization
sources, plus the per-tenant Settings → Integrations toggles.

Credentials are write-only everywhere; reads expose ``*_set`` booleans only.
The connection viewsets sit behind :class:`IntegrationToggleMixin`, so a tenant
with every toggle off sees plain 404s. The toggles endpoint itself is
tenant-admin-only and always reachable - it's how you turn things on.
"""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import VRF
from api.serializers import TenantScopedPrimaryKeyRelatedField
from api.viewsets import TenantScopedViewSet
from auth_api.permissions import can_manage_admin

from .models import IntegrationSettings, VirtualizationSource, WindowsServerConnection
from .toggles import IntegrationToggleMixin


class AddressPlacementSerializerMixin(serializers.Serializer):
    """Read/write the VRF a connection's discovered addresses land in.

    ``vrf_id`` goes through :class:`TenantScopedPrimaryKeyRelatedField` so a
    foreign tenant's VRF fails validation rather than being accepted; ``vrf``
    reads back as a mini object, and ``vrf_name`` renders NULL as *Global*
    since that is a real routing context, not a blank.
    """

    PLACEMENT_FIELDS = ["vrf_mode", "vrf_id", "vrf_name", "last_sync_skipped"]
    PLACEMENT_READ_ONLY = ["vrf_name", "last_sync_skipped"]

    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vrf_name = serializers.SerializerMethodField()

    def get_vrf_name(self, obj) -> str:
        return obj.vrf.name if obj.vrf_id else "Global"


# ─── Settings → Integrations toggles ─────────────────────────────────────────


class IntegrationSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = IntegrationSettings
        fields = ["dhcp_sync_enabled", "dns_sync_enabled", "virtualization_enabled"]


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def integrations_enabled(request):
    """Which integrations are on for the active tenant - read-only, any
    member. The sidebar uses this to hide integration nav while it's off."""
    from api.views import _get_active_tenant

    from .toggles import KEYS, integration_enabled

    tenant = _get_active_tenant(request)
    return Response({k: integration_enabled(tenant, k) for k in KEYS})


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


class WindowsServerConnectionSerializer(
    AddressPlacementSerializerMixin, serializers.ModelSerializer
):
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
                  *AddressPlacementSerializerMixin.PLACEMENT_FIELDS,
                  "enabled", "last_sync_at", "last_sync_status",
                  "last_sync_error", "created_at", "updated_at"]
        read_only_fields = ["id", "password_set", "last_sync_at",
                            "last_sync_status", "last_sync_error",
                            "created_at", "updated_at",
                            *AddressPlacementSerializerMixin.PLACEMENT_READ_ONLY]


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

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Sync now, synchronously - the button behind the sync log."""
        from .sync_tasks import run_windows_sync

        conn = self.get_object()
        result = run_windows_sync(str(conn.id))
        if "error" in result:
            return Response({"ok": False, **result}, status=502)
        return Response({"ok": True, **result})


# ─── Virtualization sources ──────────────────────────────────────────────────


class VirtualizationSourceSerializer(
    AddressPlacementSerializerMixin, serializers.ModelSerializer
):
    # Proxmox credentials: API token id + secret.
    token_id = serializers.CharField(write_only=True, required=False, allow_blank=True)
    secret = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    # vCenter credentials: SSO username + password.
    username = serializers.CharField(write_only=True, required=False, allow_blank=True)
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    credentials_set = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    pending_count = serializers.SerializerMethodField()

    def get_credentials_set(self, obj) -> bool:
        creds = obj.credentials or {}
        return bool(creds.get("secret") or creds.get("password"))

    def get_pending_count(self, obj) -> int:
        return obj.changes.filter(ignored=False).count()

    def validate(self, attrs):
        token_id = attrs.pop("token_id", None)
        secret = attrs.pop("secret", None)
        username = attrs.pop("username", None)
        password = attrs.pop("password", None)
        # Kind may be omitted on update - fall back to the stored one.
        kind = attrs.get("kind") or (self.instance.kind if self.instance else "proxmox")
        existing = (self.instance.credentials or {}) if self.instance else {}

        if kind == "vcenter":
            if password:
                attrs["credentials"] = {
                    "username": username or existing.get("username", ""),
                    "password": password,
                }
            elif username and self.instance is not None:
                creds = dict(existing)
                creds["username"] = username
                attrs["credentials"] = creds
            elif self.instance is None:
                raise serializers.ValidationError(
                    {"password": "A vCenter username and password are required."}
                )
        else:  # proxmox
            if secret:
                attrs["credentials"] = {
                    "token_id": token_id or existing.get("token_id", ""),
                    "secret": secret,
                }
            elif token_id and self.instance is not None:
                creds = dict(existing)
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
                  "verify_ssl", "token_id", "secret", "username", "password",
                  "credentials_set", "sync_mode", "poll_interval_minutes",
                  "sync_disks", "sync_networks", "sync_hosts",
                  "sync_host_hardware",
                  *AddressPlacementSerializerMixin.PLACEMENT_FIELDS,
                  "enabled", "pending_count", "last_sync_at", "last_sync_status",
                  "last_sync_error", "created_at", "updated_at"]
        read_only_fields = ["id", "kind_display", "credentials_set",
                            "pending_count", "last_sync_at", "last_sync_status",
                            "last_sync_error", "created_at", "updated_at",
                            *AddressPlacementSerializerMixin.PLACEMENT_READ_ONLY]


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
        """API reachability: version + node/host count."""
        from .virt_client import VCenterClient, VirtAPIError, proxmox_get

        source = self.get_object()
        if source.kind == "vcenter":
            client = VCenterClient(source)
            try:
                client.login()
                hosts = client.get("vcenter/host") or []
                vms = client.get("vcenter/vm") or []
            except VirtAPIError as exc:
                return Response({"ok": False, "error": str(exc)}, status=502)
            finally:
                client.close()
            return Response({
                "ok": True,
                # The client can't name the product from the source alone, and
                # guessing it there is how a vCenter probe came to report
                # "Proxmox VE". vSphere's REST list endpoints carry no version.
                "product": "VMware vCenter",
                "version": "",
                "nodes": len(hosts),
                "online_nodes": sum(
                    1 for h in hosts if h.get("connection_state") == "CONNECTED"
                ),
                "vms": len(vms),
            })
        try:
            version = proxmox_get(source, "version") or {}
            nodes = proxmox_get(source, "nodes") or []
        except VirtAPIError as exc:
            return Response({"ok": False, "error": str(exc)}, status=502)
        return Response({
            "ok": True,
            "product": "Proxmox VE",
            "version": version.get("version", ""),
            "nodes": len(nodes),
            "online_nodes": sum(1 for n in nodes if n.get("status") == "online"),
        })

    @action(detail=True, methods=["get"], url_path="discovered")
    def discovered(self, request, pk=None):
        """What this source actually contains, for authoring placement rules.

        Typing a pattern by hand invites typos that fail silently - a rule that
        matches nothing looks identical to no rule. So the rule editor offers
        the real datacenter / cluster / folder / host names, read live.
        """
        from .placement import strip_builtin_folders
        from .virt_client import VCenterClient, VirtAPIError, proxmox_get

        source = self.get_object()
        out = {"datacenter": [], "cluster": [], "folder": [], "host": []}
        try:
            if source.kind == "vcenter":
                client = VCenterClient(source)
                try:
                    client.login()
                    out["datacenter"] = sorted(
                        {d.get("name") for d in client.get("vcenter/datacenter") or []}
                        - {None, ""}
                    )
                    out["cluster"] = sorted(
                        {c.get("name") for c in client.get("vcenter/cluster") or []}
                        - {None, ""}
                    )
                    out["host"] = sorted(
                        {h.get("name") for h in client.get("vcenter/host") or []}
                        - {None, ""}
                    )
                    out["folder"] = sorted(
                        set(strip_builtin_folders(
                            f.get("name") for f in client.get("vcenter/folder") or []
                        ))
                    )
                finally:
                    client.close()
            else:
                status = proxmox_get(source, "cluster/status") or []
                out["cluster"] = sorted(
                    {s.get("name") for s in status if s.get("type") == "cluster"}
                    - {None, ""}
                ) or [source.name]
                out["host"] = sorted(
                    {s.get("name") for s in status if s.get("type") == "node"}
                    - {None, ""}
                )
        except VirtAPIError as exc:
            return Response({"ok": False, "error": str(exc)}, status=502)
        return Response({"ok": True, **out})

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Sync now, synchronously."""
        from .sync_tasks import run_virt_sync

        source = self.get_object()
        result = run_virt_sync(str(source.id))
        if "error" in result:
            return Response({"ok": False, **result}, status=502)
        return Response({"ok": True, **result})
