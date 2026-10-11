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


# ── a device type's change against its racked devices (#390) ────────────────
#
# Lock order, the way DIN types and rails take it (#310): a type change locks
# the type, then the racks its devices are in, in id order; a placement shares
# the type's lock, then locks its rack. Neither holds what the other takes
# first while it waits.


def share_type(device_type):
    """``device_type`` under a share lock until the transaction ends, its
    rack size read fresh: placements of one type run side by side, while a
    change to its size waits for them (and they for it). Outside a
    transaction it returns ``device_type`` as is."""
    from django.db import connection

    if device_type is None or device_type.pk is None or not connection.in_atomic_block:
        return device_type
    table = connection.ops.quote_name(type(device_type)._meta.db_table)
    with connection.cursor() as cur:
        cur.execute(f"SELECT 1 FROM {table} WHERE id = %s FOR SHARE", [device_type.pk])
    fresh = (
        type(device_type).objects.filter(pk=device_type.pk)
        .values("u_height", "is_full_depth", "rack_width").first()
    )
    for f, v in (fresh or {}).items():
        setattr(device_type, f, v)
    return device_type


def _dims(u_height, is_full_depth, rack_width) -> tuple:
    return ((u_height or 1), bool(is_full_depth), (rack_width or "full"))


def _type_dims(device_type) -> tuple:
    if device_type is None:
        return _dims(1, True, "full")
    return _dims(device_type.u_height, device_type.is_full_depth, device_type.rack_width)


def _footprint(device, dims) -> tuple:
    """``(position, height, face, full depth, width, side)`` of a racked
    device whose type has ``dims``."""
    h, full, width = dims
    side = (device.rack_side or "") if width == "half" else ""
    return (device.position, h, device.face or "", full, width, side)


def _clash(a, b) -> bool:
    """Whether two footprints take a common unit, as a placement judges it:
    opposite faces share only when both are shallow, and two half-width
    devices share on opposite sides."""
    pa, ha, fa, full_a, wa, sa = a
    pb, hb, fb, full_b, wb, sb = b
    if not (pa < pb + hb and pb < pa + ha):
        return False
    if fa and fb and fa != fb and not (full_a or full_b):
        return False
    if wa == "half" and wb == "half" and sa and sb and sa != sb:
        return False
    return True


def check_type_change(device_type, u_height, is_full_depth, rack_width) -> None:
    """Refuse a new height, depth or width for ``device_type`` that would put
    one of its racked devices past the top of its rack or over another
    device, or give its side-mounted strips a U height. Only conflicts the
    change makes count: rows stored conflicting before the rules do not
    block it. In a transaction it locks the type, then the racks its devices
    are in, so a device being placed meanwhile is seen."""
    from django.db import connection

    from .models import Device, Rack

    locking = connection.in_atomic_block and device_type.pk is not None
    stored = {
        "u_height": device_type.u_height, "is_full_depth": device_type.is_full_depth,
        "rack_width": device_type.rack_width,
    }
    if locking:
        fresh = (
            type(device_type).objects.select_for_update().filter(pk=device_type.pk)
            .values("u_height", "is_full_depth", "rack_width").first()
        )
        stored = fresh or stored
    old = _dims(stored["u_height"], stored["is_full_depth"], stored["rack_width"])
    new = _dims(u_height, is_full_depth, rack_width)
    changed = [f for f, before, after in (
        ("u_height", stored["u_height"] or 0, u_height or 0),
        ("is_full_depth", bool(stored["is_full_depth"]), bool(is_full_depth)),
        ("rack_width", stored["rack_width"] or "full", rack_width or "full"),
    ) if before != after]
    if not changed:
        return

    def load():
        return list(
            Device.objects.filter(device_type_id=device_type.pk, rack__isnull=False)
            .select_related("rack").order_by("rack__name", "position", "name")
        )

    mine = load()
    if not mine:
        return
    if locking:
        list(Rack.objects.select_for_update()
             .filter(pk__in={d.rack_id for d in mine}).order_by("pk"))
        mine = load()  # the devices as the rack locks found them

    problems: list[str] = []
    field = changed[0]
    if not stored["u_height"] and u_height:
        strips = [d for d in mine if d.mount]
        if strips:
            field = "u_height"
            problems += [f"{d.name} in {d.rack.name} is side-mounted" for d in strips]

    placed = [d for d in mine if d.position is not None]
    in_rack: dict = {}
    for d in placed:
        if d.rack_id not in in_rack:
            in_rack[d.rack_id] = list(
                Device.objects.filter(rack_id=d.rack_id, position__isnull=False)
                .select_related("device_type").order_by("position", "name")
            )

    def dims(dev, when):
        return when if dev.device_type_id == device_type.pk else _type_dims(dev.device_type)

    seen: set = set()
    for d in placed:
        rack = d.rack
        top = rack.starting_unit + rack.u_height - 1
        where = f"{d.name} at U{d.position} in {rack.name}"
        if d.position + new[0] - 1 > top >= d.position + old[0] - 1:
            problems.append(f"{where} would run past U{top}")
        for o in in_rack[d.rack_id]:
            pair = frozenset((d.pk, o.pk))
            if o.pk == d.pk or pair in seen:
                continue
            seen.add(pair)
            now = _clash(_footprint(d, new), _footprint(o, dims(o, new)))
            before = _clash(_footprint(d, old), _footprint(o, dims(o, old)))
            if now and not before:
                problems.append(f"{where} would overlap {o.name}")
    if not problems:
        return
    named = "; ".join(problems[:3])
    if len(problems) > 3:
        named += f" and {len(problems) - 3} more"
    raise ValidationError({field: (
        f"Racked devices of this type would no longer fit: {named}. Move them first."
    )})
