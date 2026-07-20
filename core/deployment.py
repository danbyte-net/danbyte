"""Deployment-wide Email & Delivery settings — SPA JSON endpoints.

A singleton (``DeploymentSettings``) edited only by users with ``users.manage``.
The SMTP password is write-only and stored Fernet-encrypted; reads expose
``smtp_password_set`` (a boolean) instead of the secret.
"""
from __future__ import annotations

import re

from django.core import mail
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
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

    class Meta:
        model = DeploymentSettings
        fields = [
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
            "ssrf_allowlist",
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
            "human_ids_enabled",
            "date_format",
            "time_style",
            "display_timezone",
            "release_repo_url",
            "release_repo_token",
            "release_repo_token_set",
            "disable_update_check",
            "auto_update_enabled",
            "update_channel",
            "update_window_days",
            "update_window_start",
            "update_window_end",
            "updated_at",
        ]
        read_only_fields = ["updated_at", "config_drift_last_run"]

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
                    "(e.g. 10.196.223.134 or 10.196.0.0/16)."
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

    def update(self, instance, validated_data):
        secrets = dict(instance.secrets or {})
        pw = validated_data.pop("smtp_password", None)
        if pw:
            secrets["password"] = pw
        tok = validated_data.pop("release_repo_token", None)
        if tok:
            secrets["release_repo_token"] = tok
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


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def deployment_settings(request):
    if not _require_manage(request):
        return Response({"detail": "users.manage required."}, status=403)
    obj = DeploymentSettings.load()
    if request.method == "PUT":
        ser = DeploymentSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(DeploymentSettingsSerializer(obj).data)
    return Response(DeploymentSettingsSerializer(obj).data)


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
    })


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
        return Response({"ok": False, "error": str(exc)}, status=502)
    return Response({"ok": True, "to": to})
