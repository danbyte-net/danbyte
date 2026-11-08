"""seed_building_demo - an opt-in demo of building levels (aligned floors).

In one tenant, at the site "Demo campus", a location "Tower" with an aligned
floor plan "Demo tower" of five levels - B1, Ground, 1, 2 and 3 - made the
way an operator makes them: Ground is drawn first, then each other level is
added with **Same footprint** and **Copy outer walls**
(``floor_stacks.add_floor``). Every level has the exterior shell, a central
core (stair, lift and riser closet) with walls, a corridor with doors, and
rooms drawn as areas linked to Rooms. B1 holds a server room with six racks,
a core switch, servers, a UPS and a cooling unit; each floor above has an
IDF rack with an access switch and access points, and desks on the office
floors. Two risers stand in the core through every level
(``floor_stacks.riser_through``); each floor's access switch has two fibres
down to the B1 core switch routed up the shaft, and the access points are
cabled to their floor's switch along the corridor trays.

Re-runnable: everything is found by name and made only when missing, so a
second run changes nothing and keeps what was edited since. Never part of
bootstrap or a migration - demo inventory is opt-in:

    .venv/bin/python manage.py seed_building_demo --tenant <slug>
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.models import (
    AreaType,
    Cable,
    CableTermination,
    CoolingSource,
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
)
from api.status_registry import resolve_status, seed_builtin_statuses
from core.models import Tenant

SITE_NAME = "Demo campus"
LOCATION_NAME = "Tower"
STACK_NAME = "Demo tower"
CELL_MM = 600
#: Every level: 30 × 20 cells (18 m × 12 m).
GRID = (30, 20)
#: Levels, lowest first: name → (short key for device names, ceiling mm).
LEVELS = {
    "B1": ("b1", 3600),
    "Ground": ("g", 3400),
    "1": ("l1", 3000),
    "2": ("l2", 3000),
    "3": ("l3", 3000),
}
UPPER = ["Ground", "1", "2", "3"]

# ─── the shared drawing: shell, corridor, core, IDF ─────────────────────────
#
# North rooms: y 0-8. Corridor: y 8-11. South: the core at x 13-17
# (stair west, lift and riser closet east), the IDF at x 17-20, rooms either
# side. Walls are polylines in cells; openings are spans along a segment.

SHELL = [[0, 0], [30, 0], [30, 20], [0, 20], [0, 0]]
#: The main entrance, in Ground's shell only (copies clear openings).
ENTRANCE = [{"seg": 2, "from": 23, "to": 25}]

CORE_WALLS = {
    # The core's outline; the stair and lift open on the corridor.
    "Core": ([[13, 11], [17, 11], [17, 17], [13, 17], [13, 11]], [
        {"seg": 0, "from": 0.4, "to": 1.6, "hinge": "start", "side": "left"},
        {"seg": 0, "from": 2.4, "to": 3.6},
    ]),
    "Lift shaft": ([[15, 11], [15, 13.5], [17, 13.5]], []),
    "Riser closet": ([[15, 17], [15, 14], [17, 14]], [
        {"seg": 0, "from": 1.2, "to": 2.4, "hinge": "end", "side": "right"},
    ]),
    "IDF": ([[17, 15], [20, 15], [20, 11]], []),
}

#: Riser closet: two risers side by side, through every level.
RISERS = {"Riser A": (15, 15), "Riser B": (16, 15)}
#: The IDF rack's tile on every level above B1.
IDF_TILE = (18, 12)

#: Overhead trays on every level: along the corridor, into the riser
#: closet and into the IDF.
TRAYS = {
    "Corridor": [[1, 9.5], [29, 9.5]],
    "To riser": [[16, 9.5], [16, 15]],
    "To IDF": [[18.5, 9.5], [18.5, 12]],
}

# ─── per level: rooms, partitions, doors, tiles, devices ────────────────────

#: Rooms as (name, code, x, y, w, h). Names are unique in the Tower.
ROOMS = {
    "B1": [
        ("Server room", "B1.01", 0, 0, 14, 8),
        ("Plant room", "B1.02", 14, 0, 16, 8),
        ("Storage", "B1.03", 0, 11, 13, 9),
        ("Bike store", "B1.04", 20, 11, 10, 9),
    ],
    "Ground": [
        ("Lobby", "G.01", 0, 0, 30, 8),
        ("Reception", "G.02", 0, 11, 13, 9),
        ("Café", "G.03", 20, 11, 10, 9),
    ],
    "1": [
        ("Open office 1", "1.01", 0, 0, 30, 8),
        ("Team room 1", "1.02", 0, 11, 13, 9),
        ("Kitchen 1", "1.03", 20, 11, 10, 9),
    ],
    "2": [
        ("Open office 2", "2.01", 0, 0, 20, 8),
        ("Focus rooms", "2.02", 20, 0, 10, 8),
        ("Team room 2", "2.03", 0, 11, 13, 9),
        ("Print & kitchen 2", "2.04", 20, 11, 10, 9),
    ],
    "3": [
        ("Meeting room A", "3.01", 0, 0, 10, 8),
        ("Meeting room B", "3.02", 10, 0, 10, 8),
        ("Meeting room C", "3.03", 20, 0, 10, 8),
        ("Board room", "3.04", 0, 11, 13, 9),
        ("Training room", "3.05", 20, 11, 10, 9),
    ],
}

#: Doors from the corridor: x spans on the north wall (y 8) and on the
#: south wall's west (x 0-13) and east (x 17-30) parts.
DOORS_NORTH = {
    "B1": [(5, 6.5), (20, 21.5)],
    "Ground": [(4, 7), (22, 25)],
    "1": [(4, 7), (22, 25)],
    "2": [(8, 9.5), (24, 25.5)],
    "3": [(4, 5.5), (14, 15.5), (24, 25.5)],
}
DOORS_SOUTH = {"west": (6, 7.5), "east": [(18, 19), (24, 25.5)]}

#: Vertical partitions: (x, y from, y to).
PARTITIONS = {
    "B1": [(14, 0, 8)],
    "Ground": [],
    "1": [],
    "2": [(20, 0, 8)],
    "3": [(10, 0, 8), (20, 0, 8)],
}

#: Desk areas (tiles of the demo desk type): (label, x, y, w, h).
DESKS = {
    "Ground": [("Reception desk", 4, 14, 4, 1)],
    "1": [("Desks 1A", 2, 2, 4, 2), ("Desks 1B", 8, 2, 4, 2), ("Desks 1C", 17, 2, 4, 2),
          ("Desks 1D", 23, 2, 4, 2), ("Desks 1E", 2, 5, 4, 2), ("Desks 1F", 23, 5, 4, 2)],
    "2": [("Desks 2A", 2, 2, 4, 2), ("Desks 2B", 8, 2, 4, 2), ("Desks 2C", 14, 2, 4, 2),
          ("Desks 2D", 2, 5, 4, 2), ("Desks 2E", 8, 5, 4, 2)],
    "3": [("Table A", 3, 3, 4, 2), ("Table B", 13, 3, 4, 2), ("Table C", 23, 3, 4, 2),
          ("Board table", 3, 14, 6, 2)],
}

#: Access points per level: (x, y). Named <level key>-ap<n>.
APS = {
    "Ground": [(6, 4), (24, 4), (6, 16)],
    "1": [(5, 4), (15, 4), (25, 4)],
    "2": [(5, 4), (15, 4), (25, 3)],
    "3": [(5, 4), (15, 4), (25, 4), (6, 15)],
}

#: B1's server room: racks in a row, the core switch in R03.
SERVER_RACKS = ["R01", "R02", "R03", "R04", "R05", "R06"]
B1_DEVICES = {
    # name: (type key, role key, rack, position)
    "tower-core1": ("core", "core", "R03", 40),
    "tower-pp-b1": ("panel", "panel", "R03", 42),
    "tower-srv1": ("server", "server", "R02", 20),
    "tower-srv2": ("server", "server", "R04", 20),
    "tower-srv3": ("server", "server", "R04", 24),
}

#: Device types: key → (name, U, (width, height, depth) mm or None).
TYPES = {
    "core": ("Demo Core Switch 32", 1, None),
    "access": ("Demo Access Switch 48", 1, None),
    "server": ("Demo Server 2U", 2, None),
    "panel": ("Demo Patch Panel 24", 1, None),
    "ap": ("Demo AP", 0, (220, 45, 220)),
}
#: Roles: key → (an existing role's name to use, demo slug, colour).
ROLES = {
    "core": ("Core", "demo-core", "#0ea5e9"),
    "switch": ("Switch", "demo-switch", "#0ea5e9"),
    "server": ("Server", "demo-server", "#8b5cf6"),
    "panel": ("Patch panel", "demo-patch-panel", "#64748b"),
    "ap": ("Access point", "demo-access-point", "#22c55e"),
}


class Command(BaseCommand):
    help = "Seed an opt-in demo building: an aligned floor plan of five levels."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", required=True, help="The tenant's slug.")

    def handle(self, *args, tenant: str, **options):
        t = Tenant.objects.filter(slug=tenant).first()
        if t is None:
            raise CommandError(f"No tenant with the slug {tenant!r}.")
        made = seed(t)
        out = self.stdout
        out.write(self.style.SUCCESS(f"Demo building ready in {t.name}:"))
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


def _role(s, key):
    name, slug, color = ROLES[key]
    found = DeviceRole.objects.filter(tenant=s.t, name__iexact=name).order_by("slug").first()
    if found is not None:
        return found
    return s.get(DeviceRole, tenant=s.t, slug=slug,
                 defaults={"name": f"Demo {name.lower()}", "color": color})


def _ports(kind):
    if kind == "core":
        return [(f"sfp{i}", "10gbase-x-sfpp", False) for i in range(1, 17)] + [
            (f"te{i}", "10gbase-t", False) for i in range(1, 9)
        ]
    if kind == "access":
        return [(f"ge{i}", "1000base-t", False) for i in range(1, 25)] + [
            (f"sfp{i}", "10gbase-x-sfpp", True) for i in (1, 2)
        ]
    if kind == "server":
        return [(f"eth{i}", "10gbase-t", False) for i in range(0, 4)]
    if kind == "ap":
        return [("eth0", "1000base-t", False)]
    return []


@transaction.atomic
def seed(tenant) -> dict:
    """Make (or find) the demo building in ``tenant``. Answers the pages and
    counts."""
    from api.cable_routing import PlanRouter, save_path, save_riser_route
    from api.floor_stacks import add_floor, ordered_floors, riser_through

    seed_builtin_statuses(tenant)
    s = _Seed(tenant)
    t = tenant
    site = s.get(Site, tenant=t, name=SITE_NAME)
    building = s.get(LocationType, tenant=t, slug="building", defaults={"name": "Building"})
    tower = s.get(Location, tenant=t, site=site, slug="demo-tower",
                  defaults={"name": LOCATION_NAME, "location_type": building})

    # ── catalogs (demo only) ────────────────────────────────────────────
    def tile_type(slug, name, color, icon, **kw):
        return s.get(FloorTileType, tenant=t, slug=slug, defaults={
            "name": name, "color": color, "icon": icon, **kw,
        })

    tt = {
        "rack": tile_type("rack", "Rack", "#64748b", "server"),
        "riser": tile_type("riser", "Riser", "#0d9488", "arrow-up-down"),
        "device": tile_type("device", "Device", "#6366f1", "hard-drive"),
        "ups": tile_type("demo-ups", "UPS", "#f59e0b", "battery-charging",
                         default_width=2, default_height=1),
        "cooling": tile_type("demo-cooling", "Cooling unit", "#38bdf8", "snowflake",
                             default_width=1, default_height=2),
        "desks": tile_type("demo-desks", "Desks", "#a3a3a3", "armchair",
                           default_width=4, default_height=2),
    }
    core_type = s.get(AreaType, tenant=t, slug="demo-core", defaults={
        "name": "Core", "color": "#94a3b8", "pattern": "hatched", "icon": "arrow-up-down",
    })
    mfr = s.get(Manufacturer, tenant=t, name="Demo", defaults={"slug": "demo"})
    types = {}
    for key, (name, u, size) in TYPES.items():
        defaults = {"manufacturer": mfr, "model": name, "u_height": u}
        if size:
            defaults.update(width_mm=size[0], height_mm=size[1], depth_mm=size[2])
        types[key] = s.get(DeviceType, tenant=t, name=name, defaults=defaults)
    roles = {key: _role(s, key) for key in ROLES}
    active = s.status("device", "active")

    # ── the stack: Ground first, then the other levels on its footprint ─
    stack = s.get(FloorPlanStack, tenant=t, location=tower, name=STACK_NAME,
                  defaults={"site": site})
    gw, gh = GRID
    ground = s.get(FloorPlan, tenant=t, stack=stack, name="Ground", defaults={
        "site": site, "location": tower, "floor_order": 0, "cell_mm": CELL_MM,
        "grid_width": gw, "grid_height": gh, "ceiling_mm": LEVELS["Ground"][1],
    })
    s.get(FloorPlanWall, floor_plan=ground, label="Shell", defaults={
        "points": SHELL, "exterior": True, "openings": ENTRANCE, "thickness_mm": 300,
    })
    have = set(FloorPlan.objects.filter(stack=stack).values_list("name", flat=True))
    below = ground
    if "B1" not in have:
        b1 = add_floor(stack, "B1", below=True, copy_from=ground,
                       same_footprint=True, copy_walls=True)
        b1.ceiling_mm = LEVELS["B1"][1]
        b1.save(update_fields=["ceiling_mm", "updated_at"])
        s.created += 1
    for name in ("1", "2", "3"):
        if name not in have:
            below = add_floor(stack, name, copy_from=below,
                              same_footprint=True, copy_walls=True)
            s.created += 1
        else:
            below = FloorPlan.objects.get(stack=stack, name=name)
    levels = {f.name: f for f in ordered_floors(stack) if f.name in LEVELS}
    # Cables on by default, in 2D and in 3D, on the demo levels only.
    for plan in levels.values():
        if not plan.state.get("demo_building"):
            plan.state = {**plan.state, "demo_building": True, "show_cable_links": True,
                          "show_3d_cables": True}
            plan.save(update_fields=["state"])

    # ── what every level has: core, corridor, rooms, trays ──────────────
    def wall(plan, label, points, openings=(), **kw):
        return s.get(FloorPlanWall, floor_plan=plan, label=label, defaults={
            "points": points, "openings": list(openings), **kw,
        })

    def area(plan, label, *, x, y, w, h, **kw):
        lookup = {"room": kw["room"]} if kw.get("room") else {"label": label}
        return s.get(FloorPlanArea, floor_plan=plan, **lookup, defaults={
            "x": x, "y": y, "width": w, "height": h,
            **({"label": label} if not kw.get("room") else {}), **kw,
        })

    def tile(plan, label, *, x, y, kind, w=1, h=1, **kw):
        return s.get(FloorPlanTile, floor_plan=plan, label=label, defaults={
            "x": x, "y": y, "width": w, "height": h, "tile_type": tt[kind], **kw,
        })

    def doors(spans, start, *, hinge="start"):
        return [{"seg": 0, "from": a - start, "to": b - start, "hinge": hinge, "side": "left"}
                for a, b in spans]

    rooms = {}
    for name, plan in levels.items():
        for label, (points, openings) in CORE_WALLS.items():
            if label == "IDF" and name == "B1":
                continue
            wall(plan, label, points, openings)
        wall(plan, "Corridor north", [[0, 8], [30, 8]], doors(DOORS_NORTH[name], 0))
        wall(plan, "Corridor south west", [[0, 11], [13, 11]],
             doors([DOORS_SOUTH["west"]], 0, hinge="end"))
        east = DOORS_SOUTH["east"] if name != "B1" else DOORS_SOUTH["east"][1:]
        wall(plan, "Corridor south east", [[17, 11], [30, 11]], doors(east, 17))
        wall(plan, "South partitions", [[13, 17], [13, 20]])
        wall(plan, "South east partition", [[20, 15], [20, 20]] if name != "B1"
             else [[20, 11], [20, 20]])
        for i, (x, y0, y1) in enumerate(PARTITIONS[name], 1):
            wall(plan, f"Partition {i}", [[x, y0], [x, y1]])
        area(plan, "Corridor", x=0, y=8, w=30, h=3, color="#e2e8f0", show_name=True)
        area(plan, "Core", x=13, y=11, w=4, h=6, area_type=core_type)
        for rname, code, x, y, w, h in ROOMS[name]:
            room = s.get(Room, tenant=t, location=tower, name=rname,
                         defaults={"code": code, "slug": code.lower().replace(".", "-")})
            rooms[rname] = room
            area(plan, rname, x=x, y=y, w=w, h=h, room=room)
        for tname, points in TRAYS.items():
            if name == "B1" and tname == "To IDF":
                continue
            s.get(FloorPlanTray, floor_plan=plan, name=f"{tname} {name}", defaults={
                "points": points, "level": "overhead", "kind": "ladder",
            })
        for label, x, y, w, h in DESKS.get(name, []):
            tile(plan, label, x=x, y=y, kind="desks", w=w, h=h)
        s.get(FloorPlanLabel, floor_plan=plan, text=f"Tower · {name}", defaults={
            "x": 21, "y": 17.5, "font_mm": 500, "weight": "bold",
        })

    # ── B1: the server room ─────────────────────────────────────────────
    b1 = levels["B1"]
    server_room = rooms["Server room"]
    racks = {}
    for i, rname in enumerate(SERVER_RACKS):
        rack = s.get(Rack, tenant=t, site=site, name=f"TWR-{rname}", defaults={
            "location": tower, "room": server_room, "u_height": 42,
            "status": s.status("rack", "active"),
        })
        racks[rname] = rack
        tile(b1, rack.name, x=3 + i, y=3, kind="rack", h=2, rack=rack, link_kind="rack")
    s.get(FloorPlanRaisedFloorArea, floor_plan=b1, x=1, y=1, defaults={
        "width": 12, "height": 6, "plenum_mm": 400, "label": "Raised floor",
    })
    tile(b1, "UPS-1", x=10, y=1, kind="ups", w=2, h=1)
    crah = s.get(CoolingSource, tenant=t, site=site, name="Tower CRAH-1", defaults={
        "location": tower, "type": "crah", "fluid": "water", "rated_capacity_w": 40000,
    })
    tile(b1, "CRAH-1", x=11, y=4, kind="cooling", h=2, cooling_source=crah,
         link_kind="coolingsource")
    s.get(FloorPlanTray, floor_plan=b1, name="Server row B1", defaults={
        "points": [[3, 2.5], [12.5, 2.5], [12.5, 9.5]], "level": "overhead", "kind": "ladder",
    })

    devices = {}
    for dname, (kind, role, rname, pos) in B1_DEVICES.items():
        devices[dname] = s.get(Device, tenant=t, name=dname, defaults={
            "site": site, "device_type": types[kind], "role": roles[role], "status": active,
            "location": tower, "room": server_room, "rack": racks[rname], "position": pos,
            "face": "front",
        })

    # ── the floors above: IDF rack, access switch, APs ──────────────────
    for name in UPPER:
        plan, key = levels[name], LEVELS[name][0]
        idf = rooms.get(f"IDF {name}") or s.get(
            Room, tenant=t, location=tower, name=f"IDF {name}",
            defaults={"code": f"{key.upper()}.IDF", "slug": f"idf-{key}"},
        )
        area(plan, f"IDF {name}", x=17, y=11, w=3, h=4, room=idf)
        rack = s.get(Rack, tenant=t, site=site, name=f"TWR-IDF-{key.upper()}", defaults={
            "location": tower, "room": idf, "u_height": 24,
            "status": s.status("rack", "active"),
        })
        x, y = IDF_TILE
        tile(plan, rack.name, x=x, y=y, kind="rack", h=2, rack=rack, link_kind="rack")
        devices[f"tower-{key}-sw1"] = s.get(Device, tenant=t, name=f"tower-{key}-sw1", defaults={
            "site": site, "device_type": types["access"], "role": roles["switch"],
            "status": active, "location": tower, "room": idf, "rack": rack, "position": 20,
            "face": "front",
        })
        devices[f"tower-{key}-pp1"] = s.get(Device, tenant=t, name=f"tower-{key}-pp1", defaults={
            "site": site, "device_type": types["panel"], "role": roles["panel"],
            "status": active, "location": tower, "room": idf, "rack": rack, "position": 22,
            "face": "front",
        })
        for i, (ax, ay) in enumerate(APS[name], 1):
            ap = s.get(Device, tenant=t, name=f"tower-{key}-ap{i}", defaults={
                "site": site, "device_type": types["ap"], "role": roles["ap"],
                "status": active, "location": tower,
            })
            devices[ap.name] = ap
            tile(plan, ap.name, x=ax, y=ay, kind="device", device=ap, link_kind="device")

    ports = {}
    for dname, d in devices.items():
        kind = next(k for k, (tname, _u, _s) in TYPES.items() if tname == d.device_type.name)
        for pname, ptype, uplink in _ports(kind):
            ports[(dname, pname)] = s.get(Interface, device=d, name=pname,
                                          defaults={"type": ptype, "is_uplink": uplink})

    # ── risers: drawn on Ground, placed through every level ─────────────
    risers = {}
    for label, (x, y) in RISERS.items():
        r = tile(ground, label, x=x, y=y, kind="riser", riser=True)
        others = [str(p.pk) for p in levels.values() if p.pk != ground.pk]
        before = FloorPlanTile.objects.filter(floor_plan__stack=stack, riser=True).count()
        riser_through(r, others, may_add=lambda _p: True, may_delete=lambda _t: True)
        s.created += (
            FloorPlanTile.objects.filter(floor_plan__stack=stack, riser=True).count() - before
        )
        risers[label] = {
            tl.floor_plan_id: tl
            for tl in FloorPlanTile.objects.filter(floor_plan__stack=stack, riser=True, label=label)
        }

    # ── cables ──────────────────────────────────────────────────────────
    connected = s.status("cable", "connected")
    #: label → (type, (device, port), (device, port), how, plan): how is
    #: a riser label (up that riser to B1) or "trays" (along this level's).
    cables_spec = []
    for n, name in enumerate(UPPER):
        key = LEVELS[name][0]
        sw = f"tower-{key}-sw1"
        cables_spec.append((f"TWR-F-{key.upper()}-A", "smf", (sw, "sfp1"),
                            ("tower-core1", f"sfp{2 * n + 1}"), "Riser A", name))
        cables_spec.append((f"TWR-F-{key.upper()}-B", "smf", (sw, "sfp2"),
                            ("tower-core1", f"sfp{2 * n + 2}"), "Riser B", name))
        for i in range(1, len(APS[name]) + 1):
            cables_spec.append((f"TWR-{key.upper()}-AP{i}", "cat6", (f"tower-{key}-ap{i}", "eth0"),
                                (sw, f"ge{i}"), "trays", name))
    for i, srv in enumerate(("tower-srv1", "tower-srv2", "tower-srv3"), 1):
        cables_spec.append((f"TWR-B1-S{i}", "cat6a", (srv, "eth0"),
                            ("tower-core1", f"te{i}"), "trays", "B1"))
    cables = {}
    for label, ctype, a, b, _how, _lvl in cables_spec:
        c = s.get(Cable, tenant=t, label=label, defaults={"type": ctype, "status": connected})
        s.get(CableTermination, cable=c, end="A", interface=ports[a])
        s.get(CableTermination, cable=c, end="B", interface=ports[b])
        cables[label] = c

    # ── routes: stored once, kept on a re-run ───────────────────────────
    routers = {}

    def router(plan):
        if plan.pk not in routers:
            routers[plan.pk] = PlanRouter(plan)
        return routers[plan.pk]

    for label, _ctype, _a, _b, how, lvl in cables_spec:
        plan, c = levels[lvl], cables[label]
        if FloorPlanCablePath.objects.filter(floor_plan=plan, cable=c).exists():
            continue
        r = router(plan)
        if how == "trays":
            route = r.route(c)
            if route is not None:
                save_path(plan, c, route)
                s.created += 1
            continue
        riser = risers[how].get(plan.pk)
        res = r.via_riser(c, routers=routers, only=riser.pk if riser else None)
        if res is not None:
            save_riser_route(plan, c, res)
            s.created += 2

    routes = FloorPlanCablePath.objects.filter(cable__in=cables.values()).count()
    return {
        "created": s.created,
        "cables": len(cables),
        "routes": routes,
        "stack": stack,
        "levels": levels,
        "urls": [(f"{STACK_NAME} · {n}", f"/floorplans/{p.pk}") for n, p in levels.items()]
        + [(f"Floor plan {STACK_NAME}", f"/floorplans/stacks/{stack.pk}")],
    }
