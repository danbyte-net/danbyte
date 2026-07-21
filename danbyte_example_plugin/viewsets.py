from api.viewsets import TenantScopedViewSet

from .models import Widget
from .serializers import WidgetSerializer


class WidgetViewSet(TenantScopedViewSet):
    """Tenant-scoped, RBAC default-closed CRUD for Widgets.

    Reuses the core base so scoping + row-level RBAC come for free: the object
    type derives from the model name (``widget``), which the plugin registers
    via ``register_object_type`` (see ``danbyte_plugin``), so every action
    demands a ``widget.*`` grant — anonymous/ungranted callers get 403/empty.
    """

    queryset = Widget.objects.all()
    serializer_class = WidgetSerializer
