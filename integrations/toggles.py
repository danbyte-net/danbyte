"""Per-tenant master toggles for the external-sync integrations.

Settings → Integrations writes :class:`~integrations.models.IntegrationSettings`;
everything else asks this module. Enforcement is server-side and layered:
viewsets 404 through :class:`IntegrationToggleMixin` (a disabled integration is
invisible, mirroring ``plugins.viewsets.PluginEnabledMixin``), and scheduled
jobs re-check at run time so a toggle flipped between enqueue and execution
still wins.
"""
from __future__ import annotations

from rest_framework.exceptions import NotFound

#: toggle key → IntegrationSettings field
KEYS = {
    "dhcp": "dhcp_sync_enabled",
    "dns": "dns_sync_enabled",
    "virtualization": "virtualization_enabled",
}


def integration_enabled(tenant, key: str) -> bool:
    """True when the integration ``key`` is switched on for ``tenant``."""
    field = KEYS.get(key)
    if field is None or tenant is None:
        return False
    from .models import IntegrationSettings

    row = IntegrationSettings.objects.filter(tenant=tenant).only(field).first()
    return bool(getattr(row, field, False)) if row else False


class IntegrationToggleMixin:
    """404 the whole viewset while the integration is off for the active tenant.

    ``integration_keys`` holds one or more toggle keys; any enabled key opens
    the viewset (a Windows connection can serve DHCP and DNS, so its endpoint
    stays reachable while either toggle is on).
    """

    integration_keys: tuple[str, ...] = ()

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if self.integration_keys and not any(
            integration_enabled(tenant, k) for k in self.integration_keys
        ):
            raise NotFound("Integration not enabled.")
