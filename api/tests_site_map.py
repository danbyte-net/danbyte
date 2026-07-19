"""Site map endpoint — RBAC scoping, coordinates, tile config defaults."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from api.models import Site
from core.models import DeploymentSettings, Organization, Tenant


class SiteMapTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("map-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        Site.objects.create(
            tenant=self.tenant, name="Placed",
            latitude="55.676098", longitude="12.568337",
        )
        Site.objects.create(tenant=self.tenant, name="Unplaced")

    def test_payload_includes_placed_and_unplaced_sites(self):
        r = self.client_api.get("/api/site-map/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        names = {s["name"]: s for s in body["sites"]}
        self.assertAlmostEqual(names["Placed"]["latitude"], 55.676098)
        self.assertIsNone(names["Unplaced"]["latitude"])
        self.assertTrue(names["Placed"]["can_edit"])

    def test_default_tiles_are_osm_with_attribution(self):
        r = self.client_api.get("/api/site-map/")
        tiles = r.json()["tiles"]
        self.assertEqual(
            tiles["url"], "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        )
        self.assertIn("OpenStreetMap", tiles["attribution"])
        self.assertTrue(tiles["osm_default"])

    def test_configured_tile_server_wins(self):
        ds = DeploymentSettings.load()
        ds.map_tile_url = "https://tiles.corp.example/{z}/{x}/{y}.png"
        ds.map_tile_attribution = "&copy; Corp GIS"
        ds.save()
        try:
            tiles = self.client_api.get("/api/site-map/").json()["tiles"]
            self.assertEqual(
                tiles["url"], "https://tiles.corp.example/{z}/{x}/{y}.png"
            )
            self.assertFalse(tiles["osm_default"])
        finally:
            ds.map_tile_url = ""
            ds.map_tile_attribution = ""
            ds.save()

    def test_site_latlng_roundtrip_via_sites_api(self):
        site = Site.objects.get(name="Unplaced")
        r = self.client_api.patch(
            f"/api/sites/{site.id}/",
            {"latitude": "40.712800", "longitude": "-74.006000"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        site.refresh_from_db()
        self.assertEqual(str(site.latitude), "40.712800")

    def test_member_without_view_grant_gets_no_sites(self):
        from auth_api.models import UserProfile

        member = User.objects.create_user("map-member", password="x")
        UserProfile.objects.create(user=member).tenants.add(self.tenant)
        c = APIClient()
        c.force_authenticate(member)
        s = c.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        r = c.get("/api/site-map/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sites"], [])

    def test_tile_url_validation(self):
        from core.deployment import DeploymentSettingsSerializer

        s = DeploymentSettingsSerializer()
        self.assertEqual(s.validate_map_tile_url(""), "")
        self.assertEqual(
            s.validate_map_tile_url("https://t.example/{z}/{x}/{y}.png"),
            "https://t.example/{z}/{x}/{y}.png",
        )
        from rest_framework.serializers import ValidationError

        with self.assertRaises(ValidationError):
            s.validate_map_tile_url("http://t.example/{z}/{x}/{y}.png")
        with self.assertRaises(ValidationError):
            s.validate_map_tile_url("https://t.example/tiles.png")


class SiteMapHealthTests(SiteMapTests.__bases__[0]):
    """Per-site / per-device worst-status roll-up in the map payload."""

    def setUp(self):
        from api.status_registry import seed_builtin_statuses

        self.org = Organization.objects.create(name="HO", slug="ho")
        self.tenant = Tenant.objects.create(org=self.org, name="HT", slug="ht")
        seed_builtin_statuses(self.tenant)
        self.admin = User.objects.create_superuser("map-health", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(
            tenant=self.tenant, name="S1",
            latitude="55.0", longitude="12.0",
        )

    def _payload(self):
        r = self.client_api.get("/api/site-map/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_no_checks_is_null(self):
        body = self._payload()
        self.assertIsNone(body["sites"][0]["check"])

    def test_down_check_rolls_up_to_site_and_device(self):
        from api.models import Device, DeviceType, IPAddress, Prefix
        from api.test_utils import status_for
        from monitoring.models import CheckState, CheckTemplate

        dt = DeviceType.objects.create(tenant=self.tenant, name="T")
        dev = Device.objects.create(
            tenant=self.tenant, name="d1", device_type=dt, site=self.site,
            latitude="55.0", longitude="12.0",
        )
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24",
            status=status_for(self.tenant, "container"),
        )
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.1", prefix=prefix,
            assigned_device=dev,
        )
        tpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="icmp", slug="icmp", kind="icmp", params={}
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=tpl,
            status="down",
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=CheckTemplate.objects.create(
                tenant=self.tenant, name="tcp", slug="tcp", kind="tcp", params={"port": 22}
            ),
            status="up",
        )
        body = self._payload()
        self.assertEqual(body["sites"][0]["check"], "down")
        devs = {d["name"]: d for d in body["devices"]}
        self.assertEqual(devs["d1"]["check"], "down")


class SiteMarkerTests(SiteMapHealthTests.__bases__[0]):
    """Free markers + device FOV in the map payload."""

    def setUp(self):
        self.org = Organization.objects.create(name="MO", slug="mo")
        self.tenant = Tenant.objects.create(org=self.org, name="MT", slug="mt")
        self.admin = User.objects.create_superuser("map-marker", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

    def test_marker_crud_and_payload(self):
        from api.models import FloorTileType

        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Generator", slug="generator",
            color="#f59e0b", icon="zap",
        )
        r = self.client_api.post(
            "/api/site-markers/",
            {"latitude": "55.1", "longitude": "12.1",
             "tile_type_id": str(tt.id), "label": "Gen 1"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = self.client_api.get("/api/site-map/").json()
        m = body["markers"][0]
        self.assertEqual(m["label"], "Gen 1")
        self.assertEqual(m["type"]["icon"], "zap")
        self.assertFalse(m["type"]["has_fov"])

    def test_marker_requires_exactly_one_type(self):
        r = self.client_api.post(
            "/api/site-markers/",
            {"latitude": "55.1", "longitude": "12.1", "label": "x"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_device_fov_roundtrip_and_payload(self):
        from api.models import Device, DeviceRole, DeviceType

        role = DeviceRole.objects.create(
            tenant=self.tenant, name="Camera", slug="camera",
            color="#0ea5e9", has_fov=True,
        )
        dt = DeviceType.objects.create(tenant=self.tenant, name="Cam")
        dev = Device.objects.create(
            tenant=self.tenant, name="cam1", device_type=dt, role=role,
            latitude="55.0", longitude="12.0",
        )
        r = self.client_api.patch(
            f"/api/devices/{dev.id}/",
            {"fov_direction": 270, "fov_deg": 35, "fov_distance_m": 80},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = self.client_api.get("/api/site-map/").json()
        d = body["devices"][0]
        self.assertTrue(d["has_fov"])
        self.assertEqual(d["fov"], {
            "direction": 270, "deg": 35, "distance_m": 80, "ptz": False,
        })
