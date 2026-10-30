"""A floor plan made from a view of the Site map: the projection (box →
metres → grid at several latitudes), outlines converted to areas, and the
endpoint's permissions and caps."""

from __future__ import annotations

import io
import math
import shutil
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from PIL import Image
from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import floor_plan_from_map as fm
from .models import FloorPlan, FloorPlanArea, Location, LocationType, Site, SiteMapOutline

MEDIA = tempfile.mkdtemp(prefix="danbyte-from-map-test-")
R = fm.EARTH_CIRCUMFERENCE_M / (2 * math.pi)


def _png(w=40, h=30, fmt="PNG") -> SimpleUploadedFile:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 120, 200)).save(buf, format=fmt)
    ext = {"PNG": "png", "JPEG": "jpg", "GIF": "gif"}[fmt]
    return SimpleUploadedFile(f"view.{ext}", buf.getvalue(), content_type=f"image/{ext}")


class ProjectionTests(SimpleTestCase):
    def _metres(self, lat, dlat, dlng):
        """The box's sides on the sphere: along the parallel at the middle
        latitude, and along the meridian."""
        mid = math.radians(lat + dlat / 2)
        return (math.radians(dlng) * R * math.cos(mid), math.radians(dlat) * R)

    def test_extent_in_metres_at_several_latitudes(self):
        for lat in (0.0, 33.9, -33.9, 45.0, 56.15, 60.0, 70.0):
            dlat, dlng = 0.003, 0.004
            fr = fm.frame([lat, 10.0, lat + dlat, 10.0 + dlng], 1000)
            w, h = self._metres(lat, dlat, dlng)
            self.assertAlmostEqual(fr.width_m / w, 1.0, delta=0.002, msg=lat)
            self.assertAlmostEqual(fr.height_m / h, 1.0, delta=0.002, msg=lat)
            self.assertEqual(fr.cell_mm, 1000)
            self.assertEqual(fr.grid_width, round(fr.width_m))
            self.assertEqual(fr.grid_height, round(fr.height_m))

    def test_a_degree_of_longitude_shrinks_with_latitude(self):
        eq = fm.frame([0.0, 0.0, 0.001, 0.004])
        north = fm.frame([60.0, 0.0, 60.001, 0.004])
        self.assertAlmostEqual(north.width_m / eq.width_m, 0.5, delta=0.001)
        # 0.004° of longitude at the equator is 445 m.
        self.assertAlmostEqual(eq.width_m, 445.28, delta=0.05)

    def test_cell_is_raised_to_fit_512_cells(self):
        fr = fm.frame([56.0, 10.0, 56.005, 10.02], 1000)  # ~1.25 km wide
        self.assertGreater(fr.cell_mm, 1000)
        self.assertLessEqual(fr.grid_width, fm.MAX_GRID)
        self.assertAlmostEqual(fr.grid_width * fr.cell_mm / 1000, fr.width_m,
                               delta=fr.cell_mm / 1000)

    def test_too_large_and_bad_boxes(self):
        with self.assertRaises(ValidationError):
            fm.frame([56.0, 10.0, 56.1, 10.2])  # ~12 km
        for bad in (None, "x", [1, 2, 3], [56, 10, 55, 11], [56, 11, 57, 10],
                    [56, 10, 57, float("nan")], [89, 0, 89.5, 1]):
            with self.assertRaises(ValidationError, msg=bad):
                fm.frame(bad)
        with self.assertRaises(ValidationError):
            fm.frame([56.0, 10.0, 56.001, 10.001], 20)

    def test_bbox_as_text(self):
        a = fm.frame("[56.0, 10.0, 56.001, 10.002]")
        b = fm.frame("56.0,10.0,56.001,10.002")
        self.assertEqual((a.grid_width, a.grid_height), (b.grid_width, b.grid_height))

    def test_mercator_round_trip(self):
        for lat in (-70.0, -12.5, 0.0, 41.2, 66.6):
            self.assertAlmostEqual(fm.lat_of(fm.merc_y(lat)), lat, places=9)

    def test_corners_map_to_grid_corners(self):
        fr = fm.frame([56.0, 10.0, 56.002, 10.003], 500)
        self.assertEqual(fr.to_cells(56.002, 10.0), (0.0, 0.0))
        x, y = fr.to_cells(56.0, 10.003)
        self.assertAlmostEqual(x, fr.grid_width)
        self.assertAlmostEqual(y, fr.grid_height)


class OutlineConversionTests(SimpleTestCase):
    def setUp(self):
        self.fr = fm.frame([56.0, 10.0, 56.001, 10.002], 1000)

    def test_inside_outline_keeps_its_shape(self):
        pts = [[56.0008, 10.0005], [56.0008, 10.0010], [56.0004, 10.0010],
               [56.0004, 10.0005]]
        cells = fm.outline_cells(pts, self.fr)
        self.assertEqual(len(cells), 4)
        x0, y0 = self.fr.to_cells(56.0008, 10.0005)
        self.assertEqual(cells[0], [round(x0, 3), round(y0, 3)])
        # 0.0005° of longitude at 56° is ~31 m; 0.0004° of latitude ~44.5 m.
        # A box not snapped to whole cells is stretched over the rounded
        # grid, like its image: in metres along the image it is exact.
        w = (cells[1][0] - cells[0][0]) * self.fr.width_m / self.fr.grid_width
        h = (cells[2][1] - cells[1][1]) * self.fr.height_m / self.fr.grid_height
        self.assertAlmostEqual(w, 0.0005 / 360 * fm.EARTH_CIRCUMFERENCE_M
                               * math.cos(math.radians(56.0005)), delta=0.05)
        self.assertAlmostEqual(h, math.radians(0.0004) * R, delta=0.1)

    def test_partly_outside_is_clipped_to_the_grid(self):
        pts = [[56.0005, 9.999], [56.0005, 10.001], [56.002, 10.001], [56.002, 9.999]]
        cells = fm.outline_cells(pts, self.fr)
        self.assertIsNotNone(cells)
        for x, y in cells:
            self.assertGreaterEqual(x, 0)
            self.assertGreaterEqual(y, 0)
            self.assertLessEqual(x, self.fr.grid_width)
            self.assertLessEqual(y, self.fr.grid_height)
        self.assertIn(0.0, [p[0] for p in cells])
        self.assertIn(0.0, [p[1] for p in cells])

    def test_outside_is_dropped(self):
        pts = [[57.0, 11.0], [57.0, 11.001], [57.001, 11.001]]
        self.assertIsNone(fm.outline_cells(pts, self.fr))

    def test_many_points_are_simplified_to_200(self):
        c = (56.0005, 10.001)
        ring = [[c[0] + 0.0003 * math.sin(2 * math.pi * i / 400),
                 c[1] + 0.0005 * math.cos(2 * math.pi * i / 400)] for i in range(400)]
        cells = fm.outline_cells(ring, self.fr)
        self.assertEqual(len(cells), fm.MAX_AREA_POINTS)

    def test_plain_attribution(self):
        from .site_map_views import ESRI_SAT_ATTRIBUTION, OSM_ATTRIBUTION

        self.assertEqual(fm.plain_attribution(OSM_ATTRIBUTION), "© OpenStreetMap contributors")
        self.assertTrue(fm.plain_attribution(ESRI_SAT_ATTRIBUTION).startswith("Tiles © Esri — "))
        self.assertEqual(fm.plain_attribution("<script>x</script>Me"), "xMe")


@override_settings(MEDIA_ROOT=MEDIA)
class EndpointTests(APITestCase):
    URL = "/api/floor-plans/from-map/"
    BBOX = "[56.0, 10.0, 56.001, 10.002]"

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Depot")
        btype = LocationType.objects.create(
            tenant=self.tenant, name="Building", slug="building", color="#2563eb"
        )
        self.bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building A", slug="a", code="A1",
            location_type=btype,
        )
        self.secret = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Vault", slug="vault",
            description="secret",
        )
        sq = [[56.0008, 10.0005], [56.0008, 10.0010], [56.0004, 10.0010], [56.0004, 10.0005]]
        self.o_bldg = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=sq,
        )
        self.o_free = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, points=[[a, b + 0.0008] for a, b in sq],
            label="Gate", color="#16a34a",
        )
        self.o_secret = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.secret,
            points=[[a - 0.0003, b] for a, b in sq],
        )
        SiteMapOutline.objects.create(  # another site's, in the same view
            tenant=self.tenant, site=self.site_b, points=[[a, b + 0.0004] for a, b in sq],
        )
        SiteMapOutline.objects.create(  # far away
            tenant=self.tenant, site=self.site, points=[[a + 1, b] for a, b in sq],
        )
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, grants):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        for i, (types, actions, sites, constraints) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=types, actions=actions,
                constraints=constraints,
            )
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.set(sites)
            perm.users.add(u)
        return u

    def _post(self, image=True, **body):
        body.setdefault("name", "Campus overview")
        body.setdefault("site_id", str(self.site.id))
        body.setdefault("bbox", self.BBOX)
        body.setdefault("cell_mm", "1000")
        body.setdefault("zoom", "18")
        if image is True:
            body["background_image"] = _png()
        elif image:
            body["background_image"] = image
        return self.client.post(self.URL, body, format="multipart")

    def test_creates_site_wide_plan_at_true_scale(self):
        r = self._post()
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        plan = FloorPlan.objects.get(pk=d["id"])
        fr = fm.frame(self.BBOX, 1000)
        self.assertIsNone(plan.location_id)
        self.assertEqual(plan.site_id, self.site.id)
        self.assertEqual((plan.grid_width, plan.grid_height, plan.cell_mm),
                         (fr.grid_width, fr.grid_height, 1000))
        self.assertTrue(plan.background_image.name.endswith(".png"))
        self.assertIn("OpenStreetMap contributors", plan.description)
        self.assertEqual(plan.state["from_map"]["zoom"], 18)
        self.assertEqual(plan.state["from_map"]["basemap"], "map")
        self.assertIsNone(plan.stack.location_id)
        self.assertEqual(d["areas_created"], 3)
        areas = {a.location_id: a for a in FloorPlanArea.objects.filter(floor_plan=plan)}
        self.assertEqual(areas[self.bldg.id].label, "A1")
        self.assertEqual(areas[self.bldg.id].color, "#2563eb")
        self.assertEqual(areas[self.bldg.id].shape, "polygon")
        self.assertEqual(areas[None].label, "Gate")
        self.assertEqual(areas[None].color, "#16a34a")

    def test_satellite_attribution_and_no_image(self):
        r = self._post(basemap="sat")
        self.assertIn("Esri", FloorPlan.objects.get(pk=r.json()["id"]).description)
        r = self._post(image=False, name="Outlines only")
        self.assertEqual(r.status_code, 201, r.content)
        plan = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertFalse(plan.background_image)
        self.assertNotIn("Background", plan.description)
        self.assertEqual(r.json()["areas_created"], 3)

    def test_json_body_without_image(self):
        r = self.client.post(self.URL, {
            "name": "Json", "site_id": str(self.site.id),
            "bbox": [56.0, 10.0, 56.001, 10.002],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cell_mm"], 1000)

    def test_name_clash_and_bad_input(self):
        self.assertEqual(self._post().status_code, 201)
        r = self._post()
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        self.assertEqual(self._post(name=" ").status_code, 400)
        self.assertEqual(self._post(name="x", bbox="[1,2]").status_code, 400)
        self.assertEqual(self._post(name="y", cell_mm="abc").status_code, 400)
        self.assertEqual(self._post(name="z", basemap="night").status_code, 400)
        r = self._post(name="big", bbox="[56.0, 10.0, 56.1, 10.2]")
        self.assertEqual(r.status_code, 400)
        self.assertIn("too large", str(r.json()["bbox"]))
        self.assertEqual(FloorPlan.objects.count(), 1)

    def test_image_caps(self):
        r = self._post(image=_png(fmt="GIF"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("background_image", r.json())
        r = self._post(image=SimpleUploadedFile("x.png", b"not an image"))
        self.assertEqual(r.status_code, 400)
        r = self._post(image=_png(fm.MAX_IMAGE_EDGE + 1, 2))
        self.assertEqual(r.status_code, 400)
        with mock.patch.object(fm, "MAX_IMAGE_BYTES", 10):
            r = self._post(image=_png())
        self.assertEqual(r.status_code, 400)
        self.assertIn("MB", str(r.json()))
        self.assertEqual(FloorPlan.objects.count(), 0)
        self.assertEqual(self._post(image=_png(fmt="JPEG")).status_code, 201)

    def test_other_tenants_site_is_refused(self):
        r = self._post(site_id=str(self.their_site.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_id", r.json())

    def test_needs_floorplan_add(self):
        u = self._user("viewer", [(["floorplan", "site", "sitemapoutline", "location"],
                                   ["view", "change"], [], None)])
        self._login(u)
        self.assertEqual(self._post().status_code, 403)
        self.assertEqual(FloorPlan.objects.count(), 0)

    def test_site_scoped_add_is_held_to_its_site(self):
        u = self._user("local", [
            (["floorplan"], ["view", "add"], [self.site], None),
            (["site", "location", "sitemapoutline"], ["view"], [], None),
        ])
        self._login(u)
        r = self._post(site_id=str(self.site_b.id))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(FloorPlan.objects.count(), 0)
        self.assertEqual(self._post().status_code, 201)

    def test_hidden_locations_and_outline_grant(self):
        u = self._user("partial", [
            (["floorplan"], ["view", "add"], [], None),
            (["site", "sitemapoutline"], ["view"], [], None),
            (["location"], ["view"], [], {"name": "Building A"}),
        ])
        self._login(u)
        r = self._post()
        self.assertEqual(r.status_code, 201, r.content)
        plan = FloorPlan.objects.get(pk=r.json()["id"])
        linked = set(FloorPlanArea.objects.filter(floor_plan=plan)
                     .values_list("location_id", flat=True))
        self.assertEqual(linked, {self.bldg.id, None})
        self.assertEqual(r.json()["areas_created"], 2)

        no_outlines = self._user("nooutlines", [
            (["floorplan"], ["view", "add"], [], None),
            (["site", "location"], ["view"], [], None),
        ])
        self._login(no_outlines)
        r = self._post(name="Bare")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["areas_created"], 0)
