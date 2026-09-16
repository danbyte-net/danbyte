from django.urls import path
from rest_framework.routers import DefaultRouter

from .viewsets import (
    ZabbixAdoptionRuleViewSet,
    ZabbixChangeViewSet,
    ZabbixConnectionViewSet,
    ZabbixHostLinkViewSet,
    ZabbixHostStatusView,
    ZabbixMaintenanceViewSet,
    ZabbixProvisionRuleViewSet,
)

router = DefaultRouter()
router.register(r"connections", ZabbixConnectionViewSet, basename="zabbixconnection")
router.register(r"links", ZabbixHostLinkViewSet, basename="zabbixhostlink")
router.register(r"changes", ZabbixChangeViewSet, basename="zabbixchange")
router.register(r"maintenance", ZabbixMaintenanceViewSet, basename="zabbixmaintenance")
router.register(
    r"adoption-rules", ZabbixAdoptionRuleViewSet, basename="zabbixadoptionrule"
)
router.register(
    r"template-rules", ZabbixProvisionRuleViewSet, basename="zabbixtemplaterule"
)

urlpatterns = [
    path("host-status/", ZabbixHostStatusView.as_view(), name="zabbix-host-status"),
    *router.urls,
]
