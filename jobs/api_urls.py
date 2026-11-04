"""Mounted at /api/jobs/ from api/api_urls.py."""
from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("", views.jobs_list_view, name="jobs-list"),
    path("scheduled/", views.scheduled_runs_view, name="jobs-scheduled"),
    # Before the job routes: an id never reads "bulk-requeue".
    path("bulk-requeue/", views.jobs_bulk_requeue_view, name="jobs-bulk-requeue"),
    path("bulk-cancel/", views.jobs_bulk_cancel_view, name="jobs-bulk-cancel"),
    path("<str:job_id>/", views.job_detail_view, name="jobs-detail"),
    path("<str:job_id>/requeue/", views.job_requeue_view, name="jobs-requeue"),
    path("<str:job_id>/cancel/", views.job_cancel_view, name="jobs-cancel"),
]
