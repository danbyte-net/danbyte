"""Serializers for the monitoring API.

Credentials are **write-only** everywhere: ``secret_params`` can be set on a
template but is never serialised back out (a boolean ``has_secrets`` is exposed
instead). Param validation runs the kind's ``validate_params`` so a bad config
is a clean 400, not a runtime ``unknown``.
"""
from __future__ import annotations

from django.utils.text import slugify
from drf_spectacular.utils import extend_schema_serializer
from rest_framework import serializers

from api.models import DeviceRole, DeviceType, IPAddress, Status, Prefix
from api.serializers import TenantScopedPrimaryKeyRelatedField

from .checkers import CheckConfigError, get_checker
from .models import (
    Alert,
    AlertRule,
    AcmeOrder,
    Certificate,
    CertificateAssignment,
    CertificateRequest,
    Issuer,
    CertificateBinding,
    SSHHostKey,
    CheckAssignment,
    CheckKind,
    CheckResult,
    CheckState,
    CheckTemplate,
    ConnectProtocol,
    DeviceCredential,
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
    SnmpSensor,
    StateTransition,
    WatchedEndpoint,
)


@extend_schema_serializer(component_name="MonitoringIPMini")
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
            "neighbors", "arp", "sensors", "reachable", "error", "polled_at",
        ]
        read_only_fields = fields


class CertificateSerializer(serializers.ModelSerializer):
    """An X.509 certificate — public fields only.

    The intrinsic facts are properties of the exact DER bytes the fingerprint
    covers, so they are **read-only**: subject/issuer/serial/fingerprint/validity/
    key can never be edited, whatever a payload says. Only the authored metadata
    (``name``, ``notes``) is writable, and only via PATCH — there is still no way
    for a payload to reach a fact field, which is the outermost layer of "a
    private key is never accepted". ``pem`` is the stored **public** PEM (present
    only for uploaded certs) and is read-only here; it is set by the upload path.

    ``is_expired`` / ``days_until_expiry`` / ``origin`` are derived at read time
    so a stale row can't report itself healthy or mislabel how it came to exist.
    """

    is_expired = serializers.BooleanField(read_only=True)
    days_until_expiry = serializers.FloatField(read_only=True)
    origin = serializers.CharField(read_only=True)
    binding_count = serializers.IntegerField(
        read_only=True, default=0,
        help_text="How many endpoints are on record as having served this "
        "certificate — the size of the blast radius when it expires.",
    )
    assignment_count = serializers.IntegerField(read_only=True, default=0)
    # CA / chain context — the resolved parent in this tenant's inventory, named
    # so the UI can render "issued by <CA>" and walk leaf → root without a lookup.
    issuer_certificate_subject_cn = serializers.CharField(
        source="issuer_certificate.subject_cn", read_only=True, default=None
    )

    class Meta:
        model = Certificate
        fields = [
            "id", "fingerprint_sha256", "subject", "subject_cn", "issuer",
            "issuer_cn", "serial", "san_dns", "san_ip", "not_before",
            "not_after", "is_expired", "days_until_expiry",
            "public_key_algorithm", "public_key_bits", "signature_algorithm",
            "self_signed", "last_seen", "binding_count", "assignment_count",
            # CA modelling.
            "is_ca", "subject_key_id", "authority_key_id", "issuer_certificate",
            "issuer_certificate_subject_cn",
            # Authoring surface.
            "origin", "observed", "uploaded", "pem", "name", "notes",
            "created_at", "updated_at",
        ]
        # Everything intrinsic (and the origin flags/pem) is read-only; only the
        # authored metadata may be written.
        read_only_fields = [
            f for f in fields if f not in ("name", "notes")
        ]


class CertificateUploadSerializer(serializers.Serializer):
    """Input for authoring a certificate from a pasted/uploaded public PEM.

    Only ``pem`` (plus optional metadata) is accepted — the facts are extracted
    from the bytes, never trusted from the payload. The private-key refusal and
    parsing happen in :func:`monitoring.certificates.upload_certificate`.
    """

    pem = serializers.CharField(
        help_text="The public certificate in PEM format (-----BEGIN "
        "CERTIFICATE-----). Never a private key.",
        trim_whitespace=False,
    )
    name = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )
    notes = serializers.CharField(required=False, allow_blank=True, default="")


class CertificateBindingSerializer(serializers.ModelSerializer):
    """An endpoint that served a certificate — read-only, like the certificate.

    This is the row that answers "what breaks when this expires": one
    certificate, N of these. ``chain_depth`` and ``chain_verified`` are
    per-endpoint facts, so they live here rather than on the certificate.
    """

    target_ip_address = serializers.CharField(
        source="target_ip.ip_address", read_only=True, default=None
    )
    endpoint = serializers.CharField(source="endpoint_label", read_only=True)
    certificate_subject_cn = serializers.CharField(
        source="certificate.subject_cn", read_only=True, default=None
    )
    certificate_not_after = serializers.DateTimeField(
        source="certificate.not_after", read_only=True, default=None
    )
    fingerprint_sha256 = serializers.CharField(
        source="certificate.fingerprint_sha256", read_only=True, default=None
    )

    class Meta:
        model = CertificateBinding
        fields = [
            "id", "certificate", "certificate_subject_cn", "certificate_not_after",
            "fingerprint_sha256", "target_ip", "target_ip_address", "port",
            "server_name", "endpoint", "endpoint_key", "chain_depth",
            "chain_verified", "first_seen", "last_seen",
            "created_at", "updated_at",
        ]
        read_only_fields = fields


class SSHHostKeySerializer(serializers.ModelSerializer):
    """A device's SSH host key — public data only, facts read-only.

    Authoring is by pasting an OpenSSH public-key line into ``public_key_line``
    (write-only). The type/blob/fingerprint are parsed from it — never trusted
    from the payload — in :func:`monitoring.ssh_host_keys.upload_host_key`, which
    also refuses private keys. ``device`` is required (a host key belongs to a
    device)."""

    origin = serializers.CharField(read_only=True)
    device_name = serializers.CharField(
        source="device.name", read_only=True, default=None
    )
    public_key_line = serializers.CharField(
        write_only=True, required=False, trim_whitespace=False,
        help_text="An OpenSSH public-key line: 'ssh-ed25519 AAAA… comment'.",
    )

    class Meta:
        model = SSHHostKey
        fields = [
            "id", "device", "device_name", "key_type", "public_key",
            "fingerprint_sha256", "comment", "bits", "origin", "observed",
            "uploaded", "first_seen", "last_seen", "created_at", "updated_at",
            "public_key_line",
        ]
        # Every fact is derived from the pasted key or the collector; the client
        # only supplies device + public_key_line.
        read_only_fields = [
            "id", "key_type", "public_key", "fingerprint_sha256", "comment",
            "bits", "origin", "observed", "uploaded", "first_seen", "last_seen",
            "created_at", "updated_at",
        ]


class DeviceCredentialSerializer(serializers.ModelSerializer):
    """A device login. The secret value is **never** serialised back — only
    whether one is set. Fetching it is the viewset's ``reveal`` action.

    Two sourcing modes (``secret_managed``):

    * **Managed** (default): the operator types the secret once via the
      write-only ``password`` / ``private_key`` / ``passphrase`` fields, and the
      viewset stores it in the active secret store under a Danbyte-owned ref.
    * **External**: ``secret_managed=false`` + ``secret_path`` points at a path
      the operator manages themselves (e.g. an existing Vault path).
    """

    device_name = serializers.CharField(
        source="device.name", read_only=True, default=None
    )
    # Write-only secret material — accepted on create/update, never returned.
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    private_key = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    passphrase = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    secret_set = serializers.SerializerMethodField()

    def get_secret_set(self, obj) -> bool:
        # A managed credential has its secret once a ref is assigned; an external
        # one always "has" one by reference. Cheap, never touches the store.
        return bool(obj.secret_path)

    class Meta:
        model = DeviceCredential
        fields = [
            "id", "device", "device_name", "name", "kind", "username", "port",
            "scheme", "secret_managed", "secret_provider", "secret_path",
            "secret_set", "password", "private_key", "passphrase",
            "description", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "secret_set", "created_at", "updated_at"]

    def validate(self, attrs):
        # External credentials must name a path; managed ones auto-assign it.
        managed = attrs.get(
            "secret_managed",
            getattr(self.instance, "secret_managed", True),
        )
        if not managed:
            path = attrs.get("secret_path", getattr(self.instance, "secret_path", ""))
            if not path:
                raise serializers.ValidationError(
                    {"secret_path": "Required for an external-reference credential."}
                )
        return attrs


class ConnectProtocolSerializer(serializers.ModelSerializer):
    """A user-defined device access method (a launch-URL template).

    Plain tenant-scoped CRUD — no secret is involved. The template is rendered
    into a URL client-side at launch; the server only stores the template.

    Optional targeting: ``device_type_ids`` / ``role_ids`` restrict which devices
    offer the protocol (empty = all). A device matches when its device_type is in
    ``device_types`` OR its role is in ``roles`` — the ``?device=<id>`` list
    filter applies exactly that union."""

    device_type_ids = TenantScopedPrimaryKeyRelatedField(
        source="device_types", many=True, required=False,
        queryset=DeviceType.objects.all(),
    )
    role_ids = TenantScopedPrimaryKeyRelatedField(
        source="roles", many=True, required=False,
        queryset=DeviceRole.objects.all(),
    )
    device_types_detail = serializers.SerializerMethodField()
    roles_detail = serializers.SerializerMethodField()

    def get_device_types_detail(self, obj) -> list:
        return [{"id": str(d.pk), "name": d.model} for d in obj.device_types.all()]

    def get_roles_detail(self, obj) -> list:
        return [{"id": str(r.pk), "name": r.name} for r in obj.roles.all()]

    class Meta:
        model = ConnectProtocol
        fields = [
            "id", "name", "url_template", "icon", "default_port", "weight",
            "enabled", "description", "device_type_ids", "role_ids",
            "device_types_detail", "roles_detail", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "device_types_detail", "roles_detail", "created_at", "updated_at",
        ]


class CertificateAssignmentSerializer(serializers.ModelSerializer):
    """Declares that a certificate should be presented by some object.

    The generic ``(object_type, object_id)`` target is validated for existence
    *in the active tenant* by the viewset (it lives in the ``api`` app and is
    resolved by label). Here we only guard the shape of ``object_type`` and
    expose read-only certificate context for the assignment lists.
    """

    certificate_subject_cn = serializers.CharField(
        source="certificate.subject_cn", read_only=True, default=None
    )
    certificate_fingerprint = serializers.CharField(
        source="certificate.fingerprint_sha256", read_only=True, default=None
    )
    certificate_not_after = serializers.DateTimeField(
        source="certificate.not_after", read_only=True, default=None
    )
    # The generic target as a human sees it: "10.0.0.1", "sw1" — not the raw
    # UUID. `object_context` carries the disambiguator that matters for the type
    # (an IP's VRF, a device's site), so an assignment reads without a lookup.
    object_label = serializers.SerializerMethodField()
    object_type_label = serializers.SerializerMethodField()
    object_context = serializers.SerializerMethodField()

    def _target(self, obj):
        """Resolve the assignment's (object_type, object_id) to the instance,
        cached on the serializer-bound assignment to avoid a double query."""
        if not hasattr(obj, "_resolved_target"):
            from auth_api.object_types import model_for

            model = model_for((obj.object_type or "").split(".")[-1])
            obj._resolved_target = (
                model.objects.filter(pk=obj.object_id).first() if model else None
            )
        return obj._resolved_target

    def get_object_label(self, obj) -> str:
        target = self._target(obj)
        return str(target) if target is not None else str(obj.object_id)

    def get_object_type_label(self, obj) -> str:
        from auth_api.object_types import model_for

        model = model_for((obj.object_type or "").split(".")[-1])
        return str(model._meta.verbose_name).title() if model else obj.object_type

    def get_object_context(self, obj) -> str:
        """A short disambiguator for the target: an IP's VRF (or "Global"),
        a device/VM's site. Empty when the type has no useful context."""
        target = self._target(obj)
        if target is None:
            return ""
        # IPAddress → VRF (nullable = the global table).
        if hasattr(target, "vrf_id"):
            return target.vrf.name if target.vrf_id else "Global"
        # Device / VirtualMachine → site.
        if getattr(target, "site_id", None):
            return target.site.name
        return ""

    def validate_object_type(self, value):
        from auth_api.object_types import is_registered

        value = (value or "").strip().lower()
        # Resolve by the model's registry slug (e.g. "device"), the same shape
        # ContactAssignment targets use, accepting the "app.model" label form.
        slug = value.split(".")[-1]
        if not is_registered(slug):
            raise serializers.ValidationError(
                "Unknown object type. Use e.g. api.device, api.ipaddress, "
                "api.virtualmachine, api.service."
            )
        return value

    class Meta:
        model = CertificateAssignment
        fields = [
            "id", "certificate", "certificate_subject_cn",
            "certificate_fingerprint", "certificate_not_after",
            "object_type", "object_id", "object_label", "object_type_label",
            "object_context", "notes", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class CertificateRequestSerializer(serializers.ModelSerializer):
    """A CSR request — read view. The private key is never here (it lives in the
    secret store); the public CSR is. Only ``notes`` is writable via PATCH."""

    key_spec_display = serializers.CharField(source="get_key_spec_display", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    created_by_name = serializers.CharField(
        source="created_by.get_username", read_only=True, default=None
    )
    issued_certificate_subject_cn = serializers.CharField(
        source="issued_certificate.subject_cn", read_only=True, default=None
    )

    class Meta:
        model = CertificateRequest
        fields = [
            "id", "common_name", "organization", "organizational_unit",
            "country", "state", "locality", "san_dns", "san_ip",
            "key_spec", "key_spec_display", "status", "status_display",
            "csr_pem", "issued_certificate", "issued_certificate_subject_cn",
            "created_by_name", "notes", "created_at", "updated_at",
        ]
        read_only_fields = [f for f in fields if f != "notes"]


class IssuerSerializer(serializers.ModelSerializer):
    """An external CA connector. The EAB HMAC is write-only (stored encrypted);
    the ACME account key never appears here (it lives in the secret store)."""

    eab_hmac = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    eab_hmac_set = serializers.SerializerMethodField()
    # The TSIG secret for RFC2136 DNS-01 auto-publish — write-only, encrypted at
    # rest in ``secrets`` exactly like the EAB HMAC.
    tsig_secret = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    tsig_secret_set = serializers.SerializerMethodField()
    account_registered = serializers.SerializerMethodField()

    class Meta:
        model = Issuer
        fields = [
            "id", "name", "kind", "enabled", "directory_url", "contact_email",
            "eab_kid", "eab_hmac", "eab_hmac_set", "verify_tls",
            "dns_provider", "dns_settings", "tsig_secret", "tsig_secret_set",
            "account_registered", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    # Write-only secrets → the encrypted ``secrets`` map, keyed by field name.
    _SECRET_FIELDS = {"eab_hmac": "eab_hmac", "tsig_secret": "tsig_secret"}

    def get_eab_hmac_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("eab_hmac"))

    def get_tsig_secret_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("tsig_secret"))

    def get_account_registered(self, obj) -> bool:
        return bool(obj.account_uri)

    def _apply_secrets(self, secrets: dict, validated_data) -> dict:
        for field, key in self._SECRET_FIELDS.items():
            value = validated_data.pop(field, None)
            if value is None:
                continue  # not supplied — leave the stored secret untouched
            if value:
                secrets[key] = value
            else:
                secrets.pop(key, None)
        return secrets

    def create(self, validated_data):
        secrets = self._apply_secrets({}, validated_data)
        instance = Issuer(**validated_data)
        if secrets:
            instance.secrets = secrets
        instance.save()
        return instance

    def update(self, instance, validated_data):
        instance.secrets = self._apply_secrets(dict(instance.secrets or {}), validated_data)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


class AcmeOrderSerializer(serializers.ModelSerializer):
    """An ACME issuance order — read view (created/driven by the engine)."""

    issuer_name = serializers.CharField(source="issuer.name", read_only=True)
    request_common_name = serializers.CharField(
        source="request.common_name", read_only=True, default=None
    )
    issued_certificate_subject_cn = serializers.CharField(
        source="issued_certificate.subject_cn", read_only=True, default=None
    )
    status_display = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = AcmeOrder
        fields = [
            "id", "issuer", "issuer_name", "request", "request_common_name",
            "status", "status_display", "challenge_type", "identifiers",
            "challenges", "error", "issued_certificate",
            "issued_certificate_subject_cn", "created_at", "updated_at",
        ]
        read_only_fields = fields


class SnmpSensorSerializer(serializers.ModelSerializer):
    """A user-defined SNMP health sensor (OID → inventory-item status)."""

    device_type_name = serializers.CharField(
        source="device_type.name", read_only=True, default=None
    )

    class Meta:
        model = SnmpSensor
        fields = [
            "id", "name", "slug", "description", "device_type",
            "device_type_name", "oid", "walk", "item_kind", "name_template",
            "value_map", "absent_status", "apply_mode", "enabled",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]
        extra_kwargs = {"slug": {"required": False}}

    def validate(self, attrs):
        if not attrs.get("slug") and attrs.get("name"):
            attrs["slug"] = slugify(attrs["name"])[:120] or "sensor"
        vm = attrs.get("value_map")
        if vm is not None and not isinstance(vm, dict):
            raise serializers.ValidationError(
                {"value_map": "Must be an object mapping raw value → status slug."}
            )
        return attrs


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


class WatchedEndpointSerializer(serializers.ModelSerializer):
    """A bare TLS endpoint (host:port + SNI) watched on a schedule — no device
    required. Poll state is read-only; the poller stamps it."""

    last_certificate_fingerprint = serializers.CharField(
        source="last_certificate.fingerprint_sha256", read_only=True, default=None
    )

    class Meta:
        model = WatchedEndpoint
        fields = [
            "id", "host", "port", "server_name", "interval_seconds", "enabled",
            "last_run_at", "last_status", "last_detail",
            "last_certificate", "last_certificate_fingerprint",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "last_run_at", "last_status", "last_detail",
            "last_certificate", "last_certificate_fingerprint",
            "created_at", "updated_at",
        ]

    def validate_port(self, value):
        if not (1 <= int(value) <= 65535):
            raise serializers.ValidationError("Port must be 1–65535.")
        return value

    def validate_host(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Host is required.")
        return value
