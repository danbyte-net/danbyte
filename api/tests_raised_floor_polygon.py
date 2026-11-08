"""Polygon raised floors: validation, the cell box that follows the outline,
overlap against rectangles and polygons, tenant scoping, the scene payload,
and the plenum lookups that read them (point in polygon, not in box)."""
import math

from django.test import SimpleTestCase

from . import raised_floor_geometry as rfg
from .models import FloorPlan, FloorPlanRaisedFloorArea, FloorPlanTray, Location, Site
from .pathfinding import suggest_run, underfloor_plenum_mm
from .tests_raised_floor import _Base


def turned(cx, cy, w, h, deg):
    """A w×h rectangle turned ``deg`` about (cx, cy)."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [
        [round(cx + dx * c - dy * s, 3), round(cy + dx * s + dy * c, 3)]
        for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))
    ]


class GeometryTests(SimpleTestCase):
    def test_contains_includes_the_outline(self):
        tri = [(0, 0), (4, 0), (0, 4)]
        self.assertTrue(rfg.contains(tri, (1, 1)))
        self.assertTrue(rfg.contains(tri, (2, 2)))  # on the hypotenuse
        self.assertTrue(rfg.contains(tri, (0, 0)))
        self.assertFalse(rfg.contains(tri, (3, 3)))

    def test_overlaps(self):
        a = rfg.rect_outline(0, 0, 4, 4)
        self.assertFalse(rfg.overlaps(a, rfg.rect_outline(4, 0, 4, 4)))  # shared edge
        self.assertFalse(rfg.overlaps(a, rfg.rect_outline(4, 4, 2, 2)))  # shared corner
        self.assertTrue(rfg.overlaps(a, rfg.rect_outline(3, 3, 2, 2)))
        self.assertTrue(rfg.overlaps(a, rfg.rect_outline(1, 1, 1, 1)))  # inside
        self.assertTrue(rfg.overlaps(a, rfg.rect_outline(0, 0, 4, 4)))  # the same
        self.assertTrue(rfg.overlaps(rfg.rect_outline(1, 1, 1, 1), a))
        # A diamond whose corners touch the square's edges from outside.
        self.assertFalse(rfg.overlaps(a, [(4, 2), (6, 0), (8, 2), (6, 4)]))
        self.assertTrue(rfg.overlaps(a, [(3, 2), (6, 0), (8, 2), (6, 4)]))

    def test_cell_box(self):
        self.assertEqual(rfg.cell_box([(1.5, 2.2), (4.1, 2.2), (3, 6.0)]), (1, 2, 4, 4))
        self.assertEqual(rfg.cell_box([(1, 1), (3, 1), (3, 3)]), (1, 1, 2, 2))

    def test_plenum_and_within_take_polygons(self):
        hall = turned(10, 10, 8, 4, 28)
        areas = [(hall, 500)]
        self.assertEqual(underfloor_plenum_mm(areas, [[10, 10]]), 500.0)
        # Inside the hall's box but outside the turned hall.
        self.assertEqual(underfloor_plenum_mm(areas, [[6.2, 12.8]]), 300.0)
        # Rect tuples still work beside polygon ones.
        self.assertEqual(
            underfloor_plenum_mm([(0, 0, 2, 2, 700), (hall, 500)], [[1, 1], [10, 10]]),
            700.0,
        )
        pts = suggest_run((9.5, 9.5), (11.5, 10.5), width=20, height=20, within=[hall])
        self.assertIsNotNone(pts)
        for p in pts:
            self.assertTrue(rfg.contains(hall, p, 1e-6))


class PolygonApiTests(_Base):
    def test_polygon_sets_its_cell_box(self):
        pts = turned(10, 6, 8, 4, 28)
        r = self._mk(points=pts, x=0, y=0, width=1, height=1)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["points"], pts)
        self.assertEqual(
            (body["x"], body["y"], body["width"], body["height"]), rfg.cell_box(pts)
        )

    def test_rect_rows_keep_working(self):
        r = self._mk()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["points"], [])
        row = FloorPlanRaisedFloorArea.objects.get(pk=r.json()["id"])
        self.assertEqual((row.x, row.y, row.width, row.height), (2, 2, 6, 4))

    def test_bad_polygons_rejected(self):
        for pts, why in (
            ([[1, 1], [3, 1]], "three"),
            ([[1, 1], [3, 1], [5, 1]], "no area"),
            ([[1, 1], [5, 5], [5, 1], [1, 4]], "cross"),
            ([[1, 1], ["a", 1], [3, 3]], "[x, y]"),
            ([[1, 1], [30, 1], [30, 5]], "fit inside"),
            ([[-1, 1], [3, 1], [3, 5]], "fit inside"),
        ):
            r = self._mk(points=pts)
            self.assertEqual(r.status_code, 400, pts)
            self.assertIn(why, str(r.content))

    def test_overlap_between_polygons_and_rects(self):
        self.assertEqual(self._mk().status_code, 201)  # rect 2..8 × 2..6
        # A triangle poking into the rect.
        r = self._mk(points=[[7, 5], [12, 5], [12, 10]], label="Tri")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Overlaps", str(r.content))
        # A triangle against the rect's right edge: shares it, no overlap.
        r = self._mk(points=[[8, 2], [12, 4], [8, 6]], label="Tri")
        self.assertEqual(r.status_code, 201, r.content)
        # A rectangle overlapping that triangle (inside its cell box only
        # would be fine, its body is not).
        r = self._mk(x=10, y=2, width=2, height=1)
        self.assertEqual(r.status_code, 201, r.content)  # above the slope
        r = self._mk(x=9, y=3, width=1, height=2)
        self.assertEqual(r.status_code, 400)

    def test_patch_moves_polygon_and_box(self):
        r = self._mk(points=[[2, 2], [6, 2], [4, 5]])
        aid = r.json()["id"]
        p = self.client.patch(
            f"/api/floor-plan-raised-floors/{aid}/",
            {"points": [[3, 3], [7, 3], [5, 6]]}, format="json",
        )
        self.assertEqual(p.status_code, 200, p.content)
        self.assertEqual((p.json()["x"], p.json()["y"]), (3, 3))
        # Back to a rectangle.
        p = self.client.patch(
            f"/api/floor-plan-raised-floors/{aid}/",
            {"points": [], "x": 1, "y": 1, "width": 2, "height": 2}, format="json",
        )
        self.assertEqual(p.status_code, 200, p.content)
        self.assertEqual(p.json()["points"], [])
        self.assertEqual(p.json()["width"], 2)

    def test_other_tenant_cannot_see_or_write(self):
        other_site = Site.objects.create(tenant=self.other, name="S2")
        other_loc = Location.objects.create(tenant=self.other, site=other_site, name="D2")
        hidden = FloorPlan.objects.create(tenant=self.other, location=other_loc, name="H")
        row = FloorPlanRaisedFloorArea.objects.create(
            floor_plan=hidden, x=0, y=0, width=2, height=2,
            points=[[0, 0], [2, 0], [1, 2]],
        )
        r = self._mk(floor_plan_id=str(hidden.id), points=[[0, 0], [2, 0], [1, 2]])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            self.client.patch(
                f"/api/floor-plan-raised-floors/{row.id}/",
                {"points": [[0, 0], [3, 0], [1, 2]]}, format="json",
            ).status_code,
            404,
        )

    def test_bulk_save_takes_a_polygon(self):
        pts = turned(10, 6, 8, 4, 28)
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/bulk/",
            {"raised_floors": {"create": [{"points": pts, "plenum_mm": 450}]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        row = FloorPlanRaisedFloorArea.objects.get(floor_plan=self.plan)
        self.assertEqual(row.points, pts)
        self.assertEqual(row.plenum_mm, 450)

    def test_scene_carries_points_and_tray_depth_follows_polygon(self):
        pts = turned(10, 6, 8, 4, 28)
        self._mk(points=pts, plenum_mm=800)
        scene = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertEqual(scene["raised_floors"][0]["points"], pts)
        inside = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="In", level="underfloor",
            points=[[9, 6], [11, 6]],
        )
        from .pathfinding import tray_elevations

        areas = [(rfg.outline_of(r), r.plenum_mm) for r in self.plan.raised_floor_areas.all()]
        self.assertEqual(tray_elevations([inside], 3000, areas), [-800.0])
        outside = FloorPlanTray(level="underfloor", points=[[6.2, 8.8]])
        self.assertEqual(tray_elevations([outside], 3000, areas), [-300.0])

    def test_shift_moves_points(self):
        from .floor_plan_geo import shift_contents

        self._mk(points=[[2, 2], [6, 2], [4, 5]])
        shift_contents(self.plan, 2, 1)
        row = FloorPlanRaisedFloorArea.objects.get(floor_plan=self.plan)
        self.assertEqual(row.points, [[4, 3], [8, 3], [6, 6]])
        self.assertEqual((row.x, row.y), (4, 3))
