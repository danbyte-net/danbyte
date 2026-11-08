"""Floor-plan snapshots (api/floor_plan_snapshots.py): independent copies of
a rectangle of a plan - contents moved and clipped, the raster background cut,
the CAD drawing rendered again for the part - and live views, which read and
write their source's objects through the crop with the source's permissions,
version checks and change log. Unlinking, deleting a source, tenancy and site
scope."""
from __future__ import annotations

import io
import os
import shutil
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import SimpleTestCase, override_settings
from lxml import etree
from PIL import Image
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import cad_render
from . import floor_plan_snapshots as snaps
from . import tests_cad_fixtures as fx
from .models import (
    Device,
    FloorPlan,
    FloorPlanArea,
    FloorPlanDrawing,
    FloorPlanLabel,
    FloorPlanRaisedFloorArea,
    FloorPlanStack,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    FloorTileType,
    Location,
    Site,
)

User = get_user_model()
MEDIA = tempfile.mkdtemp(prefix="danbyte-snap-test-")
SVG = "{http://www.w3.org/2000/svg}"


class _InlineQueue:
    def enqueue(self, fn, *args, **kwargs):
        fn(*args)


@override_settings(MEDIA_ROOT=MEDIA, DANBYTE_CAD_CONVERTER="")
class _Base(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Ground",
            grid_width=20, grid_height=10, cell_mm=600,
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.login(self.admin)
        q = mock.patch("django_rq.get_queue", return_value=_InlineQueue())
        q.start()
        self.addCleanup(q.stop)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, name, *grants):
        """A user with ``grants``: ``(object types, actions, constraints)``."""
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for i, (types, actions, *rest) in enumerate(grants):
            p = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=list(types), actions=list(actions),
                constraints=rest[0] if rest else None,
            )
            p.users.add(u)
        return u

    def tile(self, x, y, w=1, h=1, plan=None, **kw):
        return FloorPlanTile.objects.create(
            floor_plan=plan or self.plan, tile_type=self.tt, x=x, y=y, width=w, height=h, **kw
        )

    def snapshot(self, mode, crop, name="Room 210", target="plan", plan=None):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(
                f"/api/floor-plans/{(plan or self.plan).id}/snapshot/",
                {"name": name, "mode": mode, "target": target, "crop": crop},
                format="json",
            )

    def view(self, crop=None, name="Room view"):
        r = self.snapshot("view", crop or {"x": 4, "y": 2, "w": 6, "h": 5}, name=name)
        self.assertEqual(r.status_code, 201, r.content)
        return FloorPlan.objects.get(pk=r.data["id"])


# ─── geometry ───────────────────────────────────────────────────────────────


class GeometryTests(SimpleTestCase):
    crop = snaps.Crop(2, 2, 4, 4)

    def test_boxes_classify_in_edge_and_out(self):
        self.assertEqual(snaps.classify_box((2, 2, 6, 6), self.crop), "in")
        self.assertEqual(snaps.classify_box((5, 5, 7, 7), self.crop), "edge")
        self.assertIsNone(snaps.classify_box((6, 6, 7, 7), self.crop))

    def test_a_polyline_is_cut_into_runs_at_the_edge(self):
        runs = snaps.clip_polyline([[0, 3], [8, 3], [8, 5], [0, 5]], self.crop)
        self.assertEqual([r["points"] for r in runs],
                         [[(2.0, 3.0), (6.0, 3.0)], [(6.0, 5.0), (2.0, 5.0)]])
        self.assertEqual(runs[0]["segs"], [(0, 2.0, 4.0)])

    def test_a_polygon_is_clipped_to_the_rectangle(self):
        pts = snaps.clip_polygon([[0, 0], [4, 0], [4, 4], [0, 4]], self.crop)
        self.assertEqual(sorted(pts), [(2, 2), (2, 4), (4, 2), (4, 4)])

    def test_a_crop_must_be_whole_cells_inside_the_plan(self):
        self.assertEqual(snaps.parse_crop({"x": 1, "y": 2, "w": 3, "h": 4}, 10, 10),
                         snaps.Crop(1, 2, 3, 4))
        for bad in ({"x": 0.5, "y": 0, "w": 1, "h": 1}, {"x": 8, "y": 0, "w": 3, "h": 1},
                    {"x": 0, "y": 0, "w": 0, "h": 1}, None):
            with self.assertRaises(ValueError):
                snaps.parse_crop(bad, 10, 10)


# ─── independent copies ─────────────────────────────────────────────────────


class CopyTests(_Base):
    def test_a_copy_holds_the_crop_moved_to_its_origin_and_clipped(self):
        dev = Device.objects.create(tenant=self.tenant, site=self.site, name="sw1")
        inside = self.tile(5, 3, label="inside")
        self.tile(3, 3, 2, 1, label="zone run")  # unlinked, crosses x=4: clipped
        linked = self.tile(9, 3, 2, 1, device=dev, link_kind="device")  # crosses x=10
        self.tile(15, 3, label="outside")
        FloorPlanArea.objects.create(floor_plan=self.plan, x=2, y=3, width=4, height=2)
        FloorPlanArea.objects.create(
            floor_plan=self.plan, shape="polygon", x=8, y=5, width=4, height=4,
            points=[[8, 5], [12, 5], [12, 9], [8, 9]],
        )
        FloorPlanLabel.objects.create(floor_plan=self.plan, text="North", x=6, y=4)
        FloorPlanRaisedFloorArea.objects.create(floor_plan=self.plan, x=3, y=1, width=4, height=3)
        FloorPlanWall.objects.create(
            floor_plan=self.plan, points=[[0, 4], [12, 4]],
            openings=[{"seg": 0, "from": 5, "to": 6, "height_mm": None},
                      {"seg": 0, "from": 1, "to": 2, "height_mm": None}],
        )
        FloorPlanTray.objects.create(floor_plan=self.plan, name="T1",
                                     points=[[2, 3], [12, 3], [12, 6], [2, 6]])

        r = self.snapshot("copy", {"x": 4, "y": 2, "w": 6, "h": 5})
        self.assertEqual(r.status_code, 201, r.content)
        dst = FloorPlan.objects.get(pk=r.data["id"])
        self.assertEqual((dst.kind, dst.grid_width, dst.grid_height, dst.cell_mm),
                         ("plan", 6, 5, 600))
        self.assertEqual(dst.source_id, self.plan.pk)
        self.assertEqual(r.data["snapshot"]["kind"], "copy")
        self.assertEqual(r.data["snapshot"]["source"]["name"], "Ground")

        tiles = {t.label or str(t.device_id): t for t in dst.tiles.all()}
        self.assertEqual(set(tiles), {"inside", "zone run", str(dev.pk)})
        self.assertEqual((tiles["inside"].x, tiles["inside"].y), (1, 1))
        z = tiles["zone run"]
        self.assertEqual((z.x, z.y, z.width, z.height), (0, 1, 1, 1))
        moved = tiles[str(dev.pk)]
        self.assertEqual((moved.x, moved.y, moved.width), (5, 1, 2))
        self.assertEqual([c["kind"] for c in r.data["crossing"]], ["tile"])
        # The linked tile keeps its link: the device stands on two plans.
        self.assertEqual(FloorPlanTile.objects.filter(device=dev).count(), 2)
        self.assertTrue(FloorPlanTile.objects.filter(pk=inside.pk, x=5).exists())

        rect = dst.areas.get(shape="rect")
        self.assertEqual((rect.x, rect.y, rect.width, rect.height), (0, 1, 2, 2))
        poly = dst.areas.get(shape="polygon")
        self.assertEqual(sorted(map(tuple, poly.points)),
                         [(4, 3), (4, 5), (6, 3), (6, 5)])
        self.assertEqual((dst.labels.get().x, dst.labels.get().y), (2, 2))
        rf = dst.raised_floor_areas.get()
        self.assertEqual((rf.x, rf.y, rf.width, rf.height), (0, 0, 3, 2))
        wall = dst.walls.get()
        self.assertEqual(wall.points, [[0, 2], [6, 2]])
        # The door at 5-6 along the wall is 1-2 along the cut one; the one at
        # 1-2 lay outside and is gone.
        self.assertEqual([(o["from"], o["to"]) for o in wall.openings], [(1, 2)])
        trays = sorted(dst.trays.all(), key=lambda t: t.name)
        self.assertEqual([t.name for t in trays], ["T1", "T1 (2)"])
        self.assertEqual(trays[0].points, [[0, 1], [6, 1]])
        # Each copied row is in the change log, with the snapshot as the cause.
        entry = ChangeLogEntry.objects.filter(
            object_type="api.floorplantile", object_id=str(tiles["inside"].pk)
        ).get()
        self.assertEqual(entry.cause, "Snapshot of Ground")

    def test_the_raster_background_is_cut_at_the_crops_share_of_the_image(self):
        buf = io.BytesIO()
        Image.new("RGB", (200, 100), "white").save(buf, format="PNG")
        self.plan.background_image.save("bg.png", ContentFile(buf.getvalue()))
        r = self.snapshot("copy", {"x": 4, "y": 2, "w": 6, "h": 5})
        dst = FloorPlan.objects.get(pk=r.data["id"])
        with dst.background_image.open("rb") as fh:
            self.assertEqual(Image.open(fh).size, (60, 50))

    def test_the_cad_drawing_is_rendered_again_for_the_crop(self):
        d = self._ready()
        seen = []
        real = cad_render._run

        def spy(argv, **kw):
            seen.append(list(argv))
            return real(argv, **kw)

        with mock.patch.object(cad_render, "_run", side_effect=spy):
            r = self.snapshot("copy", {"x": 0, "y": 0, "w": 5, "h": 4})
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlanDrawing.objects.get(floor_plan_id=r.data["id"])
        self.assertEqual(copy.status, "ready", copy.error)
        ext = d.extents
        want = {"min_x": ext["min_x"], "min_y": ext["max_y"] - 2400,
                "max_x": ext["min_x"] + 3000, "max_y": ext["max_y"]}
        for k, v in want.items():
            self.assertAlmostEqual(copy.clip[k], v, places=6)
        self.assertIn("--clip", seen[-1])
        for k, v in copy.clip.items():
            self.assertAlmostEqual(copy.extents[k], v, places=6)
        self.assertAlmostEqual(copy.placement["x_mm"], 0, places=6)
        self.assertAlmostEqual(copy.placement["y_mm"], 0, places=6)
        with copy.rendered.open("rb") as fh:
            root = etree.fromstring(fh.read())
        box = [float(v) for v in root.get("viewBox").split()]
        self.assertEqual([round(v) for v in box], [0, 0, 3000, 2400])
        # The source's drawing is untouched.
        d.refresh_from_db()
        self.assertIsNone(d.clip)

    def _ready(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                f"/api/floor-plans/{self.plan.id}/drawing/",
                {"file": SimpleUploadedFile("plan.dxf", fx.floor_dxf())}, format="multipart",
            )
        self.assertEqual(r.status_code, 202, r.content)
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "ready", d.error)
        return d

    def test_a_snapshot_can_be_a_new_floor_of_this_floor_plan(self):
        r = self.snapshot("copy", {"x": 0, "y": 0, "w": 2, "h": 2}, target="floor")
        self.assertEqual(r.status_code, 201, r.content)
        dst = FloorPlan.objects.get(pk=r.data["id"])
        self.assertEqual(dst.stack_id, self.plan.stack_id)
        self.assertGreater(dst.floor_order, self.plan.floor_order)
        clash = self.snapshot("copy", {"x": 0, "y": 0, "w": 2, "h": 2}, target="floor")
        self.assertEqual(clash.status_code, 400)
        self.assertIn("name", clash.data)

    def test_a_bad_request_is_refused(self):
        for body in ({"mode": "both"}, {"crop": {"x": 18, "y": 0, "w": 5, "h": 1}},
                     {"name": ""}):
            payload = {"name": "N", "mode": "copy", "crop": {"x": 0, "y": 0, "w": 1, "h": 1},
                       **body}
            r = self.client.post(f"/api/floor-plans/{self.plan.id}/snapshot/", payload,
                                 format="json")
            self.assertEqual(r.status_code, 400, body)


# ─── live views ─────────────────────────────────────────────────────────────


class ViewTests(_Base):
    def setUp(self):
        super().setUp()
        self.inside = self.tile(5, 3, label="inside")
        self.edge = self.tile(9, 3, 2, 1, label="edge")
        self.out = self.tile(15, 3, label="outside")
        self.v = self.view()

    def contents(self, plan=None):
        r = self.client.get(f"/api/floor-plans/{(plan or self.v).id}/contents/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.data

    def test_a_view_stores_nothing_and_shows_the_crop_translated(self):
        self.assertEqual(self.v.kind, "view")
        self.assertFalse(self.v.tiles.exists())
        rows = {t["label"]: t for t in self.contents()["tiles"]}
        self.assertEqual(set(rows), {"inside", "edge"})
        self.assertEqual((rows["inside"]["x"], rows["inside"]["y"]), (1, 1))
        self.assertFalse(rows["inside"]["crosses_edge"])
        self.assertTrue(rows["edge"]["crosses_edge"])
        self.assertEqual(rows["inside"]["id"], str(self.inside.pk))
        # A change on the source shows in the view at once.
        self.inside.x = 6
        self.inside.save()
        rows = {t["label"]: t for t in self.contents()["tiles"]}
        self.assertEqual(rows["inside"]["x"], 2)

    def test_the_view_reads_its_grid_from_the_crop_and_says_what_it_shows(self):
        r = self.client.get(f"/api/floor-plans/{self.v.id}/")
        self.assertEqual((r.data["grid_width"], r.data["grid_height"]), (6, 5))
        self.assertEqual(r.data["kind"], "view")
        self.assertEqual(r.data["snapshot"]["source"]["name"], "Ground")
        self.assertEqual(r.data["snapshot"]["source_grid"], {"width": 20, "height": 10})
        self.assertEqual(r.data["tile_count"], 2)
        stack = self.client.get(f"/api/floor-plan-stacks/{self.v.stack_id}/")
        self.assertEqual(stack.data["floors"][0]["view_of"]["name"], "Ground")
        bad = self.client.patch(f"/api/floor-plans/{self.v.id}/", {"grid_width": 30},
                                format="json")
        self.assertEqual(bad.status_code, 400)
        ok = self.client.patch(f"/api/floor-plans/{self.v.id}/", {"name": "Renamed"},
                               format="json")
        self.assertEqual(ok.status_code, 200, ok.content)

    def bulk(self, body, plan=None):
        return self.client.post(f"/api/floor-plans/{(plan or self.v).id}/bulk/", body,
                                format="json")

    def test_an_edit_through_the_view_is_an_edit_of_the_source(self):
        version = self.inside.updated_at.isoformat()
        r = self.bulk({"tiles": {
            "update": [{"id": str(self.inside.pk), "x": 2, "version": version}],
            "create": [{"tile_type_id": str(self.tt.pk), "x": 0, "y": 0}],
        }})
        self.assertEqual(r.status_code, 200, r.content)
        self.inside.refresh_from_db()
        self.assertEqual(self.inside.x, 6)
        made = self.plan.tiles.get(x=4, y=2)
        self.assertEqual(made.floor_plan_id, self.plan.pk)
        self.assertFalse(self.v.tiles.exists())
        self.assertIn(str(made.pk), {t["id"] for t in r.data["tiles"]})
        entry = ChangeLogEntry.objects.filter(
            object_type="api.floorplantile", object_id=str(self.inside.pk), action="update"
        ).get()
        self.assertEqual(entry.cause, "Through the view Room view")
        # The same version again is stale now: 409, in the view's cells.
        stale = self.bulk({"tiles": {"update": [
            {"id": str(self.inside.pk), "x": 3, "version": version}]}})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["conflicts"][0]["current"]["x"], 2)

    def test_edge_and_outside_rows_are_locked_in_the_view(self):
        for pk in (self.edge.pk, self.out.pk):
            r = self.bulk({"tiles": {"update": [{"id": str(pk), "label": "x"}]}})
            self.assertEqual(r.status_code, 400, pk)
            r = self.bulk({"tiles": {"delete": [str(pk)]}})
            self.assertEqual(r.status_code, 400, pk)
        # Nothing may be dragged out over the view's edge.
        r = self.bulk({"tiles": {"update": [{"id": str(self.inside.pk), "x": 5.5}]}})
        self.assertEqual(r.status_code, 400)
        self.inside.refresh_from_db()
        self.assertEqual(self.inside.x, 5)
        self.assertEqual(self.client.post(
            f"/api/floor-plans/{self.v.id}/tiles/bulk/", {}, format="json"
        ).status_code, 400)

    def test_walls_trays_and_raised_floors_write_through_the_view(self):
        r = self.client.post("/api/floor-plan-walls/",
                             {"floor_plan_id": str(self.v.pk), "points": [[0, 1], [3, 1]]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data["points"], [[0, 1], [3, 1]])
        wall = FloorPlanWall.objects.get(pk=r.data["id"])
        self.assertEqual((wall.floor_plan_id, wall.points), (self.plan.pk, [[4, 3], [7, 3]]))
        p = self.client.patch(f"/api/floor-plan-walls/{wall.pk}/?via={self.v.pk}",
                              {"points": [[0, 2], [3, 2]]}, format="json")
        self.assertEqual(p.status_code, 200, p.content)
        wall.refresh_from_db()
        self.assertEqual(wall.points, [[4, 4], [7, 4]])
        out = self.client.patch(f"/api/floor-plan-walls/{wall.pk}/?via={self.v.pk}",
                                {"points": [[0, 2], [9, 2]]}, format="json")
        self.assertEqual(out.status_code, 400)
        far = FloorPlanTray.objects.create(floor_plan=self.plan, name="far",
                                           points=[[15, 1], [18, 1]])
        self.assertEqual(self.client.delete(
            f"/api/floor-plan-trays/{far.pk}/?via={self.v.pk}"
        ).status_code, 400)
        rf = self.client.post(f"/api/floor-plan-raised-floors/?via={self.v.pk}",
                              {"floor_plan_id": str(self.v.pk), "x": 0, "y": 0,
                               "width": 2, "height": 2}, format="json")
        self.assertEqual(rf.status_code, 201, rf.content)
        self.assertEqual((rf.data["x"], rf.data["y"]), (0, 0))
        self.assertTrue(self.plan.raised_floor_areas.filter(x=4, y=2).exists())
        self.assertEqual(self.client.delete(
            f"/api/floor-plan-walls/{wall.pk}/?via={self.v.pk}"
        ).status_code, 204)
        self.assertFalse(FloorPlanWall.objects.filter(pk=wall.pk).exists())

    def test_editing_through_a_view_needs_change_on_the_source(self):
        # Change on the view and its tiles, but only view on the source.
        u = self.member(
            "viewer", (["floorplantile"], ["view", "change", "add", "delete"]),
            (["floorplan"], ["view"]),
            (["floorplan"], ["change"], {"id": str(self.v.pk)}),
        )
        self.login(u)
        self.assertEqual(self.client.get(f"/api/floor-plans/{self.v.id}/contents/").status_code,
                         200)
        r = self.bulk({"tiles": {"update": [{"id": str(self.inside.pk), "x": 2}]}})
        self.assertEqual(r.status_code, 403, r.content)
        w = self.client.post("/api/floor-plan-walls/",
                             {"floor_plan_id": str(self.v.pk), "points": [[0, 1], [3, 1]]},
                             format="json")
        self.assertIn(w.status_code, (403,), w.content)
        # Without view on the source the view shows nothing of it.
        u2 = self.member("blind", (["floorplan"], ["view"], {"id": str(self.v.pk)}))
        self.login(u2)
        self.assertEqual(
            self.client.get(f"/api/floor-plans/{self.v.id}/contents/").status_code, 403
        )

    def test_a_view_is_seen_by_state_and_placeable(self):
        dev = Device.objects.create(tenant=self.tenant, site=self.site, name="sw1")
        t = self.tile(6, 4, device=dev, link_kind="device")
        state = self.client.get(f"/api/floor-plans/{self.v.id}/state/").data["tiles"]
        self.assertIn(str(t.pk), state)
        rows = self.client.get(f"/api/floor-plans/{self.v.id}/placeable/",
                               {"q": "sw1"}).data["results"]
        self.assertTrue(rows[0]["placed_on"][0]["this_floor"])

    def test_unlink_makes_an_independent_copy_in_place(self):
        r = self.client.post(f"/api/floor-plans/{self.v.id}/unlink/")
        self.assertEqual(r.status_code, 200, r.content)
        self.v.refresh_from_db()
        self.assertEqual(self.v.kind, "plan")
        self.assertEqual(self.v.source_id, self.plan.pk)
        self.assertEqual(r.data["snapshot"]["kind"], "copy")
        self.assertEqual({t.label for t in self.v.tiles.all()}, {"inside", "edge"})
        # Now independent: a source change no longer shows.
        self.inside.label = "renamed"
        self.inside.save()
        self.assertEqual(sorted(t["label"] for t in self.contents()["tiles"]),
                         ["edge", "inside"])
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.floorplan", object_id=str(self.v.pk), action="update",
            cause="Unlinked from Ground",
        ).exists())

    def test_deleting_a_source_with_views_is_refused_naming_them(self):
        r = self.client.delete(f"/api/floor-plans/{self.plan.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("Room view", r.data["detail"])
        self.assertEqual(r.data["views"][0]["id"], str(self.v.pk))
        s = self.client.delete(f"/api/floor-plan-stacks/{self.plan.stack_id}/")
        self.assertEqual(s.status_code, 409)
        self.assertTrue(FloorPlan.objects.filter(pk=self.plan.pk).exists())
        # Deleting the view leaves the source alone, and frees it.
        self.assertEqual(self.client.delete(f"/api/floor-plans/{self.v.id}/").status_code, 204)
        self.assertTrue(FloorPlanTile.objects.filter(pk=self.inside.pk).exists())
        self.assertEqual(self.client.delete(f"/api/floor-plans/{self.plan.id}/").status_code,
                         204)

    def test_a_snapshot_of_a_view_is_taken_of_its_source(self):
        r = self.snapshot("view", {"x": 1, "y": 1, "w": 2, "h": 2}, name="Inner",
                          plan=self.v)
        self.assertEqual(r.status_code, 201, r.content)
        inner = FloorPlan.objects.get(pk=r.data["id"])
        self.assertEqual(inner.source_id, self.plan.pk)
        self.assertEqual(inner.crop, {"x": 5, "y": 3, "w": 2, "h": 2})

    def test_the_view_shows_its_part_of_the_cad_drawing(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/floor-plans/{self.plan.id}/drawing/",
                {"file": SimpleUploadedFile("plan.dxf", fx.floor_dxf())}, format="multipart",
            )
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.get(f"/api/floor-plans/{self.v.id}/drawing/")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(f"/api/floor-plans/{self.v.id}/drawing/")
        self.assertEqual(r.data["status"], "ready", r.data)
        self.assertAlmostEqual(r.data["size"]["width"], 3600, places=6)
        self.assertAlmostEqual(r.data["size"]["height"], 3000, places=6)
        self.assertTrue(r.data["rendered_url"])
        self.assertEqual(r.data["view_of"]["name"], "Ground")
        self.assertEqual(self.client.patch(f"/api/floor-plans/{self.v.id}/drawing/",
                                           {"opacity": 10}, format="json").status_code, 400)


# ─── tenancy and site scope ─────────────────────────────────────────────────


class ScopeTests(_Base):
    def test_another_tenants_plan_cannot_be_snapshotted_or_written_through(self):
        osite = Site.objects.create(tenant=self.other, name="LON")
        oloc = Location.objects.create(tenant=self.other, site=osite, name="B", slug="b")
        oplan = FloorPlan.objects.create(tenant=self.other, location=oloc, name="Theirs")
        oview = FloorPlan.objects.create(
            tenant=self.other, location=oloc, name="Their view", kind="view",
            source=oplan, crop={"x": 0, "y": 0, "w": 2, "h": 2},
        )
        r = self.snapshot("copy", {"x": 0, "y": 0, "w": 1, "h": 1}, plan=oplan)
        self.assertEqual(r.status_code, 404)
        w = self.client.post(f"/api/floor-plan-walls/?via={oview.pk}",
                             {"floor_plan_id": str(self.plan.pk), "points": [[0, 0], [1, 0]]},
                             format="json")
        self.assertEqual(w.status_code, 400)
        self.assertFalse(FloorPlanStack.objects.filter(tenant=self.tenant, name="Room 210").exists())

    def test_a_site_scoped_user_works_only_at_their_site(self):
        other_site = Site.objects.create(tenant=self.tenant, name="FRA")
        oloc = Location.objects.create(tenant=self.tenant, site=other_site, name="F", slug="f")
        far = FloorPlan.objects.create(tenant=self.tenant, location=oloc, name="Far")
        u = self.member("local", (["floorplan"], ["view", "add", "change"]))
        ObjectPermission.objects.get(name="local-0").sites.set([self.site])
        self.login(u)
        self.assertEqual(self.snapshot("copy", {"x": 0, "y": 0, "w": 1, "h": 1},
                                       plan=far).status_code, 404)
        r = self.snapshot("view", {"x": 0, "y": 0, "w": 1, "h": 1})
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_view_row_cannot_hold_rows_of_its_own(self):
        v = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="V", kind="view",
            source=self.plan, crop={"x": 0, "y": 0, "w": 2, "h": 2},
        )
        wall = FloorPlanWall.objects.create(floor_plan=self.plan, points=[[0, 0], [1, 0]])
        r = self.client.patch(f"/api/floor-plan-walls/{wall.pk}/",
                              {"floor_plan_id": str(v.pk)}, format="json")
        self.assertEqual(r.status_code, 400)


def tearDownModule():
    shutil.rmtree(MEDIA, ignore_errors=True)
    os.makedirs(MEDIA, exist_ok=True)
