"""The cable schedule PDF's plan pages (``api/cable_schedule_plan.py``): the
background image and CAD drawing laid under the posted plan, cut to the
framed box (and a live view's crop), and the close-up pages tiling the
cabled parts of a big plan."""

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


class TilingTests(SimpleTestCase):
    def test_row_letters(self):
        self.assertEqual([cp.row_letters(i) for i in (0, 1, 25, 26, 27)],
                         ["A", "B", "Z", "AA", "AB"])

    def test_tiles_cover_the_content_centred(self):
        pages = cp.tiles(cp.Box(100, 50, 250, 90), 100, 60)
        self.assertEqual([p.label for p in pages], ["A1", "A2", "A3", "B1", "B2", "B3"])
        # 3 × 100 over 250 wide: 25 over each side; 2 × 60 over 90: 15.
        self.assertEqual((pages[0].box.x, pages[0].box.y), (75, 35))
        self.assertEqual((pages[-1].box.x2, pages[-1].box.y2), (375, 155))

    def test_a_tile_is_a_page_when_a_cable_crosses_it(self):
        geo = {
            # A route crossing A1 and A2 with no vertex in A2.
            "c1": {"lines": [[(10, 10), (190, 10)]], "boxes": []},
            # An end tile in B2 only.
            "c2": {"lines": [], "boxes": [(120, 70, 140, 90)]},
        }
        pages, dropped = cp.closeup_pages(cp.Box(0, 0, 200, 120), geo, 100, 60)
        self.assertEqual(dropped, 0)
        self.assertEqual({p.label: p.cables for p in pages},
                         {"A1": ["c1"], "A2": ["c1"], "B2": ["c2"]})

    def test_over_the_cap_the_busiest_are_kept_in_reading_order(self):
        geo = {
            "a": {"lines": [], "boxes": [(10, 10, 20, 20)]},
            "b": {"lines": [], "boxes": [(110, 10, 120, 20)]},
            "c": {"lines": [], "boxes": [(115, 15, 118, 18)]},
            "d": {"lines": [], "boxes": [(210, 10, 220, 20)]},
            "e": {"lines": [], "boxes": [(215, 15, 218, 18)]},
        }
        pages, dropped = cp.closeup_pages(cp.Box(0, 0, 300, 60), geo, 100, 60, cap=2)
        self.assertEqual([p.label for p in pages], ["A2", "A3"])
        self.assertEqual(dropped, 1)

    def test_when_close_ups_are_wanted(self):
        # mm per px × 40 px is the cell on paper.
        self.assertTrue(cp.wants_closeups("auto", 1.9 / 40))
        self.assertFalse(cp.wants_closeups("auto", 2.1 / 40))
        self.assertTrue(cp.wants_closeups("on", 4 / 40))
        self.assertFalse(cp.wants_closeups("on", 6 / 40))
        self.assertFalse(cp.wants_closeups("off", 0.1 / 40))

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
    """A wide plan (a cell prints under 2 mm on the overview) with racks at
    both ends and a cable between them through a tray."""

    def setUp(self):
        super().setUp()
        FloorPlan.objects.filter(pk=self.plan.pk).update(grid_width=300, grid_height=60)
        self.plan.refresh_from_db()
        site = self.plan.location.site
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        dtype = DeviceType.objects.create(tenant=self.tenant, name="1U", u_height=1)
        ends = []
        for i, x in enumerate((2, 290)):
            rack = Rack.objects.create(tenant=self.tenant, site=site, name=f"R{i}", u_height=42)
            FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=tt, x=x, y=10,
                                         rack=rack, link_kind="rack")
            dev = Device.objects.create(tenant=self.tenant, name=f"d{i}", site=site, rack=rack,
                                        device_type=dtype, position=40)
            ends.append(Interface.objects.create(device=dev, name="e1"))
        FloorPlanTray.objects.create(floor_plan=self.plan, name="T", points=[[2, 9], [291, 9]])
        self.cable = Cable.objects.create(tenant=self.tenant, label="LONG")
        for end, iface in zip("AB", ends, strict=True):
            CableTermination.objects.create(cable=self.cable, end=end, interface=iface)
        self.content = (0, 0, 300 * 40, 30 * 40)

    def body(self, **extra):
        return {"svg": _plan_svg(*self.content), "detail_svg": _plan_svg(*self.content),
                **extra}


class CloseupTests(_Big):
    def test_close_ups_tile_the_cabled_parts(self):
        svg, kw = self.capture(self.body())
        labels = [c["label"] for c in kw["closeups"]]
        self.assertTrue(labels)
        self.assertTrue(all(re.fullmatch(r"[A-Z]+\d+", lb) for lb in labels))
        for c in kw["closeups"]:
            self.assertEqual(c["rows"], [str(self.cable.pk)])
            page = etree.fromstring(kw["pages"][c["url"]])
            vb = [float(v) for v in page.get("viewBox").split()]
            # A cell 5 mm: the page's box is the close-up frame at 0.125 mm/px.
            _outer, w_mm, h_mm = cp.closeup_mm("a4", "landscape")
            self.assertAlmostEqual(vb[2], w_mm / cp.CLOSEUP_MM_PER_PX, places=3)
            self.assertAlmostEqual(vb[3], h_mm / cp.CLOSEUP_MM_PER_PX, places=3)
            # The background is cut for every close-up.
            self.assertIn(b"data:image/", kw["pages"][c["url"]])
        # The overview carries a labelled frame for each.
        texts = [t.text for t in etree.fromstring(svg).iter(f"{SVG}text")]
        for lb in labels:
            self.assertIn(lb, texts)
        self.assertEqual(kw["closeup_note"], "")

    def test_off_and_a_small_plan_have_none(self):
        _svg, kw = self.capture(self.body(closeups="off"))
        self.assertEqual(kw["closeups"], [])
        _svg, kw = self.capture({"svg": _plan_svg(0, 0, 400, 200),
                                 "detail_svg": _plan_svg(0, 0, 400, 200)})
        self.assertEqual(kw["closeups"], [])

    def test_the_table_names_the_detail_pages(self):
        data = cable_schedule.build(self.plan, None, self.admin, self.tenant)
        import datetime as dt

        html = cable_schedule.sheet_html(
            data, title="Big", subtitle="", generated=dt.datetime(2026, 10, 31, tzinfo=dt.UTC),
            paper="a4", orientation="landscape", thumbnail=True,
            closeups=[{"label": "A1", "url": "https://danbyte.invalid/_/closeup-A1.svg",
                       "rows": [str(self.cable.pk)]},
                      {"label": "A3", "url": "https://danbyte.invalid/_/closeup-A3.svg",
                       "rows": [str(self.cable.pk)]}],
            closeup_note="2 close-ups of the busiest parts; 1 more part with cables not shown",
        )
        self.assertIn("<th>Detail</th>", html)
        self.assertIn("<td class='ref'>A1, A3</td>", html)
        self.assertIn("Detail A1", html)
        self.assertIn("closeup-A3.svg", html)
        self.assertIn("1 more part", html)

    def test_renders_a_pdf_with_close_ups(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.pk}/cable-schedule/pdf/",
                             self.body(), format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF"))
        # The overview page, a page per close-up, then the tables.
        pages = len(re.findall(rb"/MediaBox", _pdf_objects(r.content)))
        self.assertGreaterEqual(pages, 3)
