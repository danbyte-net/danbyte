from rest_framework.routers import DefaultRouter

from .viewsets import (
    ZabbixChangeViewSet,
    ZabbixConnectionViewSet,
    ZabbixHostLinkViewSet,
)

router = DefaultRouter()
router.register(r"connections", ZabbixConnectionViewSet, basename="zabbixconnection")
router.register(r"links", ZabbixHostLinkViewSet, basename="zabbixhostlink")
router.register(r"changes", ZabbixChangeViewSet, basename="zabbixchange")

urlpatterns = router.urls
