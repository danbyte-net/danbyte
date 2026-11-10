"""Tenant vulnerability routes (#451), mounted at the top of ``/api/`` ahead
of the main router, so the per-object paths win over its detail routes. The
deployment-wide settings, import and sync paths are in ``api/api_urls.py``;
a record's id always has a dash, so ``vulnerabilities/<id>/`` never shadows
them."""
from django.urls import path
from rest_framework.routers import SimpleRouter

from . import exceptions_api, match_api

router = SimpleRouter()
router.register(r"vulnerability-exceptions", exceptions_api.VulnerabilityExceptionViewSet,
                basename="vulnerabilityexception")
router.register(r"vulnerabilities/mappings", match_api.ProductMappingViewSet,
                basename="vulnerability-mapping")
router.register(r"vulnerabilities/matches", match_api.VulnerabilityMatchViewSet,
                basename="vulnerability-match")
router.register(r"vulnerabilities", match_api.VulnerabilityViewSet,
                basename="vulnerability")

urlpatterns = [
    path("vulnerabilities/policy/", match_api.vulnerability_policy,
         name="vulnerability-policy"),
    path("vulnerabilities/summary/", match_api.vulnerability_summary,
         name="vulnerability-summary"),
    path("vulnerabilities/coverage/", match_api.vulnerability_coverage,
         name="vulnerability-coverage"),
    path("devices/<uuid:pk>/vulnerabilities/", match_api.device_vulnerabilities,
         name="device-vulnerabilities"),
    path("virtual-machines/<uuid:pk>/vulnerabilities/",
         match_api.virtual_machine_vulnerabilities, name="virtual-machine-vulnerabilities"),
    path("platforms/<uuid:pk>/vulnerabilities/", match_api.platform_vulnerabilities,
         name="platform-vulnerabilities"),
    path("applications/<uuid:pk>/vulnerabilities/", match_api.application_vulnerabilities,
         name="application-vulnerabilities"),
    *router.urls,
]
