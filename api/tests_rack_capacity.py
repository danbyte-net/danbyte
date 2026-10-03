"""Rack capacity on floor plans and sites (#247): the shared racked-device
prefetch, the PDU-rating power fallback, a floor plan's racks with their port
figures, and a site's capacity floor plan by floor plan."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    FrontPort,
    Interface,
    Location,
    PortReservation,
    PowerFeed,
    PowerOutlet,
    PowerPanel,
    PowerPort,
    Rack,
    RearPort,
    Site,
)

User = get_user_model()

ROW = ("total", "connected", "reserved", "free", "marked")


def _row(total, connected=0, reserved=0, marked=0):
    return {"total": total, "connected": connected, "reserved": reserved,
            "free": total - connected - reserved, "marked": marked}


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self._login(self.admin)
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.hall = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.dt_1u = DeviceType.objects.create(tenant=self.tenant, name="1U", u_height=1)
        self.dt_strip = DeviceType.objects.create(tenant=self.tenant, name="Strip", u_height=0)
        self.panel_role = DeviceRole.objects.create(
            tenant=self.tenant, name="Panel", slug="panel", is_patch_panel=True
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        self.panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="PP1")
        self.n = 0

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _viewer(self, *grants):
        """A tenant member holding ``(types, constraints)`` view grants."""
        user = User.objects.create_user(f"viewer{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for types, constraints in grants:
            perm = ObjectPermission.objects.create(
                name=f"view {' '.join(types)}", object_types=list(types), actions=["view"],
                constraints=constraints,
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
        self._login(user)
        return user

    def _name(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    def _rack(self, name=None, site=None, servers=2, pdu_w=3680):
        """A rack with a PDU strip (an inlet rated ``pdu_w`` and an outlet per
        server) and ``servers`` 1U servers drawing 200 W allocated / 400 W
        nameplate each."""
        site = site or self.site
        rack = Rack.objects.create(tenant=self.tenant, site=site, name=name or self._name("R"))
        pdu = Device.objects.create(
            tenant=self.tenant, site=site, rack=rack, name=self._name("pdu"),
            device_type=self.dt_strip, mount="side_left",
        )
        PowerPort.objects.create(device=pdu, name="inlet", maximum_draw=pdu_w)
        for i in range(servers):
            srv = Device.objects.create(
                tenant=self.tenant, site=site, rack=rack, name=self._name("srv"),
                device_type=self.dt_1u, position=i + 1, face="front",
            )
            PowerPort.objects.create(device=srv, name="psu", maximum_draw=400, allocated_draw=200)
            PowerOutlet.objects.create(device=pdu, name=f"C13-{i}")
        return rack

    def _plan(self, name="Hall A", racks=(), location=None):
        plan = FloorPlan.objects.create(
            tenant=self.tenant, location=location or self.hall, name=name
        )
        for i, rack in enumerate(racks):
            FloorPlanTile.objects.create(
                floor_plan=plan, tile_type=self.tt, x=i, y=0, rack=rack, link_kind="rack"
            )
        return plan

    def _count(self, url):
        # The first request of a run pays one-off lookups; count the second.
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        return len(ctx.captured_queries), resp.json()


class RackPowerTests(_Base):
    def _power(self, rack):
        return self.client.get(f"/api/racks/{rack.id}/").json()["power"]

    def test_a_primary_feed_is_the_supply(self):
        rack = self._rack()
        PowerFeed.objects.create(
            tenant=self.tenant, power_panel=self.panel, rack=rack, name="A",
            voltage=230, amperage=16, max_utilization=80,
        )
        self.assertEqual(self._power(rack), {
            "available_w": 2944, "allocated_w": 400, "maximum_w": 800, "supply": "feed",
        })

    def test_without_a_feed_the_pdus_rating_stands_in(self):
        rack = self._rack(pdu_w=3680)
        self.assertEqual(self._power(rack)["available_w"], 3680)
        second = Device.objects.create(
            tenant=self.tenant, site=self.site, rack=rack, name="pdu-b",
            device_type=self.dt_strip, mount="side_right",
        )
        PowerPort.objects.create(device=second, name="inlet", maximum_draw=3680)
        PowerOutlet.objects.create(device=second, name="C13")
        # A redundant feed is no supply of its own, so the rating still stands
        # - and two PDUs are an A/B pair: one side must carry the rack alone.
        PowerFeed.objects.create(
            tenant=self.tenant, power_panel=self.panel, rack=rack, name="B",
            voltage=230, amperage=16, type="redundant",
        )
        self.assertEqual(self._power(rack), {
            "available_w": 3680, "allocated_w": 400, "maximum_w": 800,
            "supply": "pdu_rating",
        })

    def test_with_neither_there_is_no_supply(self):
        rack = self._rack(pdu_w=None)
        self.assertEqual(self._power(rack)["available_w"], 0)
        self.assertIsNone(self._power(rack)["supply"])


class FloorPlanStateTests(_Base):
    """The 30-second poll: the same queries for 4 racks as for 32 (B1)."""

    def _state(self, plan):
        return self._count(f"/api/floor-plans/{plan.id}/state/")

    def test_flat_between_a_2x2_and_a_4x8_plan(self):
        small = self._plan("2x2", [self._rack() for _ in range(4)])
        big = self._plan("4x8", [self._rack(servers=3) for _ in range(32)])
        small_n, _ = self._state(small)
        big_n, body = self._state(big)
        self.assertEqual(small_n, big_n)
        tile = FloorPlanTile.objects.filter(floor_plan=big).first()
        power = body["tiles"][str(tile.id)]["power"]
        self.assertEqual(power, self.client.get(f"/api/racks/{tile.rack_id}/").json()["power"])
        self.assertEqual(power, {
            "available_w": 3680, "allocated_w": 600, "maximum_w": 1200, "supply": "pdu_rating",
        })


class FloorPlanRacksTests(_Base):
    def setUp(self):
        super().setUp()
        self.r1, self.r2, self.r3 = self._rack("R1"), self._rack("R2"), self._rack("R3")
        self.plan = self._plan(racks=(self.r1, self.r2))

    def _names(self, url):
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        return sorted(r["name"] for r in resp.json()["results"])

    def test_the_racks_a_plans_tiles_stand_for(self):
        # A second tile for the same rack lists it once.
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=5, y=5, rack=self.r1, link_kind="rack"
        )
        FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=9, y=9)
        self.assertEqual(self._names(f"/api/racks/?floor_plan={self.plan.id}"), ["R1", "R2"])

    def test_only_with_view_of_the_plan(self):
        url = f"/api/racks/?floor_plan={self.plan.id}"
        self._viewer((["rack"], None))
        self.assertEqual(self._names(url), [])
        self._viewer((["rack"], None), (["floorplan"], {"name": "elsewhere"}))
        self.assertEqual(self._names(url), [])
        self._viewer((["rack"], {"name": "R2"}), (["floorplan"], None))
        self.assertEqual(self._names(url), ["R2"])

    def test_another_tenants_plan_lists_nothing(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="LON")
        loc = Location.objects.create(tenant=other, site=site, name="H", slug="h")
        theirs = FloorPlan.objects.create(tenant=other, location=loc, name="H")
        self.assertEqual(self._names(f"/api/racks/?floor_plan={theirs.id}"), [])

    def test_a_bad_id_is_a_400(self):
        self.assertEqual(self.client.get("/api/racks/?floor_plan=nope").status_code, 400)


class RackPortsTests(_Base):
    """``?include=ports``: Ports and Panel ports, list and detail alike."""

    def setUp(self):
        super().setUp()
        self.rack = self._rack("R1", servers=0)
        sw = Device.objects.create(
            tenant=self.tenant, site=self.site, rack=self.rack, name="sw",
            device_type=self.dt_1u, position=10, face="front",
        )
        ports = [Interface.objects.create(device=sw, name=f"ge{i}") for i in range(4)]
        Interface.objects.create(device=sw, name="vlan10", type="virtual")
        PortReservation.objects.create(tenant=self.tenant, interface=ports[3])
        panel = Device.objects.create(
            tenant=self.tenant, site=self.site, rack=self.rack, name="pp",
            device_type=self.dt_1u, position=20, face="front", role=self.panel_role,
        )
        rear = RearPort.objects.create(device=panel, name="R", positions=4)
        fronts = [
            FrontPort.objects.create(device=panel, name=f"F{i}", rear_port=rear,
                                     rear_port_position=i + 1)
            for i in range(4)
        ]
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=ports[0])
        CableTermination.objects.create(cable=cable, end="B", front_port=fronts[0])
        # Front ports on a device that is not a patch panel are panel ports
        # too; its interface is a port.
        shelf = Device.objects.create(
            tenant=self.tenant, site=self.site, rack=self.rack, name="shelf",
            device_type=self.dt_1u, position=30, face="front",
        )
        shelf_rear = RearPort.objects.create(device=shelf, name="R", positions=2)
        for i in range(2):
            FrontPort.objects.create(device=shelf, name=f"F{i}", rear_port=shelf_rear,
                                     rear_port_position=i + 1)
        Interface.objects.create(device=shelf, name="mgmt0")

    def test_ports_and_panel_ports(self):
        detail = self.client.get(f"/api/racks/{self.rack.id}/?include=ports").json()
        self.assertEqual(detail["ports"], _row(5, connected=1, reserved=1))
        self.assertEqual(detail["panel_ports"], _row(6, connected=1))
        row = self.client.get("/api/racks/?include=ports").json()["results"][0]
        self.assertEqual((row["ports"], row["panel_ports"]),
                         (detail["ports"], detail["panel_ports"]))
        # Together they are the rack's counted ports, as its Rack view reads them.
        state = self.client.get(f"/api/racks/{self.rack.id}/port-state/").json()
        self.assertEqual(
            {k: detail["ports"][k] + detail["panel_ports"][k] for k in ROW},
            state["rack"]["ports"],
        )

    def test_null_unless_asked_for(self):
        detail = self.client.get(f"/api/racks/{self.rack.id}/").json()
        self.assertIsNone(detail["ports"])
        self.assertIsNone(detail["panel_ports"])

    def test_virtual_interfaces_count_with_the_setting(self):
        ds = DeploymentSettings.load()
        ds.port_count_virtual = True
        ds.save()
        detail = self.client.get(f"/api/racks/{self.rack.id}/?include=ports").json()
        self.assertEqual(detail["ports"]["total"], 6)

    def test_a_patch_panels_interfaces_are_panel_ports(self):
        panel = Device.objects.get(name="pp")
        Interface.objects.create(device=panel, name="console-ish")
        detail = self.client.get(f"/api/racks/{self.rack.id}/?include=ports").json()
        self.assertEqual((detail["ports"]["total"], detail["panel_ports"]["total"]), (5, 7))

    def test_a_page_costs_the_same_however_many_racks(self):
        def world(n):
            for _ in range(n):
                rack = self._rack(servers=3)
                for srv in rack.devices.exclude(mount="side_left"):
                    for k in range(3):
                        Interface.objects.create(device=srv, name=f"eth{k}")
            return self._plan(self._name("plan"), Rack.objects.order_by("-created_at")[:n])

        small = world(2)
        big = world(6)
        counts = []
        for plan in (small, big):
            n, body = self._count(f"/api/racks/?floor_plan={plan.id}&include=ports")
            counts.append(n)
        self.assertEqual(counts[0], counts[1])
        self.assertEqual(len(body["results"]), 6)
        self.assertEqual(body["results"][0]["ports"]["total"], 9)
        small_n, _ = self._count("/api/racks/?include=ports&page_size=2")
        big_n, _ = self._count("/api/racks/?include=ports&page_size=9")
        self.assertEqual(small_n, big_n)


class SiteCapacityTests(_Base):
    def setUp(self):
        super().setUp()
        self.r1, self.r2, self.r3, self.r4 = (self._rack(f"R{i}") for i in range(1, 5))
        self.plan_a = self._plan("Hall A", (self.r1, self.r2))
        hall_b = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall B", slug="hall-b"
        )
        self.plan_b = self._plan("Hall B", (self.r3,), location=hall_b)
        tile = FloorPlanTile.objects.get(floor_plan=self.plan_a, rack=self.r1)
        tile.x, tile.y, tile.width, tile.height, tile.orientation = 4, 2, 1, 2, 90
        tile.save()
        # A tile that is not a rack never reaches the thumbnail.
        FloorPlanTile.objects.create(floor_plan=self.plan_a, tile_type=self.tt, x=9, y=9)

    def _capacity(self, site=None):
        return self.client.get(f"/api/sites/{(site or self.site).id}/capacity/")

    def test_floor_plans_their_racks_and_the_racks_on_none(self):
        body = self._capacity().json()
        self.assertEqual(body["site"], {"id": str(self.site.id), "name": "AMS"})
        self.assertFalse(body["count_virtual"])
        self.assertEqual([p["name"] for p in body["floor_plans"]], ["Hall A", "Hall B"])
        hall_a = body["floor_plans"][0]
        self.assertEqual(hall_a["location"], {"id": str(self.hall.id), "name": "Hall A"})
        self.assertEqual((hall_a["grid_width"], hall_a["grid_height"]), (24, 16))
        self.assertEqual([r["name"] for r in hall_a["racks"]], ["R1", "R2"])
        self.assertEqual(
            sorted((t["rack_id"], t["x"], t["y"], t["w"], t["h"], t["orientation"])
                   for t in hall_a["tiles"]),
            sorted([(str(self.r1.id), 4, 2, 1, 2, 90), (str(self.r2.id), 1, 0, 1, 1, 0)]),
        )
        self.assertEqual(hall_a["totals"], {
            "racks": 2, "devices": 6, "u_height": 84, "u_used": 4, "u_pct": 5,
            "power": {"available_w": 7360, "allocated_w": 800, "maximum_w": 1600,
                      "pdu_rating": 2, "no_supply": 0},
            "ports": _row(0), "panel_ports": _row(0),
        })
        self.assertEqual([r["name"] for r in body["unplaced"]["racks"]], ["R4"])
        self.assertEqual(body["unplaced"]["totals"]["racks"], 1)
        self.assertEqual(body["totals"]["racks"], 4)
        self.assertEqual(body["totals"]["devices"], 12)

    def test_a_rack_reads_as_the_rack_list_reads_it(self):
        entry = self._capacity().json()["floor_plans"][0]["racks"][0]
        row = next(
            r for r in self.client.get("/api/racks/?include=ports").json()["results"]
            if r["id"] == str(self.r1.id)
        )
        self.assertEqual(
            (entry["u_used"], entry["u_height"], entry["power"], entry["ports"],
             entry["panel_ports"], entry["device_count"]),
            (row["used_units"], row["u_height"], row["power"], row["ports"],
             row["panel_ports"], row["device_count"]),
        )
        self.assertEqual(entry["u_pct"], round(row["used_units"] / row["u_height"] * 100))

    def test_plans_and_racks_follow_the_grants(self):
        self._viewer(
            (["site"], None),
            (["rack"], {"name__in": ["R1", "R3", "R4"]}),
            (["floorplan"], {"name": "Hall A"}),
        )
        body = self._capacity().json()
        self.assertEqual([p["name"] for p in body["floor_plans"]], ["Hall A"])
        self.assertEqual([r["name"] for r in body["floor_plans"][0]["racks"]], ["R1"])
        self.assertEqual([t["rack_id"] for t in body["floor_plans"][0]["tiles"]],
                         [str(self.r1.id)])
        # R3 stands on a plan they cannot see: it is on no card, but it is not
        # "on no floor plan" either.
        self.assertEqual([r["name"] for r in body["unplaced"]["racks"]], ["R4"])
        self.assertEqual(body["totals"]["racks"], 3)
        self.assertNotIn("R2", {r["name"] for p in body["floor_plans"] for r in p["racks"]})

    def test_without_floor_plan_or_rack_view(self):
        self._viewer((["site", "rack"], None))
        body = self._capacity().json()
        self.assertEqual(body["floor_plans"], [])
        self.assertEqual([r["name"] for r in body["unplaced"]["racks"]], ["R4"])
        self._viewer((["site", "floorplan"], None))
        body = self._capacity().json()
        self.assertEqual([p["racks"] for p in body["floor_plans"]], [[], []])
        self.assertEqual(body["totals"]["racks"], 0)

    def test_gated_on_site_view(self):
        self._viewer((["rack", "floorplan"], None))
        self.assertEqual(self._capacity().status_code, 403)
        lon = Site.objects.create(tenant=self.tenant, name="LON")
        self._viewer((["site", "rack", "floorplan"], {"name": "LON"}))
        self.assertEqual(self._capacity().status_code, 404)
        self.assertEqual(self._capacity(lon).status_code, 200)

    def test_another_tenants_site_is_not_found(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        theirs = Site.objects.create(tenant=other, name="LON")
        self.assertEqual(self._capacity(theirs).status_code, 404)

    def test_flat_whatever_the_site_holds(self):
        small, _ = self._count(f"/api/sites/{self.site.id}/capacity/")
        for i in range(3):
            loc = Location.objects.create(
                tenant=self.tenant, site=self.site, name=f"Hall {i}x", slug=f"hall-{i}x"
            )
            self._plan(f"Plan {i}", [self._rack(servers=4) for _ in range(6)], location=loc)
        for _ in range(4):
            self._rack()
        big, body = self._count(f"/api/sites/{self.site.id}/capacity/")
        self.assertEqual(small, big)
        self.assertLessEqual(big, 25)
        self.assertEqual(body["totals"]["racks"], 4 + 18 + 4)


class SiteRackCountTests(_Base):
    def test_the_site_page_knows_whether_it_has_racks(self):
        url = f"/api/sites/{self.site.id}/"
        self.assertEqual(self.client.get(url).json()["rack_count"], 0)
        self._rack()
        self._rack()
        self.assertEqual(self.client.get(url).json()["rack_count"], 2)
