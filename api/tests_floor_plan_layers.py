"""A floor's two background layers: the base map (a Site map snapshot,
shared by a building's levels) and the floor drawing over it - the data
migration, the basement rule, Update snapshot, framing a plan with no
anchor, Same footprint sharing the map, Expand detaching a shared map, and
the permission, tenancy and media checks."""

from __future__ import annotations

import importlib
import math

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.utils import timezone

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from . import floor_plan_from_map as fm
from .floor_plan_geo import lng_of
from .floor_plan_layers import is_ground, map_in_3d, map_visible
from .floor_plan_snapshots import Crop, make_snapshot
from .floor_stacks import add_floor
from .models import (
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanMap,
    FloorPlanStack,
    FloorPlanTile,
    FloorTileType,
    Site,
)
from .tests_floor_plan_geo import BBOX, _Base, _grown, _png

MIG = importlib.import_module("api.migrations.0256_floor_plan_base_map_data")


def frame_box(lat, lng, width_m, height_m):
    """The box of ``width_m`` × ``height_m`` centred at ``lat``/``lng`` - as
    the browser frames a plan (plan-geo.ts frameAt)."""
    per = fm.EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat))
    dx, dy = width_m / per, height_m / per
    x0, y0 = fm.merc_x(lng) - dx / 2, fm.merc_y(lat) - dy / 2
    return [fm.lat_of(y0 + dy), lng_of(x0), fm.lat_of(y0), lng_of(x0 + dx)]


class MigrationTests(_Base):
    """The data migration on rows as the release before left them: the map
    render was the floor's picture, marked by ``geo_captured_at``."""

    def _old(self, name, *, stack=None, order=0, picture=True, captured=True, bbox=BBOX,
             opacity=70):
        p = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name=name, stack=stack, floor_order=order,
            grid_width=124, grid_height=111, cell_mm=1000, background_opacity=opacity,
            geo_bbox=list(bbox) if bbox else None, geo_mpc=1.0 if bbox else None,
            geo_basemap="sat" if captured else "", geo_zoom=18,
            geo_captured_at=timezone.now() if captured else None,
            state={"from_map": {"attribution": "Tiles: Esri"}},
        )
        if picture:
            p.background_image.save(f"{name}.png", ContentFile(_png().read()), save=True)
        return p

    def test_a_map_picture_becomes_the_base_map_and_others_stay(self):
        made = self._old("Made")
        own = self._old("Own picture", captured=False)
        plain = self._old("Plain", bbox=None, captured=False)
        name = made.background_image.name
        MIG.forwards(django_apps, None)
        for p in (made, own, plain):
            p.refresh_from_db()
        self.assertFalse(made.background_image)
        self.assertEqual(made.base_map.image.name, name)  # the same file, not a copy
        self.assertEqual(made.base_map.basemap, "sat")
        self.assertEqual(made.base_map.attribution, "Tiles: Esri")
        self.assertEqual(made.map_opacity, 70)
        self.assertTrue(map_visible(made))
        # An uploaded picture is the floor's own; no map.
        self.assertTrue(own.background_image)
        self.assertIsNone(own.base_map_id)
        self.assertTrue(plain.background_image)
        self.assertIsNone(plain.base_map_id)
        # Run again: nothing more.
        n = FloorPlanMap.objects.count()
        MIG.forwards(django_apps, None)
        self.assertEqual(FloorPlanMap.objects.count(), n)

    def test_an_aligned_buildings_levels_share_one_map(self):
        stack = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Tower", aligned=True)
        b1 = self._old("B1", stack=stack, order=-10)
        g = self._old("G", stack=stack, order=0)
        one = self._old("1", stack=stack, order=10)
        cad = self._old("2", stack=stack, order=20, captured=False)  # its own picture
        bare = self._old("3", stack=stack, order=30, picture=False, captured=False)
        MIG.forwards(django_apps, None)
        rows = {p.name: FloorPlan.objects.get(pk=p.pk) for p in (b1, g, one, cad, bare)}
        ids = {p.base_map_id for p in rows.values()}
        self.assertEqual(len(ids), 1)
        self.assertIsNotNone(next(iter(ids)))
        self.assertTrue(rows["2"].background_image)  # kept, drawn over the map
        self.assertFalse(rows["G"].background_image)
        # Basements hide the building's map until shown by hand.
        self.assertFalse(map_visible(rows["B1"]))
        self.assertTrue(all(map_visible(rows[n]) for n in ("G", "1", "2", "3")))

    def test_backwards_puts_the_map_back_as_the_picture(self):
        made = self._old("Made", opacity=40)
        MIG.forwards(django_apps, None)
        made.refresh_from_db()
        name = made.base_map.image.name
        MIG.backwards(django_apps, None)
        made.refresh_from_db()
        self.assertEqual(made.background_image.name, name)
        self.assertEqual(made.background_opacity, 40)


class LayerTests(_Base):
    def test_a_plan_made_from_the_map_has_it_as_its_base_layer(self):
        p = self.plan
        self.assertFalse(p.background_image)
        self.assertIsNotNone(p.base_map_id)
        d = self.client.get(f"/api/floor-plans/{p.id}/").json()
        self.assertTrue(d["base_map"]["image"].startswith("/media/floor-plans/maps/"))
        self.assertEqual(d["base_map"]["bbox"], BBOX)
        self.assertEqual(d["base_map"]["floors"], 1)
        self.assertTrue(d["map_visible"])
        self.assertIsNone(d["map_shown"])
        self.assertIsNotNone(d["geo"]["captured_at"])

    def test_a_floor_picture_goes_over_the_map_and_keeps_it(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/background/",
                             {"background_image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertTrue(d["background_image"])
        self.assertIsNotNone(d["base_map"])
        self.assertIsNotNone(d["geo"]["captured_at"])

    def test_eyes_and_opacity_save(self):
        r = self.client.patch(f"/api/floor-plans/{self.plan.id}/", {
            "map_opacity": 35, "map_shown": False, "background_shown": False,
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d["map_opacity"], d["map_shown"], d["map_visible"],
                          d["background_shown"]), (35, False, False, False))
        scene = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()["plan"]
        self.assertIsNone(scene["base_map"])

    def test_update_snapshot_replaces_the_map_and_moves_nothing(self):
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        tile = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=tt, x=4, y=5)
        area = FloorPlanArea.objects.create(
            floor_plan=self.plan, x=1, y=2, width=3, height=2, label="R")
        m = self.plan.base_map
        old_name, old_at = m.image.name, m.captured_at
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/map/", {
            "image": _png(fmt="JPEG"), "basemap": "sat", "zoom": "17",
        }, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        m.refresh_from_db()
        tile.refresh_from_db()
        area.refresh_from_db()
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.base_map_id, m.pk)
        self.assertNotEqual(m.image.name, old_name)
        self.assertTrue(m.image.name.endswith(".jpg"))
        self.assertGreater(m.captured_at, old_at)
        self.assertEqual((m.basemap, m.zoom), ("sat", 17))
        self.assertEqual(m.bbox, BBOX)
        self.assertEqual((tile.x, tile.y, area.x, area.y), (4, 5, 1, 2))
        self.assertEqual((self.plan.geo_basemap, self.plan.geo_captured_at),
                         ("sat", m.captured_at))
        self.assertEqual(r.json()["geo"]["basemap"], "sat")
        entry = ChangeLogEntry.objects.filter(
            object_type="api.floorplanmap", object_id=str(m.pk),
        ).order_by("-timestamp").first()
        self.assertEqual(entry.cause, "Map refreshed from the Site map")
        # ...and on the floor, whose readers may not see the map's own log.
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.floorplan", object_id=str(self.plan.pk),
            cause="Map refreshed from the Site map",
        ).exists())

    def test_the_old_refresh_path_updates_the_map(self):
        m = self.plan.base_map
        old = m.image.name
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/background/", {
            "map_refresh": "1", "background_image": _png(), "basemap": "map",
        }, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        m.refresh_from_db()
        self.assertNotEqual(m.image.name, old)
        self.assertIsNone(r.json()["background_image"])

    def test_remove_clears_the_anchor_and_a_new_frame_is_free(self):
        mid = self.plan.base_map_id
        r = self.client.delete(f"/api/floor-plans/{self.plan.id}/map/")
        self.assertEqual(r.status_code, 204, r.content)
        self.plan.refresh_from_db()
        self.assertIsNone(self.plan.base_map_id)
        self.assertFalse(FloorPlanMap.objects.filter(pk=mid).exists())
        self.assertIsNone(self.plan.geo_bbox)
        self.assertIsNone(self.plan.geo_captured_at)
        d = self.client.get(f"/api/floor-plans/{self.plan.id}/").json()
        self.assertIsNone(d["geo"])
        # The old box is kept as a hint of where to look.
        self.assertEqual(d["state"]["from_map"]["bbox"], BBOX)
        # A new capture elsewhere, larger than the grid, is taken.
        gw, gh, mm = self.plan.grid_width, self.plan.grid_height, self.plan.cell_mm
        box = frame_box(55.5, 9.5, (gw + 10) * mm / 1000, (gh + 4) * mm / 1000)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/map/", {
            "image": _png(), "bbox": str(box), "grid": f"[{gw + 10}, {gh + 4}]",
            "offset": "[5, 2]",
        }, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.geo_bbox, list(box))
        self.assertEqual((self.plan.grid_width, self.plan.grid_height), (gw + 10, gh + 4))
        self.assertIsNotNone(self.plan.base_map_id)

    def test_remove_on_a_building_clears_every_level(self):
        stack = self.plan.stack
        stack.aligned = True
        stack.save()
        up = add_floor(stack, "1", copy_from=self.plan, same_footprint=True)
        self.assertEqual(up.base_map_id, self.plan.base_map_id)
        self.client.delete(f"/api/floor-plans/{self.plan.id}/map/")
        up.refresh_from_db()
        self.assertIsNone(up.base_map_id)
        self.assertIsNone(up.geo_bbox)

    def test_snapshot_copy_and_clone_get_maps_of_their_own(self):
        copy, _ = make_snapshot(self.plan, Crop(2, 2, 10, 8), name="Cut", mode="copy")
        self.assertIsNotNone(copy.base_map_id)
        self.assertNotEqual(copy.base_map_id, self.plan.base_map_id)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/clone/")
        self.assertEqual(r.status_code, 201, r.content)
        clone = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertIsNotNone(clone.base_map_id)
        self.assertNotEqual(clone.base_map_id, self.plan.base_map_id)


class FramingTests(_Base):
    """A plan with no geo anchor gets one from From site map: the box must
    be the grid's real size."""

    def setUp(self):
        super().setUp()
        self.hall = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", grid_width=30,
            grid_height=20, cell_mm=600)

    def test_a_box_of_the_grids_size_anchors_and_maps_it(self):
        box = frame_box(56.0, 10.0, 30 * 0.6, 20 * 0.6)
        r = self.client.post(f"/api/floor-plans/{self.hall.id}/map/", {
            "image": _png(), "bbox": str(box), "basemap": "map", "zoom": "19",
        }, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.hall.refresh_from_db()
        self.assertEqual(self.hall.geo_bbox, list(box))
        self.assertAlmostEqual(self.hall.geo_mpc, 0.6, delta=0.01)
        self.assertIsNotNone(self.hall.base_map_id)
        self.assertEqual(r.json()["geo"]["bbox"], list(box))

    def test_a_box_of_another_size_is_refused(self):
        box = frame_box(56.0, 10.0, 60, 40)
        r = self.client.post(f"/api/floor-plans/{self.hall.id}/map/", {
            "image": _png(), "bbox": str(box),
        }, format="multipart")
        self.assertEqual(r.status_code, 400)
        self.assertIn("bbox", r.json())
        self.hall.refresh_from_db()
        self.assertIsNone(self.hall.geo_bbox)
        r = self.client.post(f"/api/floor-plans/{self.hall.id}/map/", {
            "image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 400)

    def test_a_bad_image_leaves_no_anchor(self):
        box = frame_box(56.0, 10.0, 18, 12)
        r = self.client.post(f"/api/floor-plans/{self.hall.id}/map/", {
            "image": _png(fmt="GIF"), "bbox": str(box)}, format="multipart")
        self.assertEqual(r.status_code, 400)
        self.hall.refresh_from_db()
        self.assertIsNone(self.hall.geo_bbox)


class BuildingTests(_Base):
    """Levels of an aligned floor plan share one map; basements hide it."""

    def setUp(self):
        super().setUp()
        self.stack = self.plan.stack
        self.ground = self.plan

    def _add(self, name, **kw):
        r = self.client.post(f"/api/floor-plan-stacks/{self.stack.id}/floors/", {
            "name": name, "copy_from": str(self.ground.id), "same_footprint": True, **kw,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return FloorPlan.objects.get(pk=r.json()["id"])

    def test_same_footprint_shares_the_map_and_basements_hide_it(self):
        maps = FloorPlanMap.objects.count()
        up = self._add("1", copy_background=True)
        down = self._add("B1", below=True, copy_background=False)
        self.assertEqual(FloorPlanMap.objects.count(), maps)  # never copied per level
        self.assertEqual(up.base_map_id, self.ground.base_map_id)
        self.assertEqual(down.base_map_id, self.ground.base_map_id)
        self.assertTrue(map_visible(up))
        self.assertFalse(map_visible(down))
        d = self.client.get(f"/api/floor-plans/{down.id}/").json()
        self.assertFalse(d["map_visible"])
        self.assertEqual(d["base_map"]["floors"], 3)
        # A per-level switch shows it on the basement.
        r = self.client.patch(f"/api/floor-plans/{down.id}/", {"map_shown": True},
                              format="json")
        self.assertTrue(r.json()["map_visible"])
        # In 3D the map lies on the ground level only - never a basement's slab.
        down.refresh_from_db()
        self.ground.refresh_from_db()
        self.assertTrue(is_ground(self.ground))
        self.assertTrue(map_in_3d(self.ground))
        self.assertFalse(map_in_3d(up))
        self.assertFalse(map_in_3d(down))
        scene = self.client.get(f"/api/floor-plans/{down.id}/scene/").json()["plan"]
        self.assertIsNone(scene["base_map"])
        scene = self.client.get(f"/api/floor-plans/{self.ground.id}/scene/").json()["plan"]
        self.assertTrue(scene["base_map"])

    def test_copy_background_copies_only_the_floor_picture(self):
        self.client.post(f"/api/floor-plans/{self.ground.id}/background/",
                         {"background_image": _png()}, format="multipart")
        up = self._add("1", copy_background=True)
        bare = self._add("2", copy_background=False)
        self.assertTrue(up.background_image)
        self.assertFalse(bare.background_image)
        self.assertEqual(bare.base_map_id, self.ground.base_map_id)

    def test_update_from_any_level_updates_the_building(self):
        up = self._add("1")
        old = self.ground.base_map.image.name
        r = self.client.post(f"/api/floor-plans/{up.id}/map/", {
            "image": _png(), "basemap": "map"}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.ground.refresh_from_db()
        self.assertNotEqual(self.ground.base_map.image.name, old)
        self.assertEqual(self.ground.base_map_id, up.base_map_id)

    def test_a_map_made_on_one_level_lies_under_the_others(self):
        tower = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Tower", aligned=True)
        g = FloorPlan.objects.create(tenant=self.tenant, site=self.site, stack=tower,
                                     name="G", grid_width=30, grid_height=20, cell_mm=600)
        b1 = add_floor(tower, "B1", copy_from=g, below=True, same_footprint=True)
        odd = FloorPlan.objects.create(tenant=self.tenant, site=self.site, stack=tower,
                                       name="Annex", floor_order=50, grid_width=10,
                                       grid_height=10, cell_mm=600)
        box = frame_box(56.0, 10.0, 18, 12)
        r = self.client.post(f"/api/floor-plans/{g.id}/map/", {
            "image": _png(), "bbox": str(box)}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        for p in (g, b1, odd):
            p.refresh_from_db()
        self.assertEqual(b1.base_map_id, g.base_map_id)
        self.assertEqual(b1.geo_bbox, g.geo_bbox)
        self.assertFalse(map_visible(b1))
        self.assertIsNone(odd.base_map_id)  # another footprint

    def test_remove_takes_it_from_every_level(self):
        up = self._add("1")
        self.client.delete(f"/api/floor-plans/{up.id}/map/")
        self.ground.refresh_from_db()
        self.assertIsNone(self.ground.base_map_id)

    def test_expanding_one_level_gives_it_a_map_of_its_own(self):
        up = self._add("1")
        shared = self.ground.base_map_id
        r = self.client.post(f"/api/floor-plans/{up.id}/expand/", {
            "bbox": _grown(up, right=2), "version": up.updated_at.isoformat(),
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        up.refresh_from_db()
        self.ground.refresh_from_db()
        self.assertNotEqual(up.base_map_id, shared)
        self.assertEqual(self.ground.base_map_id, shared)
        self.assertEqual(up.base_map.bbox, up.geo_bbox)
        self.assertEqual(self.ground.base_map.bbox, BBOX)

    def test_deleting_the_last_level_deletes_the_map(self):
        mid = self.ground.base_map_id
        up = self._add("1")
        self.captureOnCommitCallbacks(execute=True)
        with self.captureOnCommitCallbacks(execute=True):
            up.delete()
        self.assertTrue(FloorPlanMap.objects.filter(pk=mid).exists())
        with self.captureOnCommitCallbacks(execute=True):
            self.ground.delete()
        self.assertFalse(FloorPlanMap.objects.filter(pk=mid).exists())


class GrowTests(_Base):
    """From site map with a frame larger than the grid: the grid grows, its
    contents move by the offset, and the map covers the frame - on every
    level that grows with it."""

    def setUp(self):
        super().setUp()
        self.hall = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", grid_width=30,
            grid_height=20, cell_mm=600)
        ttype = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        self.tile = FloorPlanTile.objects.create(
            floor_plan=self.hall, x=3, y=4, tile_type=ttype)
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.hall, x=1, y=1, width=5, height=5)

    def post(self, plan, gw, gh, ox, oy, box=None, **extra):
        box = box or frame_box(56.0, 10.0, gw * plan.cell_mm / 1000, gh * plan.cell_mm / 1000)
        return self.client.post(f"/api/floor-plans/{plan.id}/map/", {
            "image": _png(), "bbox": str(box), "grid": f"[{gw}, {gh}]",
            "offset": f"[{ox}, {oy}]", "basemap": "map", "zoom": "19", **extra,
        }, format="multipart")

    def test_grow_shift_and_map_in_one_call(self):
        r = self.post(self.hall, 50, 30, 10, 5)
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d["grid_width"], d["grid_height"]), (50, 30))
        self.assertEqual(d["grown"]["left"], 10)
        self.assertEqual(d["grown"]["right"], 10)
        self.assertEqual(d["grown"]["levels"], 1)
        self.tile.refresh_from_db()
        self.area.refresh_from_db()
        self.assertEqual((self.tile.x, self.tile.y), (13, 9))
        self.assertEqual((self.area.x, self.area.y), (11, 6))
        self.hall.refresh_from_db()
        self.assertIsNotNone(self.hall.base_map_id)
        self.assertEqual(self.hall.base_map.bbox, self.hall.geo_bbox)
        self.assertAlmostEqual(self.hall.geo_mpc, 0.6, delta=0.01)
        # Audited under one cause.
        for model, pk in (("floorplantile", self.tile.pk), ("floorplan", self.hall.pk)):
            self.assertTrue(ChangeLogEntry.objects.filter(
                object_type=f"api.{model}", object_id=str(pk),
                cause="Grew Hall to 50 × 30 cells from the Site map").exists(), model)

    def test_refusals_leave_everything_as_it_was(self):
        cases = [
            (20, 20, 0, 0, "grid"),       # smaller than the grid
            (513, 20, 0, 0, "grid"),      # over the limit
            (40, 20, 11, 0, "offset"),    # the grid sticks out
            (40, 20, -1, 0, "offset"),
        ]
        for gw, gh, ox, oy, field in cases:
            box = frame_box(56.0, 10.0, max(gw, 30) * 0.6, max(gh, 20) * 0.6)
            r = self.post(self.hall, gw, gh, ox, oy, box=box)
            self.assertEqual(r.status_code, 400, (gw, gh, ox, oy))
            self.assertIn(field, r.json())
        # A box of the wrong size for the grid asked for.
        r = self.post(self.hall, 40, 20, 5, 0, box=frame_box(56.0, 10.0, 30 * 0.6, 12))
        self.assertEqual(r.status_code, 400)
        self.assertIn("bbox", r.json())
        self.hall.refresh_from_db()
        self.tile.refresh_from_db()
        self.assertEqual((self.hall.grid_width, self.hall.grid_height), (30, 20))
        self.assertIsNone(self.hall.geo_bbox)
        self.assertEqual((self.tile.x, self.tile.y), (3, 4))

    def test_aligned_levels_grow_together(self):
        tower = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Tower", aligned=True)
        self.hall.stack = tower
        self.hall.save()
        up = add_floor(tower, "1", copy_from=self.hall, same_footprint=True)
        odd = FloorPlan.objects.create(tenant=self.tenant, site=self.site, stack=tower,
                                       name="Annex", floor_order=50, grid_width=10,
                                       grid_height=10, cell_mm=600)
        lab = FloorPlanLabel.objects.create(floor_plan=up, x=2, y=2, text="Up")
        d = self.client.get(f"/api/floor-plans/{self.hall.id}/").json()
        self.assertEqual(d["map_levels"], 2)
        r = self.post(self.hall, 40, 24, 4, 2)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["grown"]["levels"], 2)
        for p in (self.hall, up, odd):
            p.refresh_from_db()
        lab.refresh_from_db()
        self.assertEqual((up.grid_width, up.grid_height), (40, 24))
        self.assertEqual(up.geo_bbox, self.hall.geo_bbox)
        self.assertEqual(up.base_map_id, self.hall.base_map_id)
        self.assertEqual((lab.x, lab.y), (6, 4))
        self.assertEqual((odd.grid_width, odd.grid_height), (10, 10))
        self.assertIsNone(odd.base_map_id)

    def test_an_anchored_plan_grows_around_its_box(self):
        p = self.plan
        gw, gh = p.grid_width, p.grid_height
        old_area = FloorPlanArea.objects.filter(floor_plan=p).order_by("pk").first()
        r = self.post(p, gw + 3, gh + 2, 2, 1, box=_grown(p, left=2, top=1, right=1, bottom=1))
        self.assertEqual(r.status_code, 200, r.content)
        p.refresh_from_db()
        self.assertEqual((p.grid_width, p.grid_height), (gw + 3, gh + 2))
        self.assertEqual(p.base_map.bbox, p.geo_bbox)
        if old_area is not None:
            moved = FloorPlanArea.objects.get(pk=old_area.pk)
            self.assertEqual((moved.x, moved.y), (old_area.x + 2, old_area.y + 1))
        # An offset that does not match where the box is: refused.
        r = self.post(p, p.grid_width + 2, p.grid_height, 0, 0,
                      box=_grown(p, left=1, right=1))
        self.assertEqual(r.status_code, 400)

    def test_change_on_every_level_is_needed(self):
        viewer = self._user("viewer", [(["floorplan"], ["view"], [])])
        self._login(viewer)
        self.assertEqual(self.post(self.hall, 40, 20, 5, 0).status_code, 403)
        other_site = self._user("depot", [(["floorplan"], ["view", "change"],
                                           [self.site_b])])
        self._login(other_site)
        self.assertEqual(self.post(self.hall, 40, 20, 5, 0).status_code, 404)
        self.hall.refresh_from_db()
        self.assertEqual(self.hall.grid_width, 30)


class AccessTests(_Base):
    def test_change_is_needed(self):
        viewer = self._user("viewer", [(["floorplan"], ["view"], [])])
        self._login(viewer)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/map/",
                             {"image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete(
            f"/api/floor-plans/{self.plan.id}/map/").status_code, 403)
        # Viewing is enough to see the map's picture.
        url = self.plan.base_map.image.url
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_another_sites_grant_and_another_tenant_find_nothing(self):
        other_site = self._user("depot", [(["floorplan"], ["view", "change"],
                                           [self.site_b])])
        self._login(other_site)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/map/",
                             {"image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get(self.plan.base_map.image.url).status_code, 404)

        org = Organization.objects.create(name="Other", slug="other")
        t2 = Tenant.objects.create(org=org, name="Other", slug="other")
        Site.objects.create(tenant=t2, name="Elsewhere")
        stranger = get_user_model().objects.create_superuser("s", "s@x.y", "pw")
        self.client.force_login(stranger)
        sess = self.client.session
        sess["current_tenant_id"] = str(t2.id)
        sess.save()
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/map/",
                             {"image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get(self.plan.base_map.image.url).status_code, 404)

    def test_a_live_view_shows_its_sources_map_and_cannot_set_one(self):
        view, _ = make_snapshot(self.plan, Crop(0, 0, 10, 10), name="V", mode="view")
        d = self.client.get(f"/api/floor-plans/{view.id}/").json()
        self.assertEqual(d["base_map"]["id"], str(self.plan.base_map_id))
        r = self.client.post(f"/api/floor-plans/{view.id}/map/",
                             {"image": _png()}, format="multipart")
        self.assertEqual(r.status_code, 400)
