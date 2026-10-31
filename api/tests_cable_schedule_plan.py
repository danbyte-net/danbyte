"""The cable schedule PDF's plan pages (``api/cable_schedule_plan.py``): the
background image and CAD drawing laid under the posted plan, cut to the
framed box (and a live view's crop), and the close-up pages: clusters of
connected equipment on a big plan, each framed and scaled to the page."""

from __future__ import annotations

import io
import re
from unittest import mock

from django.core.files.base import ContentFile
from django.test import SimpleTestCase
from lxml import etree
from PIL import Image

from api import cable_schedule
from api import cable_schedule_plan as cp
from api.floor_plan_snapshots import Crop
from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Rack,
)
from api.svg_sanitize import MAX_IMAGE_BYTES
from api.tests_elevation_pdf import _pdf_objects
from api.tests_floor_plan_pdf import _Base

SVG = "{http://www.w3.org/2000/svg}"


def _png(w=400, h=200, colour=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, format="PNG")
    return buf.getvalue()


def _plan_svg(x, y, w, h) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {w} {h}" width="{w}" '
        f'height="{h}"><rect x="{x}" y="{y}" width="40" height="40" fill="#2563eb"/></svg>'
    )


C = cp.CELL
#: The owner's site plan: 512 × 266 cells of 1187 mm, A4 landscape.
SITE = cp.Box(0, 0, 512 * C, 266 * C)


def _end(x, y, name="", w=1.0, h=1.0):
    """An end tile at cell (x, y), in plan px with its name."""
    return (x * C, y * C, (x + w) * C, (y + h) * C, name)


def _site_geometry():
    """Three rooms of equipment far apart on the site plan, cables within
    each, and one long cable from room 1 to room 3 along a tray."""
    r1 = [_end(40, 40, "core1"), _end(43, 40, "asw1"), _end(46, 41, "fw1")]
    r2 = [_end(300, 200, "srv1"), _end(304, 202, "srv2")]
    r3 = [_end(470, 30, "edge1")]
    tray = [(41 * C, 39 * C), (250 * C, 39 * C), (250 * C, 31 * C), (470 * C, 31 * C)]
    return {
        "a": {"lines": [], "boxes": [e[:4] for e in r1[:2]], "ends": r1[:2]},
        "b": {"lines": [], "boxes": [e[:4] for e in r1[1:]], "ends": r1[1:]},
        "c": {"lines": [], "boxes": [e[:4] for e in r2], "ends": r2},
        "long": {"lines": [tray], "boxes": [r1[0][:4], r3[0][:4]],
                 "ends": [r1[0], r3[0]]},
    }


def _layout(geometry, *, mode="auto", px_per_cell=None, content=SITE, paper="a4", cap=20):
    _o, w, h = cp.closeup_mm(paper, "landscape")
    overview = cp.fit_scale(content, *cp.thumb_mm(paper, "landscape"))
    return cp.closeup_layout(geometry, content=content, grid=SITE, page_mm=(w, h),
                             overview_mm_per_px=overview, mode=mode,
                             px_per_cell=px_per_cell, cap=cap)


class LayoutTests(SimpleTestCase):
    def test_row_letters(self):
        self.assertEqual([cp.row_letters(i) for i in (0, 1, 25, 26, 27)],
                         ["A", "B", "Z", "AA", "AB"])

    def assert_sound(self, pages, geometry, lo, hi):
        ends = {e[:4] for g in geometry.values() for e in g["ends"]}
        for p in pages:
            # Every close-up holds a cable end, and prints within the clamps.
            self.assertTrue(p.ends, p.label)
            self.assertTrue(any(e.box in ends for e in p.ends))
            self.assertLessEqual(p.mm_per_px, hi + 1e-9)
            # Inside the plan.
            self.assertGreaterEqual(p.box.x, SITE.x - 1e-6)
            self.assertGreaterEqual(p.box.y, SITE.y - 1e-6)
            self.assertLessEqual(p.box.x2, SITE.x2 + 1e-6)
            self.assertLessEqual(p.box.y2, SITE.y2 + 1e-6)
            for e in p.ends:
                self.assertTrue(p.box.x <= e.box[0] and e.box[2] <= p.box.x2)
                self.assertTrue(p.box.y <= e.box[1] and e.box[3] <= p.box.y2)
        # Frames never overlap.
        for i, a in enumerate(pages):
            for b in pages[i + 1:]:
                self.assertFalse(cp.overlaps(a.box, b.box), (a.label, b.label))

    def test_one_close_up_per_cluster_of_connected_equipment(self):
        geo = _site_geometry()
        pages, dropped = _layout(geo)
        self.assertEqual(dropped, 0)
        # Three rooms, three close-ups - none for the tray run between them.
        self.assertEqual(len(pages), 3)
        self.assertEqual([p.label for p in pages], ["A", "B", "C"])
        by = {tuple(sorted(n for e in p.ends for n in e.names)): p for p in pages}
        self.assertEqual(sorted(by), [("asw1", "core1", "fw1"), ("edge1",), ("srv1", "srv2")])
        lo, hi = cp.scale_limits(None)
        self.assert_sound(pages, geo, lo, hi)
        # Small clusters print at the readable floor or larger.
        for p in pages:
            self.assertGreaterEqual(p.mm_per_px, lo - 1e-9)
        # The long cable is listed where its ends are; room 2 has only its own.
        self.assertEqual(by[("asw1", "core1", "fw1")].cables, ["a", "b", "long"])
        self.assertEqual(by[("edge1",)].cables, ["long"])
        self.assertEqual(by[("srv1", "srv2")].cables, ["c"])

    def test_a_coarse_raster_holds_the_scale_at_the_readable_floor(self):
        # 3.5 image px a cell: past 1.5 × its native size by 1.4 mm a cell,
        # under the 3 mm floor - the floor wins.
        lo, hi = cp.scale_limits(3.5)
        self.assertAlmostEqual(hi * C, cp.CLOSEUP_MIN_CELL_MM)
        pages, _ = _layout(_site_geometry(), px_per_cell=3.5)
        for p in pages:
            self.assertAlmostEqual(p.mm_per_px, lo)

    def test_a_fine_raster_caps_the_magnification(self):
        # 20 image px a cell: at most 20 × 0.265 × 1.5 = 7.9 mm a cell.
        lo, hi = cp.scale_limits(20)
        self.assertAlmostEqual(hi * C, 20 * 25.4 / 96 * 1.5)
        geo = {"x": {"lines": [], "boxes": [], "ends": [_end(100, 100, "solo")]}}
        (page,), _ = _layout(geo, px_per_cell=20)
        self.assertAlmostEqual(page.mm_per_px, hi)
        # No raster: the overall ceiling.
        (page,), _ = _layout(geo)
        self.assertAlmostEqual(page.mm_per_px * C, cp.CLOSEUP_MAX_CELL_MM)

    def test_a_wide_cluster_prints_smaller_to_fit(self):
        # A row of racks 150 cells long, linked end to end.
        ends = [_end(20 + i * 10, 100, f"r{i}") for i in range(16)]
        geo = {f"c{i}": {"lines": [], "boxes": [], "ends": [ends[i], ends[i + 1]]}
               for i in range(15)}
        (page,), _ = _layout(geo, px_per_cell=3.5)
        lo, _hi = cp.scale_limits(3.5)
        self.assertLess(page.mm_per_px, lo)
        self.assertEqual(len(page.ends), 16)

    def test_clusters_whose_frames_would_overlap_merge(self):
        # Two groups 40 cells apart: apart for the clustering, but a page
        # at the floor spans 91 cells, so their frames would overlap.
        geo = {
            "a": {"lines": [], "boxes": [], "ends": [_end(100, 100, "a1"), _end(101, 100)]},
            "b": {"lines": [], "boxes": [], "ends": [_end(141, 100, "b1"), _end(142, 100)]},
        }
        pages, _ = _layout(geo, px_per_cell=3.5)
        self.assertEqual(len(pages), 1)
        self.assertEqual(len(pages[0].ends), 4)

    def test_frames_stay_inside_the_plan(self):
        geo = {"x": {"lines": [], "boxes": [], "ends": [_end(0, 0, "corner")]},
               "y": {"lines": [], "boxes": [], "ends": [_end(511, 265, "far")]}}
        pages, _ = _layout(geo, px_per_cell=3.5)
        self.assertEqual(len(pages), 2)
        self.assert_sound(pages, geo, *cp.scale_limits(3.5))
        self.assertEqual((pages[0].box.x, pages[0].box.y), (0, 0))

    def test_when_close_ups_are_wanted(self):
        geo = _site_geometry()
        self.assertEqual(_layout(geo, mode="off"), ([], 0))
        # A small plan whose overview reads, one cluster: none in auto.
        small = cp.Box(0, 0, 60 * C, 30 * C)
        one = {"a": geo["a"]}
        self.assertEqual(_layout(one, content=small)[0], [])
        # `on`: whenever the close-up prints larger than the overview.
        self.assertEqual(len(_layout(one, content=small, mode="on")[0]), 1)
        # No cable ends: none.
        self.assertEqual(_layout({"x": {"lines": [[(0, 0), (900, 900)]], "boxes": [],
                                        "ends": []}}), ([], 0))

    def test_over_the_cap_the_busiest_are_kept(self):
        geo = {}
        for i in range(5):
            ends = [_end(20 + i * 100, 100, f"d{i}-{j}") for j in range(1)]
            for k in range(i + 1):
                geo[f"c{i}-{k}"] = {"lines": [], "boxes": [], "ends": ends}
        pages, dropped = _layout(geo, cap=2)
        self.assertEqual(dropped, 3)
        self.assertEqual(sorted(e.names[0] for p in pages for e in p.ends),
                         ["d3-0", "d4-0"])

    def test_end_names_are_drawn_in_paper_mm(self):
        geo = _site_geometry()
        pages, _ = _layout(geo, px_per_cell=3.5)
        room1 = next(p for p in pages if any("core1" in e.names for e in p.ends))
        svg = etree.fromstring(cp.compose(None, room1.box, grid=(SITE.w, SITE.h),
                                          ends=room1.ends, mm_per_px=room1.mm_per_px))
        texts = [t for t in svg.iter(f"{SVG}text") if t.get("stroke") is None]
        self.assertEqual(sorted(t.text for t in texts), ["asw1", "core1", "fw1"])
        size_mm = float(texts[0].get("font-size")) * room1.mm_per_px
        self.assertAlmostEqual(size_mm, cp.END_FONT_MM, places=4)
        outlines = list(svg.iter(f"{SVG}rect"))[1:]
        self.assertEqual(len(outlines), 3)


    def test_an_oversized_image_is_brought_under_the_cap(self):
        noisy = Image.effect_noise((2400, 2400), 120).convert("RGB")
        href = cp.encode(noisy, "PNG")
        payload = href.split(",", 1)[1]
        self.assertLessEqual(len(payload) * 3 // 4, MAX_IMAGE_BYTES)
        self.assertTrue(href.startswith("data:image/jpeg;base64,"))


class _Plan(_Base):
    def setUp(self):
        super().setUp()
        # 24 × 16 cells, the image 480 × 320: 20 image px per cell.
        self.plan.background_image.save("bp.png", ContentFile(_png(480, 320)), save=False)
        self.plan.background_opacity = 40
        self.plan.save()

    def capture(self, body, plan=None):
        with mock.patch.object(cable_schedule, "run_with_deadline",
                               return_value=b"%PDF-1.7 fake") as render:
            r = self.client.post(
                f"/api/floor-plans/{(plan or self.plan).pk}/cable-schedule/pdf/", body,
                format="json",
            )
        self.assertEqual(r.status_code, 200, r.content[:300])
        render.assert_called_once()
        args, kwargs = render.call_args
        return args[1], kwargs


class BackgroundTests(_Plan):
    def image(self, svg: bytes):
        root = etree.fromstring(svg)
        imgs = [el for el in root.iter(f"{SVG}image") if el.get("href", "").startswith("data:")]
        self.assertEqual(len(imgs), 1)
        el = imgs[0]
        raw = el.get("href").split(",", 1)[1]
        import base64

        size = Image.open(io.BytesIO(base64.b64decode(raw))).size
        return el, size

    def test_the_background_is_cut_to_the_framed_box(self):
        # Framed to cells 2..12 × 3..9 (px 80..480 × 120..360).
        svg, _kw = self.capture({"svg": _plan_svg(80, 120, 400, 240)})
        el, size = self.image(svg)
        self.assertEqual([el.get(k) for k in ("x", "y", "width", "height")],
                         ["80", "120", "400", "240"])
        self.assertEqual(el.get("opacity"), "0.4")
        # 10 × 6 cells at 20 image px per cell, no larger.
        self.assertLessEqual(size[0], 200)
        self.assertAlmostEqual(size[0] / size[1], 200 / 120, places=1)

    def test_a_box_past_the_grid_is_clipped_to_the_image(self):
        svg, _kw = self.capture({"svg": _plan_svg(-80, -40, 400, 200)})
        el, _size = self.image(svg)
        self.assertEqual([el.get(k) for k in ("x", "y", "width", "height")],
                         ["0", "0", "320", "160"])

    def test_a_live_view_cuts_its_part_of_the_source_image(self):
        view = FloorPlan.objects.create(
            tenant=self.tenant, location=self.plan.location, name="View", kind="view",
            source=self.plan, crop={"x": 12, "y": 8, "w": 12, "h": 8},
        )
        bg = cp.Background(self.plan, Crop(12, 8, 12, 8), 40)
        el = bg.element(cp.Box(0, 0, 12 * 40, 8 * 40), 0.5)
        self.assertEqual([el.get(k) for k in ("x", "y", "width", "height")],
                         ["0", "0", "480", "320"])
        # Through the endpoint too.
        svg, _kw = self.capture({"svg": _plan_svg(0, 0, 480, 320)}, plan=view)
        el, size = self.image(svg)
        self.assertEqual(el.get("width"), "480")
        self.assertLessEqual(size[0], 240)

    def test_the_cad_drawing_goes_under_the_plan(self):
        self._drawing()
        svg, kw = self.capture({"svg": _plan_svg(0, 0, 960, 640)})
        root = etree.fromstring(svg)
        # Paper, background, the clipped CAD frame, then the posted plan.
        kinds = [etree.QName(el).localname for el in root]
        self.assertEqual(kinds[:4], ["rect", "image", "svg", "g"])
        self.assertTrue(len(root[2]) and len(list(root[2].iter())) > 3)
        self.assertIn("Drawing: hall-a.dxf", kw["caption"])

    def test_no_svg_no_plan(self):
        svg, kw = self.capture({})
        self.assertEqual(svg, b"")
        self.assertFalse(kw["thumbnail"])


class _Big(_Plan):
    """The owner's site plan: 512 × 266 cells of 1187 mm under a coarse map
    image (3.5 px a cell), three rooms of racks far apart, cables within
    each and one long run from room 1 to room 3 along a tray."""

    def setUp(self):
        super().setUp()
        self.plan.background_image.save("map.png", ContentFile(_png(1792, 931)), save=False)
        self.plan.grid_width, self.plan.grid_height, self.plan.cell_mm = 512, 266, 1187
        self.plan.save()
        site = self.plan.location.site
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        dtype = DeviceType.objects.create(tenant=self.tenant, name="1U", u_height=1)
        self.iface = {}
        for name, x, y in (("core1", 40, 40), ("asw1", 43, 40), ("srv1", 300, 200),
                           ("srv2", 304, 202), ("edge1", 470, 30)):
            rack = Rack.objects.create(tenant=self.tenant, site=site, name=f"R-{name}",
                                       u_height=42)
            FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=tt, x=x, y=y,
                                         rack=rack, link_kind="rack")
            dev = Device.objects.create(tenant=self.tenant, name=name, site=site, rack=rack,
                                        device_type=dtype, position=40)
            self.iface[name] = [Interface.objects.create(device=dev, name=f"e{i}")
                                for i in range(2)]
        FloorPlanTray.objects.create(floor_plan=self.plan, name="T",
                                     points=[[41, 39], [250, 39], [250, 31], [470, 31]])
        self.cables = {}
        for label, a, b in (("UP", ("core1", 0), ("asw1", 0)),
                            ("SRV", ("srv1", 0), ("srv2", 0)),
                            ("LONG", ("core1", 1), ("edge1", 0))):
            c = Cable.objects.create(tenant=self.tenant, label=label)
            for end, (dev, i) in zip("AB", (a, b), strict=True):
                CableTermination.objects.create(cable=c, end=end, interface=self.iface[dev][i])
            self.cables[label] = str(c.pk)
        self.content = (0, 0, 512 * 40, 266 * 40)

    def layout(self, **params):
        q = {"box": ",".join(str(v) for v in self.content), **params}
        r = self.client.get(f"/api/floor-plans/{self.plan.pk}/cable-schedule/closeups/", q)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def body(self, layout=None, **extra):
        pages = (layout or self.layout())["pages"]
        return {"svg": _plan_svg(*self.content),
                "closeup_svgs": {p["label"]: _plan_svg(*p["box"]) for p in pages}, **extra}


class CloseupTests(_Big):
    def test_a_close_up_per_cluster_of_connected_equipment(self):
        layout = self.layout()
        pages = layout["pages"]
        # Three rooms, three close-ups; the long run between them is not one.
        self.assertEqual([p["label"] for p in pages], ["A", "B", "C"])
        lo = cp.CLOSEUP_MIN_CELL_MM / 40
        boxes = [cp.Box(*p["box"]) for p in pages]
        for p, b in zip(pages, boxes, strict=True):
            # The map is coarse: held at the readable floor, not magnified more.
            self.assertAlmostEqual(p["mm_per_px"], lo)
            self.assertGreaterEqual(p["cables"], 1)
            self.assertTrue(b.x >= 0 and b.y >= 0 and b.x2 <= 512 * 40 and b.y2 <= 266 * 40)
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                self.assertFalse(cp.overlaps(a, b))

    def test_the_pdf_draws_each_close_up_at_its_scale(self):
        layout = self.layout()
        svg, kw = self.capture(self.body(layout))
        by_label = {c["label"]: c for c in kw["closeups"]}
        self.assertEqual(sorted(by_label), ["A", "B", "C"])
        rows = sorted(sorted(c["rows"]) for c in kw["closeups"])
        self.assertIn(sorted([self.cables["UP"], self.cables["LONG"]]), rows)
        self.assertIn([self.cables["SRV"]], rows)
        self.assertIn([self.cables["LONG"]], rows)
        for p in layout["pages"]:
            c = by_label[p["label"]]
            page = etree.fromstring(kw["pages"][c["url"]])
            for got, want in zip(page.get("viewBox").split(), p["box"], strict=True):
                self.assertAlmostEqual(float(got), want, delta=0.5)
            # Printed at its own scale, a cell 3 mm: 1:400 for 1187 mm cells.
            self.assertAlmostEqual(c["width_mm"], p["box"][2] * p["mm_per_px"])
            self.assertEqual(c["ratio"], 400)
            # The background cut, the posted drawing used, the ends named.
            raw = kw["pages"][c["url"]]
            self.assertIn(b"data:image/", raw)
            self.assertIn(b"#2563eb", raw)
            texts = {t.text for t in page.iter(f"{SVG}text")}
            self.assertTrue(texts & {"core1", "asw1", "srv1", "srv2", "edge1"})
        # The overview carries a labelled frame for each.
        texts = [t.text for t in etree.fromstring(svg).iter(f"{SVG}text")]
        for lb in by_label:
            self.assertIn(lb, texts)
        self.assertEqual(kw["closeup_note"], "")

    def test_a_drawing_for_another_box_is_left_out(self):
        layout = self.layout()
        body = self.body(layout)
        body["closeup_svgs"]["A"] = _plan_svg(0, 0, 400, 200)
        _svg, kw = self.capture(body)
        a = next(c for c in kw["closeups"] if c["label"] == "A")
        raw = kw["pages"][a["url"]]
        self.assertNotIn(b"#2563eb", raw)
        self.assertIn(b"data:image/", raw)

    def test_hidden_devices_are_not_named(self):
        member = self._member("viewer", "floorplan", "floorplantile", "floorplancablepath",
                              "cable")
        self._login(member)
        layout = self.layout()
        _svg, kw = self.capture(self.body(layout))
        self.assertTrue(kw["closeups"])
        for c in kw["closeups"]:
            texts = {t.text for t in etree.fromstring(kw["pages"][c["url"]])
                     .iter(f"{SVG}text")}
            self.assertFalse(texts & {"core1", "asw1", "srv1", "srv2", "edge1"})

    def test_too_many_close_up_drawings_are_refused(self):
        body = {"svg": _plan_svg(*self.content),
                "closeup_svgs": {f"X{i}": _plan_svg(0, 0, 40, 40) for i in range(21)}}
        r = self.client.post(f"/api/floor-plans/{self.plan.pk}/cable-schedule/pdf/", body,
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_bad_box_is_refused(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.pk}/cable-schedule/closeups/",
                            {"box": "0,0,nan,5"})
        self.assertEqual(r.status_code, 400)

    def test_off_and_a_small_plan_have_none(self):
        self.assertEqual(self.layout(closeups="off")["pages"], [])
        _svg, kw = self.capture(self.body(closeups="off"))
        self.assertEqual(kw["closeups"], [])

    def test_the_table_names_the_detail_pages(self):
        data = cable_schedule.build(self.plan, None, self.admin, self.tenant)
        import datetime as dt

        long_id = self.cables["LONG"]
        html = cable_schedule.sheet_html(
            data, title="Big", subtitle="", generated=dt.datetime(2026, 10, 31, tzinfo=dt.UTC),
            paper="a4", orientation="landscape", thumbnail=True,
            closeups=[{"label": "A", "url": "https://danbyte.invalid/_/closeup-A.svg",
                       "rows": [long_id], "width_mm": 200, "height_mm": 80, "ratio": 400},
                      {"label": "C", "url": "https://danbyte.invalid/_/closeup-C.svg",
                       "rows": [long_id]}],
            closeup_note="2 close-ups of the busiest parts; 1 more part with cables not shown",
        )
        self.assertIn("<th>Detail</th>", html)
        self.assertIn("<td class='ref'>A, C</td>", html)
        self.assertIn("Detail A", html)
        self.assertIn("· 1:400", html)
        self.assertIn("width:200.000mm;height:80.000mm", html)
        self.assertIn("closeup-C.svg", html)
        self.assertIn("1 more part", html)

    def test_renders_a_pdf_with_close_ups(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.pk}/cable-schedule/pdf/",
                             self.body(), format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF"))
        # The overview page, a page per close-up, then the tables.
        pages = len(re.findall(rb"/MediaBox", _pdf_objects(r.content)))
        self.assertGreaterEqual(pages, 5)

