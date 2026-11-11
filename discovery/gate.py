"""Is discovery on? (#451 decision 11)

Two switches, both required: the deployment's and the tenant's Discovery
integration toggle (Settings → Integrations, default off).
``integrations.toggles`` folds the deployment switch into
``integration_enabled(tenant, "discovery")``; this module is the one place
the discovery code asks.

The deployment switch: ``DANBYTE_DISCOVERY_ENABLED`` when it is set (locked
on, or locked off - nothing can change it), else the stored
``DeploymentSettings.discovery_enabled`` (default off), which deployment
admins change on the Discovery card.
"""
from __future__ import annotations

from django.conf import settings
from rest_framework.exceptions import NotFound, PermissionDenied


def deployment_source() -> str:
    """``env`` when ``DANBYTE_DISCOVERY_ENABLED`` decides, else ``setting``."""
    return "setting" if getattr(settings, "DISCOVERY_ENABLED", None) is None else "env"


def deployment_enabled() -> bool:
    value = getattr(settings, "DISCOVERY_ENABLED", None)
    if value is not None:
        return bool(value)
    from core.models import DeploymentSettings

    return DeploymentSettings.objects.filter(pk=1, discovery_enabled=True).exists()


def winrm_state() -> tuple[bool, str, str]:
    """Whether WinRM may be switched on by a tenant: ``(ok, label, reason)``.
    Refused when the deployment forbids it (``DANBYTE_DISCOVERY_WINRM_ALLOWED``)
    or this server cannot run it."""
    if not getattr(settings, "DISCOVERY_WINRM_ALLOWED", True):
        return (False, "Forbidden by the deployment",
                "DANBYTE_DISCOVERY_WINRM_ALLOWED is off for this deployment.")
    from .winrm import available

    ok, why = available()
    if not ok:
        return False, "Not available in this build", why
    return True, "", ""


def first_use_keys_allowed() -> bool:
    """``DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS`` (default on): whether Run
    now may offer "Accept new host keys" at all."""
    return bool(getattr(settings, "DISCOVERY_ALLOW_FIRST_USE_KEYS", True))


def active(tenant) -> bool:
    """Discovery is on for ``tenant`` (and the tenant is active)."""
    from integrations.toggles import integration_enabled

    if tenant is None or not getattr(tenant, "is_active", True):
        return False
    return deployment_enabled() and integration_enabled(tenant, "discovery")


def active_tenant_ids() -> set:
    """Every active tenant with Discovery on; empty while the deployment
    switch is off. One query."""
    from integrations.models import IntegrationSettings

    if not deployment_enabled():
        return set()
    return set(IntegrationSettings.objects.filter(
        discovery_enabled=True, tenant__is_active=True).values_list("tenant_id", flat=True))


def require(request):
    """The active tenant, or 404 while discovery is off for it."""
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not active(tenant):
        raise NotFound("Discovery is off.")
    return tenant
