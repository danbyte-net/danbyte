"""Plugin framework URLs — mounted at ``/api/plugins/`` from ``api/api_urls.py``.

The framework's own endpoints come first; each installed plugin's ``api_urls``
module is then mounted under ``/api/plugins/<slug>/`` (added in a later phase).
"""
from __future__ import annotations

from django.urls import path

from . import api_views

urlpatterns = [
    path("", api_views.plugins_list, name="plugins-list"),
]
