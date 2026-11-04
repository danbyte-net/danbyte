"""Topology map endpoints kept apart from ``api.api_urls``, mounted under
``/api/`` ahead of it (``danbyte/urls.py``)."""
from django.urls import path

from routing.topology_map import routing_topology_view

from .topology_views import topology_chassis_view

urlpatterns = [
    # The virtual chassis a Diagram palette can place.
    path("topology/chassis/", topology_chassis_view, name="topology-chassis"),
    # The Routing tab: routers, AS groups and the lines per layer.
    path("topology/routing/", routing_topology_view, name="topology-routing"),
]
