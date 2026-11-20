"""The stock pool's API actions (docs/dcim/stock.md), mixed into the
inventory-item and module viewsets.

* ``POST /api/inventory-items/<id>/move/`` - put an item in stock
  (``site_id``, ``location_id``) or on a device (``device_id``, and
  ``interface_id`` to seat a transceiver), with an optional ``status_id``.
* ``POST /api/inventory-items/<id>/install-module/`` - install a module kept
  in inventory into ``module_bay_id``: it becomes the module again, same id.
* ``POST /api/modules/<id>/remove/`` - take a module out of its bay as an
  inventory item, in stock (``site_id``, ``location_id``) or loose on a
  device (``device_id``).

Every id in a payload resolves inside the active tenant. The row is read
through the viewset's own queryset (the action's grant, site scope
included) and the result is checked again where it lands, inside the
transaction, so a site-scoped editor can neither take a part from nor put
one into a site outside their scope.
"""
from __future__ import annotations

from django.db import transaction
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import stock
from .models import (
    Device,
    Interface,
    InventoryItem,
    Location,
    Module,
    ModuleBay,
    ModuleInstallConflict,
    Site,
    Status,
)
from .serializers import TenantScopedPrimaryKeyRelatedField


def _fk(model, source):
    return TenantScopedPrimaryKeyRelatedField(
        source=source, queryset=model.objects.all(), required=False, allow_null=True)


class StockPlaceSerializer(serializers.Serializer):
    """Where a part goes: a device (and port), or a site and location."""

    device_id = _fk(Device, "device")
    interface_id = _fk(Interface, "interface")
    site_id = _fk(Site, "site")
    location_id = _fk(Location, "location")
    status_id = _fk(Status, "status")

    def validate(self, attrs):
        device, iface, site = attrs.get("device"), attrs.get("interface"), attrs.get("site")
        if iface is not None and device is None:
            attrs["device"] = device = iface.device
        if (device is None) == (site is None):
            raise ValidationError({"site_id": "Pick a device, or a site to keep it in stock."})
        loc = attrs.get("location")
        if loc is not None and (site is None or loc.site_id != site.pk):
            raise ValidationError({"location_id": "Pick a location at this site."})
        return attrs


class InstallModuleSerializer(serializers.Serializer):
    module_bay_id = TenantScopedPrimaryKeyRelatedField(
        source="module_bay", queryset=ModuleBay.objects.all())
    status_id = _fk(Status, "status")
    adopt_components = serializers.BooleanField(required=False, default=False)


def assert_lands_in_scope(request, tenant, model, pk, slug: str, action: str) -> None:
    """403 unless the reader may ``action`` the row ``pk`` as it is now -
    the post-write guard of ``TenantScopedViewSet``, for these actions."""
    from auth_api import rbac

    user = request.user
    if user.is_superuser:
        return
    base = model._default_manager.filter(pk=pk)
    if not rbac.restrict_queryset(base, user, tenant, slug, action).exists():
        raise PermissionDenied("The part would land outside your permission scope.")


class InventoryMoveMixin:
    """``move`` and ``install-module`` on the inventory-item viewset."""

    @extend_schema(summary="Move an inventory item to stock or onto a device",
                   request=StockPlaceSerializer)
    @action(detail=True, methods=["post"], url_path="move")
    def move(self, request, pk=None):
        item = self.get_object()
        tenant = self._tenant_or_403()
        ser = StockPlaceSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        with transaction.atomic():
            stock.move_item(item, tenant=tenant, device=d.get("device"),
                            interface=d.get("interface"), site=d.get("site"),
                            location=d.get("location"), status=d.get("status"))
            assert_lands_in_scope(request, tenant, InventoryItem, item.pk, "inventoryitem",
                                  "change")
        fresh = self.get_queryset().model.objects.select_related(
            "device__site", "site", "location", "status", "interface", "manufacturer",
            "module_type").get(pk=item.pk)
        return Response(self.get_serializer(fresh).data)

    @extend_schema(summary="Install a module kept in inventory into a bay",
                   request=InstallModuleSerializer)
    @action(detail=True, methods=["post"], url_path="install-module")
    def install_module(self, request, pk=None):
        from .serializers import ModuleSerializer

        item = self.get_object()
        tenant = self._tenant_or_403()
        ser = InstallModuleSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        bay = ser.validated_data["module_bay"]
        if item.module_type_id is None:
            raise ValidationError({"module_bay_id": "This item is no module: it has no "
                                   "module type."})
        status = ser.validated_data.get("status")
        # The install's own rules (bay on its device, bay free, the rack's
        # cooling) - as a new module would be checked.
        check = ModuleSerializer(data={
            "device_id": str(bay.device_id), "module_bay_id": str(bay.pk),
            "module_type_id": str(item.module_type_id),
            **({"status_id": str(status.pk)} if status else {}),
        }, context=self.get_serializer_context())
        check.is_valid(raise_exception=True)
        with transaction.atomic():
            try:
                module, report = stock.item_to_module(
                    item, tenant=tenant, bay=bay, status=check.validated_data.get("status"),
                    adopt=ser.validated_data["adopt_components"])
            except ModuleInstallConflict as exc:
                detail = {"module_type_id": str(exc)}
                if exc.adoptable:
                    detail["adoptable"] = exc.adoptable
                raise ValidationError(detail) from exc
            assert_lands_in_scope(request, tenant, Module, module.pk, "module", "add")
        data = dict(ModuleSerializer(module, context=self.get_serializer_context()).data)
        data["created_interfaces"] = report["created"]["interfaces"]
        data["created_power_ports"] = report["created"]["power_ports"]
        data["adopted"] = report["adopted"]
        return Response(data, status=drf_status.HTTP_201_CREATED)


class ModuleRemoveMixin:
    """``remove`` on the module viewset: out of the bay, into inventory."""

    @extend_schema(summary="Take a module out of its bay into inventory",
                   request=StockPlaceSerializer)
    @action(detail=True, methods=["post"], url_path="remove")
    def remove(self, request, pk=None):
        from .serializers import InventoryItemSerializer

        module = self.get_object()
        tenant = self._tenant_or_403()
        ser = StockPlaceSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        if d.get("interface") is not None:
            raise ValidationError({"interface_id": "A module sits in no port."})
        with transaction.atomic():
            item = stock.module_to_item(module, tenant=tenant, device=d.get("device"),
                                        site=d.get("site"), location=d.get("location"),
                                        status=d.get("status"))
            assert_lands_in_scope(request, tenant, InventoryItem, item.pk, "inventoryitem",
                                  "add")
        return Response(InventoryItemSerializer(item, context=self.get_serializer_context()).data,
                        status=drf_status.HTTP_201_CREATED)
