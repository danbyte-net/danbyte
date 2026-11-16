"""Outpost API URLs - mounted at ``/api/outpost/`` from ``api.api_urls``."""
from __future__ import annotations

from django.urls import path

from discovery.outpost_api import (
    outpost_discovery_results_view,
    outpost_discovery_work_view,
)

from .outpost_views import (
    outpost_discovered_view,
    outpost_download_view,
    outpost_fast_results_view,
    outpost_fast_work_view,
    outpost_hello_view,
    outpost_install_script_view,
    outpost_results_view,
    outpost_snmp_results_view,
    outpost_snmp_work_view,
    outpost_sweep_work_view,
    outpost_work_view,
)

urlpatterns = [
    path("hello/", outpost_hello_view, name="outpost-hello"),
    path("work/", outpost_work_view, name="outpost-work"),
    path("results/", outpost_results_view, name="outpost-results"),
    # The fast lane: the agent owns its sub-minute set continuously and
    # reports buffered probes; the core folds them like its own lane's.
    path("fast-work/", outpost_fast_work_view, name="outpost-fast-work"),
    path("fast-results/", outpost_fast_results_view, name="outpost-fast-results"),
    # SNMP discovery (fetch on the Outpost, persist on the core).
    path("snmp-work/", outpost_snmp_work_view, name="outpost-snmp-work"),
    path("snmp/", outpost_snmp_results_view, name="outpost-snmp-results"),
    # Subnet discovery sweeps (sweep on the Outpost, create IPs on the core).
    path("sweep-work/", outpost_sweep_work_view, name="outpost-sweep-work"),
    path("discovered/", outpost_discovered_view, name="outpost-discovered"),
    # Discovery runs on Outposts: package inventory and service scans.
    path("discovery-work/", outpost_discovery_work_view, name="outpost-discovery-work"),
    path("discovery-results/", outpost_discovery_results_view,
         name="outpost-discovery-results"),
    # Package store: the generated installer + the build artifact.
    path("install.sh", outpost_install_script_view, name="outpost-install"),
    path("download/<str:version>/", outpost_download_view, name="outpost-download"),
]
