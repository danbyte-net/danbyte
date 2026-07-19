"""Mounted at /api/jobs/ from api/api_urls.py."""
from __future__ import annotations

from django.urls import path

from . import views

urlpatterns = [
    path("", views.jobs_list_view, name="jobs-list"),
    path("<str:job_id>/", views.job_detail_view, name="jobs-detail"),
    path("<str:job_id>/requeue/", views.job_requeue_view, name="jobs-requeue"),
    path("<str:job_id>/cancel/", views.job_cancel_view, name="jobs-cancel"),
]
