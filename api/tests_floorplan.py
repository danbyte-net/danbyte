"""Floor plans: palette CRUD, plan CRUD + tenant isolation, bulk tile edits,
link resolution (tenant-checked), nested-plan links."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    FloorPlan,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Location,
    Rack,
    Site,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site, location=self.loc, name="R01"
        )

        # A second tenant with its own rack — for isolation tests.
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        other_site = Site.objects.create(tenant=self.other, name="LON")
        other_loc = Location.objects.create(
            tenant=self.other, site=other_site, name="Hall B", slug="hall-b"
        )
        self.other_rack = Rack.objects.create(
            tenant=self.other, site=other_site, name="X01"
        )
        self.other_loc = other_loc


class TileTypeTests(_Base):
    def test_crud_and_slug_autogen(self):
        resp = self.client.post(
            "/api/floor-tile-types/",
            {"name": "Cooling unit", "color": "#38bdf8", "icon": "wind"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["slug"], "cooling-unit")
        tid = body["id"]

        resp = self.client.patch(
            f"/api/floor-tile-types/{tid}/",
            {"default_width": 2, "default_height": 3},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["default_width"], 2)

        # Duplicate name → slug clash rejected.
        resp = self.client.post(
            "/api/floor-tile-types/", {"name": "Cooling unit"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

        resp = self.client.delete(f"/api/floor-tile-types/{tid}/")
        self.assertEqual(resp.status_code, 204)

    def test_delete_guard_when_tiles_placed(self):
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        FloorPlanTile.objects.create(floor_plan=plan, tile_type=tt, x=0, y=0)
        resp = self.client.delete(f"/api/floor-tile-types/{tt.id}/")
        self.assertEqual(resp.status_code, 409)


class FloorPlanTests(_Base):
    def test_crud_and_tenant_isolation(self):
        resp = self.client.post(
            "/api/floor-plans/",
            {"name": "Hall A", "location_id": str(self.loc.id),
             "grid_width": 30, "grid_height": 20},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        pid = body["id"]
        self.assertEqual(body["location"]["id"], str(self.loc.id))
        self.assertEqual(body["site"]["id"], str(self.site.id))
        self.assertEqual(body["tile_count"], 0)

        # Duplicate (location, name) → friendly 400, not a 500.
        resp = self.client.post(
            "/api/floor-plans/",
            {"name": "Hall A", "location_id": str(self.loc.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        # Another tenant's location can't be referenced.
        resp = self.client.post(
            "/api/floor-plans/",
            {"name": "Sneaky", "location_id": str(self.other_loc.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        # ?location= filter.
        got = self.client.get(f"/api/floor-plans/?location={self.loc.id}").json()
        self.assertEqual(got["count"], 1)

        # A plan in the other tenant is invisible here.
        FloorPlan.objects.create(
            tenant=self.other, location=self.other_loc, name="Hidden"
        )
        got = self.client.get("/api/floor-plans/").json()
        self.assertEqual(got["count"], 1)

        # state round-trips freely (no schema).
        resp = self.client.patch(
            f"/api/floor-plans/{pid}/",
            {"state": {"overlay": "power", "grid": False}},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["state"]["overlay"], "power")

    def test_physical_scale_defaults_and_roundtrip(self):
        # Defaults give existing plans plausible real-world scale for free.
        resp = self.client.post(
            "/api/floor-plans/",
            {"name": "Hall B", "location_id": str(self.loc.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["cell_mm"], 600)
        self.assertEqual(body["ceiling_mm"], 3000)
        # And they're editable within their validator bounds.
        resp = self.client.patch(
            f"/api/floor-plans/{body['id']}/",
            {"cell_mm": 500, "ceiling_mm": 2700},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["cell_mm"], 500)
        self.assertEqual(resp.json()["ceiling_mm"], 2700)
        # Out-of-range values are rejected, not clamped silently.
        resp = self.client.patch(
            f"/api/floor-plans/{body['id']}/", {"cell_mm": 10}, format="json"
        )
        self.assertEqual(resp.status_code, 400)


class TileTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack", color="#a1a1aa"
        )

    def test_tile_crud_and_type_exclusivity(self):
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 2, "y": 3,
             "tile_type_id": str(self.tt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        tid = resp.json()["id"]

        # No type at all → rejected.
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 0, "y": 0},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        # ?floor_plan= filter.
        got = self.client.get(
            f"/api/floor-plan-tiles/?floor_plan={self.plan.id}"
        ).json()
        self.assertEqual(got["count"], 1)

        resp = self.client.patch(
            f"/api/floor-plan-tiles/{tid}/",
            {"width": 2, "height": 4, "orientation": 90, "label": "Row 1"},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["orientation"], 90)

        resp = self.client.delete(f"/api/floor-plan-tiles/{tid}/")
        self.assertEqual(resp.status_code, 204)

    def test_link_resolution_and_cross_tenant_rejected(self):
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 1, "y": 1,
             "tile_type_id": str(self.tt.id),
             "link_kind": "rack", "link_id": str(self.rack.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["linked"]["kind"], "rack")
        self.assertEqual(body["linked"]["id"], str(self.rack.id))
        self.assertEqual(body["linked"]["route"], f"/racks/{self.rack.id}")

        # Cross-tenant rack → rejected.
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 2, "y": 2,
             "tile_type_id": str(self.tt.id),
             "link_kind": "rack", "link_id": str(self.other_rack.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        # Clearing the link.
        tid = body["id"]
        resp = self.client.patch(
            f"/api/floor-plan-tiles/{tid}/",
            {"link_kind": "", "link_id": ""},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNone(resp.json()["linked"])

    def test_nested_plan_link_round_trips(self):
        child = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Cage 1"
        )
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 5, "y": 5,
             "tile_type_id": str(self.tt.id),
             "link_kind": "floorplan", "link_id": str(child.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        linked = resp.json()["linked"]
        self.assertEqual(linked["kind"], "floorplan")
        self.assertEqual(linked["route"], f"/floorplans/{child.id}")

        # Self-link rejected.
        resp = self.client.post(
            "/api/floor-plan-tiles/",
            {"floor_plan_id": str(self.plan.id), "x": 6, "y": 6,
             "tile_type_id": str(self.tt.id),
             "link_kind": "floorplan", "link_id": str(self.plan.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class BulkTileTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Wall", slug="wall"
        )

    def test_bulk_create_update_delete_in_one_call(self):
        keep = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=0
        )
        gone = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=1, y=0
        )
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/tiles/bulk/",
            {
                "create": [
                    {"x": 3, "y": 3, "tile_type_id": str(self.tt.id),
                     "link_kind": "rack", "link_id": str(self.rack.id)},
                    {"x": 4, "y": 3, "tile_type_id": str(self.tt.id)},
                ],
                "update": [{"id": str(keep.id), "x": 9, "label": "moved"}],
                "delete": [str(gone.id)],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        tiles = resp.json()
        self.assertEqual(len(tiles), 3)
        by_label = {t["label"]: t for t in tiles}
        self.assertEqual(by_label["moved"]["x"], 9)
        linked = [t for t in tiles if t["linked"]]
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0]["linked"]["kind"], "rack")
        self.assertFalse(FloorPlanTile.objects.filter(pk=gone.pk).exists())

    def test_bulk_is_transactional(self):
        before = self.plan.tiles.count()
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/tiles/bulk/",
            {
                "create": [
                    {"x": 0, "y": 0, "tile_type_id": str(self.tt.id)},
                    {"x": 1, "y": 0},  # no type → invalid, must roll back all
                ],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self.plan.tiles.count(), before)

    def test_bulk_malformed_ids_do_not_500(self):
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/tiles/bulk/",
            {"delete": ["not-a-uuid"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)  # silently skipped
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/tiles/bulk/",
            {"update": [{"id": "not-a-uuid", "x": 1}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_state_endpoint_rolls_up_rack_and_device(self):
        from monitoring.models import CheckState, CheckTemplate

        from .models import Device, DeviceType, IPAddress, Manufacturer, Prefix

        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Acme")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="1U", u_height=1
        )
        racked = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site,
            device_type=dt, rack=self.rack, position=10,
        )
        loose = Device.objects.create(
            tenant=self.tenant, name="cam1", site=self.site
        )
        rack_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=0, rack=self.rack,
            link_kind="rack",
        )
        dev_tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=2, y=0, device=loose,
            link_kind="device",
        )
        # A down check on the racked device's IP → the rack tile rolls up red.
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=prefix,
            assigned_device=racked,
        )
        tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp"
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=tmpl, kind="icmp",
            status="down",
        )

        resp = self.client.get(f"/api/floor-plans/{self.plan.id}/state/")
        self.assertEqual(resp.status_code, 200, resp.content)
        tiles = resp.json()["tiles"]

        rack_state = tiles[str(rack_tile.id)]
        self.assertEqual(rack_state["kind"], "rack")
        self.assertEqual(rack_state["used_units"], 1)
        self.assertEqual(rack_state["u_height"], self.rack.u_height)
        self.assertIn("power", rack_state)
        self.assertEqual(rack_state["device_count"], 1)
        self.assertEqual(rack_state["check"], "down")

        dev_state = tiles[str(dev_tile.id)]
        self.assertEqual(dev_state["kind"], "device")
        self.assertIsNone(dev_state["check"])  # unmonitored

    def test_bulk_on_other_tenants_plan_404s(self):
        other_plan = FloorPlan.objects.create(
            tenant=self.other, location=self.other_loc, name="Hidden"
        )
        resp = self.client.post(
            f"/api/floor-plans/{other_plan.id}/tiles/bulk/",
            {"create": []},
            format="json",
        )
        self.assertEqual(resp.status_code, 404)


class TrayTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )

    def test_tray_crud_points_validation_and_cables(self):
        cable = Cable.objects.create(tenant=self.tenant, label="C-001")
        other_cable = Cable.objects.create(tenant=self.other, label="X-001")

        resp = self.client.post(
            "/api/floor-plan-trays/",
            {"floor_plan_id": str(self.plan.id), "name": "Tray A",
             "kind": "tray", "color": "#f59e0b",
             "points": [[0, 0], [0, 5.5], [8.5, 5.5]],
             "cable_ids": [str(cable.id)]},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        tid = body["id"]
        # Half-cell lattice: 0.5 steps preserved, off-grid rounded to nearest.
        self.assertEqual(body["points"], [[0, 0], [0, 5.5], [8.5, 5.5]])
        self.assertEqual(body["cables"][0]["label"], "C-001")

        # Garbage points rejected.
        for bad in ([[1]], "nope", [[0, 0]], [[0, "a"], [1, 1]]):
            resp = self.client.post(
                "/api/floor-plan-trays/",
                {"floor_plan_id": str(self.plan.id), "name": "Bad",
                 "points": bad},
                format="json",
            )
            self.assertEqual(resp.status_code, 400, bad)

        # Cross-tenant cable rejected.
        resp = self.client.patch(
            f"/api/floor-plan-trays/{tid}/",
            {"cable_ids": [str(other_cable.id)]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        # Clearing cables works; ?floor_plan= filter scopes.
        resp = self.client.patch(
            f"/api/floor-plan-trays/{tid}/", {"cable_ids": []}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["cables"], [])
        got = self.client.get(
            f"/api/floor-plan-trays/?floor_plan={self.plan.id}"
        ).json()
        self.assertEqual(got["count"], 1)

        resp = self.client.delete(f"/api/floor-plan-trays/{tid}/")
        self.assertEqual(resp.status_code, 204)

    def test_tray_tenant_isolation(self):
        hidden_plan = FloorPlan.objects.create(
            tenant=self.other, location=self.other_loc, name="Hidden"
        )
        FloorPlanTray.objects.create(
            floor_plan=hidden_plan, name="X", points=[[0, 0], [1, 0]]
        )
        got = self.client.get("/api/floor-plan-trays/").json()
        self.assertEqual(got["count"], 0)

    def test_tray_level_and_elevation_roundtrip(self):
        resp = self.client.post(
            "/api/floor-plan-trays/",
            {"floor_plan_id": str(self.plan.id), "name": "OH-1",
             "points": [[0, 0], [4, 0]]},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        # Defaults: overhead run, elevation derived (null) until set.
        self.assertEqual(body["level"], "overhead")
        self.assertIsNone(body["elevation_mm"])

        resp = self.client.patch(
            f"/api/floor-plan-trays/{body['id']}/",
            {"level": "underfloor", "elevation_mm": -300},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["level"], "underfloor")
        self.assertEqual(resp.json()["elevation_mm"], -300)

        # Unknown level value rejected by the choices validator.
        resp = self.client.patch(
            f"/api/floor-plan-trays/{body['id']}/",
            {"level": "orbit"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_tile_rack_filter(self):
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=0, y=0,
            rack=self.rack, link_kind="rack",
        )
        got = self.client.get(
            f"/api/floor-plan-tiles/?rack={self.rack.id}"
        ).json()
        self.assertEqual(got["count"], 1)


class SceneTests(_Base):
    """GET /api/floor-plans/{id}/scene/ — the 3D room view's one-fetch payload."""

    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A",
            cell_mm=500, ceiling_mm=2800,
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )

    def test_scene_payload_shape(self):
        from .models import DeviceType

        dt = DeviceType.objects.create(
            tenant=self.tenant, name="1U Switch", u_height=1,
            image_ports={
                "front": [
                    {"kind": "interface", "name": "Gi1/0/1",
                     "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.4}
                ],
                "rear": [],
            },
        )
        Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt,
            rack=self.rack, position=10, face="front",
        )
        # A racked device with no position must not appear in the scene.
        Device.objects.create(
            tenant=self.tenant, name="loose", device_type=dt, rack=self.rack
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=2, y=3,
            rack=self.rack, link_kind="rack",
        )
        FloorPlanTray.objects.create(
            floor_plan=self.plan, name="OH-1", level="overhead",
            points=[[0, 0], [4, 0]],
        )

        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertEqual(body["plan"]["cell_mm"], 500)
        self.assertEqual(body["plan"]["ceiling_mm"], 2800)
        self.assertEqual(len(body["tiles"]), 1)
        tile = body["tiles"][0]
        self.assertEqual(tile["kind"], "rack")
        self.assertEqual(tile["x"], 2)
        self.assertEqual(tile["rack"]["name"], "R01")
        self.assertEqual(tile["rack"]["u_height"], 42)
        devs = tile["rack"]["devices"]
        self.assertEqual([d["name"] for d in devs], ["sw1"])
        self.assertEqual(devs[0]["position"], 10)
        self.assertEqual(devs[0]["u_height"], 1)
        self.assertEqual(devs[0]["rack_width"], "full")
        # Photo-anchored port markers flow through for the 3D face overlay.
        self.assertEqual(devs[0]["image_ports"]["front"][0]["name"], "Gi1/0/1")
        self.assertEqual(len(body["trays"]), 1)
        self.assertEqual(body["trays"][0]["level"], "overhead")
        self.assertIsNone(body["trays"][0]["elevation_mm"])

    def test_scene_tenant_isolation(self):
        hidden = FloorPlan.objects.create(
            tenant=self.other, location=self.other_loc, name="Hidden"
        )
        resp = self.client.get(f"/api/floor-plans/{hidden.id}/scene/")
        self.assertEqual(resp.status_code, 404)

    def test_scene_carries_type_name_for_unlinked_tiles(self):
        """Build-in-advance: a typed tile with NO linked object still lands
        in the scene with its type's name, so 3D can draw planning massing."""
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=4, y=4,
            label="future row",
        )
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        tile = next(t for t in body["tiles"] if t["label"] == "future row")
        self.assertEqual(tile["kind"], "other")
        self.assertIsNone(tile["rack"])
        self.assertEqual(tile["type_name"], "Rack")

    def test_scene_carries_perforated_from_the_tile_type(self):
        """A perforated zone type marks its scene tiles, so the 3D room can
        draw grate floor where the cold-aisle supply tiles sit."""
        grate = FloorTileType.objects.create(
            tenant=self.tenant, name="Cold aisle grate", slug="cold-grate",
            is_zone=True, perforated=True,
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=grate, x=6, y=6, width=2,
            label="supply",
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=9, label="plain",
        )
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        tile = next(t for t in body["tiles"] if t["label"] == "supply")
        self.assertTrue(tile["is_zone"])
        self.assertTrue(tile["perforated"])
        # And the flag is additive: ordinary tiles carry it as False.
        other = next(t for t in body["tiles"] if t["label"] == "plain")
        self.assertFalse(other["perforated"])

    def test_scene_device_airflow_is_effective_and_additive(self):
        """The scene carries EFFECTIVE airflow (device override beats the
        type's default), added without disturbing the rest of device_geo —
        the 2D canvas and older consumers read the same keys they always did.
        """
        from .models import DeviceType

        dt = DeviceType.objects.create(
            tenant=self.tenant, name="FTR Switch", u_height=1,
            airflow="front-to-rear",
        )
        Device.objects.create(
            tenant=self.tenant, name="inherits", device_type=dt,
            rack=self.rack, position=1, face="front",
        )
        Device.objects.create(
            tenant=self.tenant, name="overrides", device_type=dt,
            rack=self.rack, position=3, face="front",
            airflow="rear-to-front",
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=0,
            rack=self.rack, link_kind="rack",
        )
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        devs = {d["name"]: d for d in body["tiles"][0]["rack"]["devices"]}
        self.assertEqual(devs["inherits"]["airflow"], "front-to-rear")
        self.assertEqual(devs["overrides"]["airflow"], "rear-to-front")
        # Additive: the established key set is intact alongside the new one.
        for key in (
            "id", "name", "position", "face", "rack_side", "u_height",
            "rack_width", "is_full_depth", "role_color", "role_name",
            "device_type", "status", "primary_ip", "serial_number",
            "front_image", "rear_image", "has_faceplate", "image_ports",
        ):
            self.assertIn(key, devs["inherits"])

    def test_effective_airflow_on_the_device_serializer(self):
        from .models import DeviceType

        dt = DeviceType.objects.create(
            tenant=self.tenant, name="RTF Router", u_height=1,
            airflow="rear-to-front",
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="edge1", device_type=dt
        )
        body = self.client.get(f"/api/devices/{dev.id}/").json()
        self.assertEqual(body["airflow"], "")
        self.assertEqual(body["effective_airflow"], "rear-to-front")


class CablePathTests(_Base):
    def test_cable_paths_resolve_to_rack_tiles(self):
        plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        rack_b = Rack.objects.create(
            tenant=self.tenant, site=self.site, location=self.loc, name="R02"
        )
        # Two devices, one in each rack, cabled A↔B.
        dev_a = Device.objects.create(
            tenant=self.tenant, name="sw-a", site=self.site, rack=self.rack,
        )
        dev_b = Device.objects.create(
            tenant=self.tenant, name="sw-b", site=self.site, rack=rack_b,
        )
        ia = Interface.objects.create(device=dev_a, name="eth0")
        ib = Interface.objects.create(device=dev_b, name="eth0")
        cable = Cable.objects.create(tenant=self.tenant, label="A↔B")
        CableTermination.objects.create(cable=cable, end="A", interface=ia)
        CableTermination.objects.create(cable=cable, end="B", interface=ib)

        # Rack tiles for each rack.
        tile_a = FloorPlanTile.objects.create(
            floor_plan=plan, tile_type=tt, x=2, y=2,
            rack=self.rack, link_kind="rack",
        )
        tile_b = FloorPlanTile.objects.create(
            floor_plan=plan, tile_type=tt, x=18, y=2,
            rack=rack_b, link_kind="rack",
        )
        # A tray carrying the cable.
        tray = FloorPlanTray.objects.create(
            floor_plan=plan, name="Tray A", points=[[3, 2], [18, 2]]
        )
        tray.cables.add(cable)

        resp = self.client.get(f"/api/floor-plans/{plan.id}/cable-paths/")
        self.assertEqual(resp.status_code, 200, resp.content)
        cables = resp.json()["cables"]
        self.assertEqual(len(cables), 1)
        entry = cables[0]
        self.assertEqual(entry["a_tiles"], [str(tile_a.id)])
        self.assertEqual(entry["b_tiles"], [str(tile_b.id)])
        self.assertEqual(entry["tray_ids"], [str(tray.id)])
        # Endpoint device + port ride along (3D anchors runs to port quads).
        self.assertEqual(
            entry["a_points"], [{"device": str(dev_a.id), "port": "eth0"}]
        )
        self.assertEqual(
            entry["b_points"], [{"device": str(dev_b.id), "port": "eth0"}]
        )


class CableFloorPlanResolverTests(_Base):
    def test_cable_floor_plan_prefers_tray_then_tile(self):
        from .models import Device, Interface

        plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        dev = Device.objects.create(
            tenant=self.tenant, name="sw", site=self.site, rack=self.rack
        )
        ic = Interface.objects.create(device=dev, name="e0")
        cable = Cable.objects.create(tenant=self.tenant, label="c1")
        CableTermination.objects.create(cable=cable, end="A", interface=ic)
        # No plan yet → null.
        resp = self.client.get(f"/api/cables/{cable.id}/floor-plan/")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["plan_id"])
        # Tile the rack → resolves via the rack tile.
        FloorPlanTile.objects.create(
            floor_plan=plan, tile_type=tt, x=0, y=0, rack=self.rack,
            link_kind="rack",
        )
        resp = self.client.get(f"/api/cables/{cable.id}/floor-plan/")
        self.assertEqual(resp.json()["plan_id"], str(plan.id))
        # A tray carrying it wins.
        tray = FloorPlanTray.objects.create(
            floor_plan=plan, name="T", points=[[0, 0], [1, 0]]
        )
        tray.cables.add(cable)
        resp = self.client.get(f"/api/cables/{cable.id}/floor-plan/")
        self.assertEqual(resp.json()["plan_id"], str(plan.id))
