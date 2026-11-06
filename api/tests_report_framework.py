"""The report framework (``api/reports/``): the document engine, the
marking every page and the cover can show, chapter dividers, the contents
page and the kinds registry."""

from __future__ import annotations

import datetime as dt
import tempfile
from unittest import mock

from django.test import SimpleTestCase, override_settings

from .reports import engine
from .reports.cover import Cover, Look, cover_html
from .reports.divider import Chapter, compact_html, divider_css, divider_html
from .reports.marking import Marking, marking_for
from .reports.registry import get_kind, kinds, sections_for
from .reports.toc import TOC_CSS, TocEntry, toc_html

WHEN = dt.datetime(2026, 11, 2, 9, 30, tzinfo=dt.UTC)
NONE = Look(style="none")


def ctx(**kw):
    return engine.ReportContext(title="Core", tenant="Acme", generated=WHEN, **kw)


class EngineTests(SimpleTestCase):
    def test_the_page_and_its_bands(self):
        html = engine.document_html(ctx(), "<p>body</p>")
        self.assertIn("@page{size:210.000mm 297.000mm;margin:12.000mm 12.000mm 14.000mm", html)
        self.assertIn("@top-right{content:'Acme'", html)
        self.assertIn("@bottom-right{content:'Page ' counter(page) ' / ' counter(pages)", html)
        self.assertIn("<p>body</p>", html)
        self.assertNotIn("marking", html)

    def test_landscape_and_text_in_css_strings(self):
        html = engine.document_html(
            engine.ReportContext(
                title="It's", tenant="A'B", generated=WHEN, paper="a3", orientation="landscape"
            ),
            "",
        )
        self.assertIn("size:420.000mm 297.000mm", html)
        self.assertIn("content:'A\\'B'", html)


@mock.patch("api.reports.cover.logo_data_uri", lambda dark: None)
class MarkingTests(SimpleTestCase):
    def test_no_marking_until_a_catalog_provides_one(self):
        self.assertIsNone(marking_for(None, None, {}))

    def test_from_a_dict(self):
        m = Marking.from_dict(
            {"name": "Internal", "color": "#1d4ed8", "text_color": "nope", "icon_svg": ""}
        )
        self.assertEqual(m.name, "Internal")
        self.assertEqual(m.color, "#1d4ed8")
        self.assertEqual(m.text_color, "#ffffff")
        self.assertIsNone(Marking.from_dict({"name": " "}))
        self.assertIsNone(Marking.from_dict("Internal"))

    def test_every_page_band_shows_it(self):
        html = engine.document_html(
            ctx(marking={"name": "Confidential", "color": "#b91c1c"}), "<p>x</p>"
        )
        self.assertIn("@top-center{content:element(marking-top)", html)
        self.assertIn("@bottom-center{content:element(marking-bottom)", html)
        self.assertIn("position:running(marking-top)", html)
        # The running elements come first, so the first page has them.
        body = html.split("<body>", 1)[1]
        self.assertTrue(body.startswith("<span class='marking marking-top'"))
        self.assertIn("background:#b91c1c", body)
        self.assertIn(">Confidential</span>", body)

    def test_the_cover_shows_it_and_its_text_is_escaped(self):
        m = Marking(name="<Secret>", color="#b91c1c")
        html = cover_html(Cover(title="T"), NONE, 210, 297, marking=m)
        self.assertIn("class='cover-mark'", html)
        self.assertIn("&lt;Secret&gt;", html)
        self.assertNotIn("cover-mark", cover_html(Cover(title="T"), NONE, 210, 297))

    def test_the_icon_is_sanitised(self):
        m = Marking(
            name="Restricted",
            icon_svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
            '<script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>',
        )
        from .reports.marking import marking_badge

        html = marking_badge(m)
        self.assertIn("data:image/svg+xml;base64,", html)
        import base64
        import re

        data = re.search(r"base64,([A-Za-z0-9+/=]+)", html).group(1)
        self.assertNotIn(b"script", base64.b64decode(data))
        bad = marking_badge(Marking(name="X", icon_svg="not svg"))
        self.assertNotIn("<img", bad)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="divider-"))
class DividerTests(SimpleTestCase):
    def test_a_full_divider_is_its_own_page(self):
        css = divider_css(210, 297, 12, 14)
        self.assertIn("@page divider{size:210.000mm 297.000mm;margin:0", css)
        ch = Chapter("v1", 2, "DC1 fabric", "Site AMS", ["Diagram", "Devices"])
        html = divider_html(ch, NONE, 210, 297)
        self.assertIn("<section class='divider'>", html)
        self.assertIn("Chapter 2", html)
        self.assertIn("<h1 class='chapter' id='v1'>DC1 fabric</h1>", html)
        self.assertIn("<li>Devices</li>", html)

    def test_a_plain_band_in_the_tenants_colour(self):
        html = divider_html(Chapter("a", 1, "X"), Look(style="plain"), 210, 297)
        self.assertIn("<section class='divider dark'>", html)
        self.assertIn("data:image/jpeg;base64,", html)

    def test_compact(self):
        html = compact_html(Chapter("a", 1, "Devices"), NONE, 210, first=True)
        self.assertIn("class='chapter-band first'", html)
        self.assertIn("<h1 class='chapter' id='a'>Devices</h1>", html)


class TocTests(SimpleTestCase):
    def test_page_numbers_come_from_the_targets(self):
        html = toc_html([TocEntry("v1", "DC1", 1, "1"), TocEntry("v1-devices", "Devices", 2)])
        self.assertIn("<li class='l1'><a href='#v1'><span class='no'>1</span>DC1</a></li>", html)
        self.assertIn("<li class='l2'><a href='#v1-devices'>Devices</a></li>", html)
        self.assertIn("target-counter(attr(href), page)", TOC_CSS)
        self.assertEqual(toc_html([]), "")

    def test_a_real_render_numbers_the_pages(self):
        import weasyprint

        from .drawing_pdf import BASE_URL, PdfUrlFetcher

        c = ctx()
        c.extra_css += [TOC_CSS, divider_css(210, 297, 12, 14)]
        body = toc_html([TocEntry("a", "First", 1, "1"), TocEntry("b", "Second", 1, "2")])
        body += compact_html(Chapter("a", 1, "First"), NONE, 210)
        body += "<p>one</p>"
        body += compact_html(Chapter("b", 2, "Second"), NONE, 210)
        body += "<p>two</p>"
        doc = weasyprint.HTML(
            string=engine.document_html(c, body), base_url=BASE_URL, url_fetcher=PdfUrlFetcher(b"")
        ).render()
        self.assertEqual(len(doc.pages), 3)
        tree = doc.make_bookmark_tree()
        self.assertEqual([(b[0], b[1][0]) for b in tree], [("First", 1), ("Second", 2)])


class RegistryTests(SimpleTestCase):
    def test_the_built_in_kinds(self):
        self.assertTrue({"device", "prefix", "ipaddress", "topology"} <= set(kinds()))
        topo = get_kind("topology")
        self.assertEqual(
            [s.key for s in sections_for(topo)], ["diagram", "devices", "ip_addresses", "cables"]
        )
        device = get_kind("device")
        self.assertIn("interfaces", [s.key for s in sections_for(device)])
