"""Deployment-wide Email & Delivery settings — SPA JSON endpoints.

A singleton (``DeploymentSettings``) edited only by users with ``users.manage``.
The SMTP password is write-only and stored Fernet-encrypted; reads expose
``smtp_password_set`` (a boolean) instead of the secret.
"""
from __future__ import annotations

import re

from django.core import mail
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment

from .models import DeploymentSettings


def clean_display_timezone(value: str) -> str:
    """Validate an IANA timezone name. Blank = inherit (server / deployment).
    Shared by the deployment and tenant settings serializers."""
    from zoneinfo import ZoneInfo

    value = (value or "").strip()
    if not value:
        return ""
    try:
        ZoneInfo(value)
    except (ValueError, KeyError, OSError):
        raise serializers.ValidationError(
            f"'{value}' is not a valid IANA timezone (e.g. Europe/Copenhagen)."
        )
    return value


class DeploymentSettingsSerializer(serializers.ModelSerializer):
    # Write-only secret; never serialised back. A blank value on update leaves
    # the stored password untouched (so the form needn't re-enter it).
    smtp_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    smtp_password_set = serializers.SerializerMethodField()
    # Release-repo token for private update repos (write-only, in `secrets`).
    release_repo_token = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    release_repo_token_set = serializers.SerializerMethodField()
    # Vault token for the secret store (write-only, in `secrets`).
    vault_token = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    vault_token_set = serializers.SerializerMethodField()
    # Absolute URL of the custom favicon (read-only); null = the Danbyte
    # default. Uploaded via the dedicated multipart endpoint below.
    favicon_url = serializers.SerializerMethodField()

    class Meta:
        model = DeploymentSettings
        fields = [
            "session_idle_timeout_minutes",
            "email_enabled",
            "smtp_host",
            "smtp_port",
            "smtp_security",
            "smtp_username",
            "smtp_password",
            "smtp_password_set",
            "email_from",
            "public_base_url",
            "webhook_timeout",
            "outbound_proxy",
            "deployment_name",
            "changelog_retention_days",
            "favicon_url",
            "ssrf_allowlist",
            "secrets_provider",
            "vault_addr",
            "vault_mount",
            "vault_verify_tls",
            "vault_token",
            "vault_token_set",
            "map_tile_url",
            "map_tile_attribution",
            "map_satellite_url",
            "map_satellite_attribution",
            "enhanced_site_separation",
            "allow_site_settings",
            "allow_site_editor_delegation",
            "config_drift_enabled",
            "config_drift_interval_minutes",
            "config_drift_last_run",
            "ssh_terminal_enabled",
            "digest_enabled",
            "digest_frequency",
            "digest_weekday",
            "digest_recipients",
            "cert_digest_enabled",
            "cert_digest_recipients",
            "human_ids_enabled",
            "date_format",
            "time_style",
            "display_timezone",
            "release_repo_url",
            "release_repo_token",
            "release_repo_token_set",
            "disable_update_check",
            "hide_update_badge",
            "auto_update_enabled",
            "update_channel",
            "update_window_days",
            "update_window_start",
            "update_window_end",
            "updated_at",
        ]
        read_only_fields = ["updated_at", "config_drift_last_run", "favicon_url"]

    def get_favicon_url(self, obj) -> str | None:
        if not obj.favicon:
            return None
        url = obj.favicon.url
        request = self.context.get("request")
        return request.build_absolute_uri(url) if request else url

    def validate_ssrf_allowlist(self, value):
        """Each entry must parse as an address/CIDR — a typo that silently
        never matches would look like the setting is broken."""
        import ipaddress

        if not isinstance(value, list):
            raise serializers.ValidationError("Must be a list of CIDRs.")
        cleaned = []
        for entry in value:
            entry = str(entry).strip()
            if not entry:
                continue
            try:
                ipaddress.ip_network(entry, strict=False)
            except ValueError:
                raise serializers.ValidationError(
                    f"'{entry}' is not a valid address or CIDR "
                    "(e.g. 10.0.0.100 or 10.0.0.0/24)."
                )
            cleaned.append(entry)
        return cleaned

    def validate_map_tile_url(self, value):
        """Blank = OSM default. Otherwise it must be an https template with
        the {z}/{x}/{y} placeholders a raster tile layer needs."""
        value = (value or "").strip()
        if not value:
            return ""
        if not value.startswith("https://"):
            raise serializers.ValidationError("Tile URL must be https://.")
        for ph in ("{z}", "{x}", "{y}"):
            if ph not in value:
                raise serializers.ValidationError(
                    "Tile URL must contain the {z}, {x} and {y} placeholders "
                    "(e.g. https://tiles.example.com/{z}/{x}/{y}.png)."
                )
        return value

    def validate_map_satellite_url(self, value):
        return self.validate_map_tile_url(value)

    def validate_display_timezone(self, value):
        return clean_display_timezone(value)

    def get_smtp_password_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("password"))

    def get_release_repo_token_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("release_repo_token"))

    def get_vault_token_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("vault_token"))

    def update(self, instance, validated_data):
        secrets = dict(instance.secrets or {})
        pw = validated_data.pop("smtp_password", None)
        if pw:
            secrets["password"] = pw
        tok = validated_data.pop("release_repo_token", None)
        if tok:
            secrets["release_repo_token"] = tok
        vtok = validated_data.pop("vault_token", None)
        if vtok:
            secrets["vault_token"] = vtok
        instance.secrets = secrets
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


def _require_manage(request):
    # Deployment-wide settings: a tenant-narrowed admin grant does NOT pass —
    # only superusers / global users.manage / unscoped user-change grants.
    # Tenant admins get /api/tenant-settings/ instead.
    return can_manage_deployment(request.user)


@extend_schema(
    methods=["GET"],
    summary="Read deployment-wide Email & Delivery settings",
    tags=["deployment"],
    request=None,
    responses=DeploymentSettingsSerializer,
)
@extend_schema(
    methods=["PUT"],
    summary="Update deployment-wide Email & Delivery settings",
    tags=["deployment"],
    request=DeploymentSettingsSerializer,
    responses=DeploymentSettingsSerializer,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def deployment_settings(request):
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    ctx = {"request": request}
    if request.method == "PUT":
        ser = DeploymentSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        # A changed idle timeout must take effect promptly, not after the cache
        # TTL — drop the cached value so the next request re-reads it.
        from core.middleware import clear_idle_timeout_cache

        clear_idle_timeout_cache()
        return Response(DeploymentSettingsSerializer(obj, context=ctx).data)
    return Response(DeploymentSettingsSerializer(obj, context=ctx).data)


@extend_schema(
    methods=["POST"],
    summary="Sign out every browser session (force re-login for all users)",
    tags=["deployment"],
    request=None,
    responses=inline_serializer(
        name="EndAllSessionsResult", fields={"ended": serializers.IntegerField()}
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def deployment_end_all_sessions(request):
    """Delete all active sessions — an emergency "log everyone out" switch (e.g.
    after a suspected compromise or a permissions overhaul). This signs out the
    caller too. API tokens are unaffected. Deployment admins only."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    from django.contrib.sessions.models import Session

    count = Session.objects.count()
    Session.objects.all().delete()
    # Flush the caller's own session too. Without this, SessionMiddleware
    # re-saves it at response time (the idle-timeout middleware marks it
    # modified), resurrecting the very session we just deleted — so the admin
    # who hit this button would stay logged in.
    request.session.flush()
    return Response({"ended": count})


# Upload cap — a favicon is tiny; anything larger is a mistake or abuse.
FAVICON_MAX_BYTES = 1024 * 1024
FAVICON_MAX_DIM = 1024


@extend_schema(
    methods=["POST"],
    summary="Upload the custom browser-tab favicon",
    tags=["deployment"],
    request=inline_serializer(
        name="DeploymentFaviconUpload",
        fields={"favicon": serializers.ImageField()},
    ),
    responses=DeploymentSettingsSerializer,
)
@extend_schema(
    methods=["DELETE"],
    summary="Clear the custom browser-tab favicon",
    tags=["deployment"],
    request=None,
    responses=DeploymentSettingsSerializer,
)
@api_view(["POST", "DELETE"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def deployment_favicon(request):
    """Set (POST multipart ``favicon``) or clear (DELETE) the custom browser-tab
    icon. Deployment-wide branding, so ``users.manage`` only. Rejects anything
    Pillow can't open as a raster image — which also rules out SVG, keeping a
    script-carrying SVG off the same-origin media path."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    ctx = {"request": request}

    if request.method == "DELETE":
        if obj.favicon:
            obj.favicon.delete(save=False)
            obj.favicon = None
            obj.save(update_fields=["favicon", "updated_at"])
        return Response(DeploymentSettingsSerializer(obj, context=ctx).data)

    upload = request.FILES.get("favicon")
    if not upload:
        return Response({"detail": "No favicon file provided."}, status=400)
    if upload.size > FAVICON_MAX_BYTES:
        return Response(
            {"detail": "Favicon too large (max 1 MB)."}, status=400
        )
    # Validate it's a real raster image (also rejects SVG — Pillow can't open
    # it — so no active content lands on the media origin).
    try:
        from PIL import Image

        image = Image.open(upload)
        image.verify()
        if max(image.size) > FAVICON_MAX_DIM:
            return Response(
                {"detail": f"Favicon too large (max {FAVICON_MAX_DIM}px)."},
                status=400,
            )
    except Exception:
        return Response(
            {"detail": "Not a valid image. Use a PNG or ICO file."}, status=400
        )
    upload.seek(0)

    if obj.favicon:
        obj.favicon.delete(save=False)
    obj.favicon = upload
    obj.save(update_fields=["favicon", "updated_at"])
    return Response(DeploymentSettingsSerializer(obj, context=ctx).data)


# ── optional built-in device fields — admin-controlled visibility ────────
# Server-side defaults applied when a key is absent from the stored dict.
DEVICE_FIELD_VISIBILITY_DEFAULTS = {
    "comments": True,
    "location": True,
    "cluster": False,
    "airflow": False,
    # The site map is a first-class surface — coordinates default to visible
    # so a device can be placed without a settings hunt. (Deployments that
    # stored an explicit False keep their choice; stored values win.)
    "latitude": True,
    "longitude": True,
}


# ── floor-plan tile popover ─────────────────────────────────────────────────
# The field vocabulary the popover can render. Must stay in step with the
# registry in frontend/src/components/floorplan/tile-popover.tsx — this list is
# what the settings UI offers and what the API will persist.
#
# Custom fields are NOT listed: they're user-defined, so they're accepted
# generically as `cf_<key>` (see CF_FIELD_RE). Hard-coding them here would
# violate the zero-pre-filled-data rule.
FLOORPLAN_POPOVER_FIELDS = [
    # ── the tile itself ──
    "name",
    "type",
    "status",
    "linked",
    "position",
    "size",
    "orientation",
    "color",
    "fov",
    "plan",
    "created",
    "updated",
    # ── live state (already polled; no fetch) ──
    "utilization",
    "power",
    "weight",
    "device_count",
    "check",
    # ── the linked rack/device (lazily fetched when one of these is on) ──
    "linked_status",
    "linked_role",
    "linked_site",
    "linked_description",
    "linked_tags",
    "linked_numid",
    "linked_primary_ip",
    "linked_serial",
    "linked_asset_tag",
]

# Custom fields ride a generic `cf_<key>` convention rather than being enumerated
# — the key set is whatever the tenant defined.
CF_FIELD_RE = re.compile(r"^cf_[A-Za-z0-9_-]{1,64}$")

# Scope keys for per-type overrides: "tt:<tile-type-slug>" / "role:<role-slug>".
# A tile carries a tile_type XOR a role_type, so one namespace each. A scope that
# is ABSENT inherits the global list.
SCOPE_KEY_RE = re.compile(r"^(tt|role):[a-z0-9-]{1,100}$")

# Shown when nothing is configured.
FLOORPLAN_POPOVER_FIELD_DEFAULTS = [
    "name",
    "type",
    "status",
    "linked",
    "utilization",
    "position",
    "size",
]


class DeviceFieldVisibilitySerializer(serializers.Serializer):
    """Exposes the 6 optional device-field visibility booleans.

    On read, stored values are merged over the documented defaults. On write,
    only the 6 known keys are persisted back to ``device_field_visibility``;
    unknown keys are ignored.
    """

    comments = serializers.BooleanField(required=False)
    location = serializers.BooleanField(required=False)
    cluster = serializers.BooleanField(required=False)
    airflow = serializers.BooleanField(required=False)
    latitude = serializers.BooleanField(required=False)
    longitude = serializers.BooleanField(required=False)

    def to_representation(self, instance):
        stored = instance.device_field_visibility or {}
        return {
            key: bool(stored.get(key, default))
            for key, default in DEVICE_FIELD_VISIBILITY_DEFAULTS.items()
        }

    def update(self, instance, validated_data):
        merged = dict(DEVICE_FIELD_VISIBILITY_DEFAULTS)
        merged.update(instance.device_field_visibility or {})
        for key in DEVICE_FIELD_VISIBILITY_DEFAULTS:
            if key in validated_data:
                merged[key] = bool(validated_data[key])
        # Persist only the known keys (strips any previously-stored junk too).
        instance.device_field_visibility = {
            key: merged[key] for key in DEVICE_FIELD_VISIBILITY_DEFAULTS
        }
        instance.save(update_fields=["device_field_visibility", "updated_at"])
        return instance


@extend_schema(
    methods=["GET"],
    summary="Read optional device-field visibility toggles",
    tags=["deployment"],
    request=None,
    responses=DeviceFieldVisibilitySerializer,
)
@extend_schema(
    methods=["PUT"],
    summary="Update optional device-field visibility toggles",
    tags=["deployment"],
    request=DeviceFieldVisibilitySerializer,
    responses=DeviceFieldVisibilitySerializer,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def device_field_visibility(request):
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    if request.method == "PUT":
        ser = DeviceFieldVisibilitySerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(DeviceFieldVisibilitySerializer(obj).data)
    return Response(DeviceFieldVisibilitySerializer(obj).data)


def clean_popover_fields(value) -> list:
    """Keep only usable field keys, in the given order, deduped.

    A key is usable if it's in the built-in vocabulary OR is a `cf_<key>` custom
    field. Custom fields are matched by shape, not by an enumerated list — the
    tenant defines them, so anything else would mean shipping their data.
    """
    if not isinstance(value, list):
        return []
    known = set(FLOORPLAN_POPOVER_FIELDS)
    return list(
        dict.fromkeys(
            k
            for k in value
            if isinstance(k, str) and (k in known or CF_FIELD_RE.match(k))
        )
    )


def clean_popover_overrides(value) -> dict:
    """Per-scope field lists, keyed "tt:<slug>" / "role:<slug>".

    Drops unknown scope shapes and empty lists — an absent scope inherits the
    global list, so storing an empty one would be a silent "show nothing".
    """
    if not isinstance(value, dict):
        return {}
    out = {}
    for scope, fields in value.items():
        scope = str(scope)
        if not SCOPE_KEY_RE.match(scope):
            continue
        cleaned = clean_popover_fields(fields)
        if cleaned:
            out[scope] = cleaned
    return out


class FloorplanPopoverSerializer(serializers.Serializer):
    """The floor-plan tile popover config.

    ``popover_fields`` is the global ordered list; ``tile_overrides`` maps a
    tile-type slug → its own list. A slug that is ABSENT inherits the global
    list, so the two never drift apart (unlike copying the list onto every type).

    Unknown keys are dropped on read *and* write, so removing a field from the
    registry can't leave stale config behind. (Not named ``fields`` — that
    collides with ``Serializer.fields``.)
    """

    popover_fields = serializers.ListField(
        child=serializers.CharField(), required=False
    )
    tile_overrides = serializers.DictField(
        child=serializers.ListField(child=serializers.CharField()), required=False
    )

    def validate_popover_fields(self, value):
        return clean_popover_fields(value)

    def validate_tile_overrides(self, value):
        return clean_popover_overrides(value)

    def to_representation(self, instance):
        stored = clean_popover_fields(instance.floorplan_popover_fields)
        return {
            "popover_fields": stored or list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
            "tile_overrides": clean_popover_overrides(
                instance.floorplan_popover_tile_overrides
            ),
            # The vocabulary the UI renders its checklist from, so the field list
            # lives in one place (here) rather than being duplicated client-side.
            # `cf_*` keys aren't listed — the UI adds those from the tenant's own
            # custom-field definitions.
            "available": list(FLOORPLAN_POPOVER_FIELDS),
            "defaults": list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
        }

    def update(self, instance, validated_data):
        if "popover_fields" in validated_data:
            instance.floorplan_popover_fields = validated_data["popover_fields"]
        if "tile_overrides" in validated_data:
            instance.floorplan_popover_tile_overrides = validated_data[
                "tile_overrides"
            ]
        instance.save(
            update_fields=[
                "floorplan_popover_fields",
                "floorplan_popover_tile_overrides",
                "updated_at",
            ]
        )
        return instance


@extend_schema(
    methods=["GET"],
    summary="Read deployment-wide floor-plan tile popover config",
    tags=["deployment"],
    request=None,
    responses=FloorplanPopoverSerializer,
)
@extend_schema(
    methods=["PUT"],
    summary="Update deployment-wide floor-plan tile popover config",
    tags=["deployment"],
    request=FloorplanPopoverSerializer,
    responses=FloorplanPopoverSerializer,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def floorplan_popover(request):
    """Deployment-wide popover config — the default every tenant inherits."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    if request.method == "PUT":
        ser = FloorplanPopoverSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    return Response(FloorplanPopoverSerializer(obj).data)


# The faceplate component-popover vocabulary — what a port's hover card can
# show. Same idea as the tile popover: an ordered, curated key list; unknown
# keys are dropped on read AND write so removed fields never linger in config.
COMPONENT_POPOVER_FIELDS = [
    "name",        # interface name, linked
    "type",        # connector/interface type
    "state",       # disabled / enabled·no cable / up · speed · cable type
    "vlan",        # access VLAN or trunk summary
    "live",        # observed oper status + speed (SNMP), when present
    "ips",         # up to three assigned addresses, linked
    "description",
    "mac",         # the interface's MAC address
    "mtu",
    "lag",         # LAG membership
    "tags",
]

COMPONENT_POPOVER_FIELD_DEFAULTS = ["name", "type", "state", "vlan", "live", "ips"]


def clean_component_popover_fields(value) -> list:
    if not isinstance(value, list):
        return []
    known = set(COMPONENT_POPOVER_FIELDS)
    return list(dict.fromkeys(k for k in value if isinstance(k, str) and k in known))


@extend_schema(
    methods=["GET", "PUT"],
    summary="Get/replace the faceplate component-popover field list",
    tags=["deployment"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiTypes.OBJECT,
)
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def component_popover(request):
    """Deployment-wide faceplate popover config (users.manage to change)."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    if request.method == "PUT":
        obj.component_popover_fields = clean_component_popover_fields(
            request.data.get("popover_fields")
        )
        obj.save(update_fields=["component_popover_fields"])
    stored = clean_component_popover_fields(obj.component_popover_fields)
    return Response({
        "popover_fields": stored or list(COMPONENT_POPOVER_FIELD_DEFAULTS),
        "is_default": not stored,
        "available": COMPONENT_POPOVER_FIELDS,
        "defaults": COMPONENT_POPOVER_FIELD_DEFAULTS,
    })


@extend_schema(
    methods=["GET"],
    summary="The effective component-popover field list (any member)",
    tags=["deployment"],
    request=None,
    responses=OpenApiTypes.OBJECT,
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def component_popover_effective(request):
    """What the faceplate should render — readable by anyone signed in."""
    stored = clean_component_popover_fields(
        DeploymentSettings.load().component_popover_fields
    )
    return Response({"fields": stored or list(COMPONENT_POPOVER_FIELD_DEFAULTS)})


@extend_schema(
    summary="Liveness/readiness probe with version and DB status",
    tags=["deployment"],
    request=None,
    responses=inline_serializer(
        name="HealthResponse",
        fields={
            "status": serializers.CharField(),
            "database": serializers.BooleanField(),
            "version": serializers.CharField(),
        },
    ),
)
@api_view(["GET"])
@permission_classes([AllowAny])
def health(request):
    """Liveness/readiness probe — unauthenticated, cheap. Confirms the app is
    up and the DB answers, and reports the running version. Used by the release
    install-smoke and handy for nginx / a load balancer."""
    from django.db import connection

    from .version import system_version

    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        db_ok = True
    except Exception:  # noqa: BLE001 — any DB error → not ready
        db_ok = False
    return Response(
        {"status": "ok" if db_ok else "degraded",
         "database": db_ok,
         "version": system_version()["version"]},
        status=200 if db_ok else 503,
    )


@extend_schema(
    summary="Network-free runtime info (versions of Python/Django/PostgreSQL/Redis)",
    tags=["deployment"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Version plus Python/Django/PostgreSQL/Redis environment info.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def system_info(request):
    """Instant, network-free runtime info (version + Python/Django/PostgreSQL/
    Redis) for the Updates page. Deliberately separate from ``system_updates``
    so the version + environment always render immediately, even when the
    release-repo check is slow, failing, or disabled (airgapped)."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    from .version import system_info as _system_info

    return Response(_system_info())


@extend_schema(
    summary="Available release versions and whether an update exists",
    tags=["deployment"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Current version, release-repo versions with changelog, and update-available flag.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def system_updates(request):
    """Current version + the release repo's versions (with changelog), and
    whether a newer one exists. Read-only; ``users.manage`` only."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)

    from .github import list_releases
    from .version import DEFAULT_RELEASE_REPO, is_newer, system_version

    cur = system_version()
    dep = DeploymentSettings.load()
    repo = dep.release_repo_url or DEFAULT_RELEASE_REPO
    token = (dep.secrets or {}).get("release_repo_token", "")
    # Airgapped: never reach the release repo. Report the current version only;
    # bundles are uploaded and applied manually.
    if dep.disable_update_check:
        return Response({
            "current": cur, "repo_url": repo, "releases": [],
            "update_available": False, "disabled": True,
            "badge_hidden": dep.hide_update_badge,
        })
    try:
        releases = list_releases(repo, token)
    except Exception as e:  # noqa: BLE001 — surface a friendly reason
        return Response({
            "current": cur, "repo_url": repo, "releases": [],
            "update_available": False, "error": str(e),
        })
    if dep.update_channel == "stable":
        releases = [r for r in releases if not r["prerelease"]]
    for r in releases:
        r["is_current"] = r["tag"].lstrip("vV") == cur["version"].lstrip("vV")
    update_available = any(is_newer(r["tag"], cur["version"]) for r in releases)
    return Response({
        "current": cur,
        "repo_url": repo,
        "releases": releases,
        "update_available": update_available,
        "badge_hidden": dep.hide_update_badge,
    })


@extend_schema(
    summary="Send a test email to verify SMTP configuration",
    tags=["deployment"],
    request=inline_serializer(
        name="DeploymentTestEmailRequest",
        fields={"to": serializers.EmailField(required=False)},
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Delivery result: {ok: bool, to?: str, error?: str}.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def deployment_test_email(request):
    """Send a test email to verify SMTP config. Accepts ``{"to": "..."}``."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    from monitoring.notify import build_email_connection

    settings_obj = DeploymentSettings.load()
    to = (request.data or {}).get("to") or request.user.email
    if not to:
        return Response({"ok": False, "error": "No recipient address."}, status=400)
    try:
        conn = build_email_connection(settings_obj)
        mail.EmailMessage(
            subject="[Danbyte] Test email",
            body="This is a test from Danbyte's Email & Delivery settings.",
            from_email=settings_obj.email_from or None,
            to=[to],
            connection=conn,
        ).send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 — surface the SMTP error to the admin
        from core.email import describe_smtp_error

        return Response(
            {"ok": False, "detail": describe_smtp_error(exc), "error": str(exc)},
            status=502,
        )
    return Response({"ok": True, "to": to})


@extend_schema(
    summary="List the email templates available to preview",
    tags=["deployment"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def email_templates(request):
    """The templates a user can send a sample of, for the preview UI."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    from core.email_samples import TEMPLATES

    return Response({"templates": [{"key": k, "label": lbl} for k, lbl in TEMPLATES]})


@extend_schema(
    summary="Send a sample of one (or all) email templates to preview it",
    tags=["deployment"],
    request=inline_serializer(
        name="EmailPreviewRequest",
        fields={
            "to": serializers.EmailField(required=False),
            "template": serializers.CharField(required=False),
        },
    ),
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def email_send_preview(request):
    """Render one template (or ``"all"``) with sample data and send it, using
    Danbyte's effective SMTP config, so an admin can see how the emails look."""
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    from core.email import send_html_email
    from core.email_samples import TEMPLATE_KEYS, render_sample

    to = (request.data or {}).get("to") or request.user.email
    if not to:
        return Response({"ok": False, "error": "No recipient address."}, status=400)
    template = (request.data or {}).get("template") or "all"
    keys = TEMPLATE_KEYS if template == "all" else [template]
    if template != "all" and template not in TEMPLATE_KEYS:
        return Response({"ok": False, "error": "Unknown template."}, status=400)

    # Use the active tenant's effective SMTP (falls back to the deployment relay),
    # so the preview reflects the config the operator is actually testing.
    from api.views import _get_active_tenant
    from core.email import describe_smtp_error

    tenant = _get_active_tenant(request)
    sent, errors = [], {}
    for key in keys:
        try:
            subject, html, text = render_sample(key)
            send_html_email(
                f"[Preview] {subject}", [to],
                html_body=html, text_body=text, tenant=tenant,
                fail_silently=False,
            )
            sent.append(key)
        except Exception as exc:  # noqa: BLE001 — report per-template
            errors[key] = describe_smtp_error(exc)
            # An SMTP-level failure will fail every template the same way —
            # stop instead of hammering the relay (repeated failed attempts
            # can get this server's IP temporarily blocked).
            break
    if not sent and errors:
        detail = next(iter(errors.values()))
        return Response(
            {"ok": False, "detail": detail, "to": to, "sent": sent,
             "errors": errors},
            status=502,
        )
    return Response({"ok": True, "to": to, "sent": sent, "errors": errors})
