"""Site map endpoint - RBAC scoping, coordinates, tile config defaults."""
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

    def test_regions_with_boundaries_ship_with_payload(self):
        from api.models import Region

        poly = {"type": "Polygon",
                "coordinates": [[[8.0, 55.0], [9.0, 55.0], [8.5, 56.0], [8.0, 55.0]]]}
        Region.objects.create(
            tenant=self.tenant, name="Fyn", slug="fyn",
            color="#2563eb", boundary=poly,
        )
        Region.objects.create(tenant=self.tenant, name="Bare", slug="bare")
        regions = self.client_api.get("/api/site-map/").json()["regions"]
        self.assertEqual([r["name"] for r in regions], ["Fyn"])
        self.assertEqual(regions[0]["color"], "#2563eb")
        self.assertEqual(regions[0]["boundary"]["type"], "Polygon")

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

    def test_site_color_icon_roundtrip_and_map_payload(self):
        site = Site.objects.get(name="Placed")
        r = self.client_api.patch(
            f"/api/sites/{site.id}/",
            {"color": "#0ea5e9", "icon": "factory"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["color"], "#0ea5e9")
        body = self.client_api.get("/api/site-map/").json()
        placed = next(s for s in body["sites"] if s["name"] == "Placed")
        self.assertEqual(placed["color"], "#0ea5e9")
        self.assertEqual(placed["icon"], "factory")
        # Clearing goes back to "" = theme default, never null.
        r = self.client_api.patch(
            f"/api/sites/{site.id}/", {"color": "", "icon": ""}, format="json"
        )
        self.assertEqual(r.json()["color"], "")
        self.assertEqual(r.json()["icon"], "")

    def test_location_color_icon_roundtrip(self):
        from .models import Location

        site = Site.objects.get(name="Placed")
        loc = Location.objects.create(
            tenant=self.tenant, site=site, name="Hall A", slug="hall-a",
            color="#f59e0b", icon="warehouse",
        )
        r = self.client_api.get(f"/api/locations/{loc.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["color"], "#f59e0b")
        self.assertEqual(r.json()["icon"], "warehouse")
        r = self.client_api.patch(
            f"/api/locations/{loc.id}/", {"color": ""}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["color"], "")

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


class VectorBasemapTests(TestCase):
    """#467: raster or vector street basemap, the vector source, and the
    label language (deployment default, per-user override)."""

    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("vec-admin", password="x")
        self.user = User.objects.create_user("vec-user", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

    def tiles(self):
        r = self.client_api.get("/api/site-map/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["tiles"]

    def test_a_new_install_starts_on_vector_an_upgraded_one_keeps_raster(self):
        DeploymentSettings.objects.all().delete()
        self.assertEqual(DeploymentSettings.load().map_basemap, "vector")
        # The row an upgraded install already has keeps the column default.
        DeploymentSettings.objects.all().delete()
        DeploymentSettings.objects.create(pk=1)
        self.assertEqual(DeploymentSettings.load().map_basemap, "raster")
        self.assertEqual(DeploymentSettings._meta.get_field("map_basemap").default, "raster")

    def test_payload_carries_the_vector_source_and_language(self):
        ds = DeploymentSettings.load()
        ds.map_basemap = "vector"
        ds.map_label_language = "local"
        ds.save()
        tiles = self.tiles()
        self.assertEqual(tiles["basemap"], "vector")
        self.assertEqual(
            tiles["vector"]["url"],
            "https://vector.openstreetmap.org/shortbread_v1/tilejson.json",
        )
        self.assertIn("OpenStreetMap", tiles["vector"]["attribution"])
        self.assertTrue(tiles["vector"]["osm_default"])
        self.assertEqual(tiles["labels"], "local")
        # The raster URL stays: the fallback without WebGL.
        self.assertEqual(tiles["url"], "https://tile.openstreetmap.org/{z}/{x}/{y}.png")

        ds.map_vector_url = "https://tiles.corp.example/style.json"
        ds.map_vector_attribution = "Corp GIS"
        ds.save()
        tiles = self.tiles()
        self.assertEqual(tiles["vector"], {
            "url": "https://tiles.corp.example/style.json",
            "attribution": "Corp GIS", "osm_default": False,
        })

    def test_a_user_overrides_the_label_language(self):
        ds = DeploymentSettings.load()
        ds.map_label_language = "en"
        ds.save()
        # /api/me/prefs/ is a plain Django view: it needs a session login;
        # and a fresh user per request, as in real use (force_authenticate
        # hands every request the same object, profile cached).
        self.client_api.force_authenticate(None)
        self.client_api.force_login(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client_api.put("/api/me/prefs/", {"map_label_language": "browser_local"},
                                format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.tiles()["labels"], "browser_local")
        self.client_api.put("/api/me/prefs/", {"map_label_language": "auto"}, format="json")
        self.assertEqual(self.tiles()["labels"], "en")
        r = self.client_api.put("/api/me/prefs/", {"map_label_language": "<b>"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_settings_are_admin_only_and_validated(self):
        c = APIClient()
        c.force_authenticate(self.user)
        r = c.put("/api/deployment/email/", {"map_basemap": "vector"}, format="json")
        self.assertEqual(r.status_code, 403)

        base = self.client_api.get("/api/deployment/email/").json()
        for field in ("map_basemap", "map_vector_url", "map_vector_attribution",
                      "map_label_language"):
            self.assertIn(field, base)

        def put(**patch):
            return self.client_api.put("/api/deployment/email/", {**base, **patch},
                                       format="json")

        r = put(map_basemap="vector", map_label_language="en_local",
                map_vector_url=" https://tiles.example/shortbread/tilejson.json ")
        self.assertEqual(r.status_code, 200, r.content)
        ds = DeploymentSettings.load()
        self.assertEqual(ds.map_basemap, "vector")
        self.assertEqual(ds.map_vector_url, "https://tiles.example/shortbread/tilejson.json")
        for bad in ("http://tiles.example/tilejson.json",
                    "javascript:alert(1)",
                    "https://user:pw@tiles.example/tilejson.json",
                    "https:///nohost",
                    "https://tiles.example/{z}/{x}/{y}.mvt",
                    'https://tiles.example/"><script>'):
            with self.subTest(url=bad):
                self.assertEqual(put(map_vector_url=bad).status_code, 400)
        self.assertEqual(put(map_basemap="webgl").status_code, 400)
        self.assertEqual(put(map_label_language="klingon").status_code, 400)

    def test_a_capture_credits_the_basemap_it_was_drawn_from(self):
        from api.site_map_views import effective_tiles, street_attribution

        ds = DeploymentSettings.load()
        ds.map_tile_url = "https://r.example/{z}/{x}/{y}.png"
        ds.map_tile_attribution = "Raster Co"
        ds.map_vector_url = "https://v.example/tilejson.json"
        ds.map_vector_attribution = "Vector Co"
        ds.map_basemap = "vector"
        ds.save()
        self.assertEqual(street_attribution(effective_tiles()), "Vector Co")
        ds.map_basemap = "raster"
        ds.save()
        self.assertEqual(street_attribution(effective_tiles()), "Raster Co")


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

    def test_marker_list_filters_by_tile_type(self):
        """?tile_type= backs the tile-type detail page's marker read, and it
        narrows the tenant-scoped queryset - a foreign type id returns
        nothing rather than the other tenant's markers."""
        from api.models import FloorTileType, SiteMarker

        mine = FloorTileType.objects.create(
            tenant=self.tenant, name="Camera", slug="camera"
        )
        other_type = FloorTileType.objects.create(
            tenant=self.tenant, name="Generator", slug="generator"
        )
        SiteMarker.objects.create(
            tenant=self.tenant, latitude="55.1", longitude="12.1",
            tile_type=mine, label="Cam 1",
        )
        SiteMarker.objects.create(
            tenant=self.tenant, latitude="55.2", longitude="12.2",
            tile_type=other_type, label="Gen 1",
        )
        body = self.client_api.get(f"/api/site-markers/?tile_type={mine.id}").json()
        self.assertEqual([m["label"] for m in body["results"]], ["Cam 1"])

        foreign_tenant = Tenant.objects.create(org=self.org, name="MX", slug="mx")
        foreign_type = FloorTileType.objects.create(
            tenant=foreign_tenant, name="Foreign", slug="foreign"
        )
        SiteMarker.objects.create(
            tenant=foreign_tenant, latitude="1.0", longitude="1.0",
            tile_type=foreign_type, label="Theirs",
        )
        leaked = self.client_api.get(
            f"/api/site-markers/?tile_type={foreign_type.id}"
        ).json()
        self.assertEqual(leaked["count"], 0)

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


class SiteGeocodeTests(SiteMapTests.__bases__[0]):
    """GET /api/sites/geocode/ - address → coordinates via Nominatim."""

    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("geo-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

    def test_requires_query(self):
        r = self.client_api.get("/api/sites/geocode/")
        self.assertEqual(r.status_code, 400)

    def test_returns_coordinates(self):
        from unittest.mock import patch

        rows = [
            {"display_name": "Rådhuspladsen, København", "category": "place",
             "type": "square", "lat": "55.675618", "lon": "12.569628"},
            {"display_name": "broken row", "category": "place", "type": "x"},
        ]
        fake = type("R", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: rows,
        })()
        with patch("core.ssrf.safe_get", return_value=fake) as mock_get:
            r = self.client_api.get("/api/sites/geocode/?q=R%C3%A5dhuspladsen")
        self.assertEqual(r.status_code, 200, r.content)
        results = r.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertAlmostEqual(results[0]["latitude"], 55.675618)
        self.assertAlmostEqual(results[0]["longitude"], 12.569628)
        _, kwargs = mock_get.call_args
        self.assertIn("Danbyte/", kwargs["headers"]["User-Agent"])
        # Address geocoding needs no polygons - keep the request light.
        self.assertNotIn("polygon_geojson", kwargs["params"])

    def test_upstream_failure_is_502(self):
        from unittest.mock import patch

        with patch("core.ssrf.safe_get", side_effect=OSError("boom")):
            r = self.client_api.get("/api/sites/geocode/?q=x")
        self.assertEqual(r.status_code, 502)

    def test_results_follow_the_browser_language(self):
        """Nominatim answers in each place's local language unless told
        otherwise; the lookup passes the browser's language, else English
        (#420)."""
        from unittest.mock import patch

        fake = type("R", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: [],
        })()
        with patch("core.ssrf.safe_get", return_value=fake) as mock_get:
            self.client_api.get("/api/sites/geocode/?q=Tokyo",
                                HTTP_ACCEPT_LANGUAGE="da-DK,da;q=0.9,en;q=0.8")
        args, kwargs = mock_get.call_args
        self.assertEqual(kwargs["params"]["accept-language"], "da-DK,da;q=0.9,en;q=0.8")
        # Still the one guarded request to the fixed Nominatim host.
        self.assertEqual(args[0], "https://nominatim.openstreetmap.org/search")
        with patch("core.ssrf.safe_get", return_value=fake) as mock_get:
            self.client_api.get("/api/sites/geocode/?q=Tokyo")
        self.assertEqual(mock_get.call_args[1]["params"]["accept-language"], "en")
        with patch("core.ssrf.safe_get", return_value=fake) as mock_get:
            self.client_api.get("/api/sites/geocode/?q=Tokyo", HTTP_ACCEPT_LANGUAGE="x" * 500)
        self.assertEqual(len(mock_get.call_args[1]["params"]["accept-language"]), 100)
