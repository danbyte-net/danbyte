"""Runtime view of installed plugins.

The authoritative discovery outcome (loaded / incompatible / error) is computed
once at settings time by ``danbyte.plugin_loader.discover`` and stashed on
``settings._PLUGIN_LOAD_REPORT``. This module exposes it (plus live app-registry
cross-checks) to the rest of the app and the ``/api/plugins/`` endpoint.
"""
from __future__ import annotations

from django.apps import apps as django_apps
from django.conf import settings

from .base import DanbytePluginConfig


def loaded_configs() -> list[DanbytePluginConfig]:
    """Every installed plugin's live AppConfig (only the successfully-loaded)."""
    return [
        cfg
        for cfg in django_apps.get_app_configs()
        if isinstance(cfg, DanbytePluginConfig)
    ]


def loaded_slugs() -> set[str]:
    return {cfg.plugin_slug for cfg in loaded_configs()}


def get_plugin(slug: str) -> DanbytePluginConfig | None:
    for cfg in loaded_configs():
        if cfg.plugin_slug == slug:
            return cfg
    return None


def plugin_report() -> list[dict]:
    """Serialisable status of every plugin named in ``PLUGINS``.

    Reads the settings-time report so incompatible/errored plugins (which never
    entered the app registry) are still surfaced. Marks a plugin ``error`` if
    the loader thought it loaded but it is missing from the live registry (e.g.
    it raised during ``ready()``).
    """
    report = getattr(settings, "_PLUGIN_LOAD_REPORT", []) or []
    live = loaded_slugs()
    out: list[dict] = []
    for st in report:
        state = st.state
        if state == "loaded" and st.slug not in live:
            state = "error"
        out.append(
            {
                "module": st.module,
                "slug": st.slug,
                "name": st.name,
                "version": st.version,
                "author": st.author,
                "description": st.description,
                "state": state,
                "error": st.error,
                "min_version": st.min_version,
                "max_version": st.max_version,
            }
        )
    return out
