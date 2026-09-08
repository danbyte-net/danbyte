"""Scripts API - mounted at ``/api/scripts/`` from ``api/api_urls.py``."""
from __future__ import annotations

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import api_views

router = DefaultRouter()
router.register("runs", api_views.ScriptRunViewSet, basename="script-run")
router.register("", api_views.ScriptViewSet, basename="script")

urlpatterns = [path("", include(router.urls))]
