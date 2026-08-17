"""Windows DNS sync API: zones (read + per-zone sync opt-in), drift review,
and a live zone-record viewer (fetched from the server on demand, not stored)."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet

from .models import DnsDrift, DnsRecord, DnsZone
from .toggles import IntegrationToggleMixin
from .winrm_client import WinRMError, ps_str, run_json


class DnsZoneSerializer(serializers.ModelSerializer):
    connection_name = serializers.CharField(source="connection.name", read_only=True)
    drift_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = DnsZone
        fields = ["id", "connection", "connection_name", "name", "zone_type",
                  "is_reverse", "sync", "auto_create", "managed", "record_count",
                  "drift_count", "last_seen_at", "updated_at"]
        read_only_fields = [f for f in fields
                            if f not in ("sync", "auto_create")]


class DnsZoneWriteSerializer(serializers.ModelSerializer):
    """Author a zone in Danbyte. DNS is Danbyte-authoritative for managed
    content (pushing to a DNS backend is a later phase), so this stores the zone
    locally — it is not created on the server."""

    class Meta:
        model = DnsZone
        fields = ["id", "connection", "name", "is_reverse", "sync", "auto_create"]

    def validate_name(self, value):
        name = (value or "").strip().rstrip(".").lower()
        if not name:
            raise serializers.ValidationError("Enter a zone name, e.g. lab.example.com.")
        return name


class DnsZoneViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Zones are read from sync; the per-zone ``sync`` / ``auto_create`` opt-ins
    are PATCHable. A zone can also be **authored** here (POST) — stored as a
    Danbyte-owned ``managed`` zone that sync never prunes — and a managed zone
    can be removed (DELETE). Synced zones can't be deleted (sync would recreate
    them)."""

    integration_keys = ("dns",)
    tenant_field = "connection__tenant"
    http_method_names = ["get", "post", "patch", "delete"]
    queryset = DnsZone.objects.select_related("connection").order_by("name")
    serializer_class = DnsZoneSerializer
    rbac_action_map = {"records": "view"}

    def get_serializer_class(self):
        if self.action == "create":
            return DnsZoneWriteSerializer
        return DnsZoneSerializer

    def _conn_in_tenant(self, conn):
        tenant = self._tenant_or_403()
        if conn is None or conn.tenant_id != tenant.id:
            raise ValidationError({"connection": "Unknown server connection."})
        return conn

    def perform_create(self, serializer):
        conn = self._conn_in_tenant(serializer.validated_data.get("connection"))
        name = serializer.validated_data["name"]
        if DnsZone.objects.filter(connection=conn, name=name).exists():
            raise ValidationError(
                {"name": "A zone with that name already exists on that server."}
            )
        serializer.save(managed=True)

    def perform_destroy(self, instance):
        if not instance.managed:
            raise ValidationError(
                {"detail": "Only zones authored in Danbyte can be deleted; this "
                           "one is mirrored from the server."}
            )
        instance.delete()

    def get_queryset(self):
        from django.db.models import Count

        qs = super().get_queryset().annotate(drift_count=Count("drifts"))
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(connection_id=conn)
        s = (self.request.query_params.get("search") or "").strip()
        if s:
            qs = qs.filter(name__icontains=s)
        return qs

    @action(detail=True, methods=["get"])
    def records(self, request, pk=None):
        """The zone's records, straight off the server (capped at 500)."""
        zone = self.get_object()
        script = f"""
@(Get-DnsServerResourceRecord -ZoneName {ps_str(zone.name)} -ErrorAction Stop |
  Select-Object -First 500 HostName, @{{n='rtype';e={{[string]$_.RecordType}}}},
    @{{n='ttl';e={{$_.TimeToLive.ToString()}}}},
    @{{n='data';e={{
      if ($_.RecordType -eq 'A') {{ $_.RecordData.IPv4Address.IPAddressToString }}
      elseif ($_.RecordType -eq 'AAAA') {{ $_.RecordData.IPv6Address.IPAddressToString }}
      elseif ($_.RecordType -eq 'PTR') {{ $_.RecordData.PtrDomainName }}
      elseif ($_.RecordType -eq 'CNAME') {{ $_.RecordData.HostNameAlias }}
      elseif ($_.RecordType -eq 'NS') {{ $_.RecordData.NameServer }}
      elseif ($_.RecordType -eq 'MX') {{ $_.RecordData.MailExchange }}
      elseif ($_.RecordType -eq 'TXT') {{ $_.RecordData.DescriptiveText }}
      elseif ($_.RecordType -eq 'SOA') {{ $_.RecordData.PrimaryServer }}
      else {{ '' }}
    }}}}) | ConvertTo-Json -Depth 4
"""
        try:
            data = run_json(zone.connection, script)
        except WinRMError as exc:
            return Response({"ok": False, "error": str(exc)}, status=502)
        rows = data if isinstance(data, list) else ([data] if data else [])
        return Response({"ok": True, "records": rows})


class DnsRecordSerializer(serializers.ModelSerializer):
    zone_name = serializers.CharField(source="zone.name", read_only=True)
    connection = serializers.CharField(source="zone.connection_id", read_only=True)
    connection_name = serializers.CharField(
        source="zone.connection.name", read_only=True
    )

    class Meta:
        model = DnsRecord
        fields = ["id", "zone", "zone_name", "connection", "connection_name",
                  "name", "record_type", "data", "ip", "ip_address", "ttl",
                  "managed", "last_seen_at"]
        read_only_fields = fields


class DnsRecordWriteSerializer(serializers.ModelSerializer):
    """Create/edit an **authored** (managed) record. Per-type validation mirrors
    what netbox-dns enforces; the record lives in Danbyte as the source of truth
    (pushing to a DNS backend is a later phase)."""

    class Meta:
        model = DnsRecord
        fields = ["id", "zone", "name", "record_type", "data", "ttl"]

    def validate_zone(self, zone):
        tenant = self.context.get("tenant")
        if tenant is not None and zone.connection_id and \
                zone.connection.tenant_id != tenant.id:
            raise serializers.ValidationError("Zone is not in your tenant.")
        return zone

    def validate(self, attrs):
        import ipaddress as _ip

        rtype = attrs.get("record_type") or getattr(
            self.instance, "record_type", ""
        )
        data = (attrs.get("data") or getattr(self.instance, "data", "")).strip()
        if not data:
            raise serializers.ValidationError({"data": "Value is required."})

        def bad(msg):
            raise serializers.ValidationError({"data": msg})

        if rtype == "A":
            try:
                if _ip.ip_address(data).version != 4:
                    bad("An A record's value must be an IPv4 address.")
            except ValueError:
                bad("An A record's value must be an IPv4 address.")
        elif rtype == "AAAA":
            try:
                if _ip.ip_address(data).version != 6:
                    bad("An AAAA record's value must be an IPv6 address.")
            except ValueError:
                bad("An AAAA record's value must be an IPv6 address.")
        elif rtype in ("CNAME", "NS", "PTR"):
            if " " in data:
                bad(f"A {rtype} value must be a single hostname.")
        elif rtype == "MX":
            parts = data.split()
            if len(parts) != 2 or not parts[0].isdigit():
                bad('MX must be "<priority> <mail-host>", e.g. "10 mail.x.com".')
        elif rtype == "SRV":
            parts = data.split()
            if len(parts) != 4 or not all(p.isdigit() for p in parts[:3]):
                bad('SRV must be "<pri> <weight> <port> <target>".')
        elif rtype == "CAA":
            parts = data.split(maxsplit=2)
            if len(parts) != 3 or not parts[0].isdigit():
                bad('CAA must be "<flags> <tag> <value>", e.g. "0 issue ca.x".')
        # TXT: any non-empty value is fine.
        return attrs

    def create(self, validated_data):
        validated_data["managed"] = True
        rtype, data = validated_data["record_type"], validated_data["data"]
        if rtype in ("A", "AAAA"):
            validated_data["ip"] = data
        return super().create(validated_data)


class DnsRecordViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read stored A/AAAA/PTR records from reconciled zones. Filter by
    ``?zone=``, ``?connection=``, ``?ip=``, ``?prefix=<id>``, ``?type=``,
    ``?search=``. ``import`` / ``import_unmatched`` pull untracked records into
    IPAM (needs ``ipaddress.add``)."""

    integration_keys = ("dns",)
    tenant_field = "zone__connection__tenant"
    http_method_names = ["get", "post", "patch", "delete"]
    queryset = DnsRecord.objects.select_related(
        "zone", "zone__connection", "ip_address"
    ).order_by("name")
    serializer_class = DnsRecordSerializer
    # These POST actions gate on ipaddress.add (checked in the handler), not on
    # a dnsrecord write — so map them to the read action for the type-level gate.
    rbac_action_map = {"import_": "view", "import_unmatched": "view"}

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return DnsRecordWriteSerializer
        return DnsRecordSerializer

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["tenant"] = self._tenant_or_403()
        return ctx

    def perform_create(self, serializer):
        # DnsRecord scopes through zone→connection→tenant (a traversal, not an
        # own tenant field), so the base tenant-injection can't apply here — the
        # zone (validated to the tenant) carries it.
        serializer.save()

    def _guard_managed(self):
        """Only authored records are editable; the synced mirror is read-only."""
        from rest_framework.exceptions import PermissionDenied

        if not self.get_object().managed:
            raise PermissionDenied(
                "This record is synced from a DNS server and is read-only. "
                "Only records created in Danbyte can be edited."
            )

    def update(self, request, *args, **kwargs):
        self._guard_managed()
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        self._guard_managed()
        return super().destroy(request, *args, **kwargs)

    def _require_ip_add(self, request):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        if not (
            request.user.is_superuser
            or rbac.has_action(request.user, tenant, "ipaddress", "add")
        ):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You can't create IP addresses.")

    @action(detail=True, methods=["post"], url_path="import")
    def import_(self, request, pk=None):
        """Create the IPAddress for this record and link it."""
        from .dns_sync import DnsImportError, import_record, suggested_prefix_cidr

        self._require_ip_add(request)
        record = self.get_object()
        try:
            ip = import_record(record)
        except DnsImportError as exc:
            # A missing containing prefix is recoverable: tell the client so it
            # can offer to create one (with a suggested CIDR) and retry.
            return Response(
                {"ok": False, "error": str(exc), "reason": "no_prefix",
                 "suggested_prefix": suggested_prefix_cidr(record.ip)},
                status=400,
            )
        return Response({"ok": True, "ip_address": str(ip.id)})

    @action(detail=False, methods=["post"])
    def import_unmatched(self, request, pk=None):
        """Import every unlinked record in a zone (``{"zone": "<id>"}``).
        Returns how many were created and how many were skipped (no prefix)."""
        from .dns_sync import DnsImportError, import_record

        self._require_ip_add(request)
        zone_id = (request.data or {}).get("zone")
        if not zone_id:
            return Response({"detail": "zone is required."}, status=400)
        qs = self.get_queryset().filter(zone_id=zone_id, ip_address__isnull=True)
        created, skipped = 0, 0
        for record in qs:
            try:
                import_record(record)
                created += 1
            except DnsImportError:
                skipped += 1
        return Response({"ok": True, "created": created, "skipped": skipped})

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("zone"):
            qs = qs.filter(zone_id=p["zone"])
        if p.get("connection"):
            qs = qs.filter(zone__connection_id=p["connection"])
        if p.get("ip"):
            qs = qs.filter(ip=p["ip"])
        if p.get("prefix"):
            qs = qs.filter(ip_address__prefix_id=p["prefix"])
        if p.get("type"):
            qs = qs.filter(record_type=p["type"])
        s = (p.get("search") or "").strip()
        if s:
            qs = qs.filter(name__icontains=s) | qs.filter(data__icontains=s)
        return qs


class DnsDriftSerializer(serializers.ModelSerializer):
    zone_name = serializers.CharField(source="zone.name", read_only=True)
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)

    class Meta:
        model = DnsDrift
        fields = ["id", "zone", "zone_name", "kind", "kind_display",
                  "record_type", "ip", "ip_address", "danbyte_name",
                  "server_name", "last_seen_at"]
        read_only_fields = fields


class DnsDriftViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("dns",)
    tenant_field = "zone__connection__tenant"
    http_method_names = ["get", "post"]
    queryset = DnsDrift.objects.select_related(
        "zone", "zone__connection", "ip_address"
    ).order_by("ip")
    serializer_class = DnsDriftSerializer
    rbac_action_map = {"resolve": "change"}

    def create(self, request, *args, **kwargs):
        from rest_framework.exceptions import MethodNotAllowed

        raise MethodNotAllowed("POST")

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(zone__connection_id=conn)
        zone = self.request.query_params.get("zone")
        if zone:
            qs = qs.filter(zone_id=zone)
        return qs

    @action(detail=True, methods=["post"])
    def resolve(self, request, pk=None):
        """Settle one drift. Body: ``{"strategy": "accept" | "push"}``.

        accept — the server wins: take its name onto the IP (or clear the
        name when the server has no record). push — Danbyte wins: rewrite
        the record on the server to match the IP's DNS name.
        """
        from .dns_sync import push_record

        drift = self.get_object()
        strategy = (request.data or {}).get("strategy")
        if strategy == "accept":
            row = drift.ip_address
            row.dns_name = drift.server_name if drift.kind == "mismatch" else ""
            row.save(update_fields=["dns_name"])
            drift.delete()
        elif strategy == "push":
            try:
                push_record(drift.zone.connection, drift.zone, drift)
            except (WinRMError, ValueError) as exc:
                return Response({"ok": False, "error": str(exc)}, status=502)
            drift.delete()
        else:
            return Response(
                {"detail": "strategy must be 'accept' or 'push'."}, status=400
            )
        return Response({"ok": True})
