"""Discovery routes (#451 B2), mounted at ``/api/`` beside the vulnerability
routes, ahead of the main router so the per-host paths win over its detail
routes."""
from django.urls import path
from rest_framework.routers import SimpleRouter

from . import api, findings_api

router = SimpleRouter()
router.register(r"discovery/profiles", api.InventoryProfileViewSet,
                basename="inventoryprofile")
router.register(r"discovery/runs", api.InventoryRunViewSet, basename="inventoryrun")

urlpatterns = [
    path("discovery/status/", api.discovery_status, name="discovery-status"),
    path("discovery/deployment/", api.discovery_deployment, name="discovery-deployment"),
    path("discovery/settings/", api.discovery_settings, name="discovery-settings"),
    path("discovery/exempt/", api.discovery_exempt, name="discovery-exempt"),
    path("discovery/outposts/", api.discovery_outposts, name="discovery-outposts"),
    path("discovery/policy-scopes/", api.discovery_policy_scopes,
         name="discovery-policy-scopes"),
    path("discovery/policy-scopes/<uuid:pk>/", api.discovery_policy_scope,
         name="discovery-policy-scope"),
    path("discovery/host-keys/accept/", api.discovery_accept_host_keys,
         name="discovery-accept-host-keys"),
    path("discovery/services/", findings_api.discovery_services, name="discovery-services"),
    path("discovery/findings/", findings_api.discovery_findings, name="discovery-findings"),
    path("discovery/findings/accept/", findings_api.discovery_findings_accept,
         name="discovery-findings-accept"),
    path("discovery/findings/ignore/", findings_api.discovery_findings_ignore,
         name="discovery-findings-ignore"),
    path("devices/<uuid:pk>/packages/", api.device_packages, name="device-packages"),
    path("virtual-machines/<uuid:pk>/packages/", api.virtual_machine_packages,
         name="virtual-machine-packages"),
    *router.urls,
]
