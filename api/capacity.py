"""Rack capacity - space, power and ports - one rule each.

The rack page, the floor plan's live overlay and the rack's Rack view (#248)
read their figures from here, so a rack reports the same numbers everywhere.
Space and power read the rack's ``devices`` (and ``power_feeds``) through
``.all()``: a caller that prefetched them - ``RackViewSet`` does, with each
device's type, power ports and an ``outlet_n`` count - pays no query per
rack. Ports use the shared counting rule of ``api.port_utilization``.
"""
from __future__ import annotations

from .port_utilization import device_port_counts

# A counted port row, as a rack and its devices report it.
PORT_FIELDS = ("total", "connected", "reserved", "free", "marked")


def used_units(devices) -> int:
    """Distinct units occupied by ``devices`` - two half-width devices
    sharing a U count it once."""
    units: set[int] = set()
    for d in devices:
        if d.position is None:
            continue
        if d.device_type and d.device_type.exclude_from_utilization:
            continue  # blanking panels / cable management don't count
        h = d.device_type.u_height if d.device_type else 1
        if h <= 0:
            # 0U gear (vertical strips, shelf appliances) occupies no
            # units - the old `or 1` here charged each one a full U.
            continue
        units.update(range(d.position, d.position + h))
    return len(units)


def rack_space(rack) -> dict:
    """``{"u_height", "u_used", "u_free"}``: the rack's height, the units its
    devices occupy (as the rack serializer's ``used_units``), and the rest."""
    used = used_units(rack.devices.all())
    return {"u_height": rack.u_height, "u_used": used, "u_free": max(rack.u_height - used, 0)}


def rack_power(rack) -> dict:
    """Rack power rollup. Supply = primary feeds delivered to the rack
    (V × A × max-utilisation%, three-phase × √3).
    Demand = the racked devices' power-port draws - allocated where
    recorded, with the nameplate (maximum) sum alongside."""
    available = 0.0
    for f in rack.power_feeds.all():
        if f.type != "primary" or not f.voltage or not f.amperage:
            continue
        watts = abs(f.voltage) * f.amperage * (f.max_utilization / 100)
        if f.phase == "three":
            watts *= 1.732
        available += watts
    allocated = maximum = 0
    for d in rack.devices.all():
        # A device WITH outlets is a distributor (a PDU): its inlet draw
        # restates its children's draws, so counting both doubled the
        # rack's demand. Distributors contribute supply topology, not
        # demand.
        outlet_n = getattr(d, "outlet_n", None)
        if outlet_n is None:
            outlet_n = d.power_outlets.count()
        if outlet_n:
            continue
        for pp in d.power_ports.all():
            allocated += pp.allocated_draw or 0
            maximum += pp.maximum_draw or 0
    return {
        "available_w": round(available),
        "allocated_w": allocated,
        "maximum_w": maximum,
    }


def rack_ports(devices, *, count_virtual: bool) -> dict:
    """Counted ports per device and summed: ``{"devices": {device id: row},
    "total": row}``, each row ``{"total", "connected", "reserved", "free",
    "marked"}`` under the shared rule (physical interfaces and front ports,
    virtual interfaces only with ``count_virtual``, never rear ports).
    ``devices`` is a queryset; one with no port of any kind has no row and
    adds nothing to the total."""
    per_device = {
        device_id: {k: row[k] for k in PORT_FIELDS}
        for device_id, row in device_port_counts(devices, count_virtual=count_virtual).items()
    }
    total = dict.fromkeys(PORT_FIELDS, 0)
    for row in per_device.values():
        for k in PORT_FIELDS:
            total[k] += row[k]
    return {"devices": per_device, "total": total}
