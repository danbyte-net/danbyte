"""Per-tenant settings overrides — SPA JSON endpoints.

Tenant admins (``can_manage_admin`` in the active tenant) edit their tenant's
:class:`~core.models.TenantSettings` here: each group carries an ``override_*``
toggle; off = inherit the deployment default. The GET payload embeds the
non-secret deployment defaults so the UI can show what "inherit" means without
a second (deployment-admin-gated) fetch. Secrets are write-only, stored
Fernet-encrypted; reads expose ``*_set`` booleans. LDAP overrides live in
``auth_api/ldap_api.py`` (same model, directory-specific endpoints).
"""
from __future__ import annotations

from django.conf import settings
from django.core import mail
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_admin

from .deployment import DEVICE_FIELD_VISIBILITY_DEFAULTS
from .effective_settings import effective_device_fields, effective_email
from .models import DeploymentSettings, TenantSettings


class TenantSettingsSerializer(serializers.ModelSerializer):
    smtp_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    smtp_password_set = serializers.SerializerMethodField()

    class Meta:
        model = TenantSettings
        fields = [
            "override_email",
            "override_ui",
            "override_sharing",
            # email (mirrors DeploymentSettings)
            "email_enabled",
            "smtp_host",
            "smtp_port",
            "smtp_security",
            "smtp_username",
            "smtp_password",
            "smtp_password_set",
            "email_from",
            # UI policy
            "device_field_visibility",
            "human_ids_enabled",
            # floor-plan popover (its own override group)
            "override_floorplan_popover",
            "floorplan_popover_fields",
            "floorplan_popover_tile_overrides",
            # site separation (its own override group)
            "override_separation",
            "enhanced_site_separation",
            "allow_site_settings",
            # sharing & delegation
            "allow_site_editor_delegation",
            # date & time display (its own override group)
            "override_datetime",
            "date_format",
            "time_style",
            "display_timezone",
            # email digest (its own override group)
            "override_digest",
            "digest_enabled",
            "digest_frequency",
            "digest_weekday",
            "digest_recipients",
            "digest_last_run",
            "updated_at",
        ]
        read_only_fields = ["updated_at", "digest_last_run"]

    def get_smtp_password_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("password"))

    # Same allowlist as the deployment editor — a tenant must not be able to
    # store a field key the popover registry doesn't know.
    def validate_floorplan_popover_fields(self, value):
        from core.deployment import clean_popover_fields

        return clean_popover_fields(value)

    def validate_floorplan_popover_tile_overrides(self, value):
        from core.deployment import clean_popover_overrides

        return clean_popover_overrides(value)

    def validate_display_timezone(self, value):
        from core.deployment import clean_display_timezone

        return clean_display_timezone(value)

    def update(self, instance, validated_data):
        pw = validated_data.pop("smtp_password", None)
        if pw:
            secrets = dict(instance.secrets or {})
            secrets["password"] = pw
            instance.secrets = secrets
        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()
        return instance


def _deployment_defaults() -> dict:
    """Non-secret deployment values of the overridable groups, for the UI's
    "inherit" summaries. Never includes secrets."""
    dep = DeploymentSettings.load()
    merged_fields = dict(DEVICE_FIELD_VISIBILITY_DEFAULTS)
    merged_fields.update({
        k: bool(v)
        for k, v in (dep.device_field_visibility or {}).items()
        if k in merged_fields
    })
    return {
        "email_enabled": dep.email_enabled,
        "smtp_host": dep.smtp_host,
        "smtp_port": dep.smtp_port,
        "smtp_security": dep.smtp_security,
        "smtp_username": dep.smtp_username,
        "email_from": dep.email_from,
        "device_field_visibility": merged_fields,
        "human_ids_enabled": dep.human_ids_enabled,
        "enhanced_site_separation": dep.enhanced_site_separation,
        "allow_site_settings": dep.allow_site_settings,
        "allow_site_editor_delegation": dep.allow_site_editor_delegation,
        "ldap_enabled": dep.ldap_enabled,
        "ldap_server_uri": dep.ldap_server_uri,
        "date_format": dep.date_format,
        "time_style": dep.time_style,
        # Resolved for the "inherit" summary — blank means the server default.
        "display_timezone": dep.display_timezone or settings.TIME_ZONE,
    }


def _tenant_or_403(request):
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, Response({"detail": "No active tenant."}, status=400)
    if not can_manage_admin(request.user, tenant):
        return None, Response({"detail": "Tenant admin required."}, status=403)
    return tenant, None


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def tenant_settings(request):
    """The active tenant's settings overrides. Both verbs are tenant-admin-only
    (the payload carries SMTP configuration)."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err
    obj = TenantSettings.for_tenant(tenant)
    if request.method == "PUT":
        ser = TenantSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    data = TenantSettingsSerializer(obj).data
    data["deployment_defaults"] = _deployment_defaults()
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def tenant_test_email(request):
    """Send a test email through the tenant's EFFECTIVE SMTP config (its
    override when on, else the deployment relay). ``{"to": "..."}``."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err
    from monitoring.notify import build_email_connection

    eff = effective_email(tenant)
    to = (request.data or {}).get("to") or request.user.email
    if not to:
        return Response({"ok": False, "error": "No recipient address."}, status=400)
    try:
        conn = build_email_connection(eff)
        mail.EmailMessage(
            subject="[Danbyte] Test email",
            body="This is a test from Danbyte's tenant email settings.",
            from_email=eff.email_from or None,
            to=[to],
            connection=conn,
        ).send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 — surface the SMTP error to the admin
        return Response({"ok": False, "error": str(exc)}, status=502)
    return Response({
        "ok": True,
        "to": to,
        "via": "tenant" if getattr(eff, "tenant_id", None) else "deployment",
    })


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def tenant_test_digest(request):
    """Send the active tenant's monitoring digest right now (tenant-admin only),
    ignoring the enabled flag and schedule. Goes to ``{"to": "..."}`` if given,
    else the configured digest recipients, else the requester."""
    tenant, err = _tenant_or_403(request)
    if err:
        return err
    from core.email import parse_recipients
    from monitoring.digest import send_tenant_digest

    to = (request.data or {}).get("to")
    recipients = parse_recipients(to) if to else None
    if not recipients and not request.user.email:
        recipients = None  # fall through to configured recipients
    ok = send_tenant_digest(
        tenant, force=True, recipients=recipients or ([request.user.email] if request.user.email else None)
    )
    if not ok:
        return Response(
            {"ok": False, "error": "No recipients (add some, or pass 'to')."},
            status=400,
        )
    return Response({"ok": True})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_fields_view(request):
    """The EFFECTIVE optional-device-field visibility for the active tenant —
    readable by any member (the device form needs it), unlike the
    deployment-default editor which is deployment-admin-only."""
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    return Response(effective_device_fields(tenant))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_default_prefix(request):
    """The prefix this user's site says new addresses should come from.

    "Staff assigned to a site" = the sites they can EDIT (``editable_sites``) —
    a read-only viewer of ten sites has no home site, so no default. Resolves
    only when they edit exactly ONE site AND that site sets a default; anything
    else is ambiguous, and guessing would be worse than leaving the picker
    empty. Returns ``{"prefix": null}`` in that case rather than 404, so the
    form can treat "no default" as a normal answer.
    """
    from api.models import Site
    from api.views import _get_active_tenant
    from auth_api.rbac import editable_sites

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"prefix": None})
    sites = editable_sites(request.user, tenant)
    # None = edits every site (admin) → no single home site to default from.
    if not sites or len(sites) != 1:
        return Response({"prefix": None})
    site = (
        Site.objects.filter(tenant=tenant, id=next(iter(sites)))
        .select_related("default_prefix")
        .first()
    )
    if site is None or site.default_prefix_id is None:
        return Response({"prefix": None})
    return Response(
        {
            "prefix": {
                "id": str(site.default_prefix_id),
                "cidr": site.default_prefix.cidr,
            },
            "site": {"id": str(site.id), "name": site.name},
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def floorplan_popover_view(request):
    """The EFFECTIVE floor-plan popover config for the active tenant — readable
    by any member, since the canvas needs it to render a popover at all."""
    from api.views import _get_active_tenant

    from core.effective_settings import effective_floorplan_popover

    tenant = _get_active_tenant(request)
    return Response(effective_floorplan_popover(tenant))


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def tenant_floorplan_popover(request):
    """THIS TENANT's popover config — tenant-admin gated.

    Mirrors the deployment editor's payload, plus `override` (this tenant's own
    switch, independent of the UI-policy group) and the read-only
    `deployment_defaults` so the UI can show what it would inherit.
    """
    from core.deployment import (
        FLOORPLAN_POPOVER_FIELD_DEFAULTS,
        FLOORPLAN_POPOVER_FIELDS,
        FloorplanPopoverSerializer,
        clean_popover_fields,
        clean_popover_overrides,
    )
    from core.models import DeploymentSettings

    tenant, err = _tenant_or_403(request)
    if err:
        return err
    obj = TenantSettings.for_tenant(tenant)

    if request.method == "PUT":
        if "override" in request.data:
            obj.override_floorplan_popover = bool(request.data["override"])
            obj.save(update_fields=["override_floorplan_popover", "updated_at"])
        ser = FloorplanPopoverSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()

    dep = DeploymentSettings.load()
    return Response(
        {
            "override": obj.override_floorplan_popover,
            "popover_fields": clean_popover_fields(obj.floorplan_popover_fields)
            or list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
            "tile_overrides": clean_popover_overrides(
                obj.floorplan_popover_tile_overrides
            ),
            "available": list(FLOORPLAN_POPOVER_FIELDS),
            "defaults": list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
            "deployment_defaults": {
                "popover_fields": clean_popover_fields(dep.floorplan_popover_fields)
                or list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
                "tile_overrides": clean_popover_overrides(
                    dep.floorplan_popover_tile_overrides
                ),
            },
        }
    )
