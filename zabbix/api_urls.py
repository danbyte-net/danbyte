from rest_framework.routers import DefaultRouter

from .viewsets import (
    ZabbixChangeViewSet,
    ZabbixConnectionViewSet,
    ZabbixHostLinkViewSet,
    ZabbixProvisionRuleViewSet,
)

router = DefaultRouter()
router.register(r"connections", ZabbixConnectionViewSet, basename="zabbixconnection")
router.register(r"links", ZabbixHostLinkViewSet, basename="zabbixhostlink")
router.register(r"changes", ZabbixChangeViewSet, basename="zabbixchange")
router.register(
    r"template-rules", ZabbixProvisionRuleViewSet, basename="zabbixtemplaterule"
)

urlpatterns = router.urls
