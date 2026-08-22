"""Windows DHCP sync API: scopes (read + per-scope lease opt-in),
reservations (bidirectional - writes push to the server), leases (read-only).

Tenanting rides the connection: every queryset filters through
``connection__tenant``, and reservation writes re-validate that the target
scope belongs to the active tenant before any WinRM call fires.
"""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet

from .dhcp_sync import (
    WinRMError,
    push_reservation,
    push_scope,
    remove_reservation,
    remove_scope,
)
from .models import (
    DhcpLease,
    DhcpReservation,
    DhcpScope,
    WindowsServerConnection,
)
from .toggles import IntegrationToggleMixin


class DhcpScopeSerializer(serializers.ModelSerializer):
    connection_name = serializers.SerializerMethodField()
    is_local = serializers.BooleanField(read_only=True)
    prefix_cidr = serializers.CharField(
        source="prefix.cidr", read_only=True, default=None
    )
    vrf_name = serializers.SerializerMethodField()
    reservation_count = serializers.IntegerField(read_only=True)
    drift_count = serializers.IntegerField(read_only=True)

    def get_connection_name(self, obj) -> str | None:
        return obj.connection.name if obj.connection_id else None

    def get_vrf_name(self, obj) -> str | None:
        p = obj.prefix
        return p.vrf.name if p is not None and p.vrf_id else None

    class Meta:
        model = DhcpScope
        fields = ["id", "connection", "connection_name", "is_local", "scope_id",
                  "name", "description", "state", "start_range", "end_range",
                  "subnet_mask", "lease_duration", "options", "prefix",
                  "prefix_cidr", "vrf_name", "lease_sync", "reservation_count",
                  "drift_count", "last_seen_at", "updated_at"]
        # Everything mirrors the server except the one Danbyte-side knob.
        read_only_fields = [f for f in fields if f != "lease_sync"]


class DhcpScopeWriteSerializer(serializers.ModelSerializer):
    """Author a scope. Two flavours:

    * ``connection`` set - created on that Windows server first
      (``Add-DhcpServerv4Scope``); the row only saves once accepted.
    * ``connection`` null - a **local** scope owned by Danbyte, for
      deployments without a synced DHCP server. No push; pure documentation.

    The subnet comes from an **existing prefix** (``prefix``) or a typed CIDR
    (``subnet``, optionally with a ``vrf`` for lookup/creation). The scope id
    and mask derive from it; the range is the lease pool inside it.
    """

    connection = serializers.PrimaryKeyRelatedField(
        queryset=WindowsServerConnection.objects.all(),
        required=False, allow_null=True, default=None,
    )
    subnet = serializers.CharField(
        write_only=True, required=False, allow_blank=True, default="",
        help_text="Subnet CIDR, e.g. 10.50.0.0/24 (or pick an existing prefix)",
    )
    prefix = serializers.UUIDField(
        write_only=True, required=False, allow_null=True, default=None,
        help_text="Existing Prefix id to back the scope",
    )
    vrf = serializers.UUIDField(
        write_only=True, required=False, allow_null=True, default=None,
        help_text="VRF for subnet lookup/creation (ignored when prefix given)",
    )

    class Meta:
        model = DhcpScope
        fields = ["id", "connection", "name", "description",
                  "start_range", "end_range", "subnet", "prefix", "vrf"]

    def validate(self, attrs):
        import ipaddress

        subnet = (attrs.get("subnet") or "").strip()
        if bool(subnet) == bool(attrs.get("prefix")):
            raise serializers.ValidationError(
                {"subnet": "Pick an existing prefix or enter a subnet - one of "
                           "the two."}
            )
        if subnet:
            try:
                net = ipaddress.ip_network(subnet, strict=False)
            except ValueError as exc:
                raise serializers.ValidationError(
                    {"subnet": "Enter a valid subnet, e.g. 10.50.0.0/24."}
                ) from exc
            if not isinstance(net, ipaddress.IPv4Network):
                raise serializers.ValidationError(
                    {"subnet": "Only IPv4 DHCP scopes are supported."}
                )
            attrs["_net"] = net
        try:
            start = ipaddress.ip_address(attrs["start_range"])
            end = ipaddress.ip_address(attrs["end_range"])
        except ValueError as exc:
            raise serializers.ValidationError(
                {"start_range": "Enter valid start and end addresses."}
            ) from exc
        if int(start) > int(end):
            raise serializers.ValidationError(
                {"end_range": "End address is before the start."}
            )
        # Range-inside-net is checked here for typed subnets; for an existing
        # prefix the viewset checks after resolving it in-tenant.
        if subnet and (start not in attrs["_net"] or end not in attrs["_net"]):
            raise serializers.ValidationError(
                {"start_range": f"The range must lie inside {attrs['_net']}."}
            )
        return attrs


class DhcpScopeViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Scopes are read from sync; the per-scope ``lease_sync`` opt-in is PATCHable.
    A scope can also be **authored** here (POST): with a connection Danbyte
    creates it on the Windows server first (``Add-DhcpServerv4Scope``) and only
    saves once accepted; without one it's a **local** Danbyte-owned scope.
    DELETE removes a pushed scope on its server too."""

    # No integration gate: scopes are first-class - the DHCP toggle only
    # governs the Windows-sync machinery.
    # Tenant scoping is bimodal (see get_queryset) - synced scopes ride their
    # connection's tenant, local scopes carry tenant directly.
    tenant_field = "connection__tenant"
    http_method_names = ["get", "post", "patch", "delete"]
    queryset = DhcpScope.objects.select_related(
        "connection", "prefix", "prefix__vrf"
    ).order_by("scope_id")
    serializer_class = DhcpScopeSerializer

    def get_serializer_class(self):
        if self.action == "create":
            return DhcpScopeWriteSerializer
        return DhcpScopeSerializer

    def _conn_in_tenant(self, conn):
        tenant = self._tenant_or_403()
        if conn is None or conn.tenant_id != tenant.id:
            raise ValidationError({"connection": "Unknown server connection."})
        return conn

    def perform_create(self, serializer):
        import ipaddress

        from django.utils import timezone

        from api.models import VRF, Prefix

        from .dhcp_sync import _prefix_for_scope

        tenant = self._tenant_or_403()
        v = serializer.validated_data
        conn = v.get("connection")
        if conn is not None:
            self._conn_in_tenant(conn)

        # Resolve the subnet: an existing (tenant-scoped) prefix, or a typed
        # CIDR looked up / created in the chosen VRF.
        prefix_id = v.pop("prefix", None)
        vrf_id = v.pop("vrf", None)
        v.pop("subnet", None)
        if prefix_id:
            prefix = Prefix.objects.filter(pk=prefix_id, tenant=tenant).first()
            if prefix is None:
                raise ValidationError({"prefix": "Not found in this tenant."})
            try:
                net = ipaddress.ip_network(prefix.cidr, strict=False)
            except ValueError as exc:
                raise ValidationError(
                    {"prefix": "That prefix's CIDR is not usable."}
                ) from exc
            if not isinstance(net, ipaddress.IPv4Network):
                raise ValidationError(
                    {"prefix": "Only IPv4 DHCP scopes are supported."}
                )
            start = ipaddress.ip_address(v["start_range"])
            end = ipaddress.ip_address(v["end_range"])
            if start not in net or end not in net:
                raise ValidationError(
                    {"start_range": f"The range must lie inside {net}."}
                )
        else:
            net = v.pop("_net")
            vrf = None
            if vrf_id:
                vrf = VRF.objects.filter(pk=vrf_id, tenant=tenant).first()
                if vrf is None:
                    raise ValidationError({"vrf": "Not found in this tenant."})
            prefix, _ = _prefix_for_scope(
                conn, str(net.network_address), str(net.netmask),
                tenant=tenant, vrf=vrf,
                note="" if conn is None else None,
            )

        scope_id = str(net.network_address)
        mask = str(net.netmask)
        dupe = (
            DhcpScope.objects.filter(connection=conn, scope_id=scope_id)
            if conn is not None
            else DhcpScope.objects.filter(
                connection__isnull=True, tenant=tenant, scope_id=scope_id
            )
        )
        if dupe.exists():
            raise ValidationError(
                {"subnet": "A scope for this subnet already exists there."}
            )

        if conn is not None:
            try:
                push_scope(
                    conn, name=v.get("name", ""), start=str(v["start_range"]),
                    end=str(v["end_range"]), mask=mask,
                    description=v.get("description", ""),
                )
            except WinRMError as exc:
                raise ValidationError(
                    {"detail": f"The DHCP server refused: {exc}"}
                ) from exc
            serializer.save(
                scope_id=scope_id, subnet_mask=mask, prefix=prefix,
                state="Active", last_seen_at=timezone.now(),
            )
        else:
            serializer.save(
                tenant=tenant, scope_id=scope_id, subnet_mask=mask,
                prefix=prefix, state="Active",
            )

    def perform_destroy(self, instance):
        if instance.connection_id is not None:
            try:
                remove_scope(instance.connection, instance.scope_id)
            except WinRMError as exc:
                raise ValidationError(
                    {"detail": f"The DHCP server refused: {exc}"}
                ) from exc
        instance.delete()

    def get_queryset(self):
        from django.db.models import Count, Q

        from api.views import _get_active_tenant
        from auth_api.drf import restrict_for_view

        # Bimodal tenant scope - the base class can only follow one traversal.
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = restrict_for_view(
            self,
            self.queryset.filter(
                Q(connection__tenant=tenant)
                | Q(connection__isnull=True, tenant=tenant)
            ),
        )
        qs = qs.annotate(
            reservation_count=Count("reservations", distinct=True),
            drift_count=Count(
                "reservations", distinct=True,
                filter=~Q(reservations__drift=""),
            ),
        )
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(connection_id=conn)
        s = (self.request.query_params.get("search") or "").strip()
        if s:
            qs = qs.filter(scope_id__icontains=s) | qs.filter(name__icontains=s)
        return qs


class DhcpReservationSerializer(serializers.ModelSerializer):
    scope_display = serializers.CharField(source="scope.scope_id", read_only=True)
    # Server id + name so tables can link the Server cell to its detail page
    # (null for local scopes), and the scope's backing prefix so the Scope cell
    # can link into IPAM.
    connection = serializers.SerializerMethodField()
    connection_name = serializers.SerializerMethodField()
    scope_prefix = serializers.SerializerMethodField()

    def get_connection(self, obj) -> str | None:
        return str(obj.scope.connection_id) if obj.scope.connection_id else None

    def get_connection_name(self, obj) -> str | None:
        return obj.scope.connection.name if obj.scope.connection_id else None

    def get_scope_prefix(self, obj) -> str | None:
        return str(obj.scope.prefix_id) if obj.scope.prefix_id else None

    class Meta:
        model = DhcpReservation
        fields = ["id", "scope", "scope_display", "scope_prefix", "connection",
                  "connection_name", "ip", "mac", "name", "description",
                  "ip_address", "managed", "drift", "drift_detail",
                  "last_seen_at", "updated_at"]
        read_only_fields = ["id", "scope_display", "scope_prefix", "connection",
                            "connection_name", "ip_address", "managed",
                            "drift", "drift_detail", "last_seen_at",
                            "updated_at"]

    def validate_mac(self, value):
        from .dhcp_sync import _norm_mac

        mac = _norm_mac(value)
        if len(mac.replace(":", "")) != 12:
            raise serializers.ValidationError(
                "Enter a MAC address like aa:bb:cc:00:11:22."
            )
        return mac

    def validate(self, attrs):
        if self.instance is not None:
            moved = (
                "scope" in attrs and attrs["scope"].id != self.instance.scope_id
            ) or ("ip" in attrs and attrs["ip"] != self.instance.ip)
            if moved:
                raise serializers.ValidationError({
                    "ip": "A reservation's scope and IP are fixed - delete it "
                          "and create a new one to move it."
                })
        return attrs


class DhcpReservationViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Bidirectional: every write here is pushed to the Windows server first;
    the row is only saved once the server accepted it."""

    tenant_field = "scope__connection__tenant"
    queryset = DhcpReservation.objects.select_related(
        "scope", "scope__connection", "ip_address"
    ).order_by("ip")
    serializer_class = DhcpReservationSerializer
    rbac_action_map = {"resolve": "change"}

    def get_queryset(self):
        from django.db.models import Q

        from api.views import _get_active_tenant
        from auth_api.drf import restrict_for_view

        # Bimodal tenant scope (mirrors DhcpScopeViewSet): synced reservations
        # ride the connection's tenant, local ones their scope's own tenant.
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = restrict_for_view(
            self,
            self.queryset.filter(
                Q(scope__connection__tenant=tenant)
                | Q(scope__connection__isnull=True, scope__tenant=tenant)
            ),
        )
        scope = self.request.query_params.get("scope")
        if scope:
            qs = qs.filter(scope_id=scope)
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(scope__connection_id=conn)
        if self.request.query_params.get("drift") == "1":
            qs = qs.exclude(drift="")
        s = (self.request.query_params.get("search") or "").strip()
        if s:
            qs = (qs.filter(ip__icontains=s) | qs.filter(mac__icontains=s)
                  | qs.filter(name__icontains=s))
        return qs

    def _scope_in_tenant(self, scope) -> DhcpScope:
        tenant = self._tenant_or_403()
        owner = (
            scope.connection.tenant_id if scope and scope.connection_id
            else getattr(scope, "tenant_id", None)
        )
        if scope is None or owner != tenant.id:
            raise ValidationError({"scope": "Unknown scope."})
        return scope

    def perform_create(self, serializer):
        scope = self._scope_in_tenant(serializer.validated_data.get("scope"))
        v = serializer.validated_data
        if DhcpReservation.objects.filter(scope=scope, ip=v["ip"]).exists():
            raise ValidationError({"ip": "This address is already reserved."})
        if scope.connection_id is not None:  # local scopes have nothing to push to
            try:
                push_reservation(
                    scope.connection, scope, ip=v["ip"], mac=v.get("mac", ""),
                    name=v.get("name", ""), description=v.get("description", ""),
                    exists=False,
                )
            except WinRMError as exc:
                raise ValidationError(
                    {"detail": f"The DHCP server refused: {exc}"}
                ) from exc
        res = serializer.save(managed=True)
        self._link_ip(res)

    def perform_update(self, serializer):
        res = serializer.instance
        v = serializer.validated_data
        if res.scope.connection_id is not None:
            try:
                push_reservation(
                    res.scope.connection, res.scope, ip=res.ip,
                    mac=v.get("mac", res.mac), name=v.get("name", res.name),
                    description=v.get("description", res.description),
                    exists=True,
                )
            except WinRMError as exc:
                raise ValidationError(
                    {"detail": f"The DHCP server refused: {exc}"}
                ) from exc
        # An edit from Danbyte takes ownership and clears any pending drift.
        serializer.save(managed=True, drift="", drift_detail={})

    def perform_destroy(self, instance):
        if instance.scope.connection_id is not None:
            try:
                remove_reservation(instance.scope.connection, instance.scope,
                                   instance.ip)
            except WinRMError as exc:
                if instance.drift != "missing":  # already gone is fine
                    raise ValidationError(
                        {"detail": f"The DHCP server refused: {exc}"}
                    ) from exc
        instance.delete()

    def _link_ip(self, res) -> None:
        from .dhcp_sync import _ip_for_reservation

        res.ip_address = _ip_for_reservation(res.scope.connection, res.scope, res)
        res.save(update_fields=["ip_address"])

    @action(detail=True, methods=["post"])
    def resolve(self, request, pk=None):
        """Settle a drift flag. Body: ``{"strategy": "accept" | "push"}`` -
        accept the server's version into Danbyte, or re-push Danbyte's."""
        res = self.get_object()
        strategy = (request.data or {}).get("strategy")
        if not res.drift:
            return Response({"detail": "Nothing to resolve."}, status=400)
        if strategy == "accept":
            if res.drift == "missing":
                res.delete()
                return Response({"detail": "Reservation removed."})
            for field, pair in (res.drift_detail or {}).items():
                setattr(res, field, pair.get("server", getattr(res, field)))
            res.drift, res.drift_detail = "", {}
            res.save()
        elif strategy == "push":
            try:
                push_reservation(
                    res.scope.connection, res.scope, ip=res.ip, mac=res.mac,
                    name=res.name, description=res.description,
                    exists=(res.drift != "missing"),
                )
            except WinRMError as exc:
                return Response({"ok": False, "error": str(exc)}, status=502)
            res.drift, res.drift_detail = "", {}
            res.save(update_fields=["drift", "drift_detail"])
        else:
            return Response(
                {"detail": "strategy must be 'accept' or 'push'."}, status=400
            )
        return Response(DhcpReservationSerializer(res).data)


class DhcpLeaseSerializer(serializers.ModelSerializer):
    scope_display = serializers.CharField(source="scope.scope_id", read_only=True)

    class Meta:
        model = DhcpLease
        fields = ["id", "scope", "scope_display", "ip", "mac", "hostname",
                  "address_state", "expires_at", "ip_address", "last_seen_at"]
        read_only_fields = fields


class DhcpLeaseViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("dhcp",)
    tenant_field = "scope__connection__tenant"
    http_method_names = ["get"]
    queryset = DhcpLease.objects.select_related("scope").order_by("ip")
    serializer_class = DhcpLeaseSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        scope = self.request.query_params.get("scope")
        if scope:
            qs = qs.filter(scope_id=scope)
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(scope__connection_id=conn)
        s = (self.request.query_params.get("search") or "").strip()
        if s:
            qs = (qs.filter(ip__icontains=s) | qs.filter(mac__icontains=s)
                  | qs.filter(hostname__icontains=s))
        return qs
