"""Moving parts between devices, bays and the stock pool (docs/dcim/stock.md).

An :class:`~api.models.InventoryItem` has one home: a device (seated in a
port or loose on it) or a stock place (a site, maybe a location there).
These helpers move it, and turn a :class:`~api.models.Module` into a stock
item and back. A unit keeps its id across the module ↔ item change, so its
serial, asset tag, tags and change log (both object types share the id)
travel with it.

Callers (the API actions in ``api.viewsets``) check the reader's rights on
the row before and after; these helpers only keep the data true.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import ValidationError

from .models import (
    InventoryItem,
    Module,
    ModuleBay,
    Status,
    home_errors,
    install_module_report,
    transceiver_link_errors,
    uninstall_module,
)
from .status_registry import status_offered

#: The status a part takes by where it lands, by built-in slug - used when
#: the request names none and the tenant still has that status for
#: inventory items. ``None``: the type's default (``default_for``).
LANDING_STATUS = {"stock": "in_stock", "device": "spare", "port": None}


def item_status(tenant, slug: str | None):
    """The tenant's inventory-item status ``slug`` (or its default for
    inventory items when ``slug`` is None), or None."""
    qs = Status.objects.filter(tenant=tenant)
    if slug is None:
        return qs.filter(default_for__contains=["inventoryitem"]).first()
    return qs.filter(slug=slug, available_to__contains=["inventoryitem"]).first()


def module_status(tenant):
    """The tenant's default status for modules, or None."""
    return Status.objects.filter(tenant=tenant, default_for__contains=["module"]).first()


def check_status(status, model) -> None:
    if status is not None and not status_offered(status, model):
        raise ValidationError({"status_id": "This status isn't offered here."})


def free_name(device, name: str, exclude_pk=None) -> str:
    """``name``, or ``name 2``, ``name 3``… - the first the device's
    inventory doesn't use yet (names are unique per device)."""
    taken = set(InventoryItem.objects.filter(device=device).exclude(pk=exclude_pk)
                .values_list("name", flat=True))
    if name not in taken:
        return name
    n = 2
    while f"{name} {n}"[:128] in taken:
        n += 1
    return f"{name} {n}"[:128]


def _raise(errors: dict) -> None:
    if errors:
        raise ValidationError({f"{k}_id" if k in ("site", "location", "interface", "parent",
                                                  "accessory_type", "device") else k: v
                               for k, v in errors.items()})


@transaction.atomic
def move_item(item: InventoryItem, *, tenant, device=None, interface=None, site=None,
              location=None, status=None, keep_status: bool = False) -> InventoryItem:
    """Put ``item`` on ``device`` (in ``interface`` when given) or in stock
    at ``site``/``location``. Its sub-parts follow it; a sub-part seated in
    a port comes out of the port when the parent leaves the device. Without
    ``status`` the item takes the landing status (``LANDING_STATUS``) unless
    ``keep_status``."""
    if (device is None) == (site is None):
        raise ValidationError({"site_id": "Pick a device, or a site to keep it in stock."})
    if interface is not None and device is None:
        device = interface.device
    landing = "port" if interface is not None else ("device" if device is not None else "stock")
    if status is None and not keep_status:
        status = item_status(tenant, LANDING_STATUS[landing]) or item.status
    check_status(status, InventoryItem)
    moving_device = device is not None and device.pk != item.device_id
    item.device = device
    item.site = site
    item.location = location if device is None else None
    item.interface = interface
    if device is None or moving_device:
        # Off the device (or onto another): no parent there any more.
        item.parent = None
    if moving_device:
        item.name = free_name(device, item.name, exclude_pk=item.pk)
    if status is not None:
        item.status = status
    errors = home_errors(item)
    errors.update(transceiver_link_errors(item))
    _raise(errors)
    item.save()
    _follow(item)
    return item


def _follow(parent: InventoryItem) -> None:
    """Every sub-part of ``parent`` goes where it went."""
    for child in InventoryItem.objects.filter(parent=parent):
        if child.device_id == parent.device_id and child.site_id == parent.site_id \
                and child.location_id == parent.location_id:
            continue
        moving_device = parent.device_id is not None and child.device_id != parent.device_id
        child.device_id = parent.device_id
        child.site_id = parent.site_id
        child.location_id = parent.location_id
        if parent.device_id is None or moving_device:
            child.interface = None
        if moving_device:
            child.name = free_name(parent.device, child.name, exclude_pk=child.pk)
        child.save()
        _follow(child)


def _carried_custom_fields(tenant, values: dict, to_model: str) -> dict:
    """The custom-field values whose field also applies to ``to_model``."""
    if not values:
        return {}
    from customization.models import CustomField

    keys = set(CustomField.objects.filter(tenant=tenant, applies_to__contains=[to_model])
               .values_list("key", flat=True))
    return {k: v for k, v in values.items() if k in keys}


@transaction.atomic
def module_to_item(module: Module, *, tenant, device=None, site=None, location=None,
                   status=None) -> InventoryItem:
    """Take ``module`` out of its bay as an inventory item with the same id,
    module type, serial, asset tag, description and tags - in stock at
    ``site``/``location``, or loose on ``device`` (its own host when
    neither is given)."""
    if device is None and site is None:
        device = module.device
    if device is not None and site is not None:
        raise ValidationError({"site_id": "Pick a device, or a site to keep it in stock."})
    landing = "device" if device is not None else "stock"
    if status is None:
        status = item_status(tenant, LANDING_STATUS[landing])
    check_status(status, InventoryItem)
    mt = module.module_type
    tags = list(module.tags.all())
    item = InventoryItem(
        id=module.pk,
        device=device,
        site=site if device is None else None,
        location=location if device is None else None,
        name=free_name(device, mt.name[:128]) if device is not None else mt.name[:128],
        kind="module",
        module_type=mt,
        manufacturer_id=mt.manufacturer_id,
        part_id=(mt.part_number or "")[:128],
        serial_number=module.serial_number,
        asset_tag=module.asset_tag,
        description=module.description,
        status=status,
        custom_fields=_carried_custom_fields(tenant, module.custom_fields, "inventoryitem"),
    )
    _raise(home_errors(item))
    uninstall_module(module)
    module.delete()
    item.save()
    if tags:
        item.tags.set(tags)
    return item


@transaction.atomic
def item_to_module(item: InventoryItem, *, tenant, bay: ModuleBay, status=None,
                   adopt: bool = False):
    """Install the module ``item`` keeps in ``bay``: a module with the same
    id, module type, serial, asset tag, description and tags, its
    interfaces and power ports stamped as on any install. Returns
    ``(module, install report)``; raises ``ModuleInstallConflict`` as an
    install does (the caller turns it into a 400)."""
    if item.module_type_id is None:
        raise ValidationError({"module_bay_id": "This item is no module: it has no module type."})
    if item.children.exists():
        raise ValidationError({"module_bay_id": "Take its sub-parts out first."})
    if ModuleBay.objects.filter(pk=bay.pk, module__isnull=False).exists():
        raise ValidationError({"module_bay_id": "This bay already holds a module."})
    if item.module_type.tenant_id != tenant.pk or bay.device.tenant_id != tenant.pk:
        raise ValidationError({"module_bay_id": "Pick a bay in the current tenant."})
    if status is None:
        status = module_status(tenant)
    check_status(status, Module)
    tags = list(item.tags.all())
    module = Module(
        id=item.pk,
        device=bay.device,
        module_bay=bay,
        module_type=item.module_type,
        status=status,
        serial_number=item.serial_number,
        asset_tag=item.asset_tag,
        description=item.description,
        custom_fields=_carried_custom_fields(tenant, item.custom_fields, "module"),
    )
    item.delete()
    module.save()
    if tags:
        module.tags.set(tags)
    report = install_module_report(module, adopt=adopt)
    return module, report
