"""seed_dc_test — opt-in test hall for the 3D room view.

Builds "DC-TEST": ten rows of ten cabinets in hot/cold aisle pairs, every
rack built from one rack type, stamped with A/B vertical PDUs, filled with
photo-faceplate gear, cabled inside and along each row, fed from two power
panels, and run under overhead tray.

Opt-in and re-runnable, never touched by bootstrap. `--wipe` tears the hall
down first so a test run starts from nothing.

    manage.py seed_dc_test --wipe
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Location,
    Manufacturer,
    PowerFeed,
    PowerOutlet,
    PowerOutletTemplate,
    PowerPanel,
    PowerPort,
    PowerPortTemplate,
    Rack,
    RackType,
    RackTypeAccessory,
    Site,
    materialize_device_components,
)
from api.pathfinding import route_through_trays
from core.models import Tenant

TENANT_SLUG = "acme"
SITE_NAME = "DC-TEST"
LOCATION_NAME = "DC-TEST Hall"
PLAN_NAME = "DC-TEST"

ROWS = "ABCDEFGHIJ"
PER_ROW = 10
RACK_X0 = 2  # first rack column
MARGIN = 2   # perimeter walkway, 1200 mm

# A rack is "front faces −Z" at orientation 0, and grid +y is +Z, so a row
# turns 180° to face DOWN the plan and 0° to face up.
FRONT_DOWN = 180
FRONT_UP = 0

# Everything below is in 600 mm grid cells, and every distance is a REAL one.
#
# The first pass put rows one cell apart, which looked fine on the flat plan
# and was nonsense in the room: a 1200 mm-deep cabinet centred on a 600 mm
# tile overhangs 300 mm each side, so two rows a single cell apart TOUCH and
# the hall had no aisles at all. A rack tile is therefore two cells deep, and
# aisles get the widths they need to be walked:
RACK_CELLS = 2   # 1200 mm — the cabinet's actual depth
COLD_CELLS = 3   # 1800 mm — people install gear from the front here
HOT_CELLS = 2    # 1200 mm — access only, so the tighter standard minimum


def _layout():
    """Rack rows and aisles down the hall, in facing pairs.

    Fronts look at each other across a COLD aisle; the backs of adjacent
    pairs vent into a shared HOT aisle. Returns (rows, colds, hots, height)
    where rows is [(row letter, y, orientation)].
    """
    rows, colds, hots = [], [], []
    y = MARGIN
    pairs = len(ROWS) // 2
    for p in range(pairs):
        # Top of the pair looks DOWN (+y) into the cold aisle beneath it…
        rows.append((ROWS[p * 2], y, FRONT_DOWN))
        y += RACK_CELLS
        colds.append(y)
        y += COLD_CELLS
        # …and its partner looks UP (−y) into the same aisle.
        rows.append((ROWS[p * 2 + 1], y, FRONT_UP))
        y += RACK_CELLS
        if p < pairs - 1:
            hots.append(y)
            y += HOT_CELLS
    return rows, colds, hots, y + MARGIN


GRID_W = RACK_X0 + PER_ROW + MARGIN

PDU_NAME = "DC-TEST Vertical PDU 24×C13"
PDU_OUTLETS = 24
RACK_TYPE_NAME = "DC-TEST 42U"
# 600 mm wide = EXACTLY one grid cell, so cabinets bay flush the way they do
# in a real row. The 800 mm variant of the first pass overhung its 600 mm
# tile by 100 mm a side, which collided every neighbour by 200 mm — the same
# mistake as the depth one, on the other axis. A 600 mm cabinet still leaves
# ~63 mm of zero-U channel each side, enough for the 50 mm PDU strips.
OUTER_W_MM = 600
OUTER_D_MM = 1200

FW_TYPE = "PA-3420"   # 1U, photo faceplate
SRV_TYPE = "System x3650 M5"  # 2U, photo faceplate

# A FULL cabinet, because half-empty racks tell you nothing about the room:
# a redundant pair of 1U firewalls on top, then 2U servers all the way down.
# 42U = 2×1U + 20×2U with nothing left over.
FW_US = (42, 41)
SRV_US = tuple(range(39, 0, -2))  # 39, 37 … 1 — twenty 2U servers


class Command(BaseCommand):
    help = "Seed the DC-TEST hall: 100 racks, PDUs, cabling, power and trays."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete the existing DC-TEST hall first (site, racks, "
                 "devices, plan) so the run starts clean.",
        )
        parser.add_argument(
            "--full-cabling",
            action="store_true",
            help="Cable EVERY device (~4500 cables) instead of a "
                 "representative set — for stressing the cables layer.",
        )
        parser.add_argument("--tenant", default=TENANT_SLUG)

    @transaction.atomic
    def handle(self, *args, **opts):
        tenant = Tenant.objects.filter(slug=opts["tenant"]).first()
        if tenant is None:
            self.stderr.write(f"No tenant with slug {opts['tenant']!r}.")
            return
        self.t = tenant

        if opts["wipe"]:
            self._wipe()

        site, loc = self._place()
        rack_type = self._rack_type()
        plan = self._plan(loc)
        racks = self._racks(site, loc, rack_type, plan)
        devices = self._devices(site, loc, racks)
        self._power(site, racks)
        # Trays before cabling: a run can only be pinned to a tray that
        # already exists, and the whole point of the overhead tray is that the
        # cross-hall runs follow it instead of flying through the cabinets.
        self._trays(plan)
        self._cable(plan, racks, devices, full=opts['full_cabling'])

        self.stdout.write(self.style.SUCCESS(
            f"DC-TEST ready — {len(racks)} racks, "
            f"{Device.objects.filter(site=site).count()} devices, "
            f"{Cable.objects.filter(tenant=tenant, label__startswith='DCT').count()} cables. "
            f"Open /floorplans/{plan.id}?viz=3d"
        ))

    # ── teardown ─────────────────────────────────────────────────────────
    def _wipe(self):
        site = Site.objects.filter(tenant=self.t, name=SITE_NAME).first()
        if site is None:
            return
        Cable.objects.filter(
            tenant=self.t, label__startswith="DCT"
        ).delete()
        FloorPlan.objects.filter(tenant=self.t, name=PLAN_NAME).delete()
        Device.objects.filter(site=site).delete()
        PowerFeed.objects.filter(power_panel__site=site).delete()
        PowerPanel.objects.filter(site=site).delete()
        Rack.objects.filter(site=site).delete()
        Location.objects.filter(site=site).delete()
        site.delete()
        self.stdout.write("wiped the previous DC-TEST hall")

    # ── catalog + place ──────────────────────────────────────────────────
    def _place(self):
        site, _ = Site.objects.get_or_create(tenant=self.t, name=SITE_NAME)
        loc, _ = Location.objects.get_or_create(
            tenant=self.t, site=site, slug="dc-test-hall",
            defaults={"name": LOCATION_NAME},
        )
        return site, loc

    def _pdu_type(self):
        """A 0U vertical PDU: one inlet, 24 switched C13 outlets."""
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=self.t, name="Danbyte Test Gear",
            defaults={"slug": "danbyte-test-gear"},
        )
        dt, made = DeviceType.objects.get_or_create(
            tenant=self.t, name=PDU_NAME,
            defaults={
                "manufacturer": mfr,
                "u_height": 0,          # 0U → side-mountable
                "is_full_depth": False,
                "exclude_from_utilization": True,
            },
        )
        if made or dt.power_outlet_templates.count() != PDU_OUTLETS:
            dt.power_outlet_templates.all().delete()
            PowerOutletTemplate.objects.bulk_create([
                PowerOutletTemplate(device_type=dt, name=f"C13-{i:02d}")
                for i in range(1, PDU_OUTLETS + 1)
            ])
        if not dt.power_port_templates.exists():
            PowerPortTemplate.objects.create(
                device_type=dt, name="inlet",
                maximum_draw=7360, allocated_draw=3000,
            )
        return dt

    def _fix_psu_names(self, dt):
        """Rename 0-based PSU templates to the 1-based pair operators use.

        The imported library types came in with `Psu 0 / Psu 1 / Psu 2` — a
        name range expanded from zero, so a dual-PSU server claimed three
        inlets and the first one was called PSU zero. Targeted on purpose: it
        only rewrites a type whose names actually show the 0-based pattern, so
        a hand-curated type is never clobbered. Runs before the devices are
        stamped, so their power ports come out right the first time.
        """
        ports = list(dt.power_port_templates.order_by("name"))
        if not any(p.name.strip().lower() in ("psu 0", "psu0") for p in ports):
            return
        keep = ports[0]
        draw = keep.maximum_draw
        alloc = keep.allocated_draw
        dt.power_port_templates.all().delete()
        PowerPortTemplate.objects.bulk_create([
            PowerPortTemplate(
                device_type=dt, name=f"PSU {i}",
                maximum_draw=draw, allocated_draw=alloc,
            )
            for i in (1, 2)
        ])
        self.stdout.write(f"  {dt.name}: PSU templates renumbered to 1-2")

    def _rack_type(self):
        pdu = self._pdu_type()
        rt, _ = RackType.objects.update_or_create(
            tenant=self.t, name=RACK_TYPE_NAME,
            defaults={
                "u_height": 42,
                "width": 19,
                "starting_unit": 1,
                "desc_units": False,
                "outer_width_mm": OUTER_W_MM,
                "outer_depth_mm": OUTER_D_MM,
                "max_weight": 1200,
                "max_weight_unit": "kg",
                "description": "Test cabinet: 42U, 600 mm wide so a row bays "
                               "flush; the rear channels take the PDUs.",
            },
        )
        # A and B strips, rear channel, one on each rail.
        for label, mount in (("PDU-A", "side_left"), ("PDU-B", "side_right")):
            RackTypeAccessory.objects.update_or_create(
                rack_type=rt, label=label,
                defaults={
                    "device_type": pdu,
                    "mount": mount,
                    "face": "rear",
                    "mount_offset_mm": 120,
                    "mount_span_u": 40,
                },
            )
        return rt

    def _plan(self, loc):
        *_, height = _layout()
        plan, _ = FloorPlan.objects.update_or_create(
            tenant=self.t, location=loc, name=PLAN_NAME,
            defaults={
                "grid_width": GRID_W,
                "grid_height": height,
                "cell_mm": 600,
                "ceiling_mm": 3200,
            },
        )
        return plan

    # ── racks + tiles + aisles ───────────────────────────────────────────
    def _tile_types(self):
        rack_tt, _ = FloorTileType.objects.get_or_create(
            tenant=self.t, slug="rack",
            defaults={"name": "Rack", "color": "#3b82f6"},
        )
        cold, _ = FloorTileType.objects.get_or_create(
            tenant=self.t, slug="dct-cold-aisle",
            defaults={
                "name": "Cold aisle", "color": "#3b82f6",
                "is_zone": True, "perforated": True,
            },
        )
        hot, _ = FloorTileType.objects.get_or_create(
            tenant=self.t, slug="dct-hot-aisle",
            defaults={"name": "Hot aisle", "color": "#dc2626", "is_zone": True},
        )
        return rack_tt, cold, hot

    def _racks(self, site, loc, rack_type, plan):
        rack_tt, cold, hot = self._tile_types()
        plan.tiles.all().delete()
        racks: dict[str, Rack] = {}

        rows, colds, hots, _ = _layout()
        for row, y, facing in rows:
            for i in range(PER_ROW):
                name = f"DCT-{row}{i + 1:02d}"
                rack, _ = Rack.objects.update_or_create(
                    tenant=self.t, name=name,
                    defaults={
                        "site": site,
                        "location": loc,
                        "rack_type": rack_type,
                        "u_height": 42,
                        "width": 19,
                        "starting_unit": 1,
                        "outer_width_mm": OUTER_W_MM,
                        "outer_depth_mm": OUTER_D_MM,
                        "max_weight": 1200,
                        "max_weight_unit": "kg",
                        "facility_id": f"{row}{i + 1:02d}",
                    },
                )
                racks[name] = rack
                FloorPlanTile.objects.create(
                    floor_plan=plan, tile_type=rack_tt,
                    # Two cells deep: the tile has to match the 1200 mm
                    # cabinet, or the rack overhangs into the aisle.
                    x=RACK_X0 + i, y=y, width=1, height=RACK_CELLS,
                    orientation=facing, rack=rack, link_kind="rack",
                    label=name,
                )

        # Aisles at their real widths: cold inside each facing pair, hot
        # between pairs. These are walkable spans, not one-cell slivers.
        for n, y in enumerate(colds):
            FloorPlanTile.objects.create(
                floor_plan=plan, tile_type=cold,
                x=RACK_X0, y=y, width=PER_ROW, height=COLD_CELLS,
                label=f"Cold {ROWS[n * 2]}/{ROWS[n * 2 + 1]}",
            )
        for n, y in enumerate(hots):
            FloorPlanTile.objects.create(
                floor_plan=plan, tile_type=hot,
                x=RACK_X0, y=y, width=PER_ROW, height=HOT_CELLS,
                label=f"Hot {ROWS[n * 2 + 1]}/{ROWS[n * 2 + 2]}",
            )
        return racks

    # ── devices ──────────────────────────────────────────────────────────
    def _role(self, name, color):
        role, _ = DeviceRole.objects.get_or_create(
            tenant=self.t, slug=f"dct-{name.lower()}",
            defaults={"name": name, "color": color},
        )
        return role

    def _devices(self, site, loc, racks):
        fw_type = DeviceType.objects.get(tenant=self.t, name=FW_TYPE)
        srv_type = DeviceType.objects.get(tenant=self.t, name=SRV_TYPE)
        self._fix_psu_names(srv_type)
        self._fix_psu_names(fw_type)
        fw_role = self._role("Firewall", "#ef4444")
        srv_role = self._role("Server", "#10b981")

        out: dict[str, dict] = {}
        for name, rack in racks.items():
            made = {"fw": [], "srv": [], "pdu": []}
            for n, u in enumerate(FW_US, start=1):
                fw, _ = Device.objects.update_or_create(
                    tenant=self.t, name=f"{name}-fw{n}",
                    defaults={
                        "site": site, "location": loc, "rack": rack,
                        "device_type": fw_type, "role": fw_role,
                        "position": u, "face": "front",
                    },
                )
                materialize_device_components(fw)
                made["fw"].append(fw)
            for n, u in enumerate(SRV_US, start=1):
                srv, _ = Device.objects.update_or_create(
                    tenant=self.t, name=f"{name}-srv{n}",
                    defaults={
                        "site": site, "location": loc, "rack": rack,
                        "device_type": srv_type, "role": srv_role,
                        "position": u, "face": "front",
                    },
                )
                materialize_device_components(srv)
                made["srv"].append(srv)
            # The rack type's A/B strips.
            for label, mount in (("PDU-A", "side_left"), ("PDU-B", "side_right")):
                pdu, _ = Device.objects.update_or_create(
                    tenant=self.t, name=f"{name}-{label}",
                    defaults={
                        "site": site, "location": loc, "rack": rack,
                        "device_type": self._pdu_type(),
                        "role": self._role("PDU", "#f59e0b"),
                        "mount": mount, "face": "rear",
                        "mount_offset_mm": 120, "mount_span_u": 40,
                    },
                )
                materialize_device_components(pdu)
                made["pdu"].append(pdu)
            out[name] = made
        return out

    # ── power ────────────────────────────────────────────────────────────
    def _power(self, site, racks):
        panels = {}
        for side in ("A", "B"):
            panels[side], _ = PowerPanel.objects.get_or_create(
                tenant=self.t, site=site, name=f"DC-TEST Panel {side}",
            )
        for name, rack in racks.items():
            for side in ("A", "B"):
                PowerFeed.objects.update_or_create(
                    tenant=self.t, power_panel=panels[side],
                    name=f"{name}-{side}",
                    defaults={
                        # A = primary, B = redundant: the two-feed A/B story the
                        # 3D room tints the PDU strips by (blue vs red).
                        "rack": rack,
                        "type": "primary" if side == "A" else "redundant",
                        "supply": "ac", "phase": "single",
                        "voltage": 230, "amperage": 32, "max_utilization": 80,
                    },
                )

    # ── cabling ──────────────────────────────────────────────────────────
    def _link(self, label, kind, colour, a, b):
        """One cable between two components, idempotent on its label."""
        if a is None or b is None:
            return None
        if Cable.objects.filter(tenant=self.t, label=label).exists():
            return None
        cable = Cable.objects.create(
            tenant=self.t, label=label, type=kind, color=colour,
        )
        for end, point in (("A", a), ("B", b)):
            field = {
                Interface: "interface",
                PowerPort: "power_port",
                PowerOutlet: "power_outlet",
                PowerFeed: "power_feed",
            }[type(point)]
            CableTermination.objects.create(
                cable=cable, end=end, **{field: point}
            )
        return cable

    def _cable(self, plan, racks, devices, full=False):
        """Wire the hall.

        A full cabinet holds 22 devices, so cabling every port would mint
        ~4500 cables — past the point where the room draws tubes at all and
        slow to resolve. The default is a REPRESENTATIVE set: both firewalls
        and two servers powered A+B, four data drops, both feeds, plus the
        row chains. `--full-cabling` wires every device for stress testing.
        """
        for name in sorted(racks):
            d = devices[name]
            fws, srvs, pdus = d["fw"], d["srv"], d["pdu"]
            banks = [list(p.power_outlets.order_by("name")) for p in pdus]

            # Data: firewalls down into the servers below them.
            drops = srvs if full else srvs[:4]
            fw_ports = [
                list(fw.interfaces.order_by("name")) for fw in fws
            ]
            for n, srv in enumerate(drops):
                fw_i = n % len(fws)
                port = srv.interfaces.filter(name="Ethernet 1").first()
                ports = fw_ports[fw_i]
                slot = n // len(fws)
                if slot < len(ports):
                    self._link(
                        f"DCT {srv.name} uplink", "cat6", "#0ea5e9",
                        ports[slot], port,
                    )

            # Power: A and B cords, so each device has real redundancy.
            powered = [*fws, *(srvs if full else srvs[:2])]
            for slot, dev in enumerate(powered):
                dev_ports = list(dev.power_ports.order_by("name"))
                for j, port in enumerate(dev_ports[:2]):
                    bank = banks[j] if j < len(banks) else []
                    if slot < len(bank):
                        self._link(
                            f"DCT {dev.name} psu{j + 1}", "power", "#f59e0b",
                            port, bank[slot],
                        )

            # Power: each strip's inlet back to its own feed.
            for side, pdu in zip(("A", "B"), pdus):
                inlet = pdu.power_ports.filter(name="inlet").first()
                feed = PowerFeed.objects.filter(
                    tenant=self.t, name=f"{name}-{side}"
                ).first()
                self._link(
                    f"DCT {name} {side} feed", "power", "#dc2626", inlet, feed
                )

        # Data: chain each row rack-to-rack, so runs cross the hall and have
        # to follow the tray rather than hop straight through the cabinets.
        trays = list(plan.trays.all())
        cells = {
            t.rack.name: (t.x + t.width / 2, t.y + t.height / 2)
            for t in plan.tiles.select_related("rack").filter(
                rack__isnull=False
            )
        }
        routed = 0
        for row in ROWS:
            for i in range(PER_ROW - 1):
                a = devices[f"DCT-{row}{i + 1:02d}"]["fw"][0]
                b = devices[f"DCT-{row}{i + 2:02d}"]["fw"][0]
                pa = a.interfaces.filter(name__endswith="/24").first()
                pb = b.interfaces.filter(name__endswith="/23").first()
                cable = self._link(
                    f"DCT row {row} {i + 1}→{i + 2}", "smf-os2", "#facc15",
                    pa, pb,
                )
                if cable is not None:
                    routed += self._route(
                        cable,
                        cells.get(f"DCT-{row}{i + 1:02d}"),
                        cells.get(f"DCT-{row}{i + 2:02d}"),
                        trays,
                    )
        self.stdout.write(f"  {routed} row runs pinned to the tray")

    def _route(self, cable, a, b, trays):
        """Pin a run to the trays it actually follows, through the SAME
        Dijkstra the auto-route endpoint uses. Without this every seeded cable
        is point-to-point and the 3D room draws it arcing over the cabinets in
        free air, with the tray sitting there unused."""
        if a is None or b is None or not trays:
            return 0
        result = route_through_trays(a, b, [t.points for t in trays])
        if not result.reachable:
            return 0
        cable.trays.add(*[trays[i] for i in result.tray_indexes])
        return 1

    # ── trays ────────────────────────────────────────────────────────────
    def _trays(self, plan):
        plan.trays.all().delete()
        rows, _, _, _ = _layout()
        x0, x1 = RACK_X0, RACK_X0 + PER_ROW
        spine_x = x0 - 1
        # A spine down the west margin, and a branch over the centre of every
        # rack row (a rack tile is RACK_CELLS deep, so + half of that).
        FloorPlanTray.objects.create(
            floor_plan=plan, name="Spine", kind="ladder", color="#eab308",
            level="overhead", elevation_mm=2900,
            points=[
                [spine_x, rows[0][1]],
                [spine_x, rows[-1][1] + RACK_CELLS / 2],
            ],
        )
        for row, y, _facing in rows:
            mid = y + RACK_CELLS / 2
            FloorPlanTray.objects.create(
                floor_plan=plan, name=f"Row {row}", kind="ladder",
                color="#eab308", level="overhead", elevation_mm=2700,
                points=[[spine_x, mid], [x1, mid]],
            )
