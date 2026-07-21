"""Base helpers for plugin API viewsets."""
from __future__ import annotations

from rest_framework.exceptions import NotFound

from .resolve import plugin_enabled


class PluginEnabledMixin:
    """404 the whole viewset when the plugin is disabled for the active tenant.

    Mix into a plugin viewset and set ``plugin_slug``. A disabled plugin becomes
    invisible (default-closed) rather than returning an authorization error.
    RBAC still applies on top for an enabled plugin.
    """

    plugin_slug: str | None = None

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if self.plugin_slug and not plugin_enabled(self.plugin_slug, tenant):
            raise NotFound("Plugin not enabled.")
