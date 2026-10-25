from rest_framework.routers import DefaultRouter

from .viewsets import PrtgConnectionViewSet

router = DefaultRouter()
router.register(r"connections", PrtgConnectionViewSet, basename="prtgconnection")

urlpatterns = router.urls
