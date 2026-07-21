"""Example plugin API — mounted at ``/api/plugins/example/`` by the framework."""
from rest_framework.routers import DefaultRouter

from .viewsets import WidgetViewSet

router = DefaultRouter()
router.register(r"widgets", WidgetViewSet, basename="example-widget")

urlpatterns = router.urls
