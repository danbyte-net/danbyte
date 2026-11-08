"""Cooling placement (#434): which hardware a rack's cooling can take.

A device type (and a device, as an override) records how the hardware is
cooled - air, liquid, hybrid or immersion - and a rack records what its
cooling can take. Air-cooled hardware - a method of air, or none - goes in
any rack: switches, PDUs and patch panels sit in liquid racks and immersion
tanks. A liquid, hybrid or immersion device whose method the rack's
capability does not admit is refused when it is placed, re-typed or
re-marked (``DeviceSerializer.validate``, and so the spreadsheet import,
which saves through it). A rack whose capability is made stricter keeps its
devices: the rack page lists them under *Mismatched cooling*
(``?cooling_mismatch=1`` on the device list), and nothing is re-judged on
read.

Hardware that sits in a rack through another device is judged by that rack
too (#469): a device in a device bay with no rack of its own (a blade) by
the rack of the device whose bay holds it, and an installed module by its
device's rack, on its module type's method - one bay level, as a blade
chassis is racked. A device with a rack of its own is judged and counted
there only. A bay install, a module install and a parent moved into a rack
are refused like a direct placement (``placement_error``,
``module_placement_error``, ``contents_error``); a mismatched module counts
its device as mismatched.

The rule lives here once, in Python for a write and as SQL for a list. Heat
load against a rack's cooling capacity is ``api.capacity.rack_cooling``.
"""
from __future__ import annotations

from django.db.models import BooleanField, Case, Exists, F, OuterRef, Q, Value, When
from django.db.models.functions import Coalesce, NullIf

from .dcim_choices import COOLING_ADMITS, COOLING_DEFAULT, COOLING_METHOD_CHOICES

#: Every cooling method this build knows.
METHODS = tuple(value for value, _label in COOLING_METHOD_CHOICES)


def admits(capability: str, method: str) -> bool:
    """Whether a rack of ``capability`` takes hardware cooled by ``method``.
    Air-cooled hardware goes in any rack, and a rack with no capability
    (blank) - or one this build does not know - takes anything: there is
    nothing to check against. Liquid, hybrid and immersion hardware go where
    ``COOLING_ADMITS`` lets them."""
    if method == COOLING_DEFAULT:
        return True
    allowed = COOLING_ADMITS.get(capability or "")
    return allowed is None or method in allowed


def effective_method(own: str, device_type) -> str:
    """A device's cooling method: its own, else its type's, else air."""
    return own or (device_type.cooling_method if device_type else "") or COOLING_DEFAULT


def placement_error(rack, device_type, own: str = "") -> str | None:
    """Why a device of ``device_type`` with its own method ``own`` may not
    sit in ``rack``, or None when the rack takes it - always None for
    air-cooled hardware (``admits``)."""
    method = effective_method(own, device_type)
    if admits(rack.cooling_capability, method):
        return None
    from_type = not own and bool(device_type and device_type.cooling_method)
    subject = "this device type" if from_type else "this device"
    return (f"Rack {rack.name} is {rack.cooling_capability}-cooled; "
            f"{subject} is {method}-cooled.")


def refused(capability: str) -> list[str]:
    """The cooling methods a rack of ``capability`` does not take - empty for
    a rack without one, or one this build does not know (``admits``)."""
    return [m for m in METHODS if not admits(capability, m)]


def cooling_rack(device):
    """The rack whose cooling serves ``device`` (#469): its own, else the rack
    of the device whose bay holds it; None for neither."""
    if device.rack_id is not None:
        return device.rack
    return chassis_rack(device)


def chassis_rack(device):
    """The rack of the device whose bay holds ``device``, or None."""
    if device._state.adding:
        return None
    from .models import DeviceBay

    bay = (
        DeviceBay.objects.filter(installed_device=device)
        .select_related("device__rack").first()
    )
    return bay.device.rack if bay is not None else None


def module_placement_error(rack, module_type) -> str | None:
    """Why a module of ``module_type`` may not be installed in a device that
    ``rack`` cools (#469), or None - always None for an air-cooled (or
    blank) module type and for no rack."""
    if rack is None:
        return None
    method = (module_type.cooling_method if module_type else "") or COOLING_DEFAULT
    if admits(rack.cooling_capability, method):
        return None
    return (f"Rack {rack.name} is {rack.cooling_capability}-cooled; "
            f"this module type is {method}-cooled.")


def _module_error(rack, bad, **where) -> str | None:
    from .models import Module

    m = (
        Module.objects.filter(module_type__cooling_method__in=bad, **where)
        .select_related("device", "module_bay", "module_type")
        .order_by("device__name", "module_bay__name").first()
    )
    if m is None:
        return None
    return (f"Rack {rack.name} is {rack.cooling_capability}-cooled; module "
            f"{m.module_type.name} in {m.device.name}:{m.module_bay.name} is "
            f"{m.module_type.cooling_method}-cooled.")


def installed_error(rack, device) -> str | None:
    """Why ``device`` - with the modules installed in it - may not sit in a
    bay of a device ``rack`` cools (#469), or None. Its own method first, in
    ``placement_error``'s words, then its modules."""
    if rack is None:
        return None
    message = placement_error(rack, device.device_type, device.cooling_method)
    if message:
        return message
    bad = refused(rack.cooling_capability)
    if not bad or device._state.adding:
        return None
    return _module_error(rack, bad, device=device)


def contents_error(rack, device) -> str | None:
    """Why what ``device`` carries may not come into ``rack`` with it (#469):
    a module installed in it, a device in one of its bays with no rack of its
    own, or such a device's module. None when the rack takes all of it, and
    for a device not saved yet (it carries nothing)."""
    bad = refused(rack.cooling_capability) if rack is not None else []
    if not bad or device._state.adding:
        return None
    from .models import Device

    message = _module_error(rack, bad, device=device)
    if message:
        return message
    children = Device.objects.filter(parent_bay__device=device, rack__isnull=True)
    child = (
        children.annotate(cooling_effective=effective_method_sql())
        .filter(cooling_effective__in=bad)
        .select_related("parent_bay").order_by("name").first()
    )
    if child is not None:
        return (f"Rack {rack.name} is {rack.cooling_capability}-cooled; "
                f"{child.name} in bay {child.parent_bay.name} is "
                f"{child.cooling_effective}-cooled.")
    return _module_error(rack, bad, device__in=children)


def mismatched(capability: str, device) -> bool:
    """Whether a rack of ``capability`` does not take ``device`` or a module
    installed in it (#469) - ``mismatch_sql`` in Python. Reads the
    ``module_cooling`` annotation (``module_methods_sql``) where a caller
    loaded it, else asks the database."""
    if not capability:
        return False
    if not admits(capability, device.effective_cooling_method):
        return True
    methods = getattr(device, "module_cooling", None)
    if methods is None:
        methods = device.modules.values_list("module_type__cooling_method", flat=True)
    return any(not admits(capability, m or COOLING_DEFAULT) for m in methods)


def module_methods_sql():
    """The cooling methods of the modules installed in each device of a
    queryset, air and blank left out - an array, read by ``mismatched``."""
    from django.contrib.postgres.expressions import ArraySubquery

    from .models import Module

    return ArraySubquery(
        Module.objects.filter(device=OuterRef("pk"))
        .exclude(module_type__cooling_method__in=["", COOLING_DEFAULT])
        .order_by().values("module_type__cooling_method")
    )


def effective_method_sql(prefix: str = ""):
    """``effective_method`` as SQL, for a queryset of devices (``prefix``
    reaches the device from another model: ``"device__"``). Blank stored
    values fall through, as they do in Python."""
    return Coalesce(
        NullIf(F(f"{prefix}cooling_method"), Value("")),
        NullIf(F(f"{prefix}device_type__cooling_method"), Value("")),
        Value(COOLING_DEFAULT),
    )


def rack_capability_sql():
    """The capability of the rack whose cooling serves each device of a
    queryset (``cooling_rack``): its own rack's, else the rack's of the
    device whose bay holds it; NULL for neither."""
    from django.db.models import CharField

    return Case(
        When(rack__isnull=False, then=F("rack__cooling_capability")),
        default=F("parent_bay__device__rack__cooling_capability"),
        output_field=CharField(),
    )


def mismatch_sql():
    """True for a device whose rack (``rack_capability_sql``: its own, else
    its bay parent's) does not admit its effective method, or the method of
    a module installed in it (``admits``); False for every other device -
    air-cooled ones and unracked ones included. Reads the
    ``cooling_effective`` and ``cooling_capability_here`` annotations
    (``annotate_devices``)."""
    from .models import Module

    whens = []
    for capability in COOLING_ADMITS:
        bad = refused(capability)
        if not bad:
            continue
        module_bad = Exists(
            Module.objects.filter(device=OuterRef("pk"), module_type__cooling_method__in=bad)
        )
        whens.append(When(
            Q(cooling_capability_here=capability)
            & (Q(cooling_effective__in=bad) | module_bad),
            then=Value(True),
        ))
    return Case(*whens, default=Value(False), output_field=BooleanField())


def annotate_devices(qs):
    """``cooling_effective`` and ``cooling_mismatch`` on a device queryset -
    what the device list filters by, computed in the query (no query per
    row)."""
    return qs.annotate(
        cooling_effective=effective_method_sql(),
        cooling_capability_here=rack_capability_sql(),
    ).annotate(cooling_mismatch=mismatch_sql())


def unconnected_q():
    """Liquid, hybrid or immersion devices with no cooling intake connected
    to a feed or an outflow (``?cooling_unconnected=1``). Reads the
    ``cooling_effective`` annotation (``annotate_devices``)."""
    from .models import CoolingIntake

    connected = CoolingIntake.objects.filter(device=OuterRef("pk")).filter(
        Q(cooling_feed__isnull=False) | Q(outflow__isnull=False)
    )
    return ~Q(cooling_effective=COOLING_DEFAULT) & ~Exists(connected)
