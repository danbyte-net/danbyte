"""``GET /api/port-utilization/`` - the Port utilization page (#64, #535), a
page at a time.

Every device the caller may view that has a counted port, with its fill
level, read from the stored counts (``api.port_stats``): paged, searched,
sorted and counted in SQL with the list contract of ``api.list_table``.
Sorts: ``name``, ``site``, ``rack``, ``role``, ``type``, ``utilization``
(default, fullest first, then the name), ``used``, ``reserved``, ``free``.
Facets: ``site``, ``rack`` (ids), ``role``, ``type`` (names). Each row is
the roll-up's (``/api/devices/port-utilization/``): ``{id, name, site, rack,
role, device_type, total, connected, reserved, free, marked, pct}``.
``summary`` says whether the stored counts are complete yet and the basis
(``count_virtual``).
"""
from __future__ import annotations

from django.db.models import F
from rest_framework import serializers, viewsets
from rest_framework.permissions import IsAuthenticated

from auth_api.drf import RBACViewSetMixin, restrict_for_view

from . import list_summaries, port_stats
from .list_table import Facet, Sort, TableListMixin, TableSpec, fk, nat
from .models import Device
from .natural import natural
from .pagination import StandardResultsSetPagination
from .views import _get_active_tenant


def _count_virtual(request) -> bool:
    cached = getattr(request, "_pu_count_virtual", None)
    if cached is None:
        from core.effective_settings import port_count_virtual

        cached = bool(port_count_virtual(_get_active_tenant(request)))
        try:
            request._pu_count_virtual = cached
        except AttributeError:
            pass
    return cached


def _prepare(qs, request):
    return port_stats.annotate(qs, _count_virtual(request))


def _by(*keys) -> Sort:
    return Sort(keys, prepare=_prepare)


SPEC = TableSpec(
    facets={
        "site": fk("site", none_label="No site"),
        "rack": fk("rack", none_label="No rack"),
        "role": Facet(field="role__name", none_label="No role", blank=True),
        "type": Facet(field="device_type__name", none_label="No type", blank=True),
    },
    sorts={
        "name": nat("name"),
        "site": nat("site__name"),
        "rack": nat("rack__name"),
        "role": nat("role__name"),
        "type": nat("device_type__name"),
        "utilization": _by("pu_pct"),
        "used": _by("pu_used"),
        "reserved": _by("pu_reserved"),
        "free": _by("pu_free"),
    },
    expr_fields={
        "name": ("text", "name"),
        "site.name": ("text", "site__name"),
        "rack.name": ("text", "rack__name"),
        "role.name": ("text", "role__name"),
        "device_type": ("text", "device_type__name"),
        "total": ("number", "pu_total"),
        "connected": ("number", "pu_connected"),
        "reserved": ("number", "pu_reserved"),
        "free": ("number", "pu_free"),
        "marked": ("number", "pu_marked"),
        "pct": ("number", "pu_pct"),
    },
    expr_prepare=_prepare,
)


class _NoFields(serializers.Serializer):
    class Meta:
        fields = ()


class PortUtilizationViewSet(RBACViewSetMixin, TableListMixin, viewsets.GenericViewSet):
    rbac_object_type = "device"
    #: Read-only: whatever the action, the list reads.
    rbac_action_map = {"retrieve": "view", "partial_update": "view", "destroy": "view"}
    permission_classes = [IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    queryset = Device.objects.all()
    filter_backends: list = []
    table_spec = SPEC

    def get_serializer_class(self):
        return _NoFields

    def table_sortable(self) -> list[str]:
        return list(self.table_spec.sorts)

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return Device.objects.none()
        qs = restrict_for_view(self, Device.objects.filter(tenant=tenant))
        qs = _prepare(qs, self.request).filter(pu_total__gt=0)
        needle = (self.request.query_params.get("search") or "").strip()
        if needle:
            qs = qs.filter(name__icontains=needle[:200])
        return qs.order_by(F("pu_pct").desc(nulls_last=True), natural("name"), "pk")

    def _ensure(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return {"building": False, "updating": False}
        return list_summaries.ensure(port_stats.KIND, tenant)

    def list(self, request, *args, **kwargs):
        summary = self._ensure()
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs.select_related("site", "rack", "role", "device_type"))
        response = self.get_paginated_response([_row(d) for d in page or []])
        response.data["summary"] = {**summary, "count_virtual": _count_virtual(request)}
        return response

    def table_facets(self, request):
        self._ensure()
        return super().table_facets(request)

    def table_ids(self, request):
        self._ensure()
        return super().table_ids(request)


def _row(d) -> dict:
    return {
        "id": str(d.pk),
        "name": d.name,
        "site": {"id": str(d.site_id), "name": d.site.name} if d.site_id else None,
        "rack": {"id": str(d.rack_id), "name": d.rack.name} if d.rack_id else None,
        "role": {"name": d.role.name, "color": d.role.color} if d.role_id else None,
        "device_type": d.device_type.name if d.device_type_id else None,
        "total": d.pu_total,
        "connected": d.pu_connected,
        "reserved": d.pu_reserved,
        "free": d.pu_free,
        "marked": d.pu_marked,
        "pct": d.pu_pct,
    }
