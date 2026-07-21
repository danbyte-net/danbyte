"""The base class every Danbyte plugin subclasses.

A plugin ships an ``apps.py`` with a ``DanbytePluginConfig`` subclass instead of
a plain ``AppConfig``. The extra class attributes are pure metadata read by the
Django-free loader (``danbyte/plugin_loader.py``) at settings-import time, so
they must stay declarative — do NOT import models or touch the app registry at
class-definition time.

Registration of a plugin's contributions (object types, providers, checkers,
nav/pages) happens from a ``danbyte_plugin.py`` module the plugin ships, which
``plugins.apps.PluginsConfig.ready()`` autodiscovers — the same idiom as
``api/apps.py``'s ``autodiscover_modules("io")``.
"""
from __future__ import annotations

from django.apps import AppConfig


class DanbytePluginConfig(AppConfig):
    # Domain models set their own UUID primary keys (Danbyte convention); this
    # only governs implicit auto PKs, kept consistent with the core apps.
    default_auto_field = "django.db.models.BigAutoField"

    # ─── plugin metadata (read by the loader; override in your subclass) ──────
    version: str = "0.0.0"
    author: str = ""
    description: str = ""
    # Danbyte version window this plugin supports (inclusive). None = unbounded.
    min_version: str | None = None
    max_version: str | None = None
    # Per-plugin default settings, merged into settings.PLUGINS_CONFIG[slug].
    default_settings: dict = {}
    # URL/nav slug; defaults to the app label. Also the /api/plugins/<slug>/ mount.
    slug: str | None = None

    @property
    def plugin_slug(self) -> str:
        return self.slug or self.label

    def ready(self):
        # Merge this plugin's default settings under its slug, without clobbering
        # operator overrides already present in settings.PLUGINS_CONFIG.
        from django.conf import settings

        cfg = getattr(settings, "PLUGINS_CONFIG", None)
        if isinstance(cfg, dict):
            merged = {**self.default_settings, **cfg.get(self.plugin_slug, {})}
            cfg[self.plugin_slug] = merged
