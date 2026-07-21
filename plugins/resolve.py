"""Resolve whether a plugin is enabled for a tenant.

Cascade: a tenant-specific ``PluginConfig`` row → the deployment-default row
(NULL tenant) → the plugin's ``default_enabled``. A plugin that isn't installed
(not loaded) is never enabled.
"""
from __future__ import annotations

from .models import PluginConfig
from .registry import get_plugin, loaded_slugs


def plugin_enabled(slug: str, tenant=None) -> bool:
    if slug not in loaded_slugs():
        return False

    rows = {
        (r.tenant_id): r.enabled
        for r in PluginConfig.objects.filter(plugin_slug=slug)
        if r.tenant_id is None or (tenant is not None and r.tenant_id == tenant.id)
    }
    if tenant is not None and tenant.id in rows:
        return rows[tenant.id]
    if None in rows:
        return rows[None]

    cfg = get_plugin(slug)
    return bool(getattr(cfg, "default_enabled", True)) if cfg else False


def enabled_plugins(tenant=None) -> set[str]:
    return {slug for slug in loaded_slugs() if plugin_enabled(slug, tenant)}
