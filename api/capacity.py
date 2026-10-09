"""Rack capacity - space, power and ports - one rule each.

The rack page, the floor plan's live overlay, the rack's Rack view (#248), the
racks of a floor plan and a site's Capacity tab (#247) read their figures from
here, so a rack reports the same numbers everywhere. Space and power read the
rack's ``devices`` (and ``power_feeds``) through ``.all()``: a caller that
prefetched them with :func:`racked_devices_prefetch` - ``RackViewSet``, the
floor plan's ``state`` and the site capacity do - pays no query per rack or
device. Ports use the shared counting rule of ``api.port_utilization``.
"""
from __future__ import annotations

from .port_utilization import METRICS, device_port_counts, port_kinds

# A counted port row, as a rack and its devices report it.
PORT_FIELDS = ("total", "connected", "reserved", "free", "marked")

# Where a rack's power supply figure comes from (``rack_power``'s ``supply``).
SUPPLY_FEED = "feed"
SUPPLY_PDU_RATING = "pdu_rating"


def racked_devices_prefetch():
    """The ``Prefetch`` of a rack queryset's ``devices`` with everything the
    figures here read: each device's type and role, its power ports and an
    ``outlet_n`` count of its power outlets. Every device in the rack, as a
    rack's units and power count them all. ``outlet_inlet_n`` counts the
    distinct inlets its outlets name: two or more mark a PDU whose inlets
    feed separate outlet banks (see :func:`pdu_rating`).

    A page of racks, or every rack on a floor plan, then costs the same
    queries whatever stands in them; without it ``rack_power`` paid two per
    device - the floor plan's 30-second poll among them."""
    from django.db.models import Count, Prefetch

    from .models import Device

    racked = (
        Device.objects.select_related("device_type", "role")
        .annotate(
            outlet_n=Count("power_outlets", distinct=True),
            outlet_inlet_n=Count("power_outlets__power_port", distinct=True),
        )
        .prefetch_related("power_ports")
    )
    return Prefetch("devices", queryset=racked)


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


def pdu_rating(device) -> int:
    """The power one PDU (a device with outlets) can deliver, by the rated
    (maximum) draw of its inlets.

    Two or more inlets are redundant feeds of the same outlets, so the PDU
    delivers what its smallest rated inlet carries alone (#329). Only when
    its outlets name two or more different inlets does each inlet feed its
    own bank of outlets, and the banks add up. 0 when no inlet is rated."""
    rated = [pp.maximum_draw for pp in device.power_ports.all() if pp.maximum_draw]
    if not rated:
        return 0
    banks = getattr(device, "outlet_inlet_n", None)
    if banks is None:
        banks = len({o.power_port_id for o in device.power_outlets.all() if o.power_port_id})
    return sum(rated) if banks > 1 else min(rated)


def _smaller_side(ratings: list[int]) -> int:
    """The rack's PDUs as A and B sides: the larger of the two sides' smaller
    totals over every way to split them, so the figure is what one side
    carries alone. One PDU has no second side and delivers its own rating."""
    if len(ratings) == 1:
        return ratings[0]
    total = sum(ratings)
    sums = {0}
    for r in ratings:
        sums |= {s + r for s in sums if s + r <= total // 2}
    return max(sums)


def rack_power(rack) -> dict:
    """Rack power rollup: ``{"available_w", "allocated_w", "maximum_w",
    "supply"}``.

    Supply = the primary feeds delivered to the rack (V × A ×
    max-utilisation%, three-phase × √3), ``supply`` ``"feed"``. Where no
    primary feed gives a figure, the rated (maximum) draw of the rack's PDUs
    stands in (:func:`pdu_rating` each), ``supply`` ``"pdu_rating"``. Two or
    more rated PDUs are taken as A and B sides, and the supply is the smaller
    side: either side must carry the whole rack alone (#329). ``supply`` is
    None when neither is known (``available_w`` 0).

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
    ratings: list[int] = []
    for d in rack.devices.all():
        # A device WITH outlets is a distributor (a PDU): its inlet draw
        # restates its children's draws, so counting both doubled the
        # rack's demand. Distributors contribute supply topology, not
        # demand - and their inlets' rating is the supply of last resort.
        outlet_n = getattr(d, "outlet_n", None)
        if outlet_n is None:
            outlet_n = d.power_outlets.count()
        if outlet_n:
            rating = pdu_rating(d)
            if rating:
                ratings.append(rating)
            continue
        for pp in d.power_ports.all():
            allocated += pp.allocated_draw or 0
            maximum += pp.maximum_draw or 0
    fed = round(available)
    if fed:
        supply, available_w = SUPPLY_FEED, fed
    elif ratings:
        supply, available_w = SUPPLY_PDU_RATING, round(_smaller_side(ratings))
    else:
        supply, available_w = None, 0
    return {
        "available_w": available_w,
        "allocated_w": allocated,
        "maximum_w": maximum,
        "supply": supply,
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


def _port_row(sums: dict) -> dict:
    return {
        "total": sums["total"],
        "connected": sums["connected"],
        "reserved": sums["reserved"],
        "free": sums["total"] - sums["connected"] - sums["reserved"],
        "marked": sums["marked"],
    }


def _add(into: dict, kinds: dict, names) -> None:
    for name in names:
        for m in METRICS:
            into[m] += kinds[name][m]


def rack_port_split(racks, *, count_virtual: bool) -> dict:
    """``{rack id: {"ports": row, "panel_ports": row}}`` - the counted ports
    of each rack's devices (the rule of ``rack_ports``), split in two:

    * ``ports``: the counted interfaces - physical, plus virtual ones with
      ``count_virtual`` - of devices that are not patch panels;
    * ``panel_ports``: front ports, and every counted port of a device whose
      role is a patch-panel role.

    Together they are ``rack_ports``' total. ``racks`` are racks whose
    ``devices`` were prefetched with :func:`racked_devices_prefetch`; eight
    queries for all of them, whatever their size - rear ports never count,
    so they are not asked for."""
    from .models import Device

    racks = list(racks)
    # By rack, not by device: a page of racks names a few ids, where its
    # devices would name thousands.
    kinds_by_device = (
        port_kinds(Device.objects.filter(rack_id__in=[r.id for r in racks]), rear_ports=False)
        if racks else {}
    )
    interfaces = ("interfaces", "virtual") if count_virtual else ("interfaces",)
    out: dict = {}
    for rack in racks:
        ports = dict.fromkeys(METRICS, 0)
        panel = dict.fromkeys(METRICS, 0)
        for d in rack.devices.all():
            kinds = kinds_by_device.get(d.id)
            if kinds is None:
                continue
            if d.role_id is not None and d.role.is_patch_panel:
                _add(panel, kinds, (*interfaces, "front_ports"))
            else:
                _add(ports, kinds, interfaces)
                _add(panel, kinds, ("front_ports",))
        out[rack.id] = {"ports": _port_row(ports), "panel_ports": _port_row(panel)}
    return out


def pct(used, total) -> int | None:
    """``used`` as a whole percentage of ``total``; None when there is no
    total to measure against."""
    if not total:
        return None
    return round(used / total * 100)


def rack_figures(rack, split: dict) -> dict:
    """What one rack adds to a capacity rollup: its units (and the share in
    use), power, ``ports`` / ``panel_ports`` (its ``rack_port_split`` entry)
    and device count."""
    space = rack_space(rack)
    return {
        "u_height": space["u_height"],
        "u_used": space["u_used"],
        "u_pct": pct(space["u_used"], space["u_height"]),
        "power": rack_power(rack),
        "ports": split["ports"],
        "panel_ports": split["panel_ports"],
        "device_count": len(rack.devices.all()),
    }


def sum_figures(figures) -> dict:
    """``rack_figures`` added up: ``racks`` and ``devices`` counts, units and
    their share in use, power with ``pdu_rating`` / ``no_supply`` - how many
    of the racks have only their PDUs' rating, or no supply figure at all -
    and the two port rows."""
    figures = list(figures)
    u_height = sum(f["u_height"] for f in figures)
    u_used = sum(f["u_used"] for f in figures)
    power = {"available_w": 0, "allocated_w": 0, "maximum_w": 0, "pdu_rating": 0, "no_supply": 0}
    ports = dict.fromkeys(PORT_FIELDS, 0)
    panel = dict.fromkeys(PORT_FIELDS, 0)
    for f in figures:
        for k in ("available_w", "allocated_w", "maximum_w"):
            power[k] += f["power"][k]
        if f["power"]["supply"] == SUPPLY_PDU_RATING:
            power["pdu_rating"] += 1
        elif f["power"]["supply"] is None:
            power["no_supply"] += 1
        for k in PORT_FIELDS:
            ports[k] += f["ports"][k]
            panel[k] += f["panel_ports"][k]
    return {
        "racks": len(figures),
        "devices": sum(f["device_count"] for f in figures),
        "u_height": u_height,
        "u_used": u_used,
        "u_pct": pct(u_used, u_height),
        "power": power,
        "ports": ports,
        "panel_ports": panel,
    }
