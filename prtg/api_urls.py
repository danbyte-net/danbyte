from django.urls import path
from rest_framework.routers import DefaultRouter

from .hook import PrtgHookView
from .pins_api import PrtgSensorPinViewSet
from .registration_api import (
    PrtgGroupsView,
    PrtgPlanView,
    PrtgPolicyViewSet,
    PrtgSensorProfileViewSet,
)
from .viewsets import (
    PrtgAdoptionRuleViewSet,
    PrtgChangeViewSet,
    PrtgConnectionViewSet,
    PrtgDeviceLinkViewSet,
    PrtgDeviceStatesView,
    PrtgDeviceStatusView,
    PrtgRetireRuleViewSet,
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
router.register(r"policies", PrtgPolicyViewSet, basename="prtgpolicy")
router.register(r"retire-rules", PrtgRetireRuleViewSet, basename="prtgretirerule")
router.register(r"profiles", PrtgSensorProfileViewSet, basename="prtgsensorprofile")

urlpatterns = [
    path("device-status/", PrtgDeviceStatusView.as_view(), name="prtg-device-status"),
    path("device-states/", PrtgDeviceStatesView.as_view(), name="prtg-device-states"),
    path("vm-states/", PrtgVmStatesView.as_view(), name="prtg-vm-states"),
    path("groups/", PrtgGroupsView.as_view(), name="prtg-groups"),
    path("plan/", PrtgPlanView.as_view(), name="prtg-plan"),
    path("hook/<str:token>/", PrtgHookView.as_view(), name="prtg-hook"),
    *router.urls,
]
