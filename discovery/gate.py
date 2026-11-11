"""Is discovery on? (#451 decision 11)

Two switches, both required: the deployment's ``DANBYTE_DISCOVERY_ENABLED``
(env, default off) and the tenant's Discovery integration toggle
(Settings → Integrations, default off). ``integrations.toggles`` already
folds the deployment switch into ``integration_enabled(tenant,
"discovery")``; this module is the one place the discovery code asks.
"""
from __future__ import annotations

from django.conf import settings
from rest_framework.exceptions import NotFound, PermissionDenied


def deployment_enabled() -> bool:
    return bool(getattr(settings, "DISCOVERY_ENABLED", False))


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
