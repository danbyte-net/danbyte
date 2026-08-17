"""Windows DHCP sync API: scopes (read + per-scope lease opt-in),
reservations (bidirectional — writes push to the server), leases (read-only).

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
from .models import DhcpLease, DhcpReservation, DhcpScope
from .toggles import IntegrationToggleMixin


class DhcpScopeSerializer(serializers.ModelSerializer):
    connection_name = serializers.CharField(source="connection.name", read_only=True)
    prefix_cidr = serializers.CharField(
        source="prefix.cidr", read_only=True, default=None
    )
    reservation_count = serializers.IntegerField(read_only=True)
    drift_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = DhcpScope
        fields = ["id", "connection", "connection_name", "scope_id", "name",
                  "description", "state", "start_range", "end_range",
                  "subnet_mask", "lease_duration", "options", "prefix",
                  "prefix_cidr", "lease_sync", "reservation_count",
                  "drift_count", "last_seen_at", "updated_at"]
        # Everything mirrors the server except the one Danbyte-side knob.
        read_only_fields = [f for f in fields if f != "lease_sync"]


class DhcpScopeWriteSerializer(serializers.ModelSerializer):
    """Author a scope in Danbyte and push it to the Windows server. The scope id
    and subnet mask are derived from ``subnet`` (a CIDR); the range is the lease
    pool inside it."""

    subnet = serializers.CharField(
        write_only=True, help_text="Subnet CIDR, e.g. 10.50.0.0/24"
    )

    class Meta:
        model = DhcpScope
        fields = ["id", "connection", "name", "description",
                  "start_range", "end_range", "subnet"]

    def validate(self, attrs):
        import ipaddress

        try:
            net = ipaddress.ip_network(attrs["subnet"], strict=False)
        except ValueError as exc:
            raise serializers.ValidationError(
                {"subnet": "Enter a valid subnet, e.g. 10.50.0.0/24."}
            ) from exc
        if not isinstance(net, ipaddress.IPv4Network):
            raise serializers.ValidationError(
                {"subnet": "Only IPv4 DHCP scopes are supported."}
            )
        try:
            start = ipaddress.ip_address(attrs["start_range"])
            end = ipaddress.ip_address(attrs["end_range"])
        except ValueError as exc:
            raise serializers.ValidationError(
                {"start_range": "Enter valid start and end addresses."}
            ) from exc
        if start not in net or end not in net:
            raise serializers.ValidationError(
                {"start_range": f"The range must lie inside {net}."}
            )
        if int(start) > int(end):
            raise serializers.ValidationError(
                {"end_range": "End address is before the start."}
            )
        attrs["_net"] = net
        return attrs


class DhcpScopeViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Scopes are read from sync; the per-scope ``lease_sync`` opt-in is PATCHable.
    A scope can also be **authored** here (POST) — Danbyte creates it on the
    Windows server first (``Add-DhcpServerv4Scope``) and only saves the row once
    the server accepts it — and removed (DELETE, which also removes it there)."""

    integration_keys = ("dhcp",)
    tenant_field = "connection__tenant"
    http_method_names = ["get", "post", "patch", "delete"]
    queryset = DhcpScope.objects.select_related("connection", "prefix").order_by(
        "scope_id"
    )
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
        from django.utils import timezone

        from .dhcp_sync import _prefix_for_scope

        v = serializer.validated_data
        conn = self._conn_in_tenant(v.get("connection"))
        net = v.pop("_net")
        v.pop("subnet", None)
        scope_id = str(net.network_address)
        mask = str(net.netmask)
        if DhcpScope.objects.filter(connection=conn, scope_id=scope_id).exists():
            raise ValidationError(
                {"subnet": "A scope for this subnet already exists on that server."}
            )
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
        prefix, _ = _prefix_for_scope(conn, scope_id, mask)
        serializer.save(
            scope_id=scope_id, subnet_mask=mask, prefix=prefix,
            state="Active", last_seen_at=timezone.now(),
        )

    def perform_destroy(self, instance):
        try:
            remove_scope(instance.connection, instance.scope_id)
        except WinRMError as exc:
            raise ValidationError(
                {"detail": f"The DHCP server refused: {exc}"}
            ) from exc
        instance.delete()

    def get_queryset(self):
        from django.db.models import Count, Q

        qs = super().get_queryset().annotate(
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
    # Server id + name so tables can link the Server cell to its detail page,
    # and the scope's backing prefix so the Scope cell can link into IPAM.
    connection = serializers.CharField(source="scope.connection_id", read_only=True)
    connection_name = serializers.CharField(
        source="scope.connection.name", read_only=True
    )
    scope_prefix = serializers.SerializerMethodField()

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
                    "ip": "A reservation's scope and IP are fixed — delete it "
                          "and create a new one to move it."
                })
        return attrs


class DhcpReservationViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Bidirectional: every write here is pushed to the Windows server first;
    the row is only saved once the server accepted it."""

    integration_keys = ("dhcp",)
    tenant_field = "scope__connection__tenant"
    queryset = DhcpReservation.objects.select_related(
        "scope", "scope__connection", "ip_address"
    ).order_by("ip")
    serializer_class = DhcpReservationSerializer
    rbac_action_map = {"resolve": "change"}

    def get_queryset(self):
        qs = super().get_queryset()
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
        if scope is None or scope.connection.tenant_id != tenant.id:
            raise ValidationError({"scope": "Unknown scope."})
        return scope

    def perform_create(self, serializer):
        scope = self._scope_in_tenant(serializer.validated_data.get("scope"))
        v = serializer.validated_data
        if DhcpReservation.objects.filter(scope=scope, ip=v["ip"]).exists():
            raise ValidationError({"ip": "This address is already reserved."})
        try:
            push_reservation(
                scope.connection, scope, ip=v["ip"], mac=v.get("mac", ""),
                name=v.get("name", ""), description=v.get("description", ""),
                exists=False,
            )
        except WinRMError as exc:
            raise ValidationError({"detail": f"The DHCP server refused: {exc}"}) from exc
        res = serializer.save(managed=True)
        self._link_ip(res)

    def perform_update(self, serializer):
        res = serializer.instance
        v = serializer.validated_data
        try:
            push_reservation(
                res.scope.connection, res.scope, ip=res.ip,
                mac=v.get("mac", res.mac), name=v.get("name", res.name),
                description=v.get("description", res.description),
                exists=True,
            )
        except WinRMError as exc:
            raise ValidationError({"detail": f"The DHCP server refused: {exc}"}) from exc
        # An edit from Danbyte takes ownership and clears any pending drift.
        serializer.save(managed=True, drift="", drift_detail={})

    def perform_destroy(self, instance):
        try:
            remove_reservation(instance.scope.connection, instance.scope,
                               instance.ip)
        except WinRMError as exc:
            if instance.drift != "missing":  # already gone server-side is fine
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
        """Settle a drift flag. Body: ``{"strategy": "accept" | "push"}`` —
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
