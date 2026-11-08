"""Detect outline on a CAD drawing: the closed shapes read from the processed
drawing (api.cad_loops) and ``GET /api/floor-plans/<id>/drawing/loops/``."""
from __future__ import annotations

import math
from unittest import mock

from django.test import SimpleTestCase

from . import cad_loops
from . import tests_cad_fixtures as fx
from .tests_cad import _Base


class SubpathTests(SimpleTestCase):
    def test_closed_and_open_subpaths(self):
        out = cad_loops.subpaths("M0 0L10 0L10 10L0 10ZM20 0L30 0M0 0L5 5L0 5L0 0")
        self.assertEqual(len(out), 3)
        self.assertTrue(out[0][1])
        self.assertFalse(out[1][1])
        # The third ends where it starts: a loop though it has no Z.
        self.assertIsNotNone(cad_loops._loop(out[2][0], out[2][1], 1e-6))
        self.assertIsNone(cad_loops._loop(out[1][0], out[1][1], 1e-6))

    def test_curves_are_flattened(self):
        ((pts, closed),) = cad_loops.subpaths("M0 0C0 10 10 10 10 0L0 0")
        self.assertFalse(closed)
        self.assertEqual(len(pts), 1 + cad_loops.CURVE_STEPS + 1)
        self.assertAlmostEqual(pts[cad_loops.CURVE_STEPS // 2][1], 7.5)

    def test_anything_else_is_skipped(self):
        self.assertEqual(cad_loops.subpaths("M0 0A5 5 0 0 1 10 0Z"), [])
        self.assertEqual(cad_loops.subpaths("M0 0L1"), [])
        self.assertEqual(cad_loops.subpaths("10 10"), [])

    def test_a_round_loop_is_cut_to_an_areas_corners(self):
        ring = [(math.cos(i / 500 * math.tau), math.sin(i / 500 * math.tau))
                for i in range(500)]
        out = cad_loops.fit_points(ring)
        self.assertLessEqual(len(out), cad_loops.MAX_AREA_POINTS)
        self.assertGreater(len(out), 12)


class DrawingLoopsTests(_Base):
    def setUp(self):
        super().setUp()
        self.d = self.ready()

    def loops(self, x, y, plan=None):
        return self.client.get(self.url(plan, "loops/"), {"x": x, "y": y})

    def cell(self, x, y):
        """A drawing point (mm, y up) as a plan cell, the drawing at the
        plan's corner unturned."""
        ext = self.d.extents
        return (x - ext["min_x"]) / 600, (ext["max_y"] - y) / 600

    def box(self, pts):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return min(xs), min(ys), max(xs), max(ys)

    def test_a_click_in_the_room_picks_its_walls(self):
        r = self.loops(*self.cell(2500, 4500))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data["layer"], "WALLS")
        self.assertEqual(len(r.data["points"]), 4)
        x0, y0 = self.cell(0, 6000)
        x1, y1 = self.cell(10000, 0)
        for got, want in zip(self.box(r.data["points"]), (x0, y0, x1, y1), strict=True):
            self.assertAlmostEqual(got, want, places=3)

    def test_the_smallest_shape_round_the_click_wins(self):
        # The column (a circle, r 200) inside the room.
        r = self.loops(*self.cell(5000, 3000))
        self.assertEqual(r.status_code, 200)
        pts = r.data["points"]
        self.assertGreater(len(pts), 8)
        self.assertLessEqual(len(pts), 200)
        x0, y0, x1, y1 = self.box(pts)
        self.assertAlmostEqual((x1 - x0) * 600, 400, delta=2)
        # The desk: a block, half size and turned - 400 x 800 mm.
        r = self.loops(*self.cell(6800, 4400))
        self.assertEqual(r.data["layer"], "FURNITURE")
        x0, y0, x1, y1 = self.box(r.data["points"])
        self.assertAlmostEqual((x1 - x0) * 600, 400, delta=1)
        self.assertAlmostEqual((y1 - y0) * 600, 800, delta=1)
        # A solid hatch's boundary.
        r = self.loops(*self.cell(500, 500))
        self.assertEqual(r.data["layer"], "HATCH")
        x0, y0, x1, y1 = self.box(r.data["points"])
        self.assertAlmostEqual((x1 - x0) * 600, 800, delta=1)

    def test_hidden_layers_are_not_picked(self):
        self.client.patch(self.url(), {"hidden_layers": ["WALLS"]}, format="json")
        self.assertEqual(self.loops(*self.cell(2500, 4500)).status_code, 404)

    def test_outside_every_shape_is_a_404(self):
        self.assertEqual(self.loops(*self.cell(-3000, 3000)).status_code, 404)

    def test_the_placement_turns_and_moves_the_loop(self):
        self.client.patch(self.url(), {"rotation": 90, "x_mm": 1200, "y_mm": 600},
                          format="json")
        self.d.refresh_from_db()
        box = self.d.extents
        w = box["max_x"] - box["min_x"]
        h = box["max_y"] - box["min_y"]
        # Turned a quarter: the room is 6 m across and 10 m down.
        cx = (1200 + h / 2) / 600
        cy = (600 + w / 2) / 600
        # Search for the room near the middle of the turned drawing.
        found = None
        for dx in range(-6, 7):
            r = self.loops(cx + dx, cy)
            if r.status_code == 200 and r.data["layer"] == "WALLS" \
                    and len(r.data["points"]) == 4:
                found = r.data["points"]
                break
        self.assertIsNotNone(found)
        x0, y0, x1, y1 = self.box(found)
        self.assertAlmostEqual((x1 - x0) * 600, 6000, places=1)
        self.assertAlmostEqual((y1 - y0) * 600, 10000, places=1)
        self.assertGreaterEqual(x0, 2)
        self.assertGreaterEqual(y0, 1)

    def test_loops_are_read_once_per_render(self):
        with mock.patch.object(cad_loops, "read_loops", wraps=cad_loops.read_loops) as read, \
                mock.patch.object(cad_loops.cache, "get", return_value=None) as get, \
                mock.patch.object(cad_loops.cache, "set") as put:
            self.loops(*self.cell(2500, 4500))
        self.assertEqual(read.call_count, 1)
        key = put.call_args.args[0]
        self.assertIn(str(self.d.pk), key)
        get.assert_any_call(key)
        # A hit does not read the file.
        with mock.patch.object(cad_loops, "read_loops") as read, \
                mock.patch.object(cad_loops.cache, "get", side_effect=lambda k, *a: [] if k == key else None):
            self.assertEqual(self.loops(*self.cell(2500, 4500)).status_code, 404)
        read.assert_not_called()
        # A new render is a new key.
        self.d.rendered.name = self.d.rendered.name + "x"
        self.assertNotEqual(cad_loops._cache_key(self.d), key)

    def test_bad_points_and_unprocessed_drawings(self):
        self.assertEqual(self.client.get(self.url(tail="loops/")).status_code, 400)
        self.assertEqual(self.loops("nan", 1).status_code, 400)
        self.assertEqual(self.loops(1, "1e9").status_code, 400)
        self.d.status = "queued"
        self.d.save(update_fields=["status"])
        self.assertEqual(self.loops(1, 1).status_code, 409)

    def test_a_viewer_may_pick_and_others_may_not(self):
        at = self.cell(2500, 4500)
        self.login(self.member("viewer", "view"))
        self.assertEqual(self.loops(*at).status_code, 200)
        self.login(self.member("nobody"))
        self.assertIn(self.loops(*at).status_code, (403, 404))
        outsider = self.member("outsider", "view", "change", tenant=self.other)
        self.login(outsider, self.other)
        self.assertEqual(self.loops(*at).status_code, 404)

    def test_a_plan_without_a_drawing_is_a_404(self):
        self.assertEqual(self.loops(1, 1, plan=self.other_plan).status_code, 404)
        self.d.delete()
        self.assertEqual(self.loops(1, 1).status_code, 404)


class LoopsOfAnotherDrawingTests(_Base):
    def test_lines_that_only_meet_are_not_a_shape(self):
        """Four separate lines round a room are not a closed shape: only
        closed polylines, circles and hatch boundaries are picked."""

        def extras(doc, msp):
            for a, b in (((20000, 0), (24000, 0)), ((24000, 0), (24000, 3000)),
                         ((24000, 3000), (20000, 3000)), ((20000, 3000), (20000, 0))):
                msp.add_line(a, b, dxfattribs={"layer": "WALLS"})

        d = self.ready(fx.floor_dxf(extras=extras))
        ext = d.extents
        x = (22000 - ext["min_x"]) / 600
        y = (ext["max_y"] - 1500) / 600
        r = self.client.get(self.url(tail="loops/"), {"x": x, "y": y})
        self.assertEqual(r.status_code, 404)
