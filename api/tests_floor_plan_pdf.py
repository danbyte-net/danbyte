"""Floor plan PDFs: ``POST /api/floor-plans/{id}/export/pdf/`` - who may call
it and in which tenant, the sanitiser on the posted plan, the CAD drawing
laid under it in vector (hidden layers left out, colours for paper, framed
by its placement), the footer the server writes (title block, scale bar,
legend, credit line), the paper, print links and a real render."""

from __future__ import annotations

import os
import shutil
import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from lxml import etree
from rest_framework.test import APITestCase

from api import drawing_pdf
from api import floor_plan_pdf as fp
from api import tests_cad_fixtures as fx
from api.models import FloorPlan, FloorPlanDrawing, Location, Site
from api.tests_elevation_pdf import _page_mm, _pdf_objects
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

User = get_user_model()
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
MEDIA = tempfile.mkdtemp(prefix="danbyte-fp-pdf-test-")
SVG = "{http://www.w3.org/2000/svg}"

PLAN = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 640" width="960" '
    'height="640" font-family="Inter, sans-serif">'
    '<g transform="translate(80,80)"><rect x="2" y="2" width="36" height="76" '
    'fill="#2563eb" fill-opacity="0.26"/><text x="20" y="44" font-size="11" '
    'fill="#18181b">R01</text></g></svg>'
)


class _InlineQueue:
    def enqueue(self, fn, *args, **kwargs):
        fn(*args)


@override_settings(CACHES=LOCMEM, MEDIA_ROOT=MEDIA, DANBYTE_CAD_CONVERTER="")
class _Base(APITestCase):
    fake = mock.patch.object(fp, "render_with_deadline", return_value=b"%PDF-1.7 fake")

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        cache.clear()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Globex", slug="globex")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        hall = Location.objects.create(tenant=self.tenant, site=site, name="Hall A",
                                       slug="hall-a")
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=hall, name="Ground", grid_width=24,
            grid_height=16, cell_mm=600,
        )
        theirs = Site.objects.create(tenant=self.other, name="LON")
        their_loc = Location.objects.create(tenant=self.other, site=theirs, name="B", slug="b")
        self.their_plan = FloorPlan.objects.create(
            tenant=self.other, location=their_loc, name="Theirs"
        )
        q = mock.patch("django_rq.get_queue", return_value=_InlineQueue())
        q.start()
        self.addCleanup(q.stop)

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def _member(self, name, *types):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        if types:
            p = ObjectPermission.objects.create(
                name=f"{name}-perm", object_types=list(types), actions=["view"]
            )
            p.users.add(u)
        return u

    def _post(self, plan=None, body=None, query=""):
        payload = {"svg": PLAN, **(body or {})}
        return self.client.post(
            f"/api/floor-plans/{(plan or self.plan).pk}/export/pdf/{query}", payload,
            format="json",
        )

    def _drawing(self, data: bytes | None = None) -> FloorPlanDrawing:
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                f"/api/floor-plans/{self.plan.pk}/drawing/",
                {"file": SimpleUploadedFile("hall-a.dxf", data or fx.floor_dxf())},
                format="multipart",
            )
        self.assertEqual(r.status_code, 202, r.content)
        d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
        self.assertEqual(d.status, "ready", d.error)
        return d


class AccessTests(_Base):
    def test_anonymous_refused(self):
        self.client.logout()
        self.assertIn(self._post().status_code, (401, 403))

    def test_another_tenants_plan_is_not_found(self):
        with self.fake as render:
            r = self._post(self.their_plan)
        self.assertEqual(r.status_code, 404, r.content)
        render.assert_not_called()

    def test_a_superuser_in_the_other_tenant_cannot_reach_it(self):
        self._login(self.admin, self.other)
        with self.fake as render:
            self.assertEqual(self._post().status_code, 404)
        render.assert_not_called()

    def test_floorplan_view_required(self):
        self._login(self._member("racks-only", "rack", "site"))
        with self.fake as render:
            r = self._post()
        self.assertEqual(r.status_code, 403, r.content)
        render.assert_not_called()

    def test_view_is_enough(self):
        self._login(self._member("viewer", "floorplan"))
        with self.fake:
            r = self._post()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.content, b"%PDF-1.7 fake")
        self.assertRegex(
            r["Content-Disposition"], r'^attachment; filename="ground-\d{4}-\d{2}-\d{2}\.pdf"$'
        )

    def test_print_link_is_for_the_same_user_tenant_and_plan(self):
        with self.fake:
            r = self._post(query="?print=1")
        self.assertEqual(r.status_code, 200, r.content)
        link = r.json()["url"]
        self.assertRegex(
            link, rf"^/api/floor-plans/{self.plan.pk}/export/pdf/[A-Za-z0-9_-]{{24,64}}/$"
        )
        got = self.client.get(link)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 fake")
        self.assertTrue(got["Content-Disposition"].startswith("inline; "))
        token = link.rstrip("/").rsplit("/", 1)[1]
        self.assertEqual(
            self.client.get(f"/api/floor-plans/{self.their_plan.pk}/export/pdf/{token}/")
            .status_code, 404,
        )
        self._login(self._member("peer", "floorplan"))
        self.assertEqual(self.client.get(link).status_code, 404)
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(link).status_code, 404)


class SheetTests(_Base):
    def test_the_footer_comes_from_the_plan(self):
        with self.fake as render:
            r = self._post(body={
                "title": "Forged",
                "legend": {"title": "Space · units used",
                           "items": [{"label": "≤ 80% (3)", "color": "#22c55e"},
                                     {"label": "No data (1)", "color": "a1a1aa"}]},
            })
        self.assertEqual(r.status_code, 200, r.content)
        kw = render.call_args.kwargs
        self.assertEqual(kw["title"], "Ground")
        self.assertEqual(kw["subtitle"], "Hall A · AMS · Acme")
        self.assertEqual(kw["credit"], "")
        self.assertEqual(kw["legend"]["items"][1]["color"], "#a1a1aa")
        # A3 landscape by default; 24 x 16 cells of 600 mm.
        self.assertEqual(kw["sheet"]["page"], (420.0, 297.0))
        self.assertTrue(kw["bar"]["label"].endswith("m"))
        self.assertTrue(kw["bar"]["ratio"].startswith("1:"))

    def test_the_paper(self):
        with self.fake as render:
            self._post(body={"paper": {"size": "a4", "orientation": "portrait"},
                             "title_block": False})
            kw = render.call_args.kwargs
            self.assertEqual(kw["sheet"]["page"], (210.0, 297.0))
            self.assertFalse(kw["title_block"])
            for paper in ({"size": "a0"}, {"orientation": "sideways"}):
                with self.subTest(paper=paper):
                    self.assertEqual(self._post(body={"paper": paper}).status_code, 400)

    def test_a_bad_legend_is_refused(self):
        for legend in (
            {"items": [{"label": "x", "color": "red"}]},
            {"items": [{"label": "x", "color": "#12345"}]},
            {"items": [{"label": "x" * 81, "color": "#123456"}]},
            {"items": [{"label": "x", "color": "#123456"}] * 25},
        ):
            with self.subTest(legend=str(legend)[:40]), self.fake as render:
                self.assertEqual(self._post(body={"legend": legend}).status_code, 400)
                render.assert_not_called()

    def test_the_sanitiser_is_applied(self):
        hostile = PLAN.replace(
            "<rect ",
            '<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/'
            'xhtml">x</div></foreignObject><image href="file:///etc/passwd" width="5" '
            'height="5"/><rect onload="alert(2)" style="fill:red" ',
        )
        with self.fake as render:
            r = self._post(body={"svg": hostile})
        self.assertEqual(r.status_code, 200, r.content)
        svg = render.call_args.args[0]
        for gone in (b"script", b"alert", b"foreignObject", b"passwd", b"style="):
            self.assertNotIn(gone, svg)
        self.assertIn(b"R01", svg)
        with self.fake as render:
            for bad in ("<!DOCTYPE svg><svg/>", "<html/>", "not xml", ""):
                with self.subTest(bad=bad[:12]):
                    self.assertEqual(self._post(body={"svg": bad}).status_code, 400)
        render.assert_not_called()

    def test_caps_and_locks(self):
        with self.fake, mock.patch.object(fp, "MAX_BODY_BYTES", 100):
            self.assertEqual(self._post().status_code, 413)
        with mock.patch.object(fp, "render_with_deadline",
                               side_effect=drawing_pdf.RenderTimeout):
            r = self._post()
        self.assertEqual(r.status_code, 413)
        cache.add(f"topology-pdf-busy:{self.admin.pk}", 1, 60)
        with self.fake as render:
            self.assertEqual(self._post().status_code, 429)
        render.assert_not_called()


class DrawingTests(_Base):
    def _composed(self, body=None) -> tuple[etree._Element, dict]:
        with self.fake as render:
            r = self._post(body=body)
        self.assertEqual(r.status_code, 200, r.content)
        return etree.fromstring(render.call_args.args[0]), render.call_args.kwargs

    def test_the_drawing_goes_under_the_plan_in_vector(self):
        d = self._drawing()
        d.placement = {**d.placement, "hidden_layers": ["DIMS", "GRID-OFF", "FROZEN"],
                       "x_mm": 600, "opacity": 80}
        d.save()
        root, kw = self._composed()
        self.assertEqual(kw["credit"], "Drawing: hall-a.dxf")
        self.assertEqual(root.get("viewBox"), "0 0 960 640")
        frames = root.findall(f"{SVG}svg")
        self.assertEqual(len(frames), 2)
        cad, plan = frames
        g = cad.find(f"{SVG}g")
        self.assertEqual(
            g.get("transform"),
            f"scale({fp._fmt(40 / 600)}) {fp.cad_render.transform_mm(d)}",
        )
        self.assertEqual(g.get("opacity"), "0.8")
        markup = etree.tostring(cad)
        # Vector paths, hidden layers left out, nothing that references.
        self.assertIn(b"<path", markup)
        self.assertNotIn(b"data-layer", markup)
        self.assertNotIn(b"currentColor", markup)
        self.assertIn(b"Server room", markup)
        # The plan's own drawing sits on top.
        self.assertIn(b"R01", etree.tostring(plan))
        # Wall red reads on white as it is; the default colour is ink.
        strokes = {p.get("stroke") for p in cad.iter(f"{SVG}path")}
        self.assertIn("#ff0000", strokes)
        self.assertIn(fp.INK, {t.get("fill") for t in cad.iter(f"{SVG}text")})

    def test_hidden_layers_and_text_stay_hidden(self):
        d = self._drawing()
        d.placement = {**d.placement, "hidden_layers": ["WALLS"], "hide_text": True}
        d.save()
        root, _ = self._composed()
        cad = root.findall(f"{SVG}svg")[0]
        # Text off, as on the canvas: the text groups go (a dimension keeps
        # its figure, as it does on screen).
        words = {"".join(t.itertext()) for t in cad.iter(f"{SVG}text")}
        self.assertNotIn("Server room", words)
        self.assertNotIn("Cold aisle", words)
        self.assertNotIn("#ff0000", {p.get("stroke") for p in cad.iter(f"{SVG}path")})

    def test_without_the_drawing(self):
        self._drawing()
        root, kw = self._composed({"drawing": False})
        self.assertEqual(len(root.findall(f"{SVG}svg")), 1)
        self.assertEqual(kw["credit"], "")

    def test_a_drawing_still_processing_is_left_out(self):
        d = self._drawing()
        FloorPlanDrawing.objects.filter(pk=d.pk).update(status="queued")
        root, kw = self._composed()
        self.assertEqual(len(root.findall(f"{SVG}svg")), 1)

    def test_a_tampered_drawing_file_is_sanitised_again(self):
        d = self._drawing()
        path = os.path.join(MEDIA, d.rendered.name)
        with open(path, "rb") as fh:
            raw = fh.read()
        with open(path, "wb") as fh:
            fh.write(raw.replace(b"</svg>", b'<script>alert(1)</script><image href='
                                 b'"file:///etc/passwd"/></svg>'))
        root, _ = self._composed()
        markup = etree.tostring(root)
        self.assertNotIn(b"script", markup)
        self.assertNotIn(b"passwd", markup)

    def test_a_drawing_too_large_for_paper_is_refused(self):
        self._drawing()
        with self.fake as render, mock.patch.object(fp, "CAD_MAX_ELEMENTS", 5):
            r = self._post()
        self.assertEqual(r.status_code, 413, r.content)
        self.assertIn("too large", r.json()["detail"])
        render.assert_not_called()

    def test_too_much_text_leaves_the_text_out(self):
        self._drawing()
        with mock.patch.object(fp, "CAD_MAX_TEXT_CHARS", 5):
            root, kw = self._composed()
        self.assertEqual(list(root.findall(f"{SVG}svg")[0].iter(f"{SVG}text")), [])
        # The credit line says so, on the sheet.
        self.assertEqual(kw["credit"], "Drawing: hall-a.dxf · text left out")

    def test_another_tenants_drawing_is_never_read(self):
        # A drawing row pointing at this plan but filed in another tenant.
        d = self._drawing()
        FloorPlanDrawing.objects.filter(pk=d.pk).update(tenant=self.other)
        root, kw = self._composed()
        self.assertEqual(len(root.findall(f"{SVG}svg")), 1)
        self.assertEqual(kw["credit"], "")

    def test_a_real_render(self):
        self._drawing()
        r = self._post(body={"legend": {"title": "Status",
                                        "items": [{"label": "Active", "color": "#22c55e"}]}})
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF-"))
        objects = _pdf_objects(r.content)
        self.assertIn(b"/Title (Ground)", objects)
        self.assertEqual(_page_mm(r.content), (420, 297))


class HelperTests(SimpleTestCase):
    def test_contrast_safe_darkens_faint_colours_keeping_the_hue(self):
        self.assertEqual(fp.contrast_safe("#FF0000"), "#ff0000")
        out = fp.contrast_safe("#ffff00")
        self.assertNotEqual(out, "#ffff00")
        self.assertGreaterEqual(
            fp.contrast(fp._rgb(out), fp._rgb(fp.PAPER)), fp.MIN_CONTRAST - 0.01
        )
        r, g, b = fp._rgb(out)
        self.assertAlmostEqual(r, g, places=1)
        self.assertLess(b, 0.05)
        self.assertEqual(fp.contrast_safe("none"), "none")

    def test_scale_bar(self):
        # 1:100 - a millimetre of paper is 100 mm: 4 m fits 40 mm, 5 m does not.
        bar = fp.scale_bar(0.01)
        self.assertEqual((bar["label"], bar["ratio"]), ("2 m", "1:100"))
        self.assertAlmostEqual(bar["mm"], 20)
        bar = fp.scale_bar(1 / 250)
        self.assertEqual((bar["label"], bar["ratio"]), ("10 m", "1:250"))

    def test_fit_to_page_enlarges_a_small_plan(self):
        sheet = fp.plan_sheet(100, 50, "a4", "landscape", True)
        self.assertGreater(sheet["scale"], 2)
        x, y, w, h = sheet["at"]
        self.assertAlmostEqual(w, 297 - 20)
