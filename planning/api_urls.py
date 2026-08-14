"""Planning API URLs — mounted under /api/planning/ by api/api_urls.py."""
from __future__ import annotations

from django.urls import path
from rest_framework.routers import DefaultRouter

from .calendar import calendar
from .ical import calendar_ics
from .viewsets import (
    BoardViewSet,
    MilestoneViewSet,
    PlannedChangeViewSet,
    TaskLabelViewSet,
    TaskLinkViewSet,
    TaskStatusViewSet,
    TaskViewSet,
    assignable_groups,
    assignable_users,
)

router = DefaultRouter()
router.register(r"boards", BoardViewSet, basename="planning-board")
router.register(r"statuses", TaskStatusViewSet, basename="planning-status")
router.register(r"labels", TaskLabelViewSet, basename="planning-label")
router.register(r"milestones", MilestoneViewSet, basename="planning-milestone")
router.register(r"tasks", TaskViewSet, basename="planning-task")
router.register(r"links", TaskLinkViewSet, basename="planning-link")
router.register(
    r"planned-changes", PlannedChangeViewSet, basename="planning-planned-change"
)

urlpatterns = [
    path("calendar/", calendar, name="planning-calendar"),
    path("calendar.ics", calendar_ics, name="planning-calendar-ics"),
    path("assignable-users/", assignable_users, name="planning-assignable-users"),
    path("assignable-groups/", assignable_groups, name="planning-assignable-groups"),
    *router.urls,
]
