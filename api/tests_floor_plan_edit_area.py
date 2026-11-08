"""Edit area: a plan made from the Site map framed larger or smaller with
``keep_anchor`` - the grid grows or is trimmed on any side and corner,
everything placed keeps its real-world position, an aligned building's
levels follow together, a frame off the plan's box is refused, and a
shrink that would cut something is refused naming what."""

from __future__ import annotations

from audit.models import ChangeLogEntry

from . import floor_plan_from_map as fm
from . import floor_plan_geo as geo
from .floor_stacks import add_floor
from .models import (
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanStack,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    FloorTileType,
)
from .tests_floor_plan_geo import _Base, _grown, _png


def lat_lng(plan, x, y):
    """Cell (``x``, ``y``) of ``plan`` as a point on the map."""
    s, w, n, e = (float(v) for v in plan.geo_bbox)
    x0, x1, y0, y1 = fm.merc_x(w), fm.merc_x(e), fm.merc_y(n), fm.merc_y(s)
    return (
        fm.lat_of(y0 + y / plan.grid_height * (y1 - y0)),
        geo.lng_of(x0 + x / plan.grid_width * (x1 - x0)),
    )


class EditAreaTests(_Base):
    def setUp(self):
        super().setUp()
        p = self.plan
        ttype = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        self.tile = FloorPlanTile.objects.create(floor_plan=p, x=40, y=30, tile_type=ttype)
        self.wall = FloorPlanWall.objects.create(floor_plan=p, points=[[10, 10], [60, 10]])
        self.tray = FloorPlanTray.objects.create(floor_plan=p, points=[[20, 50], [20, 70]])
        self.label = FloorPlanLabel.objects.create(floor_plan=p, x=50, y=50, text="Hall")
        self.box = FloorPlanArea.objects.create(floor_plan=p, x=30, y=30, width=10, height=8)

    def post(self, plan, left=0, top=0, right=0, bottom=0, box=None, **extra):
        gw = plan.grid_width + left + right
        gh = plan.grid_height + top + bottom
        box = box or _grown(plan, left, top, right, bottom)
        return self.client.post(f"/api/floor-plans/{plan.id}/map/", {
            "image": _png(), "bbox": str(box), "grid": f"[{gw}, {gh}]",
            "offset": f"[{left}, {top}]", "basemap": "sat", "zoom": "19",
            "keep_anchor": "1", **extra,
        }, format="multipart")

    def where(self):
        """Every object's place on the map, by a key."""
        p = FloorPlan.objects.get(pk=self.plan.pk)
        t = FloorPlanTile.objects.get(pk=self.tile.pk)
        wl = FloorPlanWall.objects.get(pk=self.wall.pk)
        tr = FloorPlanTray.objects.get(pk=self.tray.pk)
        lb = FloorPlanLabel.objects.get(pk=self.label.pk)
        ar = FloorPlanArea.objects.get(pk=self.box.pk)
        return {
            "tile": lat_lng(p, t.x, t.y),
            "wall": [lat_lng(p, *pt[:2]) for pt in wl.points],
            "tray": [lat_lng(p, *pt[:2]) for pt in tr.points],
            "label": lat_lng(p, lb.x, lb.y),
            "area": lat_lng(p, ar.x, ar.y),
        }

    def assertSamePlace(self, a, b):
        def flat(d):
            out = []
            for v in d.values():
                out.extend(v if isinstance(v, list) else [v])
            return out

        for (la, lo), (lb, lob) in zip(flat(a), flat(b), strict=True):
            # Well under a centimetre.
            self.assertAlmostEqual(la, lb, delta=1e-7)
            self.assertAlmostEqual(lo, lob, delta=1e-7)

    def test_each_side_and_corner_keeps_everything_in_place(self):
        cases = [
            {"left": 4}, {"top": 3}, {"right": 5}, {"bottom": 2},
            {"left": 2, "top": 3}, {"right": 3, "top": 1}, {"right": 2, "bottom": 2},
            {"left": 1, "bottom": 4}, {"left": 1, "top": 1, "right": 1, "bottom": 1},
            {"right": -3, "bottom": -2},  # trimmed: nothing out there
            {"left": -1, "top": -1},
        ]
        for sides in cases:
            before = self.where()
            p = FloorPlan.objects.get(pk=self.plan.pk)
            gw, gh = p.grid_width, p.grid_height
            r = self.post(p, **sides)
            self.assertEqual(r.status_code, 200, (sides, r.content))
            p.refresh_from_db()
            self.assertEqual(p.grid_width, gw + sides.get("left", 0) + sides.get("right", 0))
            self.assertEqual(p.grid_height, gh + sides.get("top", 0) + sides.get("bottom", 0))
            self.assertSamePlace(before, self.where())
            self.assertEqual(p.base_map.bbox, p.geo_bbox)
            self.assertEqual(p.base_map.basemap, "sat")

    def test_the_anchor_stays_exact_and_the_change_is_logged(self):
        p = self.plan
        old = list(p.geo_bbox)
        gw, gh = p.grid_width, p.grid_height
        r = self.post(p, left=3, top=2)
        self.assertEqual(r.status_code, 200, r.content)
        p.refresh_from_db()
        # The south-east corner did not move; the cells kept their size.
        self.assertAlmostEqual(p.geo_bbox[0], old[0], places=9)
        self.assertAlmostEqual(p.geo_bbox[3], old[3], places=9)
        self.assertAlmostEqual(p.geo_mpc, self.plan.geo_mpc, delta=1e-6)
        self.assertEqual((p.grid_width, p.grid_height), (gw + 3, gh + 2))
        self.tile.refresh_from_db()
        self.assertEqual((self.tile.x, self.tile.y), (43, 32))
        cause = f"Grew Campus to {gw + 3} × {gh + 2} cells from the Site map"
        for model, pk in (("floorplan", p.pk), ("floorplantile", self.tile.pk)):
            self.assertTrue(ChangeLogEntry.objects.filter(
                object_type=f"api.{model}", object_id=str(pk), cause=cause).exists(), model)

    def test_a_frame_off_the_plans_box_is_refused(self):
        p = self.plan
        # The right size, but two cells east of where the grid is.
        box = _grown(p, -2, 0, 2, 0)
        r = self.post(p, box=box)
        self.assertEqual(r.status_code, 400)
        self.assertIn("bbox", r.json())
        p.refresh_from_db()
        self.assertEqual(p.geo_bbox, self.plan.geo_bbox)

    def test_a_shrink_that_would_cut_names_what(self):
        p = self.plan
        gw, gh = p.grid_width, p.grid_height
        old_map = p.base_map.image.name
        # The wall runs from x 10; the frame trims 12 cells off the west.
        r = self.post(p, left=-12)
        self.assertEqual(r.status_code, 400)
        msg = " ".join(r.json()["offset"])
        self.assertIn("1 wall", msg)
        self.assertNotIn("tile", msg)
        p.refresh_from_db()
        self.wall.refresh_from_db()
        self.assertEqual((p.grid_width, p.grid_height), (gw, gh))
        self.assertEqual(self.wall.points[0][:2], [10, 10])
        # The old map stays: nothing is replaced on a refusal.
        self.assertEqual(p.base_map.image.name, old_map)

    def test_aligned_levels_all_grow_and_stay_aligned(self):
        tower = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Tower", aligned=True)
        p = self.plan
        p.stack = tower
        p.save()
        up = add_floor(tower, "1", copy_from=p, same_footprint=True)
        mark = FloorPlanLabel.objects.create(floor_plan=up, x=5, y=6, text="Up")
        up.refresh_from_db()
        before = lat_lng(up, 5, 6) if up.geo_bbox else lat_lng(p, 5, 6)
        gw, gh = p.grid_width, p.grid_height
        r = self.post(p, left=2, top=1, right=3, bottom=4)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["grown"]["levels"], 2)
        p.refresh_from_db()
        up.refresh_from_db()
        mark.refresh_from_db()
        self.assertEqual((up.grid_width, up.grid_height), (gw + 5, gh + 5))
        self.assertEqual(up.geo_bbox, p.geo_bbox)
        self.assertEqual(up.base_map_id, p.base_map_id)
        self.assertEqual((mark.x, mark.y), (7, 7))
        after = lat_lng(up, mark.x, mark.y)
        self.assertAlmostEqual(after[0], before[0], delta=1e-7)
        self.assertAlmostEqual(after[1], before[1], delta=1e-7)

    def test_a_shrink_is_refused_for_what_another_level_holds(self):
        tower = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site, name="Tower", aligned=True)
        p = self.plan
        p.stack = tower
        p.save()
        up = add_floor(tower, "1", copy_from=p, same_footprint=True)
        FloorPlanLabel.objects.create(floor_plan=up, x=p.grid_width - 1, y=5, text="Edge")
        r = self.post(p, right=-3)
        self.assertEqual(r.status_code, 400)
        self.assertIn("1 label on 1", " ".join(r.json()["offset"]))
