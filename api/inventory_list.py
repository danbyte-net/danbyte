"""The Inventory page (docs/dcim/stock.md): every part the tenant has, in one
list - transceivers in ports, modules in bays, parts loose on devices, and
the stock pool at sites and locations.

``GET /api/inventory/`` reads the ``api_inventory_entry`` view
(``api.inventory_view``) with the shared table list (``api.list_table``):
``view=table``, ``f_<facet>``, ``ordering``, ``page``/``page_size``,
``search``. ``GET /api/inventory/facets/`` is the rail and
``/api/inventory/table-ids/`` every matching id.
``GET /api/inventory/counts/`` groups the same rows by part, manufacturer,
kind, site and location - how many of each there are where.

Each source is cut to what the reader may view through its own type's
grant: items by ``inventoryitem``, installed modules by ``module`` (row
constraints and site scope included, ``rbac.restrict_queryset``). A type
the reader may not view is left out, not refused.
"""
from __future__ import annotations

from django.db.models import Count, F, Q, Value
from django.db.models.functions import Coalesce, NullIf
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated

from auth_api import rbac

from .list_table import TableListMixin, TableSpec, by, fk, nat, value
from .models import INVENTORY_ITEM_KINDS, InventoryEntry, InventoryItem, Module
from .natural import natural
from .pagination import StandardResultsSetPagination
from .views import _get_active_tenant

HOME_LABELS = {"port": "In a port", "bay": "In a bay", "device": "On a device",
               "stock": "In stock"}
KIND_LABELS = dict(INVENTORY_ITEM_KINDS)


def scoped(request, tenant):
    """The tenant's rows the reader may see, by each source's own grant."""
    user = request.user
    allowed = Q(pk__in=[])
    for source, model, slug, tenant_q in (
        ("item", InventoryItem, "inventoryitem",
         Q(device__tenant=tenant) | Q(device__isnull=True, site__tenant=tenant)),
        ("module", Module, "module", Q(device__tenant=tenant)),
    ):
        if not rbac.has_action(user, tenant, slug, "view"):
            continue
        rows = rbac.restrict_queryset(model.objects.filter(tenant_q), user, tenant, slug,
                                      "view")
        allowed |= Q(source=source, pk__in=rows.values("pk"))
    return InventoryEntry.objects.filter(tenant=tenant).filter(allowed)


def _part(qs, request=None):
    """``inv_part``: the part number, else the name - what counts group by."""
    return qs.annotate(inv_part=Coalesce(NullIf(F("part_id"), Value("")), F("name")))


SPEC = TableSpec(
    facets={
        "home": value("home", labels=HOME_LABELS),
        "kind": value("kind", labels=KIND_LABELS),
        "status": fk("status", color="color", none_label="No status", text=True),
        "site": fk("site", none_label="No site"),
        "location": fk("location", none_label="No location"),
        "manufacturer": fk("manufacturer", none_label="No manufacturer"),
        "device": fk("device", none_label="In stock"),
        "module_type": fk("module_type", none_label="No module type"),
    },
    sorts={
        "name": nat("name"),
        "part_id": nat("part_id"),
        "serial_number": nat("serial_number"),
        "asset_tag": nat("asset_tag"),
        "kind": by("kind"),
        "home": by("home"),
        "status": nat("status__name"),
        "site": nat("site__name"),
        "location": nat("location__name"),
        "device": nat("device__name"),
        "place": nat("device__name"),
        "manufacturer": nat("manufacturer__name"),
        "module_type": nat("module_type__name"),
        "description": nat("description"),
        "updated": by("updated_at"),
        "created": by("created_at"),
    },
    expr_fields={
        "name": ("text", "name"),
        "part_id": ("text", "part_id"),
        "serial_number": ("text", "serial_number"),
        "asset_tag": ("text", "asset_tag"),
        "kind": ("text", "kind"),
        "home": ("text", "home"),
        "description": ("text", "description"),
        "status.name": ("text", "status__name"),
        "site.name": ("text", "site__name"),
        "location.name": ("text", "location__name"),
        "device.name": ("text", "device__name"),
        "manufacturer.name": ("text", "manufacturer__name"),
    },
)


class _NoFields(serializers.Serializer):
    class Meta:
        fields = ()


def _ref(obj):
    return {"id": str(obj.pk), "name": obj.name} if obj is not None else None


def row(e) -> dict:
    """One entry as the page reads it."""
    st = e.status if e.status_id else None
    return {
        "id": str(e.pk),
        "source": e.source,
        "home": e.home,
        "name": e.name,
        "kind": e.kind,
        "part_id": e.part_id,
        "serial_number": e.serial_number,
        "asset_tag": e.asset_tag,
        "description": e.description,
        "status": ({"id": str(st.pk), "name": st.name, "slug": st.slug, "color": st.color,
                    "text_color": st.text_color} if st else None),
        "manufacturer": _ref(e.manufacturer if e.manufacturer_id else None),
        "site": _ref(e.site if e.site_id else None),
        "location": _ref(e.location if e.location_id else None),
        "device": _ref(e.device if e.device_id else None),
        "interface": _ref(e.interface if e.interface_id else None),
        "module_bay": _ref(e.module_bay if e.module_bay_id else None),
        "module_type": _ref(e.module_type if e.module_type_id else None),
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "updated_at": e.updated_at.isoformat() if e.updated_at else None,
    }


RELATED = ("status", "manufacturer", "site", "location", "device", "interface", "module_bay",
           "module_type")


def search(qs, needle: str):
    needle = needle[:200]
    return qs.filter(Q(name__icontains=needle) | Q(part_id__icontains=needle)
                     | Q(serial_number__icontains=needle) | Q(asset_tag__icontains=needle)
                     | Q(device__name__icontains=needle) | Q(description__icontains=needle))


class InventoryViewSet(TableListMixin, viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    queryset = InventoryEntry.objects.all()
    filter_backends: list = []
    table_spec = SPEC

    def get_serializer_class(self):
        return _NoFields

    def table_sortable(self) -> list[str]:
        return list(self.table_spec.sorts)

    def _tenant(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant.")
        return tenant

    def get_queryset(self):
        request = self.request
        qs = scoped(request, self._tenant()).select_related(*RELATED)
        needle = (request.query_params.get("search") or "").strip()
        if needle:
            qs = search(qs, needle)
        return qs.order_by(natural("name"), "pk")

    @extend_schema(summary="The tenant's inventory: items and installed modules",
                   responses={200: OpenApiTypes.OBJECT})
    def list(self, request, *args, **kwargs):
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs)
        return self.get_paginated_response([row(e) for e in page or []])

    @extend_schema(summary="Inventory counts per part, manufacturer, kind, site and location",
                   responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["get"], url_path="counts")
    def counts(self, request):
        qs = self.apply_table_filters(self.get_queryset())
        grouped = (_part(qs).order_by()
                   .values("inv_part", "kind", "manufacturer_id", "manufacturer__name",
                           "site_id", "site__name", "location_id", "location__name")
                   .annotate(count=Count("pk"))
                   .order_by(natural("inv_part"), natural("site__name"),
                             natural("location__name"), "kind", "manufacturer_id",
                             "site_id", "location_id"))
        page = self.paginate_queryset(grouped)

        def ref(r, f):
            return ({"id": str(r[f"{f}_id"]), "name": r[f"{f}__name"]}
                    if r[f"{f}_id"] else None)

        return self.get_paginated_response([
            {"part": r["inv_part"], "kind": r["kind"], "manufacturer": ref(r, "manufacturer"),
             "site": ref(r, "site"), "location": ref(r, "location"), "count": r["count"]}
            for r in page or []
        ])
