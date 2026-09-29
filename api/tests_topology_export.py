"""Topology PDF export: the SVG sanitizer, WeasyPrint's URL fetcher, the sheet
plan, and ``POST /api/topology/export/pdf/`` with its print links - who may
call it, what it refuses, and a real render."""

from __future__ import annotations

import base64
import io
import re
import tempfile
import types
import zlib
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from lxml import etree
from rest_framework.test import APITestCase

from api import topology_export as tx
from api.models import Site
from api.svg_sanitize import (
    SVG_NS,
    SvgRejected,
    SvgTooLarge,
    sanitize_svg,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

User = get_user_model()

URL = "/api/topology/export/pdf/"
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


def _svg(body: str, attrs: str = 'width="200" height="100"') -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" {attrs}>{body}</svg>'


def _png(w=2, h=2) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), "#16a34a").save(buf, "PNG")
    return buf.getvalue()


def _data_png(w=2, h=2) -> str:
    return "data:image/png;base64," + base64.b64encode(_png(w, h)).decode()


def _tree(out: bytes):
    return etree.fromstring(out)


def _tags(out: bytes) -> list[str]:
    return [etree.QName(e).localname for e in _tree(out).iter()]


DRAWING = _svg(
    '<title>DC1 fabric</title><g id="nodes">'
    '<rect x="10" y="10" width="120" height="40" rx="8" fill="#0ea5e9" stroke="#0b84ba"/>'
    '<text x="70" y="34" text-anchor="middle" font-size="12" font-weight="700" '
    'fill="#ffffff">spine-01</text>'
    '<path d="M 70,50 C 70,80 70,80 70,95" fill="none" stroke="#71717a" '
    'stroke-dasharray="4 3" stroke-linecap="round"/></g>',
    'width="200" height="100" viewBox="0 0 200 100" role="img" '
    'font-family="Inter, Inter Variable, Segoe UI, Roboto, Helvetica, Arial, sans-serif"',
)


class SanitizerTests(SimpleTestCase):
    def test_keeps_the_writers_drawing(self):
        out = sanitize_svg(DRAWING)
        root = _tree(out)
        self.assertEqual(root.tag, f"{{{SVG_NS}}}svg")
        self.assertEqual(root.get("viewBox"), "0 0 200 100")
        self.assertIn("Inter", root.get("font-family"))
        rect = root.find(f".//{{{SVG_NS}}}rect")
        self.assertEqual(rect.get("fill"), "#0ea5e9")
        self.assertEqual(rect.get("rx"), "8")
        text = root.find(f".//{{{SVG_NS}}}text")
        self.assertEqual(text.text, "spine-01")
        self.assertEqual(text.get("font-weight"), "700")
        path = root.find(f".//{{{SVG_NS}}}path")
        self.assertEqual(path.get("stroke-dasharray"), "4 3")
        self.assertEqual(root.find(f"{{{SVG_NS}}}title").text, "DC1 fabric")

    def test_refuses_doctype_and_entities(self):
        laughs = (
            '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa">'
            '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
            '<svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'
        )
        xxe = (
            '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
            '<svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'
        )
        for bad in (laughs, xxe, "<!doctype svg><svg/>", "<!ENTITY x 'y'>"):
            with self.subTest(bad=bad[:30]), self.assertRaises(SvgRejected):
                sanitize_svg(bad)

    def test_refuses_what_is_not_an_svg(self):
        for bad in ("<html/>", "<svg>", "not xml", '<svg xmlns="urn:other"/>'):
            with self.subTest(bad=bad), self.assertRaises(SvgRejected):
                sanitize_svg(bad)

    def test_strips_scripts_foreign_objects_and_handlers(self):
        out = sanitize_svg(
            _svg(
                "<script>alert(1)</script>"
                '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div>'
                "</foreignObject>"
                '<rect width="5" height="5" onload="alert(1)" onclick="x()" '
                'style="fill:red" class="c" data-x="1"/>'
                '<animate attributeName="x" to="9"/><set attributeName="x" to="1"/>'
                "<iframe/>"
            )
        )
        self.assertEqual(_tags(out), ["svg", "rect"])
        rect = _tree(out).find(f"{{{SVG_NS}}}rect")
        self.assertEqual(dict(rect.attrib), {"width": "5", "height": "5"})
        self.assertNotIn(b"alert", out)

    def test_unwraps_links(self):
        out = sanitize_svg(_svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'))
        self.assertEqual(_tags(out), ["svg", "rect"])
        self.assertNotIn(b"javascript", out)

    def test_image_sources(self):
        cases = {
            "/media/device-type-images/arista/7050-front.png": True,
            "http://169.254.169.254/latest/meta-data": False,
            "https://example.com/a.png": False,
            "file:///etc/passwd": False,
            "//evil.example/a.png": False,
            "/media/documents/secret.png": False,
            "/media/device-type-images/../documents/secret.png": False,
            "/api/devices/": False,
        }
        for href, kept in cases.items():
            with self.subTest(href=href):
                out = sanitize_svg(_svg(f'<image href="{href}" width="4" height="4"/>'))
                img = _tree(out).find(f"{{{SVG_NS}}}image")
                self.assertEqual(img.get("href") == href, kept)
        # xlink:href is read too, and written as href.
        out = sanitize_svg(
            '<svg xmlns="http://www.w3.org/2000/svg" '
            'xmlns:xlink="http://www.w3.org/1999/xlink">'
            '<image xlink:href="https://example.com/a.png"/></svg>'
        )
        self.assertNotIn(b"example.com", out)

    def test_data_images_are_checked(self):
        png = _data_png()
        out = sanitize_svg(_svg(f'<image href="{png}" width="4" height="4"/>'))
        self.assertIn(png.encode(), out)
        jpeg_claim = png.replace("image/png", "image/jpeg")
        svg_image = "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode()
        for bad in (jpeg_claim, svg_image, "data:image/png;base64,!!!!", "data:text/html,x"):
            with self.subTest(bad=bad[:24]), self.assertRaises(SvgRejected):
                sanitize_svg(_svg(f'<image href="{bad}"/>'))
        with (
            mock.patch("api.svg_sanitize.MAX_IMAGE_PIXELS", 10),
            self.assertRaises(SvgTooLarge),
        ):
            sanitize_svg(_svg(f'<image href="{_data_png(4, 4)}"/>'))

    def test_use_only_points_at_a_flat_symbol(self):
        out = sanitize_svg(
            _svg(
                '<defs><symbol id="ph0" viewBox="0 0 100 100">'
                f'<image href="{_data_png()}" width="100" height="100"/></symbol>'
                '<symbol id="nest"><use href="#ph0"/></symbol>'
                '<g id="grp"><rect width="1" height="1"/></g></defs>'
                '<use href="#ph0" x="1" y="1" width="10" height="10"/>'
                '<use href="#nest"/><use href="#grp"/><use href="#missing"/>'
                '<use href="https://example.com/x.svg#ph0"/>'
            )
        )
        top = [u.get("href") for u in _tree(out).findall(f"{{{SVG_NS}}}use")]
        self.assertEqual(top, ["#ph0"])

    def test_clip_paths_resolve_and_hold_only_shapes(self):
        out = sanitize_svg(
            _svg(
                '<clipPath id="c1" clip-path="url(#c1)"><rect width="9" height="9"/>'
                '<use href="#c1"/></clipPath>'
                '<g clip-path="url(#c1)"><rect width="1" height="1"/></g>'
                '<g clip-path="url(#nope)"/><g clip-path="url(http://x/#c1)"/>'
            )
        )
        root = _tree(out)
        clip = root.find(f"{{{SVG_NS}}}clipPath")
        self.assertIsNone(clip.get("clip-path"))
        self.assertEqual([etree.QName(e).localname for e in clip], ["rect"])
        groups = root.findall(f"{{{SVG_NS}}}g")
        self.assertEqual([g.get("clip-path") for g in groups], ["url(#c1)", None, None])

    def test_attribute_values_are_checked(self):
        out = sanitize_svg(
            _svg(
                '<rect width="10" height="10" fill="url(http://x/#g)" '
                'stroke="expression(alert(1))" transform="translate(2 3) scale(0.5)"/>'
                '<rect width="10" height="10" transform="url(#x)" fill="#fff"/>'
            )
        )
        a, b = _tree(out).findall(f"{{{SVG_NS}}}rect")
        self.assertIsNone(a.get("fill"))
        self.assertIsNone(a.get("stroke"))
        self.assertEqual(a.get("transform"), "translate(2 3) scale(0.5)")
        self.assertIsNone(b.get("transform"))
        self.assertEqual(b.get("fill"), "#fff")

    def test_style_keeps_plain_rules_only(self):
        font = "data:font/woff2;base64," + base64.b64encode(b"wOF2fake").decode()
        css = (
            "@import url(http://evil/x.css);"
            "rect{fill:#ff0000;stroke:url(http://evil/)}"
            "text{font-family:Inter;behavior:url(x.htc)}"
            f'@font-face{{font-family:"Inter";src:url({font})}}'
            "[href^=x]{fill:#000}"
        )
        out = sanitize_svg(_svg(f"<style>{css}</style>"))
        style = _tree(out).find(f"{{{SVG_NS}}}style").text
        self.assertEqual(style, "rect{fill:#ff0000}text{font-family:Inter}")
        # Fonts only when the caller allows them, and only as data: URIs.
        style = _tree(sanitize_svg(_svg(f"<style>{css}</style>"), allow_fonts=True)).find(
            f"{{{SVG_NS}}}style"
        )
        self.assertIn("@font-face{", style.text)
        self.assertNotIn("evil", style.text)
        remote = '@font-face{font-family:"X";src:url(https://evil/x.woff2)}'
        out = sanitize_svg(_svg(f"<style>{remote}</style>"), allow_fonts=True)
        self.assertIsNone(_tree(out).find(f"{{{SVG_NS}}}style"))

    def test_caps(self):
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg("<g/>" * 50), max_bytes=100)
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg("<g/>" * 50), max_elements=20)
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg("<text>" + "x" * 50 + "</text>"), max_text=40)
        sanitize_svg(_svg("<g/>" * 19), max_elements=20)
        self.assertEqual(SvgTooLarge("x").status, 413)
        self.assertEqual(SvgRejected("x").status, 400)

    def test_text_after_any_element_in_a_text_counts(self):
        # A <desc> (or anything else) inside a <text> hides nothing.
        for inner in ("<desc/>", "<title/>", "<foo/>", '<tspan x="1">a</tspan>'):
            with self.subTest(inner=inner), self.assertRaises(SvgTooLarge):
                sanitize_svg(_svg(f"<text>a{inner}{'x' * 50}</text>"), max_text=40)
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg(f"<text>a<desc/>{'x' * 90_000}</text>"))

    def test_a_symbol_costs_what_it_holds_each_time_it_is_used(self):
        symbol = f'<defs><symbol id="s"><text>{"x" * 1000}</text></symbol></defs>'
        with self.assertRaises(SvgTooLarge) as cm:
            sanitize_svg(_svg(symbol + '<use href="#s"/>' * 200))
        self.assertIn("characters of text", str(cm.exception))
        # Elements too, and path data against the byte cap.
        rects = '<defs><symbol id="r">' + '<rect width="1" height="1"/>' * 30 + "</symbol></defs>"
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg(rects + '<use href="#r"/>' * 30), max_elements=500)
        path = f'<defs><symbol id="p"><path d="M0 0{" L1 1" * 2000}"/></symbol></defs>'
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg(path + '<use href="#p"/>' * 20), max_bytes=100_000)
        # Used a few times, it fits.
        sanitize_svg(_svg(symbol + '<use href="#s"/>' * 50))

    def test_a_clip_path_costs_what_it_holds_for_each_element_it_clips(self):
        clip = f'<clipPath id="c"><text>{"x" * 1000}</text></clipPath>'
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(_svg(clip + '<rect width="1" height="1" clip-path="url(#c)"/>' * 100))
        # Inside a symbol, the two multiply.
        small = f'<clipPath id="c"><text>{"x" * 100}</text></clipPath>'
        parts = '<rect width="1" height="1" clip-path="url(#c)"/>' * 30
        with self.assertRaises(SvgTooLarge):
            sanitize_svg(
                _svg(
                    f'{small}<defs><symbol id="s">{parts}</symbol></defs>' + '<use href="#s"/>' * 30
                )
            )

    def test_the_writers_photo_symbols_fit(self):
        # One symbol per photo, used by every device of its type.
        photo = (
            '<defs><symbol id="ph0" viewBox="0 0 100 100" preserveAspectRatio="none">'
            f'<image width="100" height="100" preserveAspectRatio="none" href="{_data_png()}"/>'
            "</symbol></defs>"
        )
        uses = "".join(
            f'<use href="#ph0" x="{i * 10}" y="0" width="480" height="44"/>' for i in range(400)
        )
        out = sanitize_svg(_svg(photo + uses))
        self.assertEqual(len(_tree(out).findall(f"{{{SVG_NS}}}use")), 400)


class FetcherTests(SimpleTestCase):
    def setUp(self):
        self.fetch = tx.PdfUrlFetcher(b"<svg/>")

    def _body(self, res):
        return res.read() if hasattr(res, "read") else res["string"]

    def test_serves_the_drawing_and_data_uris(self):
        self.assertEqual(self._body(self.fetch(tx.DIAGRAM_URL)), b"<svg/>")
        png = _png()
        res = self.fetch("data:image/png;base64," + base64.b64encode(png).decode())
        self.assertEqual(self._body(res), png)

    def test_refuses_the_network(self):
        for url in (
            "http://169.254.169.254/latest/meta-data/",
            "https://example.com/a.png",
            "ftp://example.com/x",
            "https://danbyte.invalid/api/devices/",
            "https://danbyte.invalid/media/documents/secret.pdf",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.fetch(url)

    def test_reads_only_the_vendored_fonts(self):
        font = sorted(tx._font_files())[0]
        body = self._body(self.fetch(Path(font).as_uri()))
        self.assertIn(body[:4], (b"\x00\x01\x00\x00", b"true", b"OTTO"))
        for url in (
            "file:///etc/passwd",
            (tx.FONT_DIR / ".." / "topology_export.py").as_uri(),
            (tx.FONT_DIR / "OFL.txt").as_uri(),
            f"file://{tx.FONT_DIR}/../../danbyte/settings.py",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.fetch(url)

    def test_vendored_fonts_cover_every_weight(self):
        self.assertEqual(len(tx._font_files()), len(tx.FONT_RANGES) * len(tx.FONT_WEIGHTS))
        self.assertTrue((tx.FONT_DIR / "OFL.txt").is_file())

    def test_device_type_photos_from_media_root(self):
        with tempfile.TemporaryDirectory() as media:
            root = Path(media)
            (root / "device-type-images").mkdir()
            (root / "device-type-images" / "front.png").write_bytes(_png())
            (root / "documents").mkdir()
            (root / "documents" / "secret.png").write_bytes(_png())
            with override_settings(MEDIA_ROOT=media):
                res = self.fetch(tx.MEDIA_IMAGES_URL + "front.png")
                self.assertEqual(self._body(res), _png())
                for rel in ("../documents/secret.png", "missing.png", "front.png?x=1"):
                    with self.subTest(rel=rel), self.assertRaises(ValueError):
                        self.fetch(tx.MEDIA_IMAGES_URL + rel)


class SheetTests(SimpleTestCase):
    def test_fits_a3_landscape_under_the_title_block(self):
        plan = tx.plan_sheet(2000, 1000, "a3", "landscape")
        self.assertEqual(plan["page"], (420.0, 297.0))
        self.assertEqual(plan["area"], (10.0, 10.0, 400.0, 259.0))
        self.assertAlmostEqual(plan["scale"], 0.2)
        x, y, w, h = plan["at"]
        self.assertAlmostEqual(x, 10.0)
        self.assertAlmostEqual(y, 10.0)  # top of the area, centred across
        self.assertAlmostEqual(w, 400.0)
        self.assertAlmostEqual(h, 200.0)

    def test_portrait_and_no_title_block(self):
        plan = tx.plan_sheet(1000, 2000, "a4", "portrait", title_block=False)
        self.assertEqual(plan["page"], (210.0, 297.0))
        self.assertEqual(plan["area"], (10.0, 10.0, 190.0, 277.0))
        self.assertAlmostEqual(plan["scale"], 277.0 / 2000)

    def test_a_small_map_is_not_blown_up(self):
        plan = tx.plan_sheet(200, 100, "tabloid", "landscape")
        self.assertAlmostEqual(plan["scale"], tx.MAX_SCALE)

    def test_svg_size(self):
        self.assertEqual(tx.svg_size(b'<svg width="300" height="150">'), (300.0, 150.0))
        self.assertEqual(tx.svg_size(b'<svg width="25.4mm" height="72pt">'), (96.0, 96.0))
        self.assertEqual(tx.svg_size(b'<svg viewBox="-24 -24 640 480">'), (640.0, 480.0))
        self.assertEqual(tx.svg_size(b"<svg>"), (1000.0, 1000.0))

    def test_title_block_text_is_escaped(self):
        import datetime as dt

        html = tx._sheet_html(
            tx.plan_sheet(100, 100),
            title="<b>DC1</b>",
            tenant="Acme & Co",
            filters="Site: DC1",
            generated=dt.datetime(2026, 9, 26, 12, 0, tzinfo=dt.UTC),
            title_block=True,
        )
        from danbyte import __version__

        self.assertIn("&lt;b&gt;DC1&lt;/b&gt;", html)
        self.assertIn("Acme &amp; Co · Site: DC1", html)
        self.assertIn(f"2026-09-26 12:00 UTC · Danbyte {__version__} · Page 1 / 1", html)
        self.assertNotIn("<b>DC1", html)


def _pdf_objects(pdf: bytes) -> bytes:
    """The PDF's streams inflated: WeasyPrint packs its dictionaries into
    compressed object streams."""
    out = [pdf]
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        try:
            out.append(zlib.decompress(m.group(1)))
        except zlib.error:
            pass
    return b"".join(out)


@override_settings(CACHES=LOCMEM)
class EndpointTests(APITestCase):
    def setUp(self):
        cache.clear()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Globex", slug="globex")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str((tenant or self.tenant).id)
        session.save()

    def _member(self, name, *types, site=None):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        if types:
            perm = ObjectPermission.objects.create(
                name=f"{name}-perm", object_types=list(types), actions=["view"]
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if site:
                perm.sites.add(site)
        return user

    def _post(self, body=None, query=""):
        payload = {"svg": DRAWING, "title": "DC1 fabric", **(body or {})}
        return self.client.post(URL + query, payload, format="json")

    fake = mock.patch.object(tx, "render_with_deadline", return_value=b"%PDF-1.7 fake")

    def test_anonymous_refused(self):
        self.client.logout()
        self.assertIn(self._post().status_code, (401, 403))

    def test_no_tenant_refused(self):
        self.client.force_login(User.objects.create_user("lone", password="x"))
        self.assertEqual(self._post().status_code, 403)

    def test_device_view_required(self):
        self._login(self._member("sites-only", "site"))
        r = self._post()
        self.assertEqual(r.status_code, 403, r.content)

    def test_site_scoped_device_view_may_export(self):
        site = Site.objects.create(tenant=self.tenant, name="dc1")
        self._login(self._member("scoped", "device", site=site))
        with self.fake:
            self.assertEqual(self._post().status_code, 200)

    def test_bad_requests(self):
        with self.fake:
            for body in (
                {"svg": ""},
                {"paper": {"size": "a0"}},
                {"paper": {"orientation": "sideways"}},
                {"svg": "<!DOCTYPE svg><svg/>"},
                {"svg": "<svg><script/>"},
            ):
                with self.subTest(body=body):
                    self.assertEqual(self._post(body).status_code, 400)
            r = self.client.post(URL, {"title": "x"}, format="json")
            self.assertEqual(r.status_code, 400)

    def test_size_caps(self):
        with self.fake, mock.patch.object(tx, "MAX_BODY_BYTES", 100):
            r = self._post()
        self.assertEqual(r.status_code, 413)
        with (
            self.fake,
            mock.patch.object(tx, "sanitize_svg", side_effect=SvgTooLarge("big")),
        ):
            r = self._post()
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["detail"], "big")

    def test_one_render_at_a_time(self):
        cache.add(f"topology-pdf-busy:{self.admin.pk}", 1, 60)
        with self.fake:
            self.assertEqual(self._post().status_code, 429)
        cache.clear()
        with self.fake:
            self.assertEqual(self._post().status_code, 200)
        # The lock is released after a render.
        self.assertIsNone(cache.get(f"topology-pdf-busy:{self.admin.pk}"))

    def test_so_many_renders_at_once_across_the_deployment(self):
        for i in range(tx.RENDER_SLOTS):
            cache.add(f"topology-pdf-slot:{i}", "someone", 60)
        with self.fake as render:
            r = self._post()
        self.assertEqual(r.status_code, 429)
        self.assertIn("Other PDFs", r.json()["detail"])
        render.assert_not_called()
        # The user's own lock went with the refusal.
        self.assertIsNone(cache.get(f"topology-pdf-busy:{self.admin.pk}"))
        cache.delete("topology-pdf-slot:1")
        with self.fake:
            self.assertEqual(self._post().status_code, 200)
        # A slot taken is given back; one held by another render is not.
        self.assertIsNone(cache.get("topology-pdf-slot:1"))
        self.assertEqual(cache.get("topology-pdf-slot:0"), "someone")

    def test_a_render_past_its_deadline_is_refused(self):
        with mock.patch.object(tx, "render_with_deadline", side_effect=tx.RenderTimeout):
            r = self._post()
        self.assertEqual(r.status_code, 413)
        self.assertIn("too long", r.json()["detail"])
        self.assertIsNone(cache.get(f"topology-pdf-busy:{self.admin.pk}"))

    def test_the_date_is_the_servers(self):
        from django.utils import timezone

        with self.fake as render:
            r = self._post({"meta": {"generated_at": "1999-12-31T23:59:00Z"}})
        when = render.call_args.kwargs["generated"]
        self.assertLess(abs((timezone.now() - when).total_seconds()), 60)
        self.assertIn(f"-{when:%Y-%m-%d}.pdf", r["Content-Disposition"])
        self.assertNotIn("1999", r["Content-Disposition"])

    def test_the_file_is_named_as_the_other_exports(self):
        # The browser names PNG, SVG and draw.io files the same way
        # (export-menu.tsx exportFileName): ø is o, and a slash a hyphen.
        with self.fake:
            r = self._post({"title": "København HQ · Ethernet1/1"})
        self.assertRegex(
            r["Content-Disposition"],
            r'^attachment; filename="kobenhavn-hq-ethernet1-1-\d{4}-\d{2}-\d{2}\.pdf"$',
        )

    def test_title_block_names_the_session_tenant(self):
        with self.fake as render:
            self._post(
                {
                    "paper": {"size": "a4", "orientation": "portrait"},
                    "meta": {"tenant": "Globex", "filters": "Site: DC1"},
                    "title_block": False,
                }
            )
        kw = render.call_args.kwargs
        self.assertEqual(kw["tenant"], "Acme")
        self.assertEqual(kw["filters"], "Site: DC1")
        self.assertEqual((kw["paper"], kw["orientation"]), ("a4", "portrait"))
        self.assertFalse(kw["title_block"])
        self.assertEqual(kw["title"], "DC1 fabric")

    def test_a_real_render(self):
        r = self._post({"meta": {"filters": "Site: DC1"}})
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertRegex(
            r["Content-Disposition"], r'^attachment; filename="dc1-fabric-\d{4}-\d{2}-\d{2}\.pdf"$'
        )
        pdf = r.content
        self.assertTrue(pdf.startswith(b"%PDF-"))
        objects = _pdf_objects(pdf)
        self.assertIn(b"/Title (DC1 fabric)", objects)
        # One A3 landscape page, in points.
        boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", objects)
        self.assertEqual(len(boxes), 1)
        w, h = (float(v) for v in boxes[0])
        self.assertAlmostEqual(w, 420 / 25.4 * 72, delta=0.5)
        self.assertAlmostEqual(h, 297 / 25.4 * 72, delta=0.5)
        # Inter is embedded, never fetched.
        self.assertIn(b"Inter", objects)

    def test_print_link_is_for_the_same_user_and_tenant(self):
        with self.fake:
            r = self._post(query="?print=1")
        self.assertEqual(r.status_code, 200, r.content)
        link = r.json()["url"]
        self.assertRegex(link, r"^/api/topology/export/pdf/[A-Za-z0-9_-]{24,64}/$")

        got = self.client.get(link)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 fake")
        self.assertTrue(got["Content-Disposition"].startswith("inline; "))
        self.assertEqual(got["Cache-Control"], "private, no-store")
        got = self.client.get(link + "?download=1")
        self.assertTrue(got["Content-Disposition"].startswith("attachment; "))

        # Another member of the tenant, with device.view: not theirs.
        self._login(self._member("peer", "device"))
        self.assertEqual(self.client.get(link).status_code, 404)
        # The same user in another tenant.
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(link).status_code, 404)
        self._login(self.admin)
        self.assertEqual(self.client.get(link).status_code, 200)
        self.client.logout()
        self.assertIn(self.client.get(link).status_code, (401, 403))

    def test_a_new_print_link_replaces_the_last(self):
        with self.fake:
            first = self._post(query="?print=1").json()["url"]
            second = self._post(query="?print=1").json()["url"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.client.get(first).status_code, 404)
        self.assertEqual(self.client.get(second).status_code, 200)

    def test_print_links_without_a_cache(self):
        with self.fake, mock.patch.object(tx.cache, "set", side_effect=ConnectionError):
            r = self._post(query="?print=1")
        self.assertEqual(r.status_code, 503)
        with self.fake:
            link = self._post(query="?print=1").json()["url"]
        with mock.patch.object(tx.cache, "get", side_effect=ConnectionError):
            self.assertEqual(self.client.get(link).status_code, 503)

    def test_print_link_expires(self):
        with self.fake:
            link = self._post(query="?print=1").json()["url"]
        import time

        from django.core.cache.backends import locmem

        later = types.SimpleNamespace(time=lambda: time.time() + tx.PRINT_TTL + 1)
        with mock.patch.object(locmem, "time", later):
            self.assertEqual(self.client.get(link).status_code, 404)

    def test_unknown_or_malformed_tokens(self):
        for token in ("x" * 40, "short", "a" * 30 + "%2e%2e"):
            with self.subTest(token=token):
                r = self.client.get(f"{URL}{token}/")
                self.assertEqual(r.status_code, 404)


class DeadlineTests(SimpleTestCase):
    """The render runs in a forked child the parent stops at its deadline."""

    def test_a_slow_render_is_stopped(self):
        import time

        def slow(*args, **kwargs):
            time.sleep(30)

        start = time.monotonic()
        with (
            mock.patch.object(tx, "render_topology_pdf", side_effect=slow),
            self.assertRaises(tx.RenderTimeout),
        ):
            tx.render_with_deadline(b"<svg/>", timeout=0.5, title="x")
        self.assertLess(time.monotonic() - start, 10)

    def test_the_childs_answer_and_its_failure(self):
        with mock.patch.object(tx, "render_topology_pdf", return_value=b"%PDF-child"):
            self.assertEqual(tx.render_with_deadline(b"<svg/>", title="x"), b"%PDF-child")
        with (
            mock.patch.object(tx, "render_topology_pdf", side_effect=ValueError("boom")),
            self.assertRaisesRegex(RuntimeError, "ValueError: boom"),
        ):
            tx.render_with_deadline(b"<svg/>", title="x")
