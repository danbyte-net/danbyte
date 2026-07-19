"""Per-SITE settings overrides — SPA JSON endpoints (email group, v1).

The third settings layer: site → tenant → deployment. Editing a site's
settings requires being a **site admin** of that site:

* tenant admins (``can_manage_admin``) always qualify;
* otherwise the tenant's ``allow_site_settings`` switch (separation group)
  must be ON, and the user must hold EITHER an explicit ``sitesettings``
  change grant scoped to the site (grantable to users or groups — build your
  own "Site X admins" group) OR be a site editor there
  (``rbac.editable_sites``).

GET embeds the site's *effective parent* email values (tenant-or-deployment)
as ``parent_defaults`` so the UI can show what "inherit" means. The SMTP
password is write-only, Fernet-encrypted, exposed as ``smtp_password_set``.
"""
from __future__ import annotations

from django.core import mail
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_admin

from .effective_settings import effective_email, effective_separation
from .models import SiteSettings


class SiteSettingsSerializer(serializers.ModelSerializer):
    smtp_password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    smtp_password_set = serializers.SerializerMethodField()

    class Meta:
        model = SiteSettings
        fields = [
            "override_email",
            "email_enabled",
            "smtp_host",
            "smtp_port",
            "smtp_security",
            "smtp_username",
            "smtp_password",
            "smtp_password_set",
            "email_from",
            "updated_at",
        ]
        read_only_fields = ["updated_at"]

    def get_smtp_password_set(self, obj) -> bool:
        return bool((obj.secrets or {}).get("password"))

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


def manageable_settings_sites(user, tenant):
    """The sites whose settings ``user`` may edit — ``"all"`` | set of ids.

    Union of the qualification arms; empty set when the allow switch is off
    (tenant admins bypass it).
    """
    from auth_api import rbac

    if can_manage_admin(user, tenant):
        return "all"
    if not effective_separation(tenant).allow_site_settings:
        return set()
    out: set = set()
    # Explicit sitesettings grant (None = unscoped grant → any site).
    scope = rbac.site_scope(user, tenant, "sitesettings", "change")
    if scope is None and rbac.has_action(user, tenant, "sitesettings", "change"):
        return "all"
    if scope:
        out |= scope
    # Site editors qualify implicitly.
    editable = rbac.editable_sites(user, tenant)
    if editable is None:
        return "all"
    out |= editable
    return out


def _site_or_403(request, site_id):
    from api.models import Site
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, None, Response({"detail": "No active tenant."}, status=400)
    site = Site.objects.filter(tenant=tenant, pk=site_id).first()
    if site is None:
        return None, None, Response({"detail": "Site not found."}, status=404)
    allowed = manageable_settings_sites(request.user, tenant)
    if allowed != "all" and site.pk not in allowed:
        return None, None, Response(
            {"detail": "Site admin required (and the tenant must allow "
                       "site-managed settings)."},
            status=403,
        )
    return tenant, site, None


def _parent_defaults(tenant) -> dict:
    """The email values the site would inherit (tenant-or-deployment
    effective). Never includes secrets."""
    eff = effective_email(tenant)
    return {
        "email_enabled": eff.email_enabled,
        "smtp_host": eff.smtp_host,
        "smtp_port": eff.smtp_port,
        "smtp_security": eff.smtp_security,
        "smtp_username": eff.smtp_username,
        "email_from": eff.email_from,
    }


@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def site_settings(request, site_id):
    """One site's settings overrides — site-admin gated (both verbs)."""
    tenant, site, err = _site_or_403(request, site_id)
    if err:
        return err
    obj = SiteSettings.for_site(site)
    if request.method == "PUT":
        ser = SiteSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
    data = SiteSettingsSerializer(obj).data
    data["site"] = {"id": str(site.id), "name": site.name}
    data["parent_defaults"] = _parent_defaults(tenant)
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def site_test_email(request, site_id):
    """Send a test email through the site's EFFECTIVE SMTP config (its
    override when on, else tenant/deployment). ``{"to": "..."}``."""
    tenant, site, err = _site_or_403(request, site_id)
    if err:
        return err
    from monitoring.notify import build_email_connection

    eff = effective_email(tenant, site=site)
    to = (request.data or {}).get("to") or request.user.email
    if not to:
        return Response({"ok": False, "error": "No recipient address."}, status=400)
    try:
        conn = build_email_connection(eff)
        mail.EmailMessage(
            subject="[Danbyte] Test email",
            body=f"This is a test from the email settings of site {site.name}.",
            from_email=eff.email_from or None,
            to=[to],
            connection=conn,
        ).send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 — surface the SMTP error to the admin
        return Response({"ok": False, "error": str(exc)}, status=502)
    via = "deployment"
    if isinstance(eff, SiteSettings):
        via = "site"
    elif getattr(eff, "tenant_id", None):
        via = "tenant"
    return Response({"ok": True, "to": to, "via": via})
