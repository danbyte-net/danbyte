"""Zero-U side mounting (vertical PDU strips): the placement rules, the two
rack-rollup fixes the feature owns (0U gear no longer charged a unit; PDU
draw no longer double-counted), and the scene payload that lets the 3D room
draw the strip."""

from django.contrib.auth import get_user_model

from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Location,
    PowerOutlet,
    PowerPort,
    Rack,
    Site,
)


class ZeroUMountTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.rack = Rack.objects.create(
            tenant=self.tenant, site=self.site, location=self.loc,
            name="rack-01", u_height=42,
        )
        self.dt_pdu = DeviceType.objects.create(
            tenant=self.tenant, name="Vertical PDU", u_height=0
        )
        self.dt_1u = DeviceType.objects.create(
            tenant=self.tenant, name="R650", u_height=1
        )
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _post(self, name, dt, **extra):
        return self.client.post(
            "/api/devices/",
            {"name": name, "device_type_id": str(dt.id),
             "rack_id": str(self.rack.id), **extra},
            format="json",
        )

    # ── Placement rules ──────────────────────────────────────────────────

    def test_mount_requires_a_rack(self):
        r = self.client.post(
            "/api/devices/",
            {"name": "pdu", "device_type_id": str(self.dt_pdu.id),
             "mount": "side_left"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("mount", r.json())

    def test_mount_requires_a_zero_u_type(self):
        r = self._post("srv", self.dt_1u, mount="side_left")
        self.assertEqual(r.status_code, 400)
        self.assertIn("mount", r.json())

    def test_mount_excludes_u_position(self):
        r = self._post("pdu", self.dt_pdu, mount="side_left", position=5)
        self.assertEqual(r.status_code, 400)
        self.assertIn("position", r.json())

    def test_mount_excludes_face(self):
        r = self._post("pdu", self.dt_pdu, mount="side_left", face="front")
        self.assertEqual(r.status_code, 400)
        self.assertIn("mount", r.json())

    def test_span_longer_than_the_rack_rejected(self):
        r = self._post(
            "pdu", self.dt_pdu, mount="side_left", mount_span_u=50
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("mount_span_u", r.json())

    def test_offset_without_mount_rejected(self):
        r = self._post("pdu", self.dt_pdu, mount_offset_mm=150)
        self.assertEqual(r.status_code, 400)
        self.assertIn("mount", r.json())

    def test_valid_mount_roundtrips(self):
        r = self._post(
            "pdu-a", self.dt_pdu,
            mount="side_left", mount_offset_mm=150, mount_span_u=40,
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["mount"], "side_left")
        self.assertEqual(body["mount_offset_mm"], 150)
        self.assertEqual(body["mount_span_u"], 40)
        self.assertIsNone(body["position"])

    # ── The two rollup fixes ─────────────────────────────────────────────

    def test_zero_u_gear_occupies_no_units(self):
        # A positioned 0U appliance AND a mounted strip: neither counts.
        # (The old `or 1` charged the positioned one a full unit.)
        self.assertEqual(
            self._post("appl", self.dt_pdu, position=5).status_code, 201
        )
        self.assertEqual(
            self._post("pdu", self.dt_pdu, mount="side_right").status_code,
            201,
        )
        self.assertEqual(
            self._post("srv", self.dt_1u, position=10).status_code, 201
        )
        r = self.client.get(f"/api/racks/{self.rack.id}/")
        self.assertEqual(r.json()["used_units"], 1)  # just the 1U server

    def test_rack_power_skips_distributors(self):
        # The PDU's inlet restates its children's draw — counting both
        # doubled the rack. Only the leaf device's draw may count.
        pdu = Device.objects.create(
            tenant=self.tenant, site=self.site, name="pdu",
            device_type=self.dt_pdu, rack=self.rack, mount="side_left",
        )
        PowerPort.objects.create(
            device=pdu, name="inlet", allocated_draw=500, maximum_draw=1000
        )
        PowerOutlet.objects.create(device=pdu, name="out1")
        srv = Device.objects.create(
            tenant=self.tenant, site=self.site, name="srv",
            device_type=self.dt_1u, rack=self.rack, position=10,
        )
        PowerPort.objects.create(
            device=srv, name="psu1", allocated_draw=500, maximum_draw=1000
        )
        p = self.client.get(f"/api/racks/{self.rack.id}/").json()["power"]
        self.assertEqual(p["allocated_w"], 500)
        self.assertEqual(p["maximum_w"], 1000)

    # ── Scene payload ────────────────────────────────────────────────────

    def test_scene_carries_mounted_strips(self):
        plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A"
        )
        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        FloorPlanTile.objects.create(
            floor_plan=plan, tile_type=tt, x=1, y=1, rack=self.rack
        )
        Device.objects.create(
            tenant=self.tenant, site=self.site, name="pdu",
            device_type=self.dt_pdu, rack=self.rack,
            mount="side_right", mount_offset_mm=100, mount_span_u=38,
        )
        body = self.client.get(f"/api/floor-plans/{plan.id}/scene/").json()
        tile = next(t for t in body["tiles"] if t["rack"])
        dev = next(d for d in tile["rack"]["devices"] if d["name"] == "pdu")
        self.assertIsNone(dev["position"])
        self.assertEqual(dev["mount"], "side_right")
        self.assertEqual(dev["mount_offset_mm"], 100)
        self.assertEqual(dev["mount_span_u"], 38)
