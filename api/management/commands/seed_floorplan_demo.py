"""seed_floorplan_demo - an opt-in demo floor plan that uses every feature.

In one tenant, a site "Demo campus" with two buildings and a floor plan of
Building A with two floors: rooms drawn as areas with linked walls and
doors, a hatched area of a demo area type, labels, a label that opens the
first floor (and its Back button there), a raised floor, racks and a
cabinet, a standalone server, overhead and underfloor trays, a dozen cables
between two switches, a firewall and two servers (one breakout, one
planned, one left inferred, one stale, one up a riser to the first floor)
with stored routes, and a site-wide plan with the two buildings' outlines
opening the building plan. The building plan shows its cables and their
labels by default.

Re-runnable: everything is found by name and made only when missing, so a
second run changes nothing and keeps what was edited since. Never part of
bootstrap or a migration - demo inventory is opt-in:

    .venv/bin/python manage.py seed_floorplan_demo --tenant <slug>
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.models import (
    AreaType,
    Cabinet,
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanArea,
    FloorPlanCablePath,
    FloorPlanLabel,
    FloorPlanRaisedFloorArea,
    FloorPlanStack,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    FloorTileType,
    Interface,
    Location,
    LocationType,
    Manufacturer,
    Rack,
    Room,
    Site,
    Status,
)
from api.status_registry import resolve_status, seed_builtin_statuses
from core.models import Tenant

SITE_NAME = "Demo campus"
STACK_NAME = "Demo HQ"
OVERVIEW_NAME = "Demo campus overview"
CELL_MM = 600
#: Building A, both floors: 40 × 24 cells (24 m × 14.4 m).
GRID = (40, 24)

#: Devices: name → (type key, role slug, rack or cabinet, position).
DEVICES = {
    "demo-sw1": ("switch", "switch", "R01", 40),
    # In the office's wall cabinet.
    "demo-fw1": ("firewall", "firewall", "CAB-01", None),
    "demo-sw2": ("switch", "switch", "R02", 40),
    "demo-srv1": ("server", "server", "R02", 30),
    # Standalone, on the first floor: the riser cable's far end.
    "demo-srv2": ("server", "server", None, None),
}
TYPES = {
    "switch": ("Demo Switch 24", 1),
    "firewall": ("Demo Firewall", 1),
    "server": ("Demo Server 2U", 2),
}
ROLES = {"switch": "#0ea5e9", "firewall": "#ef4444", "server": "#8b5cf6"}

#: Cables: label → (type, [A ends], [B ends], how it is routed). An end is
#: (device, port). Routes: a tray name list (through those trays), "auto",
#: "none" (left inferred), "stale" (stored, then marked out of date),
#: "riser" (up the riser to the first floor).
CABLES = [
    ("DEMO-C01", "smf", [("demo-sw1", "sfp1")], [("demo-sw2", "sfp1")], ["OH-1"]),
    ("DEMO-C02", "smf", [("demo-sw1", "sfp2")], [("demo-sw2", "sfp2")], ["OH-1"]),
    ("DEMO-C03", "cat6", [("demo-fw1", "ge1")], [("demo-sw1", "ge1")], "auto"),
    ("DEMO-C04", "cat6", [("demo-fw1", "ge2")], [("demo-sw2", "ge1")], "auto"),
    ("DEMO-C05", "cat6a", [("demo-srv1", "eth0")], [("demo-sw1", "ge2")], ["UF-1"]),
    ("DEMO-C06", "cat6a", [("demo-srv1", "eth1")], [("demo-sw2", "ge2")], "auto"),
    ("DEMO-C07", "dac-passive", [("demo-sw1", "sfp3")],
     [("demo-srv1", "eth2"), ("demo-fw1", "ge3")], "auto"),
    ("DEMO-C08", "cat6", [("demo-sw1", "ge4")], [("demo-sw2", "ge4")], ["OH-1"]),
    ("DEMO-C09", "cat6", [("demo-sw1", "ge5")], [("demo-sw2", "ge5")], "none"),
    ("DEMO-C10", "cat6", [("demo-sw1", "ge6")], [("demo-srv1", "eth3")], "stale"),
    ("DEMO-C11", "smf", [("demo-sw2", "sfp4")], [("demo-srv2", "eth0")], "riser"),
    ("DEMO-C12", "cat6", [("demo-sw1", "ge7")], [("demo-sw2", "ge7")], ["UF-1"]),
]
#: The planned cable (a planned status, long dash on the plan).
PLANNED = "DEMO-C08"
BREAKOUT = "DEMO-C07"


class Command(BaseCommand):
    help = "Seed an opt-in demo floor plan that exercises every floor-plan feature."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", required=True, help="The tenant's slug.")

    def handle(self, *args, tenant: str, **options):
        t = Tenant.objects.filter(slug=tenant).first()
        if t is None:
            raise CommandError(f"No tenant with the slug {tenant!r}.")
        made = seed(t)
        out = self.stdout
        out.write(self.style.SUCCESS(f"Demo floor plan ready in {t.name}:"))
        for name, path in made["urls"]:
            out.write(f"  {name}: {path}")
        out.write(
            f"  {made['cables']} cables, {made['routes']} stored routes "
            f"({made['created']} objects made this run)"
        )


# ─── The seeder ─────────────────────────────────────────────────────────────


class _Seed:
    def __init__(self, tenant):
        self.t = tenant
        self.created = 0

    def get(self, model, defaults=None, **lookup):
        obj, made = model.objects.get_or_create(defaults=defaults or {}, **lookup)
        self.created += int(made)
        return obj

    def status(self, model_slug, value):
        return resolve_status(self.t, value, model_slug)


@transaction.atomic
def seed(tenant) -> dict:
    """Make (or find) the demo in ``tenant``. Answers the pages and counts."""
    seed_builtin_statuses(tenant)
    s = _Seed(tenant)
    t = tenant
    site = s.get(Site, tenant=t, name=SITE_NAME)
    building = s.get(LocationType, tenant=t, slug="building", defaults={"name": "Building"})
    loc_a = s.get(Location, tenant=t, site=site, slug="demo-building-a",
                  defaults={"name": "Building A", "location_type": building})
    loc_b = s.get(Location, tenant=t, site=site, slug="demo-building-b",
                  defaults={"name": "Building B", "location_type": building})
    server_room = s.get(Room, tenant=t, location=loc_a, slug="server-room",
                        defaults={"name": "Server room"})
    office = s.get(Room, tenant=t, location=loc_a, slug="office", defaults={"name": "Office"})

    # ── catalogs (demo only) ────────────────────────────────────────────
    tile_types = {
        key: s.get(FloorTileType, tenant=t, slug=key, defaults={
            "name": name, "color": color, "icon": icon,
        })
        for key, name, color, icon in (
            ("rack", "Rack", "#64748b", "server"),
            ("cabinet", "Cabinet", "#a16207", "box"),
            ("riser", "Riser", "#0d9488", "arrow-up-down"),
            ("device", "Device", "#6366f1", "hard-drive"),
        )
    }
    loading = s.get(AreaType, tenant=t, slug="demo-loading-bay", defaults={
        "name": "Loading bay", "color": "#f59e0b", "pattern": "hatched", "icon": "truck",
    })
    planned = (
        Status.objects.filter(tenant=t, is_planned=True, available_to__contains=["cable"]).first()
        or s.get(Status, tenant=t, slug="demo-planned-run", defaults={
            "name": "Planned run", "color": "#a855f7", "is_planned": True,
            "available_to": ["cable"],
        })
    )

    # ── devices ─────────────────────────────────────────────────────────
    mfr = s.get(Manufacturer, tenant=t, name="Demo", defaults={"slug": "demo"})
    types = {
        key: s.get(DeviceType, tenant=t, name=name,
                   defaults={"manufacturer": mfr, "model": name, "u_height": u})
        for key, (name, u) in TYPES.items()
    }
    roles = {
        slug: s.get(DeviceRole, tenant=t, slug=slug,
                    defaults={"name": slug.title(), "color": color})
        for slug, color in ROLES.items()
    }
    racks = {
        name: s.get(Rack, tenant=t, site=site, name=name, defaults={
            "location": loc_a, "room": server_room, "u_height": 42,
            "status": s.status("rack", "active"),
        })
        for name in ("R01", "R02")
    }
    cabinet = s.get(Cabinet, tenant=t, site=site, name="CAB-01", defaults={
        "location": loc_a, "room": office, "inner_width_mm": 500, "inner_height_mm": 600,
        "outer_width_mm": 600, "outer_height_mm": 700, "outer_depth_mm": 250,
    })
    devices = {}
    for name, (kind, role, rack, pos) in DEVICES.items():
        defaults = {
            "site": site, "device_type": types[kind], "role": roles[role],
            "status": s.status("device", "active"), "location": loc_a,
        }
        if rack == cabinet.name:
            defaults.update(cabinet=cabinet, room=office)
        elif rack:
            defaults.update(rack=racks[rack], position=pos, face="front", room=server_room)
        devices[name] = s.get(Device, tenant=t, name=name, defaults=defaults)
    ports = {}
    for name, d in devices.items():
        kind = DEVICES[name][0]
        if kind == "switch":
            spec = [(f"ge{i}", "1000base-t", False) for i in range(1, 21)]
            spec += [(f"sfp{i}", "10gbase-x-sfpp", i <= 2) for i in range(1, 5)]
        elif kind == "firewall":
            spec = [(f"ge{i}", "1000base-t", False) for i in range(1, 9)]
        else:
            spec = [(f"eth{i}", "10gbase-t", False) for i in range(0, 6)]
        for pname, ptype, uplink in spec:
            ports[(name, pname)] = s.get(Interface, device=d, name=pname,
                                         defaults={"type": ptype, "is_uplink": uplink})

    # ── the building plan: Ground and First ─────────────────────────────
    stack = s.get(FloorPlanStack, tenant=t, location=loc_a, name=STACK_NAME,
                  defaults={"site": site})
    gw, gh = GRID
    floors = {}
    for order, (name, elevation, ceiling) in enumerate(
        (("Ground", 0, 3200), ("First", 4000, 3000))
    ):
        floors[name] = s.get(FloorPlan, tenant=t, stack=stack, name=name, defaults={
            "site": site, "location": loc_a, "floor_order": order * 10,
            "elevation_mm": elevation, "ceiling_mm": ceiling, "cell_mm": CELL_MM,
            "grid_width": gw, "grid_height": gh,
        })
    ground, first = floors["Ground"], floors["First"]
    if not ground.state.get("demo"):
        # Cables and their labels on by default, on the demo plan only.
        ground.state = {**ground.state, "demo": True, "show_cable_links": True,
                        "show_cable_labels": True, "show_photos": True}
        ground.save(update_fields=["state"])

    def area(plan, *, x, y, w, h, **kw):
        key = {"room": kw.get("room"), "location": kw.get("location")}
        lookup = {k: v for k, v in key.items() if v is not None}
        if not lookup:
            lookup = {"label": kw.get("label", "")}
        return s.get(FloorPlanArea, floor_plan=plan, **lookup, defaults={
            "x": x, "y": y, "width": w, "height": h, **kw,
        })

    def walls(plan, a, label, openings):
        x, y, w, h = a.x, a.y, a.width, a.height
        return s.get(FloorPlanWall, floor_plan=plan, label=label, defaults={
            "points": [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
            "source_area": a, "openings": openings,
        })

    srv_area = area(ground, x=2, y=2, w=16, h=10, room=server_room)
    off_area = area(ground, x=21, y=2, w=16, h=10, room=office)
    area(ground, x=2, y=15, w=12, h=7, area_type=loading, label="Loading bay")
    # A door on the bottom side of each room (segment 2 runs right to left).
    walls(ground, srv_area, "Server room walls",
          [{"seg": 2, "from": 2, "to": 3.5, "hinge": "start", "side": "left"}])
    walls(ground, off_area, "Office walls",
          [{"seg": 2, "from": 11, "to": 12.5, "hinge": "end", "side": "right"},
           {"seg": 3, "from": 4, "to": 6}])
    s.get(FloorPlanRaisedFloorArea, floor_plan=ground, x=2, y=2, defaults={
        "width": 16, "height": 10, "plenum_mm": 400, "label": "Raised floor",
    })
    s.get(FloorPlanLabel, floor_plan=ground, text="Building A · Ground", defaults={
        "x": 21, "y": 14, "font_mm": 600, "weight": "bold",
    })
    s.get(FloorPlanLabel, floor_plan=ground, text="Hot aisle", defaults={
        "x": 4, "y": 7.2, "font_mm": 300, "color": "red",
    })
    up = s.get(FloorPlanLabel, floor_plan=ground, text="First floor ↑", defaults={
        "x": 30, "y": 18, "font_mm": 500, "plate": True, "plate_color": "blue",
        "opens": first,
    })
    s.get(FloorPlanLabel, floor_plan=first, pair_id=up.pk, defaults={
        "text": "Back to Demo HQ · Ground", "x": 0.5, "y": 0.5, "font_mm": 500,
        "plate": True, "plate_color": "blue", "opens": ground, "z": 1,
    })
    s.get(FloorPlanLabel, floor_plan=first, text="Building A · First", defaults={
        "x": 21, "y": 14, "font_mm": 600, "weight": "bold",
    })

    def tile(plan, label, *, x, y, kind, w=1, h=1, **kw):
        return s.get(FloorPlanTile, floor_plan=plan, label=label, defaults={
            "x": x, "y": y, "width": w, "height": h, "tile_type": tile_types[kind], **kw,
        })

    tile(ground, "R01", x=5, y=5, kind="rack", rack=racks["R01"], link_kind="rack")
    tile(ground, "R02", x=13, y=5, kind="rack", rack=racks["R02"], link_kind="rack")
    tile(ground, "CAB-01", x=34, y=4, kind="cabinet", cabinet=cabinet, link_kind="cabinet")
    riser_g = tile(ground, "Riser", x=16, y=10, kind="riser", riser=True)
    riser_f = tile(first, "Riser", x=16, y=10, kind="riser", riser=True)
    if riser_f.riser_to_id is None:
        riser_f.riser_to = riser_g
        riser_f.save(update_fields=["riser_to"])
    srv2 = devices["demo-srv2"]
    photo = bool(srv2.device_type.front_image)
    tile(first, "demo-srv2", x=6, y=6, kind="device", device=srv2, link_kind="device",
         display="photo" if photo else "icon")

    def tray(plan, name, points, level):
        return s.get(FloorPlanTray, floor_plan=plan, name=name, defaults={
            "points": points, "level": level,
            "kind": "ladder" if level == "overhead" else "basket",
        })

    tray(ground, "OH-1", [[5, 4], [17, 4]], "overhead")
    tray(ground, "OH-2", [[17, 4], [34, 4]], "overhead")
    tray(ground, "OH-3", [[17, 4], [17, 10]], "overhead")
    tray(ground, "UF-1", [[5, 7], [14, 7]], "underfloor")
    tray(first, "OH-F1", [[6, 5], [17, 5], [17, 10]], "overhead")

    # ── cables ──────────────────────────────────────────────────────────
    connected = s.status("cable", "connected")
    cables = {}
    for label, ctype, a_ends, b_ends, _how in CABLES:
        c = s.get(Cable, tenant=t, label=label, defaults={
            "type": ctype, "status": planned if label == PLANNED else connected,
            "description": "Breakout: one port to two devices" if label == BREAKOUT else "",
        })
        for end, ends in (("A", a_ends), ("B", b_ends)):
            for dev, port in ends:
                s.get(CableTermination, cable=c, end=end, interface=ports[(dev, port)])
        cables[label] = c

    # ── routes: stored once, kept on a re-run ───────────────────────────
    from api.cable_routing import PlanRouter, save_path, save_riser_route

    router = PlanRouter(ground)
    trays = {tr.name: tr for tr in ground.trays.all()}
    for label, _ctype, _a, _b, how in CABLES:
        c = cables[label]
        if how == "none":
            continue
        if FloorPlanCablePath.objects.filter(floor_plan=ground, cable=c).exists():
            continue
        if how == "riser":
            res = router.via_riser(c)
            if res is not None:
                save_riser_route(ground, c, res)
            continue
        route = router.route(
            c, tray_ids=[trays[n].pk for n in how] if isinstance(how, list) else None
        )
        if route is None:
            continue
        row = save_path(ground, c, route)
        s.created += 1
        if how == "stale":
            row.stale = True
            row.save(update_fields=["stale"])

    # ── the site-wide plan: the buildings, opening their plans ──────────
    campus = s.get(FloorPlanStack, tenant=t, site=site, location=None, name=OVERVIEW_NAME)
    overview = s.get(FloorPlan, tenant=t, stack=campus, name="Site", defaults={
        "site": site, "location": None, "cell_mm": 2000, "grid_width": 60, "grid_height": 40,
    })
    area(overview, x=8, y=8, w=14, h=9, location=loc_a, opens=ground)
    area(overview, x=32, y=14, w=12, h=16, location=loc_b)
    s.get(FloorPlanLabel, floor_plan=overview, text="Demo campus", defaults={
        "x": 8, "y": 3, "font_mm": 4000, "weight": "bold",
    })

    routes = FloorPlanCablePath.objects.filter(
        floor_plan__in=[ground, first], cable__in=cables.values()
    ).count()
    return {
        "created": s.created,
        "cables": len(cables),
        "routes": routes,
        "plans": {"ground": ground, "first": first, "overview": overview},
        "urls": [
            ("Demo HQ · Ground", f"/floorplans/{ground.pk}"),
            ("Demo HQ · First", f"/floorplans/{first.pk}"),
            (OVERVIEW_NAME, f"/floorplans/{overview.pk}"),
            ("Floor plan Demo HQ", f"/floorplans/stacks/{stack.pk}"),
        ],
    }
