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
    VmConfigView,
    VmDiffView,
    VmFetchNowView,
    VmNodesView,
    VmVersionsView,
    VmVersionView,
)

router = DefaultRouter()
router.register(r"connections", OxidizedConnectionViewSet, basename="oxidizedconnection")
router.register(r"links", OxidizedNodeLinkViewSet, basename="oxidizednodelink")


def _config_paths(prefix: str, name: str, views) -> list:
    """The config endpoints for one object kind: ``<prefix>/<id>/…``."""
    nodes, config, versions, version, diff, fetch_now = views
    base = f"{prefix}/<uuid:obj_id>/"
    return [
        path(base, nodes.as_view(), name=f"oxidized-{name}"),
        path(f"{base}config/", config.as_view(), name=f"oxidized-{name}-config"),
        path(f"{base}versions/", versions.as_view(), name=f"oxidized-{name}-versions"),
        path(
            f"{base}versions/<str:oid>/", version.as_view(), name=f"oxidized-{name}-version"
        ),
        path(f"{base}diff/", diff.as_view(), name=f"oxidized-{name}-diff"),
        path(f"{base}fetch-now/", fetch_now.as_view(), name=f"oxidized-{name}-fetch-now"),
    ]


urlpatterns = [
    *_config_paths("devices", "device", (
        DeviceNodesView, DeviceConfigView, DeviceVersionsView, DeviceVersionView,
        DeviceDiffView, DeviceFetchNowView,
    )),
    # A virtual router is a VM (#384): the same surface, gated on
    # virtualmachine.view_config.
    *_config_paths("virtual-machines", "vm", (
        VmNodesView, VmConfigView, VmVersionsView, VmVersionView,
        VmDiffView, VmFetchNowView,
    )),
    *router.urls,
]
