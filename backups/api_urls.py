"""Backup API - mounted at ``/api/backups/`` from ``api/api_urls.py``."""
from __future__ import annotations

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import api_views

router = DefaultRouter()
router.register("targets", api_views.BackupTargetViewSet, basename="backup-target")
router.register("schedules", api_views.BackupScheduleViewSet, basename="backup-schedule")
router.register("restore-runs", api_views.RestoreRunViewSet, basename="restore-run")
router.register("", api_views.BackupViewSet, basename="backup")

urlpatterns = [
    path("status/", api_views.backups_status, name="backups-status"),
    path("upload/", api_views.backup_upload, name="backups-upload"),
    path("", include(router.urls)),
]
