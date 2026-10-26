from django.urls import path
from rest_framework.routers import DefaultRouter

from .hook import PrtgHookView
from .pins_api import PrtgSensorPinViewSet
from .viewsets import (
    PrtgAdoptionRuleViewSet,
    PrtgChangeViewSet,
    PrtgConnectionViewSet,
    PrtgDeviceLinkViewSet,
    PrtgDeviceStatesView,
    PrtgDeviceStatusView,
    PrtgSensorViewSet,
    PrtgVmStatesView,
)

router = DefaultRouter()
router.register(r"connections", PrtgConnectionViewSet, basename="prtgconnection")
router.register(r"links", PrtgDeviceLinkViewSet, basename="prtgdevicelink")
router.register(r"sensors", PrtgSensorViewSet, basename="prtgsensor")
router.register(r"changes", PrtgChangeViewSet, basename="prtgchange")
router.register(r"adoption-rules", PrtgAdoptionRuleViewSet, basename="prtgadoptionrule")
router.register(r"sensor-pins", PrtgSensorPinViewSet, basename="prtgsensorpin")

urlpatterns = [
    path("device-status/", PrtgDeviceStatusView.as_view(), name="prtg-device-status"),
    path("device-states/", PrtgDeviceStatesView.as_view(), name="prtg-device-states"),
    path("vm-states/", PrtgVmStatesView.as_view(), name="prtg-vm-states"),
    path("hook/<str:token>/", PrtgHookView.as_view(), name="prtg-hook"),
    *router.urls,
]
