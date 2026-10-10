from django.urls import path
from rest_framework.routers import DefaultRouter

from .viewsets import (
    DeviceConfigView,
    DeviceDiffView,
    DeviceFetchNowView,
    DeviceNodesView,
    DeviceVersionsView,
    DeviceVersionView,
    OxidizedConnectionViewSet,
    OxidizedNodeLinkViewSet,
)

router = DefaultRouter()
router.register(r"connections", OxidizedConnectionViewSet, basename="oxidizedconnection")
router.register(r"links", OxidizedNodeLinkViewSet, basename="oxidizednodelink")

urlpatterns = [
    path("devices/<uuid:device_id>/", DeviceNodesView.as_view(), name="oxidized-device"),
    path(
        "devices/<uuid:device_id>/config/", DeviceConfigView.as_view(),
        name="oxidized-device-config",
    ),
    path(
        "devices/<uuid:device_id>/versions/", DeviceVersionsView.as_view(),
        name="oxidized-device-versions",
    ),
    path(
        "devices/<uuid:device_id>/versions/<str:oid>/", DeviceVersionView.as_view(),
        name="oxidized-device-version",
    ),
    path("devices/<uuid:device_id>/diff/", DeviceDiffView.as_view(), name="oxidized-device-diff"),
    path(
        "devices/<uuid:device_id>/fetch-now/", DeviceFetchNowView.as_view(),
        name="oxidized-device-fetch-now",
    ),
    *router.urls,
]
