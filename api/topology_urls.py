"""Topology map endpoints kept apart from ``api.api_urls``, mounted under
``/api/`` ahead of it (``danbyte/urls.py``)."""
from django.urls import path

from .topology_views import topology_chassis_view

urlpatterns = [
    # The virtual chassis a Diagram palette can place.
    path("topology/chassis/", topology_chassis_view, name="topology-chassis"),
]
