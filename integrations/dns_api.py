"""Windows DNS sync API: zones (read + per-zone sync opt-in), drift review,
and a live zone-record viewer (fetched from the server on demand, not stored)."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
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
                  "is_reverse", "sync", "record_count", "drift_count",
                  "last_seen_at", "updated_at"]
        read_only_fields = [f for f in fields if f != "sync"]


class DnsZoneViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Zones come from sync; only the per-zone ``sync`` opt-in is writable."""

    integration_keys = ("dns",)
    tenant_field = "connection__tenant"
    http_method_names = ["get", "patch"]
    queryset = DnsZone.objects.select_related("connection").order_by("name")
    serializer_class = DnsZoneSerializer
    rbac_action_map = {"records": "view"}

    def get_queryset(self):
        from django.db.models import Count

        qs = super().get_queryset().annotate(drift_count=Count("drifts"))
        conn = self.request.query_params.get("connection")
        if conn:
            qs = qs.filter(connection_id=conn)
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
                  "last_seen_at"]
        read_only_fields = fields


class DnsRecordViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read-only stored A/AAAA/PTR records from reconciled zones. Filter by
    ``?zone=``, ``?connection=``, ``?ip=``, ``?prefix=<id>``, ``?type=``,
    ``?search=`` — the backbone of the zone table and the IPAM cross-links."""

    integration_keys = ("dns",)
    tenant_field = "zone__connection__tenant"
    http_method_names = ["get"]
    queryset = DnsRecord.objects.select_related(
        "zone", "zone__connection", "ip_address"
    ).order_by("name")
    serializer_class = DnsRecordSerializer

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
