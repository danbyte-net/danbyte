"""API shapes for the PRTG integration."""
from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse

from rest_framework import serializers

from api.models import DeviceRole, DeviceType, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField

from . import status as st
from .models import (
    PrtgAdoptionRule,
    PrtgChange,
    PrtgConnection,
    PrtgDeviceLink,
    PrtgSensor,
    PrtgSensorProfile,
)


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

    #: The adoption defaults, each one of the active tenant's rows.
    adopt_site = TenantScopedPrimaryKeyRelatedField(
        queryset=Site.objects.all(), required=False, allow_null=True
    )
    adopt_role = TenantScopedPrimaryKeyRelatedField(
        queryset=DeviceRole.objects.all(), required=False, allow_null=True
    )
    adopt_device_type = TenantScopedPrimaryKeyRelatedField(
        queryset=DeviceType.objects.all(), required=False, allow_null=True
    )
    #: The adoption defaults by name, so the page can say them.
    adopt_names = serializers.SerializerMethodField()
    #: Not a column: three names for the form and the card.
    list_columns_exclude = ("adopt_names",)
    #: What "register all" gives an object: a profile of this connection and
    #: a PRTG group or probe (object id; the path is kept for reading).
    register_profile = serializers.PrimaryKeyRelatedField(
        queryset=PrtgSensorProfile.objects.all(), required=False, allow_null=True
    )
    register_profile_name = serializers.CharField(
        source="register_profile.name", read_only=True, default=""
    )

    def get_adopt_names(self, obj) -> dict:
        return {
            "site": obj.adopt_site.name if obj.adopt_site_id else None,
            "role": obj.adopt_role.name if obj.adopt_role_id else None,
            "device_type": obj.adopt_device_type.model if obj.adopt_device_type_id else None,
        }

    class Meta:
        model = PrtgConnection
        fields = [
            "id", "name", "url", "api_v2_url", "v2_base", "api_key", "api_key_set",
            "verify_tls", "enabled", "status_interval_seconds", "provision_scope",
            "engines", "engine_names", "state_map", "link_mode",
            "push_enabled", "hook_token_set",
            "write_acknowledgements", "sync_maintenance", "last_maintenance_sync_at",
            "adopt_devices", "adopt_site", "adopt_role", "adopt_device_type",
            "adopt_names", "read_inventory", "last_inventory_at",
            "register_all", "register_profile", "register_profile_name",
            "register_group_id", "register_group_path", "groups_read_at",
            "group_layout", "layout_regions", "layout_locations", "layout_root_id",
            "layout_root_path",
            "last_plan_at", "last_plan_summary",
            "seed_device_objid", "send_credentials", "send_tags", "tag_site_role",
            "auto_apply_registration",
            "prune_devices", "write_mode", "write_detail", "write_checked_at",
            "last_apply_at", "last_apply_summary",
            "version", "supported", "v2_available", "last_checked_at", "last_error",
            "last_status_at", "last_status_summary",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "v2_base", "api_key_set", "version", "supported", "v2_available",
            "last_checked_at", "last_error", "engine_names", "hook_token_set",
            "last_status_at", "last_status_summary", "created_at", "updated_at",
            "last_maintenance_sync_at", "last_inventory_at", "adopt_names",
            "register_profile_name", "groups_read_at", "last_plan_at",
            "last_plan_summary", "write_mode", "write_detail", "write_checked_at",
            "last_apply_at", "last_apply_summary",
        ]

    def _own(self, value, what):
        """A default has to be one of this connection's tenant's rows - also
        when there is no request to scope the lookup by."""
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

    def validate_register_profile(self, value):
        """A profile of this connection: one of another connection - or
        another tenant - would be a sensor list nobody here can see."""
        if value is None:
            return value
        self._own(value, "profile")
        if self.instance is None or value.connection_id != self.instance.id:
            raise serializers.ValidationError("Pick a profile of this connection.")
        return value

    def validate_seed_device_objid(self, value):
        value = (value or "").strip()
        if value and not value.isdigit():
            raise serializers.ValidationError("A PRTG object id is a number.")
        return value

    def validate_register_group_id(self, value):
        value = (value or "").strip()
        if value and not value.isdigit():
            raise serializers.ValidationError("A PRTG object id is a number.")
        return value

    def validate_layout_root_id(self, value):
        return self.validate_register_group_id(value)

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
        layout = attrs.get("group_layout", self.instance.group_layout if self.instance else "")
        root = attrs.get("layout_root_id", self.instance.layout_root_id if self.instance else "")
        reg = attrs.get("register_group_id",
                        self.instance.register_group_id if self.instance else "")
        if layout and layout != PrtgConnection.LAYOUT_NONE and not (root or reg):
            raise serializers.ValidationError({
                "layout_root_id": "Pick the probe or group the layout is built under.",
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
        defaults = (instance.adopt_site_id, instance.adopt_role_id, instance.adopt_device_type_id)
        obj = super().update(instance, validated_data)
        if "state_map" in validated_data and before != st.clean_map(obj.state_map):
            # The device list reads the stored states; a new map must not
            # wait for the next read to show.
            from .reader import remap

            remap(obj)
        if (obj.adopt_site_id, obj.adopt_role_id, obj.adopt_device_type_id) != defaults:
            # The queue is what the operator is looking at when they set
            # these; its proposals must not wait for the next read.
            from .adopt import refresh_pending_proposals

            refresh_pending_proposals(obj)
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


def _ref(obj) -> dict | None:
    return {"id": str(obj.id), "name": obj.name} if obj is not None else None


class PrtgDeviceLinkSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()
    #: Paused in PRTG, by anyone.
    paused = serializers.BooleanField(read_only=True)
    virtual_machine = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    #: How the connection creates objects in PRTG (``v2``, ``seed``,
    #: ``none``, or "" before it was asked): whether sensors can be added.
    write_mode = serializers.CharField(source="connection.write_mode", read_only=True)

    def get_device(self, obj) -> dict | None:
        return _ref(obj.device)

    def get_virtual_machine(self, obj) -> dict | None:
        return _ref(obj.virtual_machine)

    def get_url(self, obj) -> str:
        return obj.connection.device_url(obj.objid)

    class Meta:
        model = PrtgDeviceLink
        fields = [
            "id", "connection", "device", "virtual_machine", "objid", "name", "host",
            "probe_name",
            "group_path", "matched_by", "created_here", "tagged", "status_raw",
            "state", "sensor_counts", "status_read_at", "last_seen_at", "url",
            "maintenance_paused_at", "maintenance_paused_until", "maintenance_events",
            "maintenance_note", "last_apply", "paused", "write_mode", "sent_tags",
        ]
        read_only_fields = fields


class PrtgChangeSerializer(serializers.ModelSerializer):
    device = serializers.SerializerMethodField()
    virtual_machine = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    #: Whether this one can be applied at all - "needs a decision" cannot.
    applicable = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        return _ref(obj.device)

    def get_virtual_machine(self, obj) -> dict | None:
        return _ref(obj.virtual_machine)

    def get_applicable(self, obj) -> bool:
        if obj.kind == PrtgChange.ADOPT:
            from monitoring.external.adoption import applicable

            return applicable(obj.detail or {})
        if obj.planned:
            # Whether it can be written as it stands: a group to create it
            # in, the credentials its sensors need, a PRTG that writes - and
            # not written already.
            d = obj.detail or {}
            return bool(d.get("applicable", True)) and not d.get("applied")
        return obj.kind != PrtgChange.AMBIGUOUS

    #: A write to PRTG, from the planning pass.
    planned = serializers.BooleanField(read_only=True)
    #: ``ready``, ``attention``, ``applied``, ``failed`` or ``decision``.
    status = serializers.SerializerMethodField()
    #: Deletes something in PRTG: confirmed row by row, never "apply all".
    destructive = serializers.SerializerMethodField()

    def get_status(self, obj) -> str:
        from .writer import change_status

        return change_status(obj)

    def get_destructive(self, obj) -> bool:
        return obj.kind in PrtgChange.DESTRUCTIVE

    #: A decision row's choices beyond its candidates: ``{can_create}``.
    decision = serializers.SerializerMethodField()

    def get_decision(self, obj) -> dict | None:
        if obj.kind != PrtgChange.AMBIGUOUS or (obj.detail or {}).get("applied"):
            return None
        from .reader import can_create_separately

        return {"can_create": can_create_separately(obj)}

    class Meta:
        model = PrtgChange
        fields = [
            "id", "kind", "kind_display", "device", "virtual_machine", "key", "detail",
            "ignored",
            "applicable", "planned", "status", "destructive", "decision", "created_at", "updated_at",
        ]
        read_only_fields = fields


class PrtgSensorSerializer(serializers.ModelSerializer):
    """One imported sensor: what the Sensors tab and the /prtg tables show.
    Read-only - the row is PRTG's, rewritten by every status read. The
    channels and history are their own endpoints, read on demand."""

    device = serializers.SerializerMethodField()
    virtual_machine = serializers.SerializerMethodField()
    connection_name = serializers.CharField(source="connection.name", read_only=True)
    #: PRTG's own word for the status ("Paused by Dependency").
    status = serializers.SerializerMethodField()
    paused = serializers.BooleanField(read_only=True)
    acknowledged = serializers.BooleanField(read_only=True)
    #: Whether Danbyte can acknowledge it in PRTG now: down, and the
    #: connection writes acknowledgements.
    ackable = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    device_url = serializers.SerializerMethodField()
    prtg_device = serializers.CharField(source="link.name", read_only=True)
    #: When the channels were last read, or null - they are read on demand.
    channels_at = serializers.SerializerMethodField()
    #: What the sensor watches, resolved by every read (:mod:`prtg.objects`).
    ip_address = serializers.SerializerMethodField()
    interface = serializers.SerializerMethodField()
    service = serializers.SerializerMethodField()

    def get_device(self, obj) -> dict | None:
        return _ref(obj.device)

    def get_virtual_machine(self, obj) -> dict | None:
        return _ref(obj.virtual_machine)

    def get_status(self, obj) -> str:
        return st.label(obj.status_raw) if obj.status_raw is not None else ""

    def get_ackable(self, obj) -> bool:
        from .acks import ACKABLE

        return obj.status_raw in ACKABLE and bool(obj.connection.write_acknowledgements)

    def get_url(self, obj) -> str:
        return obj.connection.sensor_url(obj.objid)

    def get_device_url(self, obj) -> str:
        return obj.connection.device_url(obj.link.objid)

    def get_channels_at(self, obj) -> str | None:
        return (obj.channels or {}).get("fetched_at")

    def get_ip_address(self, obj) -> dict | None:
        a = obj.ip_address
        if a is None:
            return None
        return {"id": str(a.id), "address": str(a.ip_address), "dns_name": a.dns_name or ""}

    def get_interface(self, obj) -> dict | None:
        """A device interface (``kind: interface``, its page is
        ``/interfaces/<id>``) or a VM interface (``kind: vm_interface``, on
        its VM's page)."""
        if obj.interface is not None:
            i = obj.interface
            return {"id": str(i.id), "name": i.name, "kind": "interface",
                    "parent": str(i.device_id)}
        if obj.vm_interface is not None:
            i = obj.vm_interface
            return {"id": str(i.id), "name": i.name, "kind": "vm_interface",
                    "parent": str(i.vm_id)}
        return None

    def get_service(self, obj) -> dict | None:
        svc = obj.service
        if svc is None:
            return None
        ports = ", ".join(
            f"{proto}/{','.join(str(p) for p in ports)}"
            for proto, ports in svc.port_map().items()
        )
        return {"id": str(svc.id), "name": svc.name, "ports": ports}

    class Meta:
        model = PrtgSensor
        fields = [
            "id", "connection", "connection_name", "device", "virtual_machine",
            "link", "prtg_device", "objid", "name", "kind", "kind_label", "status_raw", "status",
            "state", "paused", "acknowledged", "ackable", "message", "tags", "active",
            "last_value", "last_value_raw", "unit", "interval_seconds", "uptime_pct",
            "downtime_pct", "priority", "last_check_at", "last_up_at", "last_down_at",
            "probe_name", "group_path", "last_seen_at", "url", "device_url", "channels_at",
            "ip_address", "interface", "service",
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
