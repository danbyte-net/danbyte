"""Moving a rack to another site together with its devices (#394).

A racked device is at its rack's site (#377), so a rack with devices cannot
change site on an ordinary edit. ``plan`` works out what a move takes: the
devices that go along (racked ones and, through device bays, their children),
what blocks it because it is still tied to a site, and what is cleared.
``apply`` performs a plan with no blockers. Both run inside the caller's
transaction, with the rack locked (``rack_units.lock_rack``) so a device
placed meanwhile is seen or waits.

Blocks, listed with a reason each: a cable from a moving port to anything
outside the moving devices (another device, a power feed, a circuit), a VLAN
or IP address of another site on a moving device, a power feed delivered to
the rack from another site's panel, a cluster at another site, a device in a
bay of a device outside the rack, a rack of the same name at the new site and,
under enhanced site separation, a catalog entry (device type, status, tag)
local to another site. Cleared: a floor-plan tile that places the rack or one
of its devices on a plan of another site. Updated: each device's site and
location, and the site a port reservation on a moving port carries.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from django.db.models import Q

from .models import (
    Cable,
    CableTermination,
    Device,
    FloorPlanTile,
    Interface,
    IPAddress,
    PortReservation,
    PowerFeed,
    Rack,
)

# The cable ends and reservable points that sit on a device.
DEVICE_POINTS = (
    "interface", "front_port", "rear_port", "console_port",
    "console_server_port", "power_port", "power_outlet", "aux_port",
)
# A long list of one kind stops here and says how many more.
PER_KIND = 25


@dataclass
class Plan:
    rack: Rack
    site: object
    location: object
    devices: list = field(default_factory=list)
    blockers: list = field(default_factory=list)
    tiles: list = field(default_factory=list)

    @property
    def device_ids(self) -> set:
        return {d.pk for d in self.devices}

    def block(self, code: str, message: str) -> None:
        self.blockers.append({"code": code, "message": message})


def _site_name(site_id, names: dict) -> str:
    return names.get(site_id, "another site")


def plan(rack: Rack, site, location) -> Plan:
    """What moving ``rack`` to ``site`` (and ``location``, or none) takes."""
    from core.effective_settings import separation_enabled

    p = Plan(rack=rack, site=site, location=location)
    tenant_id = rack.tenant_id
    p.devices = list(
        Device.objects.filter(tenant_id=tenant_id, rack=rack)
        .select_related("device_type", "status", "cluster", "parent_bay__device")
        .prefetch_related("tags")
        .order_by("name")
    )
    _add_children(p, tenant_id)
    ids = p.device_ids
    names = dict(
        type(site).objects.filter(tenant_id=tenant_id).values_list("pk", "name")
    )

    if Rack.objects.filter(site=site, name=rack.name).exclude(pk=rack.pk).exists():
        p.block("name", f"{site.name} already has a rack named {rack.name}.")
    _check_bays(p)
    if ids:
        _check_cables(p, ids)
        _check_vlans(p, ids, names)
        _check_ips(p, ids, names)
        for d in p.devices:
            c = d.cluster
            if c is not None and c.site_id and c.site_id != site.pk:
                p.block("cluster", f"{d.name}: cluster {c.name} is at "
                                   f"{_site_name(c.site_id, names)}.")
    feeds = list(
        PowerFeed.objects.filter(rack=rack)
        .exclude(power_panel__site_id=site.pk)
        .values_list("power_panel__site_id", flat=True)
    )
    for site_id in sorted(set(feeds), key=lambda s: _site_name(s, names)):
        n = sum(1 for s in feeds if s == site_id)
        p.block("power_feed", f"{n} power feed{'s' if n != 1 else ''} from "
                              f"{_site_name(site_id, names)} deliver"
                              f"{'' if n != 1 else 's'} to this rack.")
    if separation_enabled(rack.tenant):
        _check_catalog(p, names)

    p.tiles = list(
        FloorPlanTile.objects.filter(Q(rack=rack) | Q(device_id__in=ids))
        .exclude(floor_plan__location__site_id=site.pk)
    )
    _cap(p)
    return p


def _add_children(p: Plan, tenant_id) -> None:
    """Devices installed in the bays of moving devices go along, unless they
    are racked somewhere else."""
    seen = p.device_ids
    frontier = set(seen)
    while frontier:
        kids = list(
            Device.objects.filter(tenant_id=tenant_id, parent_bay__device_id__in=frontier)
            .exclude(pk__in=seen)
            .select_related("device_type", "status", "cluster", "rack",
                            "parent_bay__device")
            .prefetch_related("tags")
        )
        frontier = set()
        for k in kids:
            seen.add(k.pk)
            if k.rack_id and k.rack_id != p.rack.pk:
                p.block("bay", f"{k.name} sits in a bay of "
                               f"{k.parent_bay.device.name} but is racked in "
                               f"{k.rack.name}.")
                continue
            p.devices.append(k)
            frontier.add(k.pk)


def _check_bays(p: Plan) -> None:
    ids = p.device_ids
    for d in p.devices:
        bay = getattr(d, "parent_bay", None)
        if bay is not None and bay.device_id not in ids:
            p.block("bay", f"{d.name} sits in a bay of {bay.device.name}, "
                           "outside the rack.")


def _check_cables(p: Plan, ids: set) -> None:
    touch = Q()
    for f in DEVICE_POINTS:
        touch |= Q(**{f"{f}__device_id__in": ids})
    cable_ids = set(
        CableTermination.objects.filter(touch).values_list("cable_id", flat=True)
    )
    if not cable_ids:
        return
    rows = CableTermination.objects.filter(cable_id__in=cable_ids).values(
        "cable_id",
        *[f"{f}__device_id" for f in DEVICE_POINTS],
        *[f"{f}__device__name" for f in DEVICE_POINTS],
        *[f"{f}__name" for f in DEVICE_POINTS],
    )
    inside_end: dict = {}
    leaving: set = set()
    for row in rows:
        dev = next((row[f"{f}__device_id"] for f in DEVICE_POINTS
                    if row[f"{f}__device_id"] is not None), None)
        if dev in ids:
            f = next(f for f in DEVICE_POINTS if row[f"{f}__device_id"] == dev)
            inside_end.setdefault(
                row["cable_id"], f"{row[f'{f}__device__name']} {row[f'{f}__name']}"
            )
        else:
            leaving.add(row["cable_id"])
    cables = {c.pk: c for c in Cable.objects.filter(pk__in=leaving)}
    for cid in sorted(leaving, key=lambda c: inside_end.get(c, "")):
        # The far end is not named: the caller may not be allowed to see it.
        p.block("cable", f"{cables[cid]} on {inside_end[cid]} leaves the rack.")


def _check_vlans(p: Plan, ids: set, names: dict) -> None:
    site_pk = p.site.pk
    rows = list(
        Interface.objects.filter(device_id__in=ids, vlan__site__isnull=False)
        .exclude(vlan__site_id=site_pk)
        .values_list("device__name", "name", "vlan__vlan_id", "vlan__site_id")
    )
    rows += list(
        Interface.tagged_vlans.through.objects.filter(
            interface__device_id__in=ids, vlan__site__isnull=False
        )
        .exclude(vlan__site_id=site_pk)
        .values_list("interface__device__name", "interface__name",
                     "vlan__vlan_id", "vlan__site_id")
    )
    for dev, port, vid, site_id in sorted(set(rows)):
        p.block("vlan", f"{dev} {port} carries VLAN {vid} of "
                        f"{_site_name(site_id, names)}.")


def _check_ips(p: Plan, ids: set, names: dict) -> None:
    site_pk = p.site.pk
    on_device = Q(assigned_device_id__in=ids) | Q(assigned_interface__device_id__in=ids)
    elsewhere = (
        (Q(site__isnull=False) & ~Q(site_id=site_pk))
        | (Q(prefix__site__isnull=False) & ~Q(prefix__site_id=site_pk))
    )
    rows = (
        IPAddress.objects.filter(tenant_id=p.rack.tenant_id)
        .filter(on_device).filter(elsewhere)
        .values_list("pk", "assigned_device__name", "assigned_interface__device__name",
                     "site_id", "prefix__site_id")
        .distinct()
    )
    counts: dict = {}
    for _pk, dev, iface_dev, site_id, prefix_site in rows:
        where = site_id if site_id and site_id != site_pk else prefix_site
        key = (dev or iface_dev, where)
        counts[key] = counts.get(key, 0) + 1
    for (dev, site_id), n in sorted(counts.items(), key=lambda kv: str(kv[0])):
        p.block("ip", f"{dev}: {n} IP address{'es' if n != 1 else ''} of "
                      f"{_site_name(site_id, names)}.")


def _check_catalog(p: Plan, names: dict) -> None:
    """Under enhanced site separation a catalog entry local to one site is
    not offered at another, so the rack and its devices must not take one
    along."""
    site_pk = p.site.pk

    def foreign(entry) -> bool:
        owner = getattr(entry, "owning_site_id", None) if entry is not None else None
        return owner is not None and owner != site_pk

    for obj in [p.rack, *p.devices]:
        dt = getattr(obj, "device_type", None)
        if foreign(dt):
            p.block("catalog", f"{obj.name}: device type {dt.name} is local to "
                               f"{_site_name(dt.owning_site_id, names)}.")
        if foreign(obj.status):
            p.block("catalog", f"{obj.name}: status {obj.status.name} is local to "
                               f"{_site_name(obj.status.owning_site_id, names)}.")
        for tag in obj.tags.all():
            if foreign(tag):
                p.block("catalog", f"{obj.name}: tag {tag.name} is local to "
                                   f"{_site_name(tag.owning_site_id, names)}.")


def _cap(p: Plan) -> None:
    """At most ``PER_KIND`` reasons of one kind, then how many more."""
    kept, counts = [], {}
    for b in p.blockers:
        counts[b["code"]] = counts.get(b["code"], 0) + 1
        if counts[b["code"]] <= PER_KIND:
            kept.append(b)
    for code, n in counts.items():
        if n > PER_KIND:
            kept.append({"code": code, "message": f"…and {n - PER_KIND} more."})
    p.blockers = kept


def payload(p: Plan, *, moved: bool) -> dict:
    def ref(obj):
        return {"id": str(obj.pk), "name": obj.name} if obj is not None else None

    rack = p.rack
    return {
        "rack": ref(rack),
        "from_site": {"id": str(rack.site_id), "name": rack.site.name},
        "to_site": ref(p.site),
        "to_location": ref(p.location),
        "devices": [
            {"id": str(d.pk), "name": d.name, "position": d.position,
             "face": d.face, "mount": d.mount, "racked": d.rack_id == rack.pk}
            for d in p.devices
        ],
        "cleared": {"floor_plan_tiles": len(p.tiles)},
        "blockers": p.blockers,
        "can_move": not p.blockers,
        "moved": moved,
    }


def apply(p: Plan) -> None:
    """Perform a plan with no blockers. Each object is saved on its own so
    the change log records every one."""
    assert not p.blockers
    site, location = p.site, p.location
    for d in p.devices:
        d.site = site
        d.location = location
        d.save(update_fields=["site", "location", "updated_at"])
    rack = p.rack
    rack.site = site
    rack.location = location
    rack.save(update_fields=["site", "location", "updated_at"])
    ids = p.device_ids
    for tile in p.tiles:
        if tile.rack_id == rack.pk:
            tile.rack = None
        if tile.device_id in ids:
            tile.device = None
        if tile.link_kind in ("rack", "device"):
            tile.link_kind = ""
        tile.save(update_fields=["rack", "device", "link_kind", "updated_at"])
    if ids:
        held = Q()
        for f in DEVICE_POINTS:
            held |= Q(**{f"{f}__device_id__in": ids})
        for hold in PortReservation.objects.filter(held):
            # save() recomputes the site from the held port.
            hold.save()
