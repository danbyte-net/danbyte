"""Rack capacity - space, power, cooling and ports - one rule each.

The rack page, the floor plan's live overlay, the rack's Rack view (#248), the
racks of a floor plan and a site's Capacity tab (#247) read their figures from
here, so a rack reports the same numbers everywhere. Space, power and cooling
read the rack's ``devices`` (and ``power_feeds``) through ``.all()``: a caller
that prefetched them with :func:`racked_devices_prefetch` - ``RackViewSet``,
the floor plan's ``state`` and the site capacity do - pays no query per rack
or device. Ports use the shared counting rule of ``api.port_utilization``.
"""
from __future__ import annotations

from .port_utilization import METRICS, device_port_counts, port_kinds

# A counted port row, as a rack and its devices report it.
PORT_FIELDS = ("total", "connected", "reserved", "free", "marked")

# Where a rack's power supply figure comes from (``rack_power``'s ``supply``).
SUPPLY_FEED = "feed"
SUPPLY_PDU_RATING = "pdu_rating"
SUPPLY_BUDGET = "budget"


def racked_devices_prefetch(prefix: str = ""):
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
    return Prefetch(f"{prefix}devices", queryset=racked)


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

    A rack's power budget (``max_power_w``) overrides both: demand is then
    measured against the budget, ``supply`` ``"budget"``, and ``supplied_w``
    keeps what the feeds or PDUs would give (0 when neither is known).

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
        if _is_distributor(d):
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
    out = {
        "available_w": available_w,
        "allocated_w": allocated,
        "maximum_w": maximum,
        "supply": supply,
    }
    budget = getattr(rack, "max_power_w", None)
    if budget:
        out.update(available_w=budget, supply=SUPPLY_BUDGET, supplied_w=available_w)
    return out


def _is_distributor(device) -> bool:
    """A device with power outlets - a PDU: its inlet restates the draw of
    what it feeds, so it adds no load of its own (see ``rack_power``)."""
    outlet_n = getattr(device, "outlet_n", None)
    if outlet_n is None:
        outlet_n = device.power_outlets.count()
    return bool(outlet_n)


def rack_cooling(rack, devices=None) -> dict:
    """Rack heat load against its cooling (#434): ``{"available_w",
    "heat_allocated_w", "heat_maximum_w", "supply", "mismatched"}`` - the
    shape of ``rack_power``.

    Heat = per device, its type's ``heat_output_w`` where set, else the power
    it draws - allocated in ``heat_allocated_w``, the nameplate (maximum) sum
    in ``heat_maximum_w`` - skipping distributors (PDUs) as power demand
    does. Supply = the rack's ``cooling_capacity_w``, ``supply`` ``"budget"``;
    without one, the primary cooling feeds delivered to the rack (rated
    capacity × max-utilisation%, :func:`feed_cooling_w`), ``supply``
    ``"feed"``; with neither, ``supply`` is None and ``available_w`` 0. Reads
    ``rack.cooling_feeds`` - prefetch them, as ``rack_power``'s callers do
    ``power_feeds``. ``mismatched``
    counts the devices whose effective cooling method the rack's capability
    does not take (``api.cooling``), 0 for a rack without one.

    ``devices`` defaults to ``rack.devices.all()`` - prefetch them with
    :func:`racked_devices_prefetch`. ``cooling_free_annotation`` is the same
    allocated figure in SQL, for filtering a list of racks."""
    from .cooling import admits

    if devices is None:
        devices = rack.devices.all()
    capability = getattr(rack, "cooling_capability", "") or ""
    allocated = maximum = mismatched = 0
    for d in devices:
        if capability and not admits(capability, d.effective_cooling_method):
            mismatched += 1
        a, m = device_heat(d)
        allocated += a
        maximum += m
    capacity = getattr(rack, "cooling_capacity_w", None)
    fed = 0
    if not capacity and getattr(rack, "pk", None) is not None:
        fed = sum(
            feed_cooling_w(f) for f in rack.cooling_feeds.all() if f.type == "primary"
        )
    if capacity:
        supply, available = SUPPLY_BUDGET, capacity
    elif fed:
        supply, available = SUPPLY_FEED, fed
    else:
        supply, available = None, 0
    return {
        "available_w": available,
        "heat_allocated_w": allocated,
        "heat_maximum_w": maximum,
        "supply": supply,
        "mismatched": mismatched,
    }


def device_heat(d) -> tuple[int, int]:
    """``(allocated, maximum)`` heat one device gives off - its type's
    ``heat_output_w`` where set, else its power ports' draws; 0, 0 for a
    distributor (PDU). See :func:`rack_cooling`."""
    if _is_distributor(d):
        return 0, 0
    heat = d.device_type.heat_output_w if d.device_type is not None else None
    if heat is not None:
        return heat, heat
    allocated = maximum = 0
    for pp in d.power_ports.all():
        allocated += pp.allocated_draw or 0
        maximum += pp.maximum_draw or 0
    return allocated, maximum


def feed_cooling_w(feed) -> int:
    """What one cooling feed delivers: its rated capacity × its
    max-utilisation %, in whole watts rounded down (as the SQL twin in
    :func:`cooling_free_annotation`); 0 without a rating."""
    if not feed.rated_capacity_w:
        return 0
    return feed.rated_capacity_w * (feed.max_utilization or 0) // 100


def _rack_heat(rack) -> tuple[int, int]:
    """``(allocated, maximum)`` heat of ``rack``; 0, 0 without one."""
    if rack is None:
        return 0, 0
    fig = rack_cooling(rack)
    return fig["heat_allocated_w"], fig["heat_maximum_w"]


def _connected_heat(feed) -> tuple[int, int, int]:
    """``(allocated, maximum, devices)``: the heat of every device the feed
    reaches through cooling intakes (api.cooling_trace.downstream)."""
    from django.db.models import Count

    from .cooling_trace import downstream
    from .models import Device

    reached = downstream([feed.pk], feed.tenant_id)
    if not reached:
        return 0, 0, 0
    devices = (
        Device.objects.filter(pk__in=list(reached)).select_related("device_type")
        .annotate(outlet_n=Count("power_outlets", distinct=True))
        .prefetch_related("power_ports")
    )
    allocated = maximum = 0
    for d in devices:
        a, m = device_heat(d)
        allocated += a
        maximum += m
    return allocated, maximum, len(reached)


def _has_intakes(feed) -> bool:
    cache = getattr(feed, "_prefetched_objects_cache", {})
    if "intakes" in cache:
        return bool(cache["intakes"])
    return feed.intakes.exists()


def cooling_feed_capacity(feed) -> dict:
    """A cooling feed's load (#434): the heat on it against what the feed
    delivers - ``{"available_w", "rated_w", "heat_allocated_w",
    "heat_maximum_w", "redundant", "basis", "devices"}``. Where cooling
    intakes name the feed, the heat is that of the devices they connect -
    behind CDUs too - ``basis`` ``"intakes"`` and ``devices`` how many;
    otherwise its rack's heat, ``basis`` ``"rack"``. A redundant feed is
    measured against the whole load too: it must carry it alone when the
    primary fails. ``available_w`` is 0 without a rating, the heat 0 without
    a rack or intakes."""
    devices = None
    if feed.pk is not None and _has_intakes(feed):
        allocated, maximum, devices = _connected_heat(feed)
        basis = "intakes"
    else:
        allocated, maximum = _rack_heat(feed.rack)
        basis = "rack"
    return {
        "available_w": feed_cooling_w(feed),
        "rated_w": feed.rated_capacity_w or 0,
        "heat_allocated_w": allocated,
        "heat_maximum_w": maximum,
        "redundant": feed.type == "redundant",
        "basis": basis,
        "devices": devices,
    }


def cooling_feed_flow(feed) -> dict:
    """A cooling feed's flow (#434): ``{"connected_lpm", "rated_lpm",
    "intakes"}`` - the summed ``max_flow_lpm`` of the intakes on it (those
    that give one) against its own ``flow_rate_lpm``; null where neither is
    recorded."""
    connected = None
    n = 0
    for i in feed.intakes.all():
        n += 1
        if i.max_flow_lpm is not None:
            connected = (connected or 0) + float(i.max_flow_lpm)
    rated = feed.flow_rate_lpm
    return {
        "connected_lpm": round(connected, 1) if connected is not None else None,
        "rated_lpm": float(rated) if rated is not None else None,
        "intakes": n,
    }


def cooling_source_capacity(source) -> dict:
    """A cooling source's load (#434): the heat of the racks its feeds
    deliver to - each rack once, however many of the source's feeds reach
    it - against the source's ``rated_capacity_w``: ``{"available_w",
    "heat_allocated_w", "heat_maximum_w", "racks"}``. Prefetch
    ``cooling_feeds__rack`` and the racks' devices
    (``racked_devices_prefetch("cooling_feeds__rack__")``)."""
    allocated = maximum = 0
    seen: set = set()
    for f in source.cooling_feeds.all():
        if f.rack_id is None or f.rack_id in seen:
            continue
        seen.add(f.rack_id)
        a, m = _rack_heat(f.rack)
        allocated += a
        maximum += m
    return {
        "available_w": source.rated_capacity_w or 0,
        "heat_allocated_w": allocated,
        "heat_maximum_w": maximum,
        "racks": len(seen),
    }


def cooling_free_annotation():
    """A rack queryset's cooling supply less the heat its devices give off,
    allocated - ``rack_cooling``'s figures, as one SQL expression: the
    ``cooling_capacity_w``, else the primary cooling feeds' sum; NULL for a
    rack with neither. What ``?cooling_free_w_gte=`` filters on, in the
    list's own query."""
    from django.db.models import (
        Case,
        Exists,
        ExpressionWrapper,
        F,
        IntegerField,
        OuterRef,
        Subquery,
        Sum,
        Value,
        When,
    )
    from django.db.models.functions import Coalesce

    from .models import CoolingFeed, Device, PowerOutlet, PowerPort

    drawn = (
        PowerPort.objects.filter(device=OuterRef("pk"))
        .order_by().values("device").annotate(w=Sum("allocated_draw")).values("w")
    )
    device_heat = Case(
        When(Exists(PowerOutlet.objects.filter(device=OuterRef("pk"))), then=Value(0)),
        default=Coalesce(
            F("device_type__heat_output_w"),
            Subquery(drawn, output_field=IntegerField()),
            Value(0),
        ),
        output_field=IntegerField(),
    )
    heat = (
        Device.objects.filter(rack=OuterRef("pk"))
        .order_by().annotate(heat=device_heat)
        .values("rack").annotate(total=Sum("heat")).values("total")
    )
    fed = (
        CoolingFeed.objects.filter(
            rack=OuterRef("pk"), type="primary", rated_capacity_w__isnull=False
        )
        .order_by().values("rack")
        .annotate(w=Sum(ExpressionWrapper(
            F("rated_capacity_w") * F("max_utilization") / 100,
            output_field=IntegerField(),
        )))
        .values("w")
    )
    used = Coalesce(Subquery(heat, output_field=IntegerField()), Value(0))
    return Case(
        When(
            cooling_capacity_w__gt=0,
            then=ExpressionWrapper(F("cooling_capacity_w") - used, output_field=IntegerField()),
        ),
        When(
            Exists(fed.filter(w__gt=0)),
            then=ExpressionWrapper(
                Subquery(fed, output_field=IntegerField()) - used,
                output_field=IntegerField(),
            ),
        ),
        default=None,
        output_field=IntegerField(),
    )


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
    use), power, cooling, ``ports`` / ``panel_ports`` (its
    ``rack_port_split`` entry) and device count."""
    space = rack_space(rack)
    return {
        "u_height": space["u_height"],
        "u_used": space["u_used"],
        "u_pct": pct(space["u_used"], space["u_height"]),
        "power": rack_power(rack),
        "cooling": rack_cooling(rack),
        "ports": split["ports"],
        "panel_ports": split["panel_ports"],
        "device_count": len(rack.devices.all()),
    }


def sum_figures(figures) -> dict:
    """``rack_figures`` added up: ``racks`` and ``devices`` counts, units and
    their share in use, power with ``pdu_rating`` / ``no_supply`` /
    ``budget`` - how many of the racks have only their PDUs' rating, no
    supply figure at all, or a power budget - cooling with ``budget`` /
    ``no_supply`` - the racks with and without a cooling capacity - and
    ``mismatched`` devices, and the two port rows."""
    figures = list(figures)
    u_height = sum(f["u_height"] for f in figures)
    u_used = sum(f["u_used"] for f in figures)
    power = {
        "available_w": 0, "allocated_w": 0, "maximum_w": 0,
        "pdu_rating": 0, "no_supply": 0, "budget": 0,
    }
    cooling = {
        "available_w": 0, "heat_allocated_w": 0, "heat_maximum_w": 0,
        "budget": 0, "no_supply": 0, "mismatched": 0,
    }
    ports = dict.fromkeys(PORT_FIELDS, 0)
    panel = dict.fromkeys(PORT_FIELDS, 0)
    for f in figures:
        for k in ("available_w", "allocated_w", "maximum_w"):
            power[k] += f["power"][k]
        if f["power"]["supply"] == SUPPLY_PDU_RATING:
            power["pdu_rating"] += 1
        elif f["power"]["supply"] == SUPPLY_BUDGET:
            power["budget"] += 1
        elif f["power"]["supply"] is None:
            power["no_supply"] += 1
        for k in ("available_w", "heat_allocated_w", "heat_maximum_w", "mismatched"):
            cooling[k] += f["cooling"][k]
        cooling["budget" if f["cooling"]["supply"] == SUPPLY_BUDGET else "no_supply"] += 1
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
        "cooling": cooling,
        "ports": ports,
        "panel_ports": panel,
    }
