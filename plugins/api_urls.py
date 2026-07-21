"""Plugin framework URLs — mounted at ``/api/plugins/`` from ``api/api_urls.py``.

The framework's own endpoints come first; then each installed plugin that ships
an ``api_urls`` module is mounted under ``/api/plugins/<slug>/``. This runs at
URLconf import (after the app registry is ready), so ``loaded_configs()`` is
populated.
"""
from __future__ import annotations

from importlib.util import find_spec

from django.urls import include, path

from . import api_views, ui_views
from .registry import loaded_configs

urlpatterns = [
    path("", api_views.plugins_list, name="plugins-list"),
    path("apply/", api_views.plugins_apply, name="plugins-apply"),
    path("ui/", ui_views.plugin_ui, name="plugins-ui"),
    # Must precede the per-plugin includes below, or the "<slug>/" mount would
    # shadow "<slug>/config/".
    path("<str:slug>/config/", api_views.plugin_config, name="plugin-config"),
]

for _cfg in loaded_configs():
    _mod = f"{_cfg.name}.api_urls"
    if find_spec(_mod) is not None:
        urlpatterns.append(path(f"{_cfg.plugin_slug}/", include(_mod)))
