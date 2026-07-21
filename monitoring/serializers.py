"""Serializers for the monitoring API.

Credentials are **write-only** everywhere: ``secret_params`` can be set on a
template but is never serialised back out (a boolean ``has_secrets`` is exposed
instead). Param validation runs the kind's ``validate_params`` so a bad config
is a clean 400, not a runtime ``unknown``.
"""
from __future__ import annotations

from django.utils.text import slugify
from rest_framework import serializers

from api.models import IPAddress, Status, Prefix

from .checkers import CheckConfigError, get_checker
from .models import (
    Alert,
    AlertRule,
    CheckAssignment,
    CheckKind,
    CheckResult,
    CheckState,
    CheckTemplate,
    DeviceSnmp,
    MonitoringEngine,
    MonitoringDenySubnet,
    MonitoringPolicy,
    MonitoringProfile,
    MonitoringSettings,
    NotificationChannel,
    OutpostRelease,
    Silence,
    SnmpProfile,
    StateTransition,
)


class IPMiniSerializer(serializers.ModelSerializer):
    class Meta:
        model = IPAddress
        fields = ["id", "ip_address"]


class TemplateMiniSerializer(serializers.ModelSerializer):
    class Meta:
        model = CheckTemplate
        fields = ["id", "name", "kind"]


class SnmpProfileSerializer(serializers.ModelSerializer):
    """Reusable SNMP credentials. ``secret_params`` is write-only (encrypted at
    rest); reads expose only ``has_secrets``."""

    has_secrets = serializers.SerializerMethodField()
    secret_params = serializers.JSONField(write_only=True, required=False)

    class Meta:
        model = SnmpProfile
        fields = [
            "id", "name", "slug", "version", "params", "secret_params",
            "has_secrets", "timeout_ms", "is_default", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs):
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = slugify(attrs["name"])[:120] or "snmp"
        return attrs

    def get_has_secrets(self, obj) -> bool:
        return bool(obj.secret_params)


class DeviceSnmpSerializer(serializers.ModelSerializer):
    """Read-only observed SNMP state for a device."""

    profile_name = serializers.CharField(source="profile.name", read_only=True, default=None)

    class Meta:
        model = DeviceSnmp
        fields = [
            "id", "device", "profile", "profile_name", "data", "interfaces",
            "neighbors", "arp", "reachable", "error", "polled_at",
        ]
        read_only_fields = fields


class CheckTemplateSerializer(serializers.ModelSerializer):
    has_secrets = serializers.SerializerMethodField()
    usage_count = serializers.SerializerMethodField()
    secret_params = serializers.JSONField(write_only=True, required=False)

    class Meta:
        model = CheckTemplate
        fields = [
            "id", "name", "slug", "kind", "params", "secret_params",
            "has_secrets", "usage_count", "interval_seconds", "timeout_ms",
            "retries", "rise", "fall", "degraded_enabled", "enabled",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]
        extra_kwargs = {"slug": {"required": False}}

    def get_has_secrets(self, obj) -> bool:
        return bool(obj.secret_params)

    def get_usage_count(self, obj) -> int:
        # Prefer an annotation (list view) to avoid N+1; fall back to a count.
        n = getattr(obj, "assignment_count", None)
        return n if n is not None else obj.assignments.count()

    def validate_kind(self, value):
        # The checker registry is the source of truth (built-ins + plugin kinds),
        # not the CheckKind enum — so a plugin-registered kind validates too.
        if get_checker(value) is None:
            raise serializers.ValidationError(f"unknown kind '{value}'")
        return value

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        params = attrs.get("params", getattr(self.instance, "params", {}) or {})
        checker = get_checker(kind)
        if checker is not None:
            try:
                checker.validate_params(params)
            except CheckConfigError as e:
                raise serializers.ValidationError({"params": str(e)})
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = slugify(attrs["name"])[:120] or "check"
        return attrs


class CheckAssignmentSerializer(serializers.ModelSerializer):
    template_detail = TemplateMiniSerializer(source="template", read_only=True)
    target_kind = serializers.CharField(read_only=True)
    exclusions = serializers.PrimaryKeyRelatedField(
        many=True, queryset=IPAddress.objects.all(), required=False
    )

    class Meta:
        model = CheckAssignment
        fields = [
            "id", "template", "template_detail", "ip_address", "prefix",
            "target_kind", "schedule_mode", "overrides", "enabled",
            "apply_to_children", "exclusions", "created_at",
        ]
        read_only_fields = ["created_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request is None:
            self.fields["exclusions"].queryset = IPAddress.objects.none()
            return

        from api.views import _get_active_tenant
        from auth_api import rbac

        tenant = _get_active_tenant(request)
        qs = IPAddress.objects.none()
        if tenant is not None:
            qs = rbac.restrict_queryset(
                IPAddress.objects.filter(tenant=tenant),
                request.user,
                tenant,
                "ipaddress",
                "view",
            )
        self.fields["exclusions"].queryset = qs

    def validate(self, attrs):
        ip = attrs.get("ip_address", getattr(self.instance, "ip_address", None))
        prefix = attrs.get("prefix", getattr(self.instance, "prefix", None))
        if bool(ip) == bool(prefix):
            raise serializers.ValidationError(
                "Assign to exactly one target — an IP or a prefix, not both."
            )
        return attrs


class MonitoringProfileSerializer(serializers.ModelSerializer):
    template_detail = TemplateMiniSerializer(source="templates", many=True, read_only=True)

    class Meta:
        model = MonitoringProfile
        fields = [
            "id", "name", "slug", "description", "enabled", "templates",
            "template_detail", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs):
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = slugify(attrs["name"])[:120] or "profile"
        return attrs


class MonitoringPolicySerializer(serializers.ModelSerializer):
    profile_detail = MonitoringProfileSerializer(source="profiles", many=True, read_only=True)
    template_detail = TemplateMiniSerializer(source="templates", many=True, read_only=True)

    class Meta:
        model = MonitoringPolicy
        fields = [
            "id", "scope", "vrf", "device_type", "device_role", "device",
            "prefix", "enabled", "inherit", "target", "interval_seconds",
            "profiles", "profile_detail", "templates", "template_detail",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def validate(self, attrs):
        scope = attrs.get("scope", getattr(self.instance, "scope", ""))
        targets = {
            "vrf": attrs.get("vrf", getattr(self.instance, "vrf", None)),
            "device_type": attrs.get("device_type", getattr(self.instance, "device_type", None)),
            "device_role": attrs.get("device_role", getattr(self.instance, "device_role", None)),
            "device": attrs.get("device", getattr(self.instance, "device", None)),
            "prefix": attrs.get("prefix", getattr(self.instance, "prefix", None)),
        }
        expected = None if scope == "global" else scope
        for key, value in targets.items():
            if key == expected:
                if value is None:
                    raise serializers.ValidationError({key: "Required for this scope."})
            elif value is not None:
                raise serializers.ValidationError({key: "Must be empty for this scope."})
        return attrs


class MonitoringDenySubnetSerializer(serializers.ModelSerializer):
    vrf_detail = serializers.SerializerMethodField()

    class Meta:
        model = MonitoringDenySubnet
        fields = ["id", "vrf", "vrf_detail", "cidr", "description", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]

    def get_vrf_detail(self, obj):
        if obj.vrf_id is None:
            return None
        return {"id": str(obj.vrf_id), "name": obj.vrf.name, "rd": obj.vrf.rd}

    def validate_cidr(self, value):
        import ipaddress

        try:
            return str(ipaddress.ip_network(value, strict=False))
        except ValueError as exc:
            raise serializers.ValidationError(str(exc))


class CheckStateSerializer(serializers.ModelSerializer):
    target_ip = IPMiniSerializer(read_only=True)
    template = TemplateMiniSerializer(read_only=True)

    class Meta:
        model = CheckState
        fields = [
            "id", "target_ip", "template", "kind", "status", "since",
            "last_checked", "last_latency_ms", "consecutive_success",
            "consecutive_fail", "next_run",
        ]


class CheckResultSerializer(serializers.ModelSerializer):
    template_name = serializers.CharField(source="template.name", read_only=True, default=None)

    class Meta:
        model = CheckResult
        fields = [
            "id", "template", "template_name", "kind", "status",
            "latency_ms", "detail", "timestamp",
        ]


class StateTransitionSerializer(serializers.ModelSerializer):
    template_name = serializers.CharField(source="template.name", read_only=True, default=None)
    target_ip = serializers.SerializerMethodField()

    class Meta:
        model = StateTransition
        fields = [
            "id", "target_ip", "template", "template_name", "kind",
            "from_status", "to_status", "at", "detail",
        ]

    def get_target_ip(self, obj):
        if not obj.target_ip_id:
            return None
        return {"id": str(obj.target_ip_id), "ip_address": obj.target_ip.ip_address}


class MonitoringSettingsSerializer(serializers.ModelSerializer):
    skip_ip_statuses = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Status.objects.all(), required=False
    )
    skip_ip_status_detail = serializers.SerializerMethodField()
    flap_exclude_ip_statuses = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Status.objects.all(), required=False
    )
    flap_exclude_ip_status_detail = serializers.SerializerMethodField()
    outpost_repo_token = serializers.JSONField(write_only=True, required=False)
    outpost_repo_token_set = serializers.SerializerMethodField()

    class Meta:
        model = MonitoringSettings
        fields = [
            "global_enabled", "default_interval_seconds", "stale_after_scans",
            "stale_after_days", "skip_ip_statuses", "skip_ip_status_detail",
            "dns_sync_enabled", "dns_clear_on_missing", "dns_preserve_if_alive",
            "renotify_enabled", "renotify_interval_minutes",
            "escalate_enabled", "escalate_after_minutes",
            "flap_threshold", "flap_window_minutes",
            "group_notifications", "group_threshold",
            "discovery_enabled", "discovery_min_prefix_length",
            "discovery_interval_minutes", "discovery_all_prefixes",
            "cleanup_enabled", "cleanup_after_days",
            "flap_exclude_ip_statuses", "flap_exclude_ip_status_detail",
            "default_engine", "outpost_repo_url", "outpost_repo_token",
            "outpost_repo_token_set", "updated_at",
        ]
        read_only_fields = ["updated_at"]

    def get_outpost_repo_token_set(self, obj) -> bool:
        return bool((obj.outpost_repo_token or {}).get("token"))

    def get_skip_ip_status_detail(self, obj):
        return [
            {"id": str(s.id), "name": s.name, "color": s.color, "text_color": s.text_color}
            for s in obj.skip_ip_statuses.all()
        ]

    def get_flap_exclude_ip_status_detail(self, obj):
        return [
            {"id": str(s.id), "name": s.name, "color": s.color, "text_color": s.text_color}
            for s in obj.flap_exclude_ip_statuses.all()
        ]


class AlertSerializer(serializers.ModelSerializer):
    target_ip = IPMiniSerializer(read_only=True)
    template = TemplateMiniSerializer(read_only=True)
    rule_name = serializers.CharField(source="rule.name", read_only=True, default=None)
    acknowledged = serializers.SerializerMethodField()
    acknowledged_by_name = serializers.SerializerMethodField()
    silenced = serializers.SerializerMethodField()

    class Meta:
        model = Alert
        fields = [
            "id", "target_ip", "template", "rule_name", "kind", "severity",
            "status", "check_status", "opened_at", "last_status_at",
            "resolved_at", "detail", "acknowledged", "acknowledged_at",
            "acknowledged_by_name", "ack_note", "silenced", "flapping",
            "escalated", "notify_count",
        ]

    def get_acknowledged(self, obj) -> bool:
        return obj.acknowledged_at is not None

    def get_acknowledged_by_name(self, obj):
        u = obj.acknowledged_by
        if u is None:
            return None
        return u.get_full_name() or u.get_username()

    def get_silenced(self, obj) -> bool:
        # Set by the view via an annotation/attribute to avoid N+1 silence
        # queries per row; defaults to False when not pre-computed.
        return bool(getattr(obj, "_silenced", False))


class SilenceSerializer(serializers.ModelSerializer):
    match_prefix_cidr = serializers.CharField(
        source="match_prefix.cidr", read_only=True, default=None
    )
    match_ip_address = serializers.CharField(
        source="match_ip.ip_address", read_only=True, default=None
    )
    created_by_name = serializers.SerializerMethodField()
    is_active = serializers.SerializerMethodField()

    class Meta:
        model = Silence
        fields = [
            "id", "reason", "match_kinds", "match_statuses", "match_tag_slugs",
            "match_prefix", "match_prefix_cidr", "match_ip", "match_ip_address",
            "starts_at", "ends_at", "created_by_name", "is_active",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def get_created_by_name(self, obj):
        u = obj.created_by
        if u is None:
            return None
        return u.get_full_name() or u.get_username()

    def get_is_active(self, obj) -> bool:
        return obj.is_active()

    def validate(self, attrs):
        starts = attrs.get("starts_at", getattr(self.instance, "starts_at", None))
        ends = attrs.get("ends_at", getattr(self.instance, "ends_at", None))
        if starts and ends and ends <= starts:
            raise serializers.ValidationError(
                {"ends_at": "End must be after start."}
            )
        return attrs

    def validate_match_statuses(self, value):
        bad = [s for s in value if s not in ("down", "stale", "degraded")]
        if bad:
            raise serializers.ValidationError(
                f"Only down/stale/degraded apply; got {bad}."
            )
        return value


class AlertRuleSerializer(serializers.ModelSerializer):
    match_prefix_cidr = serializers.CharField(
        source="match_prefix.cidr", read_only=True, default=None
    )
    alert_count = serializers.SerializerMethodField()

    class Meta:
        model = AlertRule
        fields = [
            "id", "name", "enabled", "weight", "match_kinds", "match_statuses",
            "match_tag_slugs", "match_prefix", "match_prefix_cidr", "severity",
            "alert_count", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def get_alert_count(self, obj) -> int:
        return obj.alerts.filter(status="firing").count()

    def validate_match_statuses(self, value):
        bad = [s for s in value if s not in ("down", "stale", "degraded")]
        if bad:
            raise serializers.ValidationError(
                f"Only down/stale/degraded can trigger alerts; got {bad}."
            )
        return value


class NotificationChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = NotificationChannel
        fields = [
            "id", "name", "kind", "config", "on_statuses", "min_severity",
            "enabled", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    # config validation per transport: which key the channel needs to deliver.
    _URL_KINDS = {"webhook", "slack", "teams", "discord"}

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        config = attrs.get("config", getattr(self.instance, "config", {}) or {})
        if kind in self._URL_KINDS and not config.get("url"):
            raise serializers.ValidationError(
                {"config": f"{kind} needs a webhook 'url'."}
            )
        if kind == "email" and not config.get("recipients"):
            raise serializers.ValidationError(
                {"config": "email needs a 'recipients' list."}
            )
        if kind == "pagerduty" and not config.get("routing_key"):
            raise serializers.ValidationError(
                {"config": "pagerduty needs an Events v2 'routing_key'."}
            )
        return attrs


class MonitoringEngineSerializer(serializers.ModelSerializer):
    """A monitoring engine — the built-in ``local`` or a remote **Outpost**.

    The auth token is never read back; the API exposes only ``token_set`` (and
    the one-time value from the ``enroll`` action). ``kind`` is read-only: remote
    engines are created here, the local one is the built-in singleton.
    """

    slug = serializers.SlugField(required=False, allow_blank=True)
    token_set = serializers.BooleanField(read_only=True)
    is_local = serializers.BooleanField(read_only=True)
    ssh_configured = serializers.BooleanField(read_only=True)
    # Write-only — the credential is never serialised back out.
    ssh_credential = serializers.JSONField(write_only=True, required=False)
    binding_count = serializers.SerializerMethodField()
    check_count = serializers.SerializerMethodField()

    class Meta:
        model = MonitoringEngine
        fields = [
            "id", "name", "slug", "description", "kind", "transport", "enabled",
            "token_set", "is_local", "poll_interval_seconds", "auto_update",
            "ssh_host", "ssh_port", "ssh_user", "ssh_credential",
            "ssh_host_key", "ssh_configured",
            "last_seen_at", "stale_since", "agent_version", "agent_hostname", "agent_ip",
            "binding_count", "check_count", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "kind", "token_set", "is_local", "ssh_configured",
            "last_seen_at", "stale_since", "agent_version", "agent_hostname", "agent_ip",
            "created_at", "updated_at",
        ]

    def get_binding_count(self, obj) -> int:
        return obj.bindings.count()

    def get_check_count(self, obj) -> int:
        return obj.check_states.count()

    def validate(self, attrs):
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = slugify(attrs["name"])
        return attrs


class EngineBindingSerializer(serializers.Serializer):
    """Read/write the engine bound to one site/location/prefix.

    ``engine_id`` null clears the binding (→ inherit).
    """

    scope = serializers.ChoiceField(choices=["site", "location", "prefix"])
    object_id = serializers.UUIDField()
    engine_id = serializers.UUIDField(required=False, allow_null=True)


class OutpostReleaseSerializer(serializers.ModelSerializer):
    """A stored Outpost build. The artifact is write-only (upload); reads expose
    only whether it's present — downloads go through the auth'd endpoint."""

    has_artifact = serializers.SerializerMethodField()
    artifact = serializers.FileField(write_only=True, required=False)

    class Meta:
        model = OutpostRelease
        fields = [
            "id", "version", "source", "artifact", "has_artifact",
            "git_url", "git_ref", "description", "is_default", "size_bytes",
            "created_at",
        ]
        read_only_fields = ["id", "size_bytes", "created_at"]

    def get_has_artifact(self, obj) -> bool:
        return bool(obj.artifact)

    def validate(self, attrs):
        source = attrs.get("source", getattr(self.instance, "source", "file"))
        if source == "git":
            url = attrs.get("git_url") or getattr(self.instance, "git_url", "")
            if not url:
                raise serializers.ValidationError(
                    {"git_url": "A git URL is required for a git release."}
                )
        elif not attrs.get("artifact") and not (
            self.instance and self.instance.artifact
        ):
            raise serializers.ValidationError(
                {"artifact": "Upload a build file for a file release."}
            )
        return attrs
