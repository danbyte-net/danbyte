"""Which rack units a device takes, and the rack-level checks that keep
devices inside their rack (#375, #376).

A device takes ``u_height`` units from its ``position`` up (a typeless or 0U
device parked at a position takes one). It takes them on its face only when
both it and the other device are shallow; a full-depth device - the
default, and what a typeless device is drawn as - takes both faces.

Concurrency, the way DIN rails do it (#310): a placement and a change to the
rack's units or site lock the rack row for their transaction, so the second
of two such writes reads what the first committed.
"""
from __future__ import annotations

from rest_framework.exceptions import ValidationError


def height(device_type) -> int:
    """Units a device of ``device_type`` takes at a position."""
    return (device_type.u_height if device_type else 1) or 1


def full_depth(device_type) -> bool:
    """Whether a device of ``device_type`` fills both faces of its units."""
    return device_type is None or bool(device_type.is_full_depth)


def lock_rack(rack):
    """``rack`` locked until the transaction ends, its units and site read
    fresh. Outside a transaction (a plain script) it returns ``rack`` as is."""
    from django.db import connection

    if rack is None or rack.pk is None or not connection.in_atomic_block:
        return rack
    fresh = (
        type(rack).objects.select_for_update().filter(pk=rack.pk)
        .values("u_height", "starting_unit", "site_id").first()
    )
    if fresh is None:
        raise ValidationError({"rack_id": "That rack is gone."})
    rack.u_height = fresh["u_height"]
    rack.starting_unit = fresh["starting_unit"]
    rack.site_id = fresh["site_id"]
    return rack


def devices_outside(rack, starting_unit: int, u_height: int) -> list:
    """The devices at a U position in ``rack`` that would not fit in units
    ``starting_unit`` .. ``starting_unit + u_height - 1``. Side-mounted
    strips have no position and never block."""
    top = starting_unit + u_height - 1
    return [
        d for d in rack.devices.select_related("device_type")
        .filter(position__isnull=False).order_by("position", "name")
        if d.position < starting_unit or d.position + height(d.device_type) - 1 > top
    ]


def check_units(rack, starting_unit: int, u_height: int, field: str = "u_height") -> None:
    """Refuse new units for ``rack`` that would leave a device outside them."""
    outside = devices_outside(rack, starting_unit, u_height)
    if not outside:
        return
    named = ", ".join(f"{d.name} at U{d.position}" for d in outside[:3])
    if len(outside) > 3:
        named += f" and {len(outside) - 3} more"
    top = starting_unit + u_height - 1
    raise ValidationError({field: (
        f"Devices are installed outside U{starting_unit}–U{top} ({named}). "
        "Move or remove them first."
    )})
