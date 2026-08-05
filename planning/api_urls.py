"""Planning API URLs — mounted under /api/planning/ by api/api_urls.py."""
from __future__ import annotations

from rest_framework.routers import DefaultRouter

from .viewsets import (
    BoardViewSet,
    TaskLabelViewSet,
    TaskLinkViewSet,
    TaskStatusViewSet,
    TaskViewSet,
)

router = DefaultRouter()
router.register(r"boards", BoardViewSet, basename="planning-board")
router.register(r"statuses", TaskStatusViewSet, basename="planning-status")
router.register(r"labels", TaskLabelViewSet, basename="planning-label")
router.register(r"tasks", TaskViewSet, basename="planning-task")
router.register(r"links", TaskLinkViewSet, basename="planning-link")

urlpatterns = [*router.urls]
