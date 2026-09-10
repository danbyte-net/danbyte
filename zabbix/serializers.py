"""API shapes for the Zabbix integration (#162)."""
from __future__ import annotations

from rest_framework import serializers

from .models import (
    ZabbixChange,
    ZabbixConnection,
    ZabbixHostLink,
    ZabbixTemplateRule,
)
from .severity import DEFAULT_MAP, MAPPABLE, SEVERITIES, clean_map


class ZabbixConnectionSerializer(serializers.ModelSerializer):
    """The token is write-only. The API says whether one is set, never what."""

    token = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    token_set = serializers.BooleanField(read_only=True)
    supported = serializers.BooleanField(read_only=True)
    api_url = serializers.CharField(read_only=True)

    def validate_url(self, value):
        value = (value or "").strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            raise serializers.ValidationError(
                "Start with http:// or https:// - this is the frontend URL, "
                "and Danbyte appends /api_jsonrpc.php to it."
            )
        if value.endswith("/api_jsonrpc.php"):
            raise serializers.ValidationError(
                "Give the frontend URL, not the API endpoint - Danbyte adds "
                "/api_jsonrpc.php itself."
            )
        return value

    def validate_severity_map(self, value):
        """Stored cleaned, so nothing downstream has to cope with a hole."""
        if value in (None, "", {}):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected an object.")
        allowed = {"up", "degraded", "down"}
        known = {str(v) for v, _ in SEVERITIES}
        for key, status in value.items():
            if str(key) not in known:
                raise serializers.ValidationError(
                    f"'{key}' is not a Zabbix severity (0-5)."
                )
            if status not in allowed:
                raise serializers.ValidationError(
                    f"'{status}' is not one of {', '.join(sorted(allowed))}."
                )
        return clean_map(value)

    def validate_sync_interval_minutes(self, value):
        # A minute is far too often to walk somebody's whole host list, and a
        # week is not a sync. Both ends are the API's to defend.
        if not 5 <= value <= 1440:
            raise serializers.ValidationError(
                "Between 5 minutes and 24 hours."
            )
        return value

    def validate_prune_after_days(self, value):
        if value > 365:
            raise serializers.ValidationError(
                "365 days or fewer. To keep hosts indefinitely, leave removal "
                "switched off."
            )
        return value

    def create(self, validated_data):
        token = validated_data.pop("token", "")
        obj = super().create(validated_data)
        if token:
            obj.credentials = {"token": token}
            obj.save(update_fields=["credentials"])
        return obj

    def update(self, instance, validated_data):
        # Blank keeps what is stored - the field renders empty, and a save
        # from a form that never showed the secret must not wipe it.
        token = validated_data.pop("token", None)
        obj = super().update(instance, validated_data)
        if token:
            obj.credentials = {"token": token}
            obj.save(update_fields=["credentials"])
        return obj

    class Meta:
        model = ZabbixConnection
        fields = [
            "id", "name", "url", "api_url", "token", "token_set", "verify_tls",
            "enabled", "version", "supported", "last_checked_at", "last_error",
            "severity_map", "provision_mode", "prune_hosts", "prune_after_days",
            "auto_sync", "sync_interval_minutes", "last_sync_at",
            "last_sync_summary", "send_snmp_credentials", "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id", "api_url", "token_set", "supported", "version",
            "last_checked_at", "last_error", "last_sync_at", "last_sync_summary",
            "created_at", "updated_at",
        ]


class ZabbixDefaultsSerializer(serializers.Serializer):
    """What the form needs to render itself - severities, their defaults, and
    the statuses a severity can map onto, named by the tenant's own catalog."""

    severities = serializers.ListField(child=serializers.DictField())
    default_map = serializers.DictField()
    statuses = serializers.ListField(child=serializers.DictField())

    @staticmethod
    def payload(tenant=None) -> dict:
        from monitoring.status_labels import status_options

        return {
            "severities": [
                {"value": str(v), "label": label} for v, label in SEVERITIES
            ],
            "default_map": DEFAULT_MAP,
            # Only the three states a severity can mean: stale and skipped are
            # Danbyte's own bookkeeping, not something Zabbix can tell us.
            "statuses": status_options(tenant, MAPPABLE),
        }


class ZabbixHostLinkSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    class Meta:
        model = ZabbixHostLink
        fields = [
            "id", "device", "hostid", "host_name", "matched_by",
            "created_here", "last_seen_at", "unwanted_since",
        ]
        read_only_fields = fields


class ZabbixChangeSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    #: Whether this one can be applied at all - "needs a decision" cannot.
    applicable = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    def get_applicable(self, obj) -> bool:
        return obj.kind != ZabbixChange.AMBIGUOUS

    class Meta:
        model = ZabbixChange
        fields = [
            "id", "kind", "kind_display", "device", "detail", "ignored",
            "applicable", "created_at",
        ]
        read_only_fields = [
            "id", "kind", "kind_display", "device", "detail", "applicable",
            "created_at",
        ]


class ZabbixTemplateRuleSerializer(serializers.ModelSerializer):
    """A rule saying which Zabbix templates a kind of device should carry."""

    scope_display = serializers.CharField(source="get_scope_display", read_only=True)
    #: What the rule is about, resolved for display - the SPA should not have
    #: to fetch four catalogs to render a list of rules.
    object_name = serializers.SerializerMethodField()

    _CATALOG = {
        ZabbixTemplateRule.SCOPE_ROLE: "DeviceRole",
        ZabbixTemplateRule.SCOPE_PLATFORM: "Platform",
        ZabbixTemplateRule.SCOPE_TYPE: "DeviceType",
        ZabbixTemplateRule.SCOPE_MANUFACTURER: "Manufacturer",
    }

    def get_object_name(self, obj) -> str:
        model_name = self._CATALOG.get(obj.scope)
        if not model_name or not obj.object_id:
            return ""
        from django.apps import apps

        row = apps.get_model("api", model_name).objects.filter(
            pk=obj.object_id, tenant=obj.tenant
        ).first()
        return getattr(row, "name", "") if row else ""

    def validate_templates(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Expected a list of template names.")
        names = []
        for raw in value:
            name = str(raw or "").strip()
            if name and name not in names:
                names.append(name)
        if not names:
            raise serializers.ValidationError("Name at least one template.")
        return names

    def validate(self, attrs):
        scope = attrs.get("scope", getattr(self.instance, "scope", None))
        object_id = attrs.get("object_id", getattr(self.instance, "object_id", None))
        if scope == ZabbixTemplateRule.SCOPE_TENANT:
            # The catch-all is about everything, so an object would be a
            # contradiction rather than extra precision.
            attrs["object_id"] = None
        elif not object_id:
            raise serializers.ValidationError(
                {"object_id": "Pick what this rule is about."}
            )
        return attrs

    class Meta:
        model = ZabbixTemplateRule
        fields = [
            "id", "connection", "scope", "scope_display", "object_id",
            "object_name", "templates", "enabled", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "scope_display", "object_name", "created_at", "updated_at",
        ]
