"""The report cover page (``api/reports/cover.py``,
``api/report_background.py``): on and off in the object report, its text,
the logo and its fallback, the tenant's look reaching the render, the
coloured wave background (the default colours give the blue still, cached,
quick, small), the uploaded image (type, size, SVG sanitised,
tenant-scoped, tenant-admin only), and the page it adds."""

from __future__ import annotations

import io
import re
import shutil
import tempfile
import time
from pathlib import Path
from unittest import mock

import numpy as np
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from PIL import Image

from audit.models import ChangeLogEntry
from core.models import Tenant, TenantSettings

from . import object_report as rep
from . import report_background as rb
from .reports import cover as rc
from .tests_elevation_pdf import _pdf_objects
from .tests_object_report import _Report

COVER = "<section class='cover"


def _png(size=(40, 20), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (30, 120, 200)).save(buf, fmt)
    return buf.getvalue()


def _pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page(?![s\w])", _pdf_objects(pdf)))


def _cover_of(html: str) -> str:
    start = html.index(COVER)
    return html[start : html.index("</section>", start)]


class _Cover(_Report):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        media = override_settings(MEDIA_ROOT=self.media)
        media.enable()
        self.addCleanup(media.disable)

    def devices(self, **options):
        return self.ok("devices", {"filters": {}, "options": options})

    def look(self, **fields):
        TenantSettings.objects.update_or_create(tenant=self.tenant, defaults=fields)

    def upload(self, data, name="cover.png", content_type="image/png"):
        f = SimpleUploadedFile(name, data, content_type=content_type)
        return self.client.post(
            "/api/tenant-settings/report-cover/", {"image": f}, format="multipart"
        )


class CoverOnOffTests(_Cover):
    def test_off_by_default(self):
        html = self.devices()
        self.assertNotIn(COVER, html)
        self.assertNotIn("@page cover", html)

    def test_on(self):
        html = self.devices(cover=True, title="Leaf switches")
        self.assertIn(COVER, html)
        # Its own page: no running header or footer on it.
        self.assertRegex(html, r"@page cover\{[^}]*margin:0;@top-left\{content:none\}")
        cover = _cover_of(html)
        self.assertIn("<h1 class='cover-title'>Leaf switches</h1>", cover)
        self.assertIn(">Acme</p>", cover)  # the tenant line
        self.assertIn("Prepared by <b>admin</b>", cover)
        self.assertIn("2 devices", cover)  # the generated subtitle
        self.assertIn("Danbyte ", cover)
        # The heavy display title.
        self.assertRegex(html, r"h1\.cover-title\{font-size:\d+pt;font-weight:800;")
        self.assertLess(html.index(COVER), html.index("<header>"))

    def test_title_subtitle_and_project(self):
        html = self.devices(
            cover=True,
            cover_title="Q4 <audit>",
            cover_subtitle="",
            cover_project="Project Falcon",
            group_by="site",
        )
        self.assertIn("Q4 &lt;audit&gt;", html)
        self.assertIn("Project Falcon", html)
        self.assertNotIn("class='subtitle'", html)

    def test_generated_subtitle_names_the_grouping(self):
        self.assertIn("2 devices · Group by Site", self.devices(cover=True, group_by="site"))

    def test_full_name_and_date_format(self):
        self.admin.first_name, self.admin.last_name = "Ada", "Lovelace"
        self.admin.save()
        self.look(override_datetime=True, date_format="DD.MM.YYYY", display_timezone="UTC")
        html = self.devices(cover=True)
        self.assertIn("Prepared by <b>Ada Lovelace</b>", html)
        self.assertIn(timezone.now().strftime("%d.%m.%Y"), html)

    def test_bad_background_choice_is_refused(self):
        r, _ = self.html("devices", {"options": {"cover": True, "cover_background": "http://x"}})
        self.assertEqual(r.status_code, 400)


class LogoTests(_Cover):
    def test_the_white_wordmark_on_the_background(self):
        with mock.patch.object(rc, "_white_wordmark", return_value=b"WHITE"):
            html = self.devices(cover=True)
        self.assertIn("<div class='top'><img src='data:image/png;base64,V0hJVEU='", html)
        self.assertRegex(html, r"section\.cover \.top img\{height:7\.5mm;width:auto;")

    def test_the_colour_wordmark_on_paper(self):
        self.look(report_cover_style="none")
        with mock.patch("core.email.email_logo", return_value=(b"LOGO", "image/png")):
            html = self.devices(cover=True)
        self.assertIn("<div class='top'><img src='data:image/png;base64,TE9HTw=='", html)

    def test_an_uploaded_branding_logo_wins(self):
        with (
            mock.patch.object(rc, "has_branding_logo", return_value=True),
            mock.patch("core.email.email_logo", return_value=(b"LOGO", "image/png")),
        ):
            html = self.devices(cover=True)
        self.assertIn("base64,TE9HTw=='", html)

    def test_text_when_no_logo_can_be_read(self):
        self.look(report_cover_style="none")
        with mock.patch("core.email.email_logo", return_value=None):
            html = self.devices(cover=True)
        self.assertIn("<div class='top'><div class='word'>DANBYTE</div>", html)


class LookTests(_Cover):
    def test_waves_by_default_full_page_with_white_text(self):
        cover = _cover_of(self.devices(cover=True))
        self.assertIn("cover-waves dark", cover)
        self.assertIn("<img class='bg' src='data:image/jpeg;base64,", cover)

    def test_the_tenants_colours_reach_the_render(self):
        green = ("#14532d", "#16a34a", "#ffffff")
        self.look(report_cover_horizon=green[0], report_cover_wave=green[1])
        with mock.patch.object(rb, "waves", wraps=rb.waves) as drawn:
            self.devices(cover=True, orientation="portrait")
        drawn.assert_called_once_with(*rb.size_px(210, 297), *green)

    def test_plain_and_none(self):
        self.look(report_cover_style="plain", report_cover_horizon="#14532d")
        with mock.patch.object(rb, "plain", wraps=rb.plain) as drawn:
            cover = _cover_of(self.devices(cover=True, orientation="portrait"))
        drawn.assert_called_once_with(*rb.size_px(210, 297), "#14532d")
        self.assertIn("cover-plain dark", cover)
        cover = _cover_of(self.devices(cover=True, cover_background="none"))
        self.assertIn("cover-none'", cover)
        self.assertNotIn("class='bg'", cover)

    def test_a_report_may_pick_another_background(self):
        self.look(report_cover_style="none")
        self.assertIn("cover-waves dark", self.devices(cover=True, cover_background="waves"))

    def test_settings_validation(self):
        put = lambda body: self.client.put("/api/tenant-settings/", body, format="json")  # noqa: E731
        r = put({"report_cover_wave": "red"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("report_cover_wave", r.json())
        self.assertEqual(put({"report_cover_style": "zigzag"}).status_code, 400)
        r = put({"report_cover_style": "upload"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("report_cover_style", r.json())
        r = put({"report_cover_horizon": "#14532D", "report_cover_style": "plain"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["report_cover_horizon"], "#14532d")
        self.assertEqual(r.json()["report_cover_style"], "plain")

    def test_describe_tells_the_dialog(self):
        got = self.client.get("/api/devices/report/").json()["cover"]
        self.assertEqual(got, {"project": "Acme", "upload": False, "background": "waves"})


class BackgroundTests(SimpleTestCase):
    def test_the_default_colours_are_the_blue_still(self):
        # The blue still's own brightness-to-colour curve, measured from the
        # reference render: the horizon colour lifted towards white.
        t = np.linspace(0.0, 0.37, 50, dtype=np.float32)
        ref = rb._rgb("#063d66") + (255.0 - rb._rgb("#063d66")) * t[:, None]
        got = rb.gradient_map(t, *rb.DEFAULT_COLORS)
        self.assertLess(float(np.abs(got - ref).max()), 1.0)

    def test_quick_small_and_deterministic(self):
        w, h = rb.size_px(210, 297)
        start = time.perf_counter()
        a = rb.waves(w, h, *rb.DEFAULT_COLORS)
        took = time.perf_counter() - start
        self.assertEqual(a, rb.waves(w, h, *rb.DEFAULT_COLORS))
        self.assertLess(took, 2.0)
        self.assertLess(len(a), 600 * 1024)
        img = Image.open(io.BytesIO(a))
        self.assertEqual((img.format, img.size), ("JPEG", (w, h)))
        # Darker at the top than in the middle: the shade for the text.
        top = sum(img.getpixel((w // 2, 2)))
        self.assertLess(top, sum(img.getpixel((w // 2, h // 2))))

    def test_colours_change_it(self):
        green = Image.open(io.BytesIO(rb.waves(60, 90, "#14532d", "#16a34a", "#ffffff")))
        r, g, b = green.getpixel((30, 45))
        self.assertGreater(g, b)

    def test_landscape_uses_its_own_still(self):
        img = Image.open(io.BytesIO(rb.waves(120, 80, *rb.DEFAULT_COLORS)))
        self.assertEqual(img.size, (120, 80))

    def test_cached_in_media(self):
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        look = rc.Look()
        with override_settings(MEDIA_ROOT=media):
            first = rb.background("waves", look, 40, 60)
            files = list((Path(media) / "cache" / "report-covers").glob("cover-*.jpg"))
            self.assertEqual(len(files), 1)
            with mock.patch.object(rb, "waves") as drawn:
                again = rb.background("waves", look, 40, 60)
            drawn.assert_not_called()
        self.assertEqual(first, again)


class UploadTests(_Cover):
    def test_png_and_jpeg(self):
        r = self.upload(_png())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["report_cover_image_set"])
        self.assertEqual(r.json()["report_cover_image_type"], "image/png")
        r = self.upload(_png(fmt="JPEG"), "c.jpg", "image/jpeg")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["report_cover_image_type"], "image/jpeg")
        got = self.client.get("/api/tenant-settings/report-cover/")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got["Content-Type"], "image/jpeg")
        self.assertIn("sandbox", got["Content-Security-Policy"])

    def test_other_types_are_refused(self):
        self.assertEqual(self.upload(_png(fmt="GIF"), "c.gif", "image/gif").status_code, 400)
        self.assertEqual(self.upload(b"not an image at all").status_code, 400)
        # A PNG that says it is a JPEG.
        self.assertEqual(self.upload(_png(), "c.jpg", "image/jpeg").status_code, 400)
        self.assertFalse(TenantSettings.for_tenant(self.tenant).report_cover_image)

    def test_size_cap(self):
        r = self.upload(_png() + b"\0" * (rc.MAX_IMAGE_BYTES + 1))
        self.assertEqual(r.status_code, 400)
        self.assertIn("2 MB", r.json()["image"][0])

    def test_svg_is_sanitised(self):
        svg = (
            b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10' onload='alert(1)'>"
            b"<script>alert(1)</script><rect width='10' height='5' fill='#0369a1'/>"
            b"<image href='https://evil.example/x.png' width='5' height='5'/></svg>"
        )
        r = self.upload(svg, "c.svg", "image/svg+xml")
        self.assertEqual(r.status_code, 200, r.content)
        stored = bytes(TenantSettings.for_tenant(self.tenant).report_cover_image)
        self.assertIn(b"<rect", stored)
        for bad in (b"script", b"onload", b"evil.example"):
            self.assertNotIn(bad, stored)
        r = self.upload(b"<!DOCTYPE svg [<!ENTITY x 'y'>]><svg/>", "c.svg", "image/svg+xml")
        self.assertEqual(r.status_code, 400)

    def test_tenant_admin_only(self):
        reader = self.member("reader", (["api.device"], ["view"]))
        self.login(reader)
        self.assertEqual(self.upload(_png()).status_code, 403)
        self.assertEqual(self.client.get("/api/tenant-settings/report-cover/").status_code, 403)
        self.assertEqual(self.client.delete("/api/tenant-settings/report-cover/").status_code, 403)

    def test_tenant_scoped(self):
        self.assertEqual(self.upload(_png()).status_code, 200)
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        self.login(self.admin, other)
        self.assertEqual(self.client.get("/api/tenant-settings/report-cover/").status_code, 404)
        self.assertFalse(rc.look_for(other).image)
        self.assertTrue(rc.look_for(self.tenant).image)

    def test_delete_falls_back_to_the_waves(self):
        self.upload(_png())
        self.client.put("/api/tenant-settings/", {"report_cover_style": "upload"}, format="json")
        r = self.client.delete("/api/tenant-settings/report-cover/")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["report_cover_image_set"])
        self.assertEqual(r.json()["report_cover_style"], "waves")

    def test_the_change_log_keeps_a_digest_not_the_bytes(self):
        TenantSettings.for_tenant(self.tenant)
        self.assertEqual(self.upload(_png()).status_code, 200)
        entry = (
            ChangeLogEntry.objects.filter(object_type="core.tenantsettings", action="update")
            .order_by("-timestamp")
            .first()
        )
        self.assertIsNotNone(entry)
        new = entry.changes["report_cover_image"]["new"]
        self.assertIn("sha256", new)
        self.assertNotIn("PNG", new)


class CustomImageTests(_Cover):
    def test_a_cover_with_the_upload(self):
        self.upload(_png())
        with mock.patch.object(rb, "photo", wraps=rb.photo) as drawn:
            cover = _cover_of(self.devices(cover=True, cover_background="upload"))
        drawn.assert_called_once()
        self.assertIn("cover-upload dark", cover)
        self.assertIn("<img class='bg' src='data:image/jpeg;base64,", cover)
        # The tenant's default can be the upload, and a report can say none.
        self.client.put("/api/tenant-settings/", {"report_cover_style": "upload"}, format="json")
        self.assertIn("cover-upload dark", self.devices(cover=True))
        cover = _cover_of(self.devices(cover=True, cover_background="none"))
        self.assertNotIn("class='bg", cover)

    def test_upload_asked_without_one_draws_the_waves(self):
        cover = _cover_of(self.devices(cover=True, cover_background="upload"))
        self.assertIn("cover-waves dark", cover)

    def test_an_svg_upload_is_shown_whole_over_the_plain_colour(self):
        svg = (
            b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
            b"<circle r='4' cx='5' cy='5'/></svg>"
        )
        self.upload(svg, "c.svg", "image/svg+xml")
        cover = _cover_of(self.devices(cover=True, cover_background="upload"))
        self.assertIn("cover-plain dark", cover)
        self.assertIn("<img class='bg art' src='data:image/svg+xml;base64,", cover)


class PageCountTests(_Cover):
    def test_the_estimate_counts_the_cover(self):
        with mock.patch.object(rep, "render_with_deadline") as render:
            r = self.client.post(
                "/api/devices/report/?estimate=1",
                {"filters": {}, "options": {"cover": True}},
                format="json",
            )
        render.assert_not_called()
        self.assertEqual(r.json()["pages"], 1)
        self.assertEqual(r.json()["seconds"], round(rep.estimate_seconds(r.json()["cells"], 1), 1))

    def test_a_real_render_adds_one_page(self):
        self.upload(_png((400, 300)))

        def pdf(**options):
            r = self.client.post(
                "/api/devices/report/", {"filters": {}, "options": options}, format="json"
            )
            self.assertEqual(r.status_code, 200, r.content[:300])
            return r.content

        plain = _pages(pdf(paper="a4", orientation="portrait"))
        self.assertEqual(_pages(pdf(paper="a4", orientation="portrait", cover=True)), plain + 1)
        with_image = pdf(paper="a4", orientation="landscape", cover=True, cover_background="upload")
        self.assertEqual(_pages(with_image), plain + 1)
