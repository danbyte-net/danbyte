"""The geo anchor of a plan made from the Site map: the backfill from
``state.from_map``, Refresh map, Expand (every kind of object moves with the
cells added west and north, versions, audit, refusals, permissions),
re-importing outlines, the plan footprints on the Site map and GPS
placement."""

from __future__ import annotations

import importlib
import io
import shutil
import tempfile

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import floor_plan_from_map as fm
from . import floor_plan_geo as geo
from .models import (
    Cable,
    Device,
    FloorPlan,
    FloorPlanArea,
    FloorPlanCablePath,
    FloorPlanDrawing,
    FloorPlanLabel,
    FloorPlanRaisedFloorArea,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    FloorTileType,
    Location,
    Site,
    SiteMapOutline,
)

MEDIA = tempfile.mkdtemp(prefix="danbyte-plan-geo-test-")
BBOX = [56.0, 10.0, 56.001, 10.002]


def _png(w=40, h=30, fmt="PNG", name="view") -> SimpleUploadedFile:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 120, 200)).save(buf, format=fmt)
    ext = {"PNG": "png", "JPEG": "jpg", "GIF": "gif"}[fmt]
    return SimpleUploadedFile(f"{name}.{ext}", buf.getvalue(), content_type=f"image/{ext}")


def _grown(plan, left=0, top=0, right=0, bottom=0):
    """``plan``'s box grown by whole cells on each side."""
    s, w, n, e = plan.geo_bbox
    x0, x1 = fm.merc_x(w), fm.merc_x(e)
    y0, y1 = fm.merc_y(n), fm.merc_y(s)
    cx = (x1 - x0) / plan.grid_width
    cy = (y1 - y0) / plan.grid_height
    return [
        fm.lat_of(y1 + bottom * cy), geo.lng_of(x0 - left * cx),
        fm.lat_of(y0 - top * cy), geo.lng_of(x1 + right * cx),
    ]


class BackfillTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.mig = importlib.import_module("api.migrations.0242_floor_plan_geo")

    def _plan(self, name, state, **kw):
        return FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name=name, state=state,
            grid_width=124, grid_height=111, cell_mm=1000, **kw,
        )

    def test_from_map_state_becomes_the_anchor(self):
        made = self._plan("Made", {"from_map": {
            "bbox": BBOX, "zoom": 18, "basemap": "sat", "attribution": "x",
        }})
        made.background_image.save("bg.png", ContentFile(_png().read()), save=True)
        bare = self._plan("Outlines only", {"from_map": {"bbox": BBOX, "basemap": None}})
        copy = self._plan("Copy", {"from_map": {"bbox": BBOX}}, crop={"x": 0, "y": 0,
                                                                      "w": 5, "h": 5})
        bad = self._plan("Bad", {"from_map": {"bbox": [1, 2, 3]}})
        plain = self._plan("Plain", {"zoom": 3})
        self.mig.backfill(django_apps, None)
        for p in (made, bare, copy, bad, plain):
            p.refresh_from_db()
        self.assertEqual(made.geo_bbox, BBOX)
        self.assertEqual((made.geo_zoom, made.geo_basemap), (18, "sat"))
        self.assertEqual(made.geo_captured_at, made.created_at)
        self.assertAlmostEqual(made.geo_mpc, fm.frame(BBOX).width_m / 124, places=6)
        self.assertEqual(bare.geo_bbox, BBOX)
        self.assertEqual(bare.geo_basemap, "")
        self.assertIsNone(bare.geo_captured_at)
        for p in (copy, bad, plain):
            self.assertIsNone(p.geo_bbox, p.name)
        # Idempotent.
        self.mig.backfill(django_apps, None)
        made.refresh_from_db()
        self.assertEqual(made.geo_bbox, BBOX)


@override_settings(MEDIA_ROOT=MEDIA)
class _Base(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Depot")
        self.bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building A", slug="a", code="A1",
        )
        sq = [[56.0008, 10.0005], [56.0008, 10.0010], [56.0004, 10.0010], [56.0004, 10.0005]]
        self.o_bldg = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, location=self.bldg, points=sq,
        )
        self.o_free = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, points=[[a, b + 0.0008] for a, b in sq],
            label="Gate",
        )
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)
        r = self.client.post("/api/floor-plans/from-map/", {
            "name": "Campus", "site_id": str(self.site.id), "bbox": str(BBOX),
            "cell_mm": "1000", "zoom": "18", "background_image": _png(),
        }, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        self.plan = FloorPlan.objects.get(pk=r.json()["id"])

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, grants):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        for i, (types, actions, sites) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=types, actions=actions,
            )
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.set(sites)
            perm.users.add(u)
        return u


class AnchorTests(_Base):
    def test_made_from_the_map_has_an_anchor(self):
        p = self.plan
        self.assertEqual(p.geo_bbox, BBOX)
        self.assertEqual((p.geo_zoom, p.geo_basemap), (18, "map"))
        self.assertIsNotNone(p.geo_captured_at)
        self.assertAlmostEqual(p.geo_mpc, 1.0, delta=0.01)
        d = self.client.get(f"/api/floor-plans/{p.id}/").json()
        self.assertEqual(d["geo"]["bbox"], BBOX)
        self.assertEqual(d["geo"]["basemap"], "map")
        self.assertIn("OpenStreetMap", d["geo"]["attribution"])

    def test_plain_plan_has_none(self):
        other = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        self.assertIsNone(self.client.get(f"/api/floor-plans/{other.id}/").json()["geo"])
        r = self.client.post(f"/api/floor-plans/{other.id}/expand/",
                             {"bbox": BBOX}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_plain_background_upload_drops_the_capture(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/background/",
                             {"background_image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["geo"]["captured_at"])
        self.assertEqual(r.json()["geo"]["bbox"], BBOX)


class RefreshTests(_Base):
    URL = "/api/floor-plans/{}/background/"

    def test_refresh_replaces_only_the_background(self):
        area = self.plan.areas.first()
        before = (area.points, self.plan.grid_width, self.plan.geo_captured_at)
        old_name = self.plan.background_image.name
        r = self.client.post(self.URL.format(self.plan.id), {
            "map_refresh": "1", "basemap": "sat", "zoom": "17",
            "background_image": _png(fmt="JPEG"),
        }, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.plan.refresh_from_db()
        area.refresh_from_db()
        self.assertEqual((area.points, self.plan.grid_width), before[:2])
        self.assertGreater(self.plan.geo_captured_at, before[2])
        self.assertEqual((self.plan.geo_basemap, self.plan.geo_zoom), ("sat", 17))
        self.assertNotEqual(self.plan.background_image.name, old_name)
        self.assertTrue(self.plan.background_image.name.endswith(".jpg"))
        self.assertIn("Esri", r.json()["geo"]["attribution"])
        entry = ChangeLogEntry.objects.filter(
            object_type="api.floorplan", object_id=str(self.plan.pk),
        ).order_by("-timestamp").first()
        self.assertEqual(entry.cause, "Map refreshed from the Site map")

    def test_refresh_checks_the_image_and_the_anchor(self):
        url = self.URL.format(self.plan.id)
        for bad in (None, _png(fmt="GIF"), SimpleUploadedFile("x.png", b"no")):
            body = {"map_refresh": "1"}
            if bad is not None:
                body["background_image"] = bad
            self.assertEqual(self.client.post(url, body, format="multipart").status_code, 400)
        body = {"map_refresh": "1", "background_image": _png(), "basemap": "night"}
        self.assertEqual(self.client.post(url, body, format="multipart").status_code, 400)
        plain = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        r = self.client.post(self.URL.format(plain.id), {
            "map_refresh": "1", "background_image": _png(),
        }, format="multipart")
        self.assertEqual(r.status_code, 400)

    def test_refresh_needs_change(self):
        viewer = self._user("viewer", [(["floorplan"], ["view"], [])])
        self._login(viewer)
        r = self.client.post(self.URL.format(self.plan.id), {
            "map_refresh": "1", "background_image": _png(),
        }, format="multipart")
        self.assertEqual(r.status_code, 403)


class ExpandTests(_Base):
    def setUp(self):
        super().setUp()
        p = self.plan
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        self.tile = FloorPlanTile.objects.create(floor_plan=p, tile_type=tt, x=2, y=3)
        self.riser = FloorPlanTile.objects.create(
            floor_plan=p, tile_type=tt, x=10, y=4, riser=True,
        )
        self.raised = FloorPlanRaisedFloorArea.objects.create(
            floor_plan=p, x=1, y=1, width=3, height=2,
        )
        self.rect = FloorPlanArea.objects.create(
            floor_plan=p, x=4, y=5, width=3, height=2, label="Rect",
        )
        self.poly = p.areas.get(location=self.bldg)
        self.poly_points = [list(pt) for pt in self.poly.points]
        self.label = FloorPlanLabel.objects.create(floor_plan=p, text="N", x=6, y=7)
        self.wall = FloorPlanWall.objects.create(
            floor_plan=p, points=[[0, 0], [5, 0]],
            openings=[{"seg": 0, "from": 1, "to": 2}], source_area=self.rect,
        )
        self.tray = FloorPlanTray.objects.create(
            floor_plan=p, name="T1", points=[[1, 1], [8, 1]],
        )
        cable = Cable.objects.create(tenant=self.tenant, label="C1")
        self.path = FloorPlanCablePath.objects.create(
            tenant=self.tenant, floor_plan=p, cable=cable, riser=self.riser,
            legs=[{
                "from": {"end": "A", "tile": str(self.tile.id), "at": [2.5, 3.5]},
                "to": {"end": "B", "tile": str(self.riser.id), "at": [10.5, 4.5]},
                "points": [[2.5, 3.5], [2.5, 1], [10.5, 1], [10.5, 4.5]],
                "trays": [{"id": str(self.tray.id), "entry": [2.5, 1], "exit": [8, 1],
                           "elevation_mm": 2700}],
                "waypoints": [[9, 1]],
            }],
            tile_ids=[str(self.tile.id), str(self.riser.id)],
            tray_order=[str(self.tray.id)],
        )
        self.drawing = FloorPlanDrawing.objects.create(
            tenant=self.tenant, floor_plan=p, source="floor-plans/cad/x.dxf",
            source_kind="dxf", placement={"x_mm": 100, "y_mm": 50},
        )
        r = self.client.post(f"/api/floor-plans/{p.id}/snapshot/", {
            "name": "Corner", "mode": "view", "crop": {"x": 1, "y": 2, "w": 10, "h": 8},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.view = FloorPlan.objects.get(pk=r.json()["id"])
        r = self.client.post(f"/api/floor-plans/{p.id}/snapshot/", {
            "name": "Rect room", "mode": "view", "area_id": str(self.rect.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.follower = FloorPlan.objects.get(pk=r.json()["id"])
        self.view_label = FloorPlanLabel.objects.create(
            floor_plan=p, text="Back", x=3, y=3, shown_in=self.view,
        )
        p.refresh_from_db()

    def expand(self, bbox, plan=None, **body):
        plan = plan or self.plan
        body["bbox"] = str(bbox)
        return self.client.post(f"/api/floor-plans/{plan.id}/expand/", body,
                                format="multipart")

    def test_growing_west_and_north_moves_everything(self):
        p = self.plan
        gw, gh = p.grid_width, p.grid_height
        r = self.expand(_grown(p, left=5, top=3, right=2, bottom=1),
                        version=p.updated_at.isoformat())
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d["grid_width"], d["grid_height"]), (gw + 7, gh + 4))
        self.assertEqual(
            {k: d["expanded"][k] for k in ("left", "top", "right", "bottom")},
            {"left": 5, "top": 3, "right": 2, "bottom": 1},
        )
        for obj in (self.tile, self.riser, self.raised, self.rect, self.poly, self.label,
                    self.wall, self.tray, self.path, self.drawing, self.view,
                    self.view_label):
            obj.refresh_from_db()
        self.assertEqual((self.tile.x, self.tile.y), (7, 6))
        self.assertEqual((self.riser.x, self.riser.y), (15, 7))
        self.assertTrue(self.riser.riser)
        self.assertEqual((self.raised.x, self.raised.y), (6, 4))
        self.assertEqual((self.rect.x, self.rect.y), (9, 8))
        self.assertEqual(self.poly.points[0], [round(self.poly_points[0][0] + 5, 6),
                                               round(self.poly_points[0][1] + 3, 6)])
        self.assertEqual((self.label.x, self.label.y), (11, 10))
        self.assertEqual((self.view_label.x, self.view_label.y), (8, 6))
        self.assertEqual(self.view_label.shown_in_id, self.view.id)
        self.assertEqual(self.wall.points, [[5, 3], [10, 3]])
        self.assertEqual(self.wall.openings, [{"seg": 0, "from": 1, "to": 2}])
        self.assertEqual(self.wall.source_area_id, self.rect.id)
        self.assertEqual(self.tray.points, [[6, 4], [13, 4]])
        leg = self.path.legs[0]
        self.assertEqual(leg["from"]["at"], [7.5, 6.5])
        self.assertEqual(leg["to"]["at"], [15.5, 7.5])
        self.assertEqual(leg["points"][1], [7.5, 4])
        self.assertEqual(leg["trays"][0]["entry"], [7.5, 4])
        self.assertEqual(leg["trays"][0]["elevation_mm"], 2700)
        self.assertEqual(leg["waypoints"], [[14, 4]])
        self.assertFalse(self.path.stale)
        self.assertEqual(self.path.riser_id, self.riser.id)
        self.assertEqual((self.drawing.placement["x_mm"], self.drawing.placement["y_mm"]),
                         (5100, 3050))
        self.assertEqual((self.view.crop["x"], self.view.crop["y"]), (6, 5))
        # The area-following view follows the area to its new place.
        snap = self.client.get(f"/api/floor-plans/{self.follower.id}/").json()["snapshot"]
        self.assertEqual((snap["crop"]["x"], snap["crop"]["y"]), (9, 8))
        # The new box holds the old one and is in whole cells.
        self.plan.refresh_from_db()
        self.assertLess(self.plan.geo_bbox[1], BBOX[1])
        self.assertGreater(self.plan.geo_bbox[2], BBOX[2])
        self.assertEqual(self.plan.state["from_map"]["bbox"], self.plan.geo_bbox)
        fr = geo.plan_frame(self.plan)
        x, y = fr.to_cells(BBOX[2], BBOX[1])
        self.assertAlmostEqual(x, 5, places=6)
        self.assertAlmostEqual(y, 3, places=6)

    def test_every_move_is_logged_with_the_cause(self):
        r = self.expand(_grown(self.plan, left=1))
        self.assertEqual(r.status_code, 200, r.content)
        cause = "Expanded Campus from the Site map"
        for model, obj in (("floorplantile", self.tile), ("floorplanarea", self.rect),
                           ("floorplanwall", self.wall), ("floorplantray", self.tray),
                           ("floorplanlabel", self.label), ("floorplan", self.plan),
                           ("floorplancablepath", self.path), ("floorplan", self.view)):
            entry = ChangeLogEntry.objects.filter(
                object_type=f"api.{model}", object_id=str(obj.pk), cause=cause,
            )
            self.assertTrue(entry.exists(), model)

    def test_growing_east_and_south_moves_nothing(self):
        gw = self.plan.grid_width
        r = self.expand(_grown(self.plan, right=4, bottom=2))
        self.assertEqual(r.status_code, 200, r.content)
        self.tile.refresh_from_db()
        self.assertEqual((self.tile.x, self.tile.y), (2, 3))
        self.assertEqual(r.json()["grid_width"], gw + 4)
        self.assertEqual(r.json()["expanded"]["moved"], {})

    def test_without_a_render_the_old_background_is_padded_in_place(self):
        old = self.plan.geo_captured_at
        gw, gh = self.plan.grid_width, self.plan.grid_height
        r = self.expand(_grown(self.plan, left=gw, top=gh))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["expanded"]["background"], "padded")
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.geo_captured_at, old)
        with self.plan.background_image.open("rb") as f:
            img = Image.open(f)
            img.load()
        self.assertEqual(img.size, (80, 60))
        # The old picture sits in the bottom right quarter; the new margin
        # is empty.
        self.assertEqual(img.getpixel((60, 45))[:3], (10, 120, 200))
        self.assertEqual(img.getpixel((5, 5))[3], 0)

    def test_with_a_render_it_becomes_the_background(self):
        old = self.plan.geo_captured_at
        r = self.expand(_grown(self.plan, left=2), background_image=_png(90, 40),
                        basemap="sat", zoom="17")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["expanded"]["background"], "rendered")
        self.plan.refresh_from_db()
        self.assertGreater(self.plan.geo_captured_at, old)
        self.assertEqual(self.plan.geo_basemap, "sat")
        self.assertEqual(Image.open(self.plan.background_image.path).size, (90, 40))

    def test_stale_version_is_a_conflict_and_nothing_moves(self):
        stamp = self.plan.updated_at.isoformat()
        self.plan.description = "edited elsewhere"
        self.plan.save()
        r = self.expand(_grown(self.plan, left=3), version=stamp)
        self.assertEqual(r.status_code, 409, r.content)
        self.tile.refresh_from_db()
        self.assertEqual(self.tile.x, 2)

    def test_shrinking_and_too_large_are_refused(self):
        gw = self.plan.grid_width
        for bbox in (_grown(self.plan, left=-3), _grown(self.plan, top=2, bottom=-4),
                     _grown(self.plan, left=513 - gw), BBOX, [1, 2, 3]):
            r = self.expand(bbox)
            self.assertEqual(r.status_code, 400, bbox)
        r = self.expand(_grown(self.plan, left=513 - gw))
        self.assertIn("at most 512", str(r.json()))
        self.tile.refresh_from_db()
        self.assertEqual(self.tile.x, 2)
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.grid_width, gw)
        self.assertEqual(self.expand(_grown(self.plan, left=512 - gw)).status_code, 200)

    def test_a_view_is_refused(self):
        r = self.expand(_grown(self.plan, left=1), plan=self.view)
        self.assertEqual(r.status_code, 400)

    def test_permissions_and_site_scope(self):
        viewer = self._user("viewer", [(["floorplan"], ["view"], [])])
        self._login(viewer)
        self.assertEqual(self.expand(_grown(self.plan, left=1)).status_code, 403)
        elsewhere = self._user("elsewhere", [(["floorplan"], ["view", "change"],
                                              [self.site_b])])
        self._login(elsewhere)
        self.assertIn(self.expand(_grown(self.plan, left=1)).status_code, (403, 404))
        local = self._user("local", [(["floorplan"], ["view", "change"], [self.site])])
        self._login(local)
        self.assertEqual(self.expand(_grown(self.plan, left=1)).status_code, 200)
        self.tile.refresh_from_db()
        self.assertEqual(self.tile.x, 3)


class ImportOutlinesTests(_Base):
    def url(self):
        return f"/api/floor-plans/{self.plan.id}/import-outlines/"

    def test_offers_only_outlines_no_area_stands_for(self):
        r = self.client.post(self.url(), {"dry_run": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["outlines"], [])
        self.plan.areas.filter(location=self.bldg).delete()
        new = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, label="Shed",
            points=[[56.0002, 10.0002], [56.0002, 10.0003], [56.0001, 10.0003]],
        )
        SiteMapOutline.objects.create(  # another site's
            tenant=self.tenant, site=self.site_b, label="Theirs",
            points=[[56.0002, 10.0002], [56.0002, 10.0003], [56.0001, 10.0003]],
        )
        offered = self.client.post(self.url(), {"dry_run": True}, format="json").json()
        self.assertEqual({o["id"] for o in offered["outlines"]},
                         {str(self.o_bldg.id), str(new.id)})
        r = self.client.post(self.url(), {"apply": [str(self.o_bldg.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1)
        self.assertEqual([o["id"] for o in r.json()["outlines"]], [str(new.id)])
        area = self.plan.areas.get(location=self.bldg)
        self.assertEqual(area.shape, "polygon")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(area.pk), cause="Outlines imported into Campus").exists())

    def test_after_expanding_the_new_part_is_offered(self):
        far = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site, label="West yard",
            points=[[56.0005, 9.9996], [56.0005, 9.9998], [56.0003, 9.9998]],
        )
        offered = self.client.post(self.url(), {"dry_run": True}, format="json").json()
        self.assertEqual(offered["outlines"], [])
        cells = round(0.0006 / ((BBOX[3] - BBOX[1]) / self.plan.grid_width))
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/expand/",
                             {"bbox": _grown(self.plan, left=cells)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        offered = self.client.post(self.url(), {"dry_run": True}, format="json").json()
        self.assertEqual([o["id"] for o in offered["outlines"]], [str(far.id)])

    def test_needs_change_and_area_add(self):
        viewer = self._user("viewer", [(["floorplan", "sitemapoutline"], ["view"], [])])
        self._login(viewer)
        self.assertEqual(self.client.post(self.url(), {"dry_run": True},
                                          format="json").status_code, 403)
        editor = self._user("editor", [
            (["floorplan"], ["view", "change"], []),
            (["sitemapoutline", "location", "floorplanarea"], ["view"], []),
        ])
        self._login(editor)
        self.plan.areas.filter(location=self.bldg).delete()
        r = self.client.post(self.url(), {"apply": [str(self.o_bldg.id)]}, format="json")
        self.assertEqual(r.status_code, 403)


class FootprintAndGpsTests(_Base):
    def test_footprints_on_the_site_map(self):
        FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        d = self.client.get("/api/site-map/").json()
        self.assertEqual(d["plan_footprints"], [{
            "id": str(self.plan.id), "name": "Campus", "stack": self.plan.stack.name,
            "site_id": str(self.site.id), "bbox": BBOX,
        }])
        elsewhere = self._user("elsewhere", [
            (["floorplan"], ["view"], [self.site_b]),
            (["site"], ["view"], []),
        ])
        self._login(elsewhere)
        self.assertEqual(self.client.get("/api/site-map/").json()["plan_footprints"], [])
        local = self._user("local", [
            (["floorplan"], ["view"], [self.site]),
            (["site"], ["view"], []),
        ])
        self._login(local)
        self.assertEqual(len(self.client.get("/api/site-map/").json()["plan_footprints"]), 1)

    def test_place_at_gps_position(self):
        inside = Device.objects.create(
            tenant=self.tenant, name="cam-1", site=self.site,
            latitude="56.000500", longitude="10.001000",
        )
        Device.objects.create(  # off the plan
            tenant=self.tenant, name="cam-far", site=self.site,
            latitude="56.100000", longitude="10.001000",
        )
        Device.objects.create(  # no GPS
            tenant=self.tenant, name="sw-1", site=self.site,
        )
        Device.objects.create(  # another site's, on the box
            tenant=self.tenant, name="cam-b", site=self.site_b,
            latitude="56.000500", longitude="10.001000",
        )
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/placeable/?gps=1")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual([row["name"] for row in rows], ["cam-1"])
        x, y = geo.plan_frame(self.plan).to_cells(56.0005, 10.001)
        self.assertEqual(rows[0]["gps_cell"], [round(x, 3), round(y, 3)])
        allrows = self.client.get(f"/api/floor-plans/{self.plan.id}/placeable/").json()
        by = {row["name"]: row for row in allrows["results"]}
        self.assertIsNone(by["sw-1"]["gps_cell"])
        self.assertIsNone(by["cam-far"]["gps_cell"])
        self.assertIsNotNone(by["cam-1"]["gps_cell"])
        self.assertEqual(inside.name, "cam-1")
        # A plan with no anchor offers none.
        hall = FloorPlan.objects.create(tenant=self.tenant, site=self.site, name="Hall")
        r = self.client.get(f"/api/floor-plans/{hall.id}/placeable/?gps=1")
        self.assertEqual(r.json()["results"], [])

    def test_gps_cell_in_a_views_cells(self):
        Device.objects.create(
            tenant=self.tenant, name="cam-1", site=self.site,
            latitude="56.000500", longitude="10.001000",
        )
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/snapshot/", {
            "name": "Middle", "mode": "view", "crop": {"x": 40, "y": 30, "w": 60, "h": 50},
        }, format="json")
        view_id = r.json()["id"]
        rows = self.client.get(f"/api/floor-plans/{view_id}/placeable/?gps=1").json()["results"]
        x, y = geo.plan_frame(self.plan).to_cells(56.0005, 10.001)
        self.assertEqual(rows[0]["gps_cell"], [round(round(x, 3) - 40, 3),
                                              round(round(y, 3) - 30, 3)])
