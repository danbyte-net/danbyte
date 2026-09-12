"""API shapes for the Zabbix integration (#162)."""
from __future__ import annotations

from rest_framework import serializers

from api.models import DeviceRole, DeviceType, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField

from .models import (
    ZabbixAdoptionRule,
    ZabbixChange,
    ZabbixConnection,
    ZabbixHostLink,
    ZabbixMaintenance,
    ZabbixProvisionRule,
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
    #: Which monitoring engines read through this connection. Named rather than
    #: nested so the form can render chips without a second round-trip.
    engine_names = serializers.SerializerMethodField()

    def get_engine_names(self, obj) -> list:
        return [
            {"id": str(e.id), "name": e.name}
            for e in obj.engines.all().order_by("name")
        ]

    #: The adoption defaults by name, so the page can say them without a
    #: round-trip per id.
    adopt_names = serializers.SerializerMethodField()

    def get_adopt_names(self, obj) -> dict:
        return {
            "site": obj.adopt_site.name if obj.adopt_site_id else None,
            "role": obj.adopt_role.name if obj.adopt_role_id else None,
            "device_type": obj.adopt_device_type.model if obj.adopt_device_type_id else None,
        }

    def _tenant(self):
        from api.views import _get_active_tenant

        request = self.context.get("request")
        if self.instance is not None:
            return self.instance.tenant
        return _get_active_tenant(request) if request is not None else None

    def _own(self, value, what):
        """A default has to be one of this tenant's rows. A UUID from anywhere
        is not proof of anything."""
        tenant = self._tenant()
        if value is not None and tenant is not None and value.tenant_id != tenant.id:
            raise serializers.ValidationError(f"That {what} is not in the active tenant.")
        return value

    def validate_adopt_site(self, value):
        return self._own(value, "site")

    def validate_adopt_role(self, value):
        return self._own(value, "role")

    def validate_adopt_device_type(self, value):
        return self._own(value, "device type")

    def validate_engines(self, value):
        """An engine has to be one of this tenant's, and a Zabbix one.

        A UUID from anywhere is not proof of anything, and linking a local
        engine to a Zabbix connection would quietly do nothing.
        """
        from api.views import _get_active_tenant

        request = self.context.get("request")
        tenant = (
            self.instance.tenant if self.instance is not None
            else (_get_active_tenant(request) if request is not None else None)
        )
        for engine in value:
            if tenant is not None and engine.tenant_id != tenant.id:
                raise serializers.ValidationError(
                    "An engine is not in the active tenant."
                )
            if engine.kind != "zabbix":
                raise serializers.ValidationError(
                    f"{engine.name} is not a Zabbix engine."
                )
        return value

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
            "enabled", "engines", "engine_names",
            "version", "supported", "last_checked_at", "last_error",
            "severity_map", "provision_mode", "provision_scope",
            "prune_hosts", "prune_after_days",
            "auto_sync", "sync_interval_minutes", "last_sync_at",
            "last_sync_summary", "send_snmp_credentials",
            "sync_maintenance", "last_maintenance_sync_at", "write_acknowledgements",
            "adopt_hosts", "adopt_site", "adopt_role", "adopt_device_type",
            "adopt_names", "read_inventory", "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id", "api_url", "token_set", "supported", "engine_names", "version",
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


class ZabbixMaintenanceSerializer(serializers.ModelSerializer):
    event = serializers.SerializerMethodField()
    host_count = serializers.SerializerMethodField()

    def get_event(self, obj) -> dict | None:
        e = obj.event
        return {"id": str(e.id), "name": e.name, "kind": e.kind} if e else None

    def get_host_count(self, obj) -> int:
        return len(obj.hostids or [])

    class Meta:
        model = ZabbixMaintenance
        fields = [
            "id", "event", "name", "maintenanceid", "starts_at", "ends_at",
            "host_count", "synced_at", "last_error",
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
        if obj.kind == ZabbixChange.ADOPT:
            from .adopt import applicable

            return applicable(obj.detail or {})
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


class ZabbixProvisionRuleSerializer(serializers.ModelSerializer):
    """A rule saying what a kind of device carries in Zabbix."""

    # A connection id from anywhere is not proof it is this tenant's.
    connection = TenantScopedPrimaryKeyRelatedField(
        queryset=ZabbixConnection.objects.all()
    )

    scope_display = serializers.CharField(source="get_scope_display", read_only=True)
    #: What the rule is about, resolved for display - the SPA should not have
    #: to fetch four catalogs to render a list of rules.
    object_name = serializers.SerializerMethodField()

    _CATALOG = {
        ZabbixProvisionRule.SCOPE_SITE: "Site",
        ZabbixProvisionRule.SCOPE_ROLE: "DeviceRole",
        ZabbixProvisionRule.SCOPE_PLATFORM: "Platform",
        ZabbixProvisionRule.SCOPE_TYPE: "DeviceType",
        ZabbixProvisionRule.SCOPE_MANUFACTURER: "Manufacturer",
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

    @staticmethod
    def _names(value, what: str) -> list:
        if not isinstance(value, list):
            raise serializers.ValidationError(f"Expected a list of {what} names.")
        names = []
        for raw in value:
            name = str(raw or "").strip()
            if name and name not in names:
                names.append(name)
        return names

    def validate_templates(self, value):
        return self._names(value, "template")

    def validate_groups(self, value):
        return self._names(value, "group")

    def validate(self, attrs):
        # A rule naming neither does nothing, while sitting in the list looking
        # like it does something.
        templates = attrs.get("templates", getattr(self.instance, "templates", None))
        groups = attrs.get("groups", getattr(self.instance, "groups", None))
        proxy = attrs.get("proxy", getattr(self.instance, "proxy", ""))
        if not (templates or groups or (proxy or "").strip()):
            raise serializers.ValidationError(
                {"templates": "Name at least one template, host group or proxy."}
            )
        scope = attrs.get("scope", getattr(self.instance, "scope", None))
        object_id = attrs.get("object_id", getattr(self.instance, "object_id", None))
        if scope == ZabbixProvisionRule.SCOPE_TENANT:
            # The catch-all is about everything, so an object would be a
            # contradiction rather than extra precision.
            attrs["object_id"] = None
        elif not object_id:
            raise serializers.ValidationError(
                {"object_id": "Pick what this rule is about."}
            )
        return attrs

    class Meta:
        model = ZabbixProvisionRule
        fields = [
            "id", "connection", "scope", "scope_display", "object_id",
            "object_name", "templates", "groups", "proxy", "enabled",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "scope_display", "object_name", "created_at", "updated_at",
        ]


class ZabbixAdoptionRuleSerializer(serializers.ModelSerializer):
    """Where an adopted host lands, by what it looks like."""

    connection = TenantScopedPrimaryKeyRelatedField(
        queryset=ZabbixConnection.objects.all()
    )
    site = TenantScopedPrimaryKeyRelatedField(queryset=Site.objects.all())
    role = TenantScopedPrimaryKeyRelatedField(
        queryset=DeviceRole.objects.all(), required=False, allow_null=True
    )
    device_type = TenantScopedPrimaryKeyRelatedField(
        queryset=DeviceType.objects.all(), required=False, allow_null=True
    )
    scope_display = serializers.CharField(source="get_scope_display", read_only=True)
    site_name = serializers.CharField(source="site.name", read_only=True)
    role_name = serializers.CharField(source="role.name", read_only=True, default="")
    device_type_name = serializers.CharField(
        source="device_type.model", read_only=True, default=""
    )

    def validate_pattern(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A pattern is needed.")
        if value.startswith("regex:"):
            import re

            try:
                re.compile(value[6:])
            except re.error as exc:
                raise serializers.ValidationError(
                    f"Not a valid regular expression: {exc}"
                ) from exc
        return value

    class Meta:
        model = ZabbixAdoptionRule
        fields = [
            "id", "connection", "scope", "scope_display", "pattern",
            "site", "site_name", "role", "role_name",
            "device_type", "device_type_name", "weight", "enabled",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "scope_display", "site_name", "role_name", "device_type_name",
            "created_at", "updated_at",
        ]
