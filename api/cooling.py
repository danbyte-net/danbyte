"""Cooling placement (#434): which hardware a rack's cooling can take.

A device type (and a device, as an override) records how the hardware is
cooled - air, liquid, hybrid or immersion - and a rack records what its
cooling can take. A device whose effective method the rack's capability does
not admit is refused when it is placed, re-typed or re-marked
(``DeviceSerializer.validate``, and so the spreadsheet import, which saves
through it). A rack whose capability is made stricter keeps its devices: the
rack page lists them under *Mismatched cooling* (``?cooling_mismatch=1`` on
the device list), and nothing is re-judged on read.

The rule lives here once, in Python for a write and as SQL for a list. Heat
load against a rack's cooling capacity is ``api.capacity.rack_cooling``.
"""
from __future__ import annotations

from django.db.models import BooleanField, Case, F, Q, Value, When
from django.db.models.functions import Coalesce, NullIf

from .dcim_choices import COOLING_ADMITS, COOLING_DEFAULT


def admits(capability: str, method: str) -> bool:
    """Whether a rack of ``capability`` takes hardware cooled by ``method``.
    A rack with no capability (blank) - or one this build does not know -
    takes anything: there is nothing to check against."""
    allowed = COOLING_ADMITS.get(capability or "")
    return allowed is None or method in allowed


def effective_method(own: str, device_type) -> str:
    """A device's cooling method: its own, else its type's, else air."""
    return own or (device_type.cooling_method if device_type else "") or COOLING_DEFAULT


def placement_error(rack, device_type, own: str = "") -> str | None:
    """Why a device of ``device_type`` with its own method ``own`` may not
    sit in ``rack``, or None when the rack takes it."""
    method = effective_method(own, device_type)
    if admits(rack.cooling_capability, method):
        return None
    from_type = not own and bool(device_type and device_type.cooling_method)
    subject = "this device type" if from_type else "this device"
    return (f"Rack {rack.name} is {rack.cooling_capability}-cooled; "
            f"{subject} is {method}-cooled.")


def effective_method_sql(prefix: str = ""):
    """``effective_method`` as SQL, for a queryset of devices (``prefix``
    reaches the device from another model: ``"device__"``). Blank stored
    values fall through, as they do in Python."""
    return Coalesce(
        NullIf(F(f"{prefix}cooling_method"), Value("")),
        NullIf(F(f"{prefix}device_type__cooling_method"), Value("")),
        Value(COOLING_DEFAULT),
    )


def mismatch_sql():
    """True for a device in a rack whose capability does not admit its
    effective method; False for every other device, unracked ones included.
    Reads the ``cooling_effective`` annotation (``annotate_devices``)."""
    return Case(
        *(
            When(
                Q(rack__cooling_capability=capability)
                & ~Q(cooling_effective__in=sorted(allowed)),
                then=Value(True),
            )
            for capability, allowed in COOLING_ADMITS.items()
        ),
        default=Value(False),
        output_field=BooleanField(),
    )


def annotate_devices(qs):
    """``cooling_effective`` and ``cooling_mismatch`` on a device queryset -
    what the device list filters by, computed in the query (no query per
    row)."""
    return qs.annotate(cooling_effective=effective_method_sql()).annotate(
        cooling_mismatch=mismatch_sql()
    )
