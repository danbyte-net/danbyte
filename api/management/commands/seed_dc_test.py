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
from core.models import Tenant

TENANT_SLUG = "acme"
SITE_NAME = "DC-TEST"
LOCATION_NAME = "DC-TEST Hall"
PLAN_NAME = "DC-TEST"

ROWS = "ABCDEFGHIJ"
PER_ROW = 10
RACK_X0 = 2  # first rack column
# Rows sit in facing PAIRS: fronts look at each other across a COLD aisle,
# backs vent into the HOT aisle between pairs. Five pairs of two rows.
ROW_Y = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
GRID_W = RACK_X0 + PER_ROW + 2
GRID_H = ROW_Y[-1] + 3

# A rack is "front faces −Z" at orientation 0, and grid +y is +Z, so an
# even-indexed row (the top of a pair) turns 180° to face down into the cold
# aisle below it, and its partner faces up into the same aisle.
FRONT_DOWN = 180
FRONT_UP = 0

PDU_NAME = "DC-TEST Vertical PDU 24×C13"
PDU_OUTLETS = 24
RACK_TYPE_NAME = "DC-TEST 42U 800mm"
OUTER_W_MM = 800  # 800 mm gives a real zero-U channel for the PDUs
OUTER_D_MM = 1200

FW_TYPE = "PA-3420"
SRV_TYPE = "System x3650 M5"
FW_U = 42
SRV_US = (2, 5)  # two 2U servers low in the rack


class Command(BaseCommand):
    help = "Seed the DC-TEST hall: 100 racks, PDUs, cabling, power and trays."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete the existing DC-TEST hall first (site, racks, "
                 "devices, plan) so the run starts clean.",
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
        self._cable(racks, devices)
        self._trays(plan)

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
                "description": "Test cabinet: 42U, 800 mm wide so both "
                               "rear channels take a vertical PDU.",
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
        plan, _ = FloorPlan.objects.update_or_create(
            tenant=self.t, location=loc, name=PLAN_NAME,
            defaults={
                "grid_width": GRID_W,
                "grid_height": GRID_H,
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

        for r, row in enumerate(ROWS):
            y = ROW_Y[r]
            # Even index = top of a facing pair → look down into the cold
            # aisle beneath; odd index = bottom of the pair → look up.
            facing = FRONT_DOWN if r % 2 == 0 else FRONT_UP
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
                    x=RACK_X0 + i, y=y, width=1, height=1,
                    orientation=facing, rack=rack, link_kind="rack",
                    label=name,
                )

        # Aisles: a cold aisle inside each facing pair, hot between pairs.
        for r in range(0, len(ROW_Y), 2):
            FloorPlanTile.objects.create(
                floor_plan=plan, tile_type=cold,
                x=RACK_X0, y=ROW_Y[r] + 1, width=PER_ROW, height=1,
                label=f"Cold {ROWS[r]}/{ROWS[r + 1]}",
            )
        for r in range(1, len(ROW_Y) - 1, 2):
            FloorPlanTile.objects.create(
                floor_plan=plan, tile_type=hot,
                x=RACK_X0, y=ROW_Y[r] + 1, width=PER_ROW, height=1,
                label=f"Hot {ROWS[r]}/{ROWS[r + 1]}",
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
        fw_role = self._role("Firewall", "#ef4444")
        srv_role = self._role("Server", "#10b981")

        out: dict[str, dict] = {}
        for name, rack in racks.items():
            made = {"fw": None, "srv": [], "pdu": []}
            fw, _ = Device.objects.update_or_create(
                tenant=self.t, name=f"{name}-fw",
                defaults={
                    "site": site, "location": loc, "rack": rack,
                    "device_type": fw_type, "role": fw_role,
                    "position": FW_U, "face": "front",
                },
            )
            materialize_device_components(fw)
            made["fw"] = fw
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
                        "rack": rack, "type": "primary", "supply": "ac",
                        "phase": "single", "voltage": 230, "amperage": 32,
                        "max_utilization": 80,
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

    def _cable(self, racks, devices):
        names = sorted(racks)
        for name in names:
            d = devices[name]
            fw, srvs, pdus = d["fw"], d["srv"], d["pdu"]
            fw_ifaces = list(fw.interfaces.order_by("name"))

            # Data: the firewall down to each server in its own cabinet.
            for n, srv in enumerate(srvs):
                port = srv.interfaces.filter(name="Ethernet 1").first()
                if n < len(fw_ifaces):
                    self._link(
                        f"DCT {name} fw→srv{n + 1}", "cat6", "#0ea5e9",
                        fw_ifaces[n], port,
                    )

            # Power: every device takes A and B, split across the two strips.
            # Bank order comes from the list, not the name — a device called
            # "DCT-A01-PDU-A" splits on "-" to "A", which matched nothing and
            # silently left every server unpowered.
            banks = [list(p.power_outlets.order_by("name")) for p in pdus]
            for slot, dev in enumerate([fw, *srvs]):
                ports = list(dev.power_ports.order_by("name"))
                for j, port in enumerate(ports[:2]):
                    bank = banks[j] if j < len(banks) else []
                    if slot < len(bank):
                        self._link(
                            f"DCT {dev.name} psu{j + 1}", "power", "#f59e0b",
                            port, bank[slot],
                        )

            # Power: each strip's inlet back to its feed.
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
        for row in ROWS:
            for i in range(PER_ROW - 1):
                a = devices[f"DCT-{row}{i + 1:02d}"]["fw"]
                b = devices[f"DCT-{row}{i + 2:02d}"]["fw"]
                pa = a.interfaces.filter(name__endswith="/24").first()
                pb = b.interfaces.filter(name__endswith="/23").first()
                self._link(
                    f"DCT row {row} {i + 1}→{i + 2}", "smf-os2", "#facc15",
                    pa, pb,
                )

    # ── trays ────────────────────────────────────────────────────────────
    def _trays(self, plan):
        plan.trays.all().delete()
        x0, x1 = RACK_X0, RACK_X0 + PER_ROW - 1
        # A spine down the west side, and a branch over every row of racks.
        FloorPlanTray.objects.create(
            floor_plan=plan, name="Spine", kind="ladder", color="#eab308",
            level="overhead", elevation_mm=2800,
            points=[[x0 - 1, ROW_Y[0]], [x0 - 1, ROW_Y[-1]]],
        )
        for r, row in enumerate(ROWS):
            FloorPlanTray.objects.create(
                floor_plan=plan, name=f"Row {row}", kind="ladder",
                color="#eab308", level="overhead", elevation_mm=2600,
                points=[[x0 - 1, ROW_Y[r]], [x1, ROW_Y[r]]],
            )
