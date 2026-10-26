"""API shapes for the PRTG integration."""
from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse

from rest_framework import serializers

from api.models import DeviceRole, DeviceType, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField

from . import status as st
from .models import PrtgAdoptionRule, PrtgChange, PrtgConnection, PrtgDeviceLink


def _host(url: str) -> str:
    return (urlparse(url or "").hostname or "").lower()


def _origin(url: str) -> tuple:
    p = urlparse(url or "")
    return (p.scheme, (p.hostname or "").lower(), p.port)


def _clean_url(value: str, what: str) -> str:
    value = (value or "").strip().rstrip("/")
    if not value.startswith(("http://", "https://")):
        raise serializers.ValidationError(f"Start with http:// or https:// - {what}.")
    if not urlparse(value).hostname:
        raise serializers.ValidationError("The URL has no host.")
    return value


class PrtgConnectionSerializer(serializers.ModelSerializer):
    """The API key is write-only. The API says whether one is set, never what."""

    api_key = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=True
    )
    api_key_set = serializers.BooleanField(read_only=True)
    supported = serializers.BooleanField(read_only=True)
    v2_base = serializers.CharField(read_only=True)
    #: Whether a push token exists. The token itself is shown once, by
    #: ``rotate-hook-token``, and never again.
    hook_token_set = serializers.BooleanField(read_only=True)
    #: The engines by name, so the form renders chips without a round-trip.
    engine_names = serializers.SerializerMethodField()

    def get_engine_names(self, obj) -> list:
        return [{"id": str(e.id), "name": e.name} for e in obj.engines.all().order_by("name")]

    class Meta:
        model = PrtgConnection
        fields = [
            "id", "name", "url", "api_v2_url", "v2_base", "api_key", "api_key_set",
            "verify_tls", "enabled", "status_interval_seconds", "provision_scope",
            "engines", "engine_names", "state_map", "link_mode",
            "push_enabled", "hook_token_set",
            "version", "supported", "v2_available", "last_checked_at", "last_error",
            "last_status_at", "last_status_summary",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "v2_base", "api_key_set", "version", "supported", "v2_available",
            "last_checked_at", "last_error", "engine_names", "hook_token_set",
            "last_status_at", "last_status_summary", "created_at", "updated_at",
        ]

    def _tenant(self):
        from api.views import _get_active_tenant

        if self.instance is not None:
            return self.instance.tenant
        request = self.context.get("request")
        return _get_active_tenant(request) if request is not None else None

    def validate_name(self, value):
        value = (value or "").strip()
        tenant = self._tenant()
        if tenant is not None:
            clash = PrtgConnection.objects.filter(tenant=tenant, name=value)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError("A PRTG connection with this name exists.")
        return value

    def validate_url(self, value):
        value = _clean_url(value, "the address of the PRTG web interface")
        if urlparse(value).path.rstrip("/").endswith("/api"):
            raise serializers.ValidationError(
                "Give the web interface URL, not the API path - Danbyte adds /api/ itself."
            )
        return value

    def validate_api_v2_url(self, value):
        if not (value or "").strip():
            return ""
        return _clean_url(value, "where API v2 answers, or leave blank")

    def validate_status_interval_seconds(self, value):
        # Every read walks the whole sensors table on the PRTG core server.
        if not 60 <= value <= 3600:
            raise serializers.ValidationError("Between 1 minute and 1 hour.")
        return value

    def validate_engines(self, value):
        """This tenant's PRTG engines only: a UUID from anywhere proves
        nothing, and a local engine linked here would quietly do nothing."""
        tenant = self._tenant()
        for engine in value:
            if tenant is not None and engine.tenant_id != tenant.id:
                raise serializers.ValidationError("An engine is not in the active tenant.")
            if engine.kind != "prtg":
                raise serializers.ValidationError(f"{engine.name} is not a PRTG engine.")
        return value

    def validate_state_map(self, value):
        """Only the six codes that carry a verdict, each onto up, degraded or
        down. Stored cleaned, so nothing downstream copes with a hole."""
        if value in (None, "", {}):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected an object.")
        editable = set(st.STATE_MAP.defaults)
        allowed = set(st.STATE_MAP.mappable)
        for key, state in value.items():
            if str(key) in st.STATE_MAP.fixed:
                if state not in (None, "", "unknown"):
                    raise serializers.ValidationError(
                        f"{st.label(key)} is always unknown - PRTG is not measuring it."
                    )
                continue
            if str(key) not in editable:
                raise serializers.ValidationError(f"'{key}' is not a PRTG status code.")
            if state not in allowed:
                raise serializers.ValidationError(
                    f"'{state}' is not one of {', '.join(sorted(allowed))}."
                )
        return st.clean_map(value)

    def validate(self, attrs):
        url = attrs.get("url", self.instance.url if self.instance else "")
        v2 = attrs.get("api_v2_url", self.instance.api_v2_url if self.instance else "")
        # The key travels to both addresses, so both name the same server.
        if v2 and _host(v2) != _host(url):
            raise serializers.ValidationError({
                "api_v2_url": "Use the same host as the web interface URL.",
            })

        api_key = attrs.pop("api_key", None)
        creds = dict(self.instance.credentials or {}) if self.instance else {}
        if api_key:
            creds["api_key"] = api_key
        elif self.instance is not None:
            # A stored key is for the server it was typed for. Moving the URL
            # to another origin without retyping it would hand the key to
            # whatever answers there - so it is dropped instead.
            if "url" in attrs and _origin(attrs["url"]) != _origin(self.instance.url):
                creds.pop("api_key", None)
        attrs["credentials"] = creds
        return attrs

    def update(self, instance, validated_data):
        before = st.clean_map(instance.state_map)
        obj = super().update(instance, validated_data)
        if "state_map" in validated_data and before != st.clean_map(obj.state_map):
            # The device list reads the stored states; a new map must not
            # wait for the next read to show.
            from .reader import remap

            remap(obj)
        return obj


class PrtgDefaultsSerializer(serializers.Serializer):
    """What the map editor needs: every code, its default, which are fixed,
    and the states an editable code may mean - named by the tenant."""

    codes = serializers.ListField(child=serializers.DictField())
    default_map = serializers.DictField()
    statuses = serializers.ListField(child=serializers.DictField())

    @staticmethod
    def payload(tenant=None) -> dict:
        from monitoring.status_labels import status_options

        return {
            "codes": [
                {"value": str(code), "label": label,
                 "fixed": str(code) in st.STATE_MAP.fixed,
                 "reason": st.UNKNOWN_REASON.get(code, "")}
                for code, label in st.SOURCE_VALUES
            ],
            "default_map": st.STATE_MAP.default_map(),
            "statuses": status_options(tenant, list(st.STATE_MAP.mappable)),
        }


class PrtgDeviceLinkSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    def get_url(self, obj) -> str:
        return obj.connection.device_url(obj.objid)

    class Meta:
        model = PrtgDeviceLink
        fields = [
            "id", "connection", "device", "objid", "name", "host", "probe_name",
            "group_path", "matched_by", "created_here", "tagged", "status_raw",
            "state", "sensor_counts", "status_read_at", "last_seen_at", "url",
        ]
        read_only_fields = fields


class PrtgChangeSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    #: Whether this one can be applied at all - "needs a decision" cannot.
    applicable = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    def get_applicable(self, obj) -> bool:
        return obj.kind != PrtgChange.AMBIGUOUS

    class Meta:
        model = PrtgChange
        fields = [
            "id", "kind", "kind_display", "device", "key", "detail", "ignored",
            "applicable", "created_at",
        ]
        read_only_fields = fields


class PrtgAdoptionRuleSerializer(serializers.ModelSerializer):
    """Where an adopted PRTG device lands, by what it looks like."""

    connection = TenantScopedPrimaryKeyRelatedField(queryset=PrtgConnection.objects.all())
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

    class Meta:
        model = PrtgAdoptionRule
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

    def validate_pattern(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A pattern is needed.")
        if value.startswith("regex:"):
            try:
                re.compile(value[6:])
            except re.error as exc:
                raise serializers.ValidationError(
                    f"Not a valid regular expression: {exc}"
                ) from exc
        return value

    def validate(self, attrs):
        scope = attrs.get("scope", getattr(self.instance, "scope", None))
        pattern = attrs.get("pattern", getattr(self.instance, "pattern", ""))
        if scope == PrtgAdoptionRule.SCOPE_IP and "/" in pattern:
            try:
                ipaddress.ip_network(pattern, strict=False)
            except ValueError as exc:
                raise serializers.ValidationError({"pattern": "Not a valid CIDR."}) from exc
        return attrs
