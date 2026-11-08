"""Device profile routes, mounted at the top of ``/api/``."""
from rest_framework.routers import SimpleRouter

from .api import DeviceProfileAssignmentViewSet, DeviceProfileViewSet

router = SimpleRouter()
router.register(r"device-profiles", DeviceProfileViewSet, basename="device-profile")
router.register(r"device-profile-assignments", DeviceProfileAssignmentViewSet,
                basename="device-profile-assignment")

urlpatterns = router.urls
