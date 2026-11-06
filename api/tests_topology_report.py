"""The topology report (``api/reports/kinds/topology.py``): the drawing is
the Export's sheet (one builder for both), the tables are the devices on the
map, their addresses and the cables between them, read through the reader's
lists; hidden objects and another tenant's views are dropped and never
named; a bulk report is one PDF with a chapter a view or a ZIP; and the
saved views list (``/api/topology-views/?summary=1``)."""

from __future__ import annotations

import datetime as dt
import io
import re
import zipfile
from unittest import mock

from django.test import override_settings

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant, TenantSettings

from . import topology_export as tx
from .models import Device, TopologyView
from .reports.kinds import topology as topo
from .reports.marking import Marking
from .tests_elevation_pdf import _pdf_objects
from .tests_object_report import LOCMEM, _Queue, _Report

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">'
    '<rect x="10" y="10" width="120" height="40" fill="#2563eb"/>'
    '<text x="20" y="35">sw-a</text></svg>'
)


@override_settings(CACHES=LOCMEM)
class _Topo(_Report):
    def view_entry(self, *devices, **extra):
        return {
            "title": extra.pop("title", "Core"),
            "svg": SVG,
            "device_ids": [str(d.pk) for d in devices],
            **extra,
        }

    def docs(self, body, query=""):
        """The documents the report would render, and the response."""
        seen = {}

        def fake(**kwargs):
            seen.update(kwargs)
            return b"%PDF-1.7 fake"

        with mock.patch.object(topo, "render_with_deadline", side_effect=fake):
            r = self.client.post(f"/api/topology/report/{query}", body, format="json")
        return r, seen

    def html(self, body):
        r, seen = self.docs(body)
        self.assertEqual(r.status_code, 200, r.content[:400])
        self.assertEqual(len(seen["docs"]), 1)
        return seen["docs"][0][1]


class DescribeTests(_Topo):
    def test_sections_and_columns(self):
        r = self.client.get("/api/topology/report/")
        self.assertEqual(r.status_code, 200)
        got = r.json()
        self.assertEqual(got["type"], "topology")
        keys = [s["key"] for s in got["sections"]]
        self.assertEqual(keys, ["diagram", "devices", "ip_addresses", "cables"])
        devices = got["sections"][1]
        self.assertEqual(
            devices["default_columns"],
            ["name", "role", "device_type", "site", "primary_ip", "status"],
        )
        self.assertEqual(got["limits"]["objects"], topo.MAX_VIEWS)

    def test_needs_device_view(self):
        self.login(self.member("nobody", (["site"], ["view"])))
        self.assertEqual(self.client.get("/api/topology/report/").status_code, 403)
        r = self.client.post(
            "/api/topology/report/", {"views": [self.view_entry()]}, format="json"
        )
        self.assertEqual(r.status_code, 403)

    def test_a_section_the_reader_may_not_view(self):
        self.login(self.member("d", (["device"], ["view"])))
        got = self.client.get("/api/topology/report/").json()
        cables = next(s for s in got["sections"] if s["key"] == "cables")
        self.assertFalse(cables["available"])
        html = self.html({"views": [self.view_entry(self.dev_a, self.dev_b)]})
        self.assertIn("Cabling left out: you may not view them.", html)
        self.assertNotIn("C-77", html)


class ContentTests(_Topo):
    def test_one_view(self):
        html = self.html(
            {"views": [self.view_entry(self.dev_a, self.dev_b, filters="Site AMS")]}
        )
        # The tables: devices with their badges, addresses, the cable both ends.
        for text in ("sw-a", "sw-b", "10.9.0.1", "C-77", "sw-b · eth-down", "sw-a · eth-uplink"):
            self.assertIn(text, html)
        self.assertIn("background:#16a34a", html)  # Active, as its badge
        self.assertIn("background:#2563eb", html)  # the Leaf role
        # Four chapters, so a contents page with page numbers.
        self.assertIn("<section class='toc'>", html)
        self.assertIn("target-counter(attr(href), page)", html)
        for anchor in ("v1-diagram", "v1-devices", "v1-ip_addresses", "v1-cables"):
            self.assertIn(f"href='#{anchor}'", html)
            self.assertIn(f"id='{anchor}'", html)
        # The drawing on its own landscape page, on the Export's sheet.
        self.assertIn("section class='diagram-page diagram-landscape'", html)
        self.assertIn("https://danbyte.invalid/_/diagram.svg", html)
        self.assertIn("Acme · Site AMS", html)
        # Compact chapter banners, no full dividers for one view.
        self.assertIn("class='chapter-band", html)
        self.assertNotIn("<section class='divider", html)

    def test_only_the_cables_between_the_drawn_devices(self):
        other = Device.objects.create(tenant=self.tenant, name="sw-c", site=self.ams)
        html = self.html({"views": [self.view_entry(self.dev_a, other)]})
        self.assertNotIn("C-77", html)  # its far end, sw-b, is not drawn
        html = self.html({"views": [self.view_entry(self.dev_a, self.dev_b)]})
        self.assertIn("C-77", html)

    def test_sections_and_columns_picked(self):
        html = self.html(
            {
                "views": [self.view_entry(self.dev_a)],
                "sections": ["devices"],
                "columns": {"devices": ["serial_number", "name"]},
            }
        )
        head = re.search(r"<thead><tr>(.*?)</tr>", html).group(1)
        self.assertEqual(re.findall(r"<th[^>]*>(.*?)</th>", head), ["Serial number", "Name"])
        self.assertNotIn("diagram-page", html)
        self.assertNotIn("10.9.0.1", html)
        # One chapter: no contents page.
        self.assertNotIn("<section class='toc'>", html)

    def test_cover(self):
        html = self.html(
            {
                "views": [self.view_entry(self.dev_a)],
                "options": {"cover": True, "cover_project": "Northwind"},
            }
        )
        self.assertIn("section class='cover", html)
        self.assertIn("Northwind", html)
        self.assertIn("<h1 class='cover-title'>Core</h1>", html)

    def test_marking_on_every_page_and_the_cover(self):
        marking = Marking(name="Confidential", color="#b91c1c", text_color="#ffffff")
        with mock.patch.object(topo, "marking_for", return_value=marking):
            html = self.html(
                {"views": [self.view_entry(self.dev_a)], "options": {"cover": True}}
            )
        self.assertIn("element(marking-top)", html)
        self.assertIn("element(marking-bottom)", html)
        self.assertIn("class='marking marking-top'", html)
        self.assertIn("class='cover-mark'", html)
        self.assertIn("background:#b91c1c", html)


class ScopeTests(_Topo):
    def test_a_hidden_device_is_dropped_and_never_named(self):
        self.login(self.member("ams", (["device", "ipaddress", "cable"], ["view"]),
                               sites=[self.ams]))
        html = self.html({"views": [self.view_entry(self.dev_a, self.dev_b)]})
        self.assertIn("sw-a", html)
        self.assertNotIn("sw-b", html)
        self.assertNotIn("SN-B1", html)

    def test_another_tenants_devices_and_views_are_ignored(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="Globex", slug="globex")
        far = Device.objects.create(tenant=other, name="far-sw")
        theirs = TopologyView.objects.create(tenant=other, name="Their map")
        html = self.html({"views": [self.view_entry(self.dev_a, far)]})
        self.assertNotIn("far-sw", html)
        r, _ = self.docs({"views": [self.view_entry(self.dev_a, view=str(theirs.pk), title="")]})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("Their map", r.content.decode())

    def test_a_saved_views_name_titles_it(self):
        mine = TopologyView.objects.create(tenant=self.tenant, name="DC1 fabric")
        html = self.html({"views": [self.view_entry(self.dev_a, view=str(mine.pk), title="")]})
        self.assertIn("DC1 fabric", html)

    def test_a_bad_drawing_is_refused(self):
        for svg in ("not an svg", ""):
            r, _ = self.docs({"views": [{**self.view_entry(self.dev_a), "svg": svg}]})
            self.assertEqual(r.status_code, 400, svg)
        r, _ = self.docs({"views": []})
        self.assertEqual(r.status_code, 400)
        r, _ = self.docs({"views": [self.view_entry(self.dev_a)] * (topo.MAX_VIEWS + 1)})
        self.assertEqual(r.status_code, 400)


class BulkTests(_Topo):
    def test_one_pdf_with_a_chapter_a_view(self):
        html = self.html(
            {
                "views": [
                    self.view_entry(self.dev_a, title="AMS"),
                    self.view_entry(self.dev_b, title="LON"),
                ],
                "options": {"cover": True},
            }
        )
        self.assertEqual(html.count("<section class='divider"), 2)
        self.assertIn("Chapter 1", html)
        self.assertIn("Chapter 2", html)
        self.assertIn("<li class='l1'><a href='#v1'>", html)
        self.assertIn("<li class='l2'><a href='#v2-devices'>", html)
        self.assertIn("https://danbyte.invalid/_/diagram-1.svg", html)
        self.assertIn("2 topology views", html)

    def test_a_zip_of_pdfs(self):
        r, seen = self.docs(
            {
                "views": [
                    self.view_entry(self.dev_a, title="AMS"),
                    self.view_entry(self.dev_b, title="LON"),
                ],
                "options": {"output": "zip"},
            }
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(seen["zipped"])
        names = [n for n, _ in seen["docs"]]
        self.assertTrue(names[0].startswith("ams-") and names[1].startswith("lon-"))
        self.assertNotIn("sw-b", seen["docs"][0][1])

    def test_a_real_zip(self):
        r = self.client.post(
            "/api/topology/report/",
            {
                "views": [
                    self.view_entry(self.dev_a, title="AMS"),
                    self.view_entry(self.dev_b, title="LON"),
                ],
                "sections": ["diagram", "devices"],
                "options": {"output": "zip"},
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            files = zf.namelist()
            self.assertEqual(len(files), 2)
            self.assertTrue(zf.read(files[0]).startswith(b"%PDF-"))


class RenderTests(_Topo):
    def test_a_real_render_with_contents_and_bookmarks(self):
        r = self.client.post(
            "/api/topology/report/",
            {
                "views": [self.view_entry(self.dev_a, self.dev_b)],
                "options": {"cover": True, "title": "Core network"},
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertIn("core-network-", r["Content-Disposition"])
        objects = _pdf_objects(r.content)
        pages = len(re.findall(rb"/Type\s*/Page(?![s\w])", objects))
        # Cover, contents, drawing, then the tables.
        self.assertGreaterEqual(pages, 4)
        self.assertIn(b"/Outlines", objects)

    def test_the_contents_page_numbers_match_the_pages(self):
        import weasyprint

        _, seen = self.docs({"views": [self.view_entry(self.dev_a, self.dev_b)]})
        html = seen["docs"][0][1]
        doc = weasyprint.HTML(
            string=html, base_url=tx.BASE_URL, url_fetcher=tx.PdfUrlFetcher(SVG.encode())
        ).render()
        at = {}
        for i, page in enumerate(doc.pages):
            for anchor in page.anchors:
                at.setdefault(anchor, i + 1)
        tree = doc.make_bookmark_tree()
        # (label, (page, x, y), children, state) each.
        labels = {b[0]: b[1][0] + 1 for b in tree}
        self.assertEqual(labels["Devices"], at["v1-devices"])
        self.assertEqual(labels["Diagram"], at["v1-diagram"])
        text = _page_text(doc.pages[0])
        for label, anchor in (("Devices", "v1-devices"), ("Cabling", "v1-cables")):
            m = re.search(rf"{label}[\s.]*(\d+)", text)
            self.assertIsNotNone(m, text)
            self.assertEqual(int(m.group(1)), at[anchor])


def _page_text(page) -> str:
    from weasyprint.formatting_structure import boxes

    out = []

    def walk(box):
        if isinstance(box, boxes.TextBox):
            out.append(box.text)
        for child in getattr(box, "children", []) or []:
            walk(child)

    walk(page._page_box)
    return " ".join(out)


class SharedSheetTests(_Topo):
    """The Export's PDF and the report's diagram page are one builder: a
    change to the sheet reaches both."""

    def test_both_paths_call_the_same_builder_with_the_same_inputs(self):
        when = dt.datetime(2026, 11, 2, 9, 0, tzinfo=dt.UTC)
        svg = tx.sanitize_svg(SVG)
        with mock.patch.object(tx, "topology_sheet", wraps=tx.topology_sheet) as built:
            tx.render_topology_pdf(
                svg,
                title="Core",
                tenant="Acme",
                filters="Site AMS",
                generated=when,
                paper="a4",
                orientation="landscape",
            )
            page = topo.diagram_page(
                svg,
                entry={"title": "Core", "filters": "Site AMS"},
                tenant=self.tenant,
                generated=when,
                paper="a4",
                orientation="landscape",
                title_block=True,
                src=tx.DIAGRAM_URL,
                anchor="v1-diagram",
                bookmark="Diagram",
                level=1,
            )
        self.assertEqual(built.call_count, 2)
        export, report = (c.kwargs for c in built.call_args_list)
        shared = ("title", "tenant", "filters", "generated", "paper", "orientation",
                  "title_block")
        self.assertEqual({k: export[k] for k in shared}, {k: report[k] for k in shared})
        self.assertEqual(built.call_args_list[0].args, built.call_args_list[1].args)
        # And the sheet itself is the Export's, but for its page label.
        sheet = tx.topology_sheet(
            svg, title="Core", tenant="Acme", filters="Site AMS", generated=when,
            paper="a4", orientation="landscape", page_label="",
        )
        self.assertIn(sheet.html.split(">", 1)[1], page)

    def test_the_export_endpoint_uses_it(self):
        with mock.patch.object(tx, "topology_sheet", wraps=tx.topology_sheet) as built:
            pdf = tx.render_topology_pdf(tx.sanitize_svg(SVG), title="Core")
        self.assertTrue(pdf.startswith(b"%PDF-"))
        built.assert_called_once()


@override_settings(CACHES=LOCMEM, REPORT_JOB_TIMEOUT=300, REPORT_JOB_KEEP=3600)
class BackgroundTests(_Topo):
    def test_end_to_end(self):
        from . import object_report as rep

        rendered = []

        def fake(**kwargs):
            rendered.append(kwargs)
            return b"%PDF-1.7 background"

        queue = _Queue()
        with (
            mock.patch.object(rep, "RENDER_BUDGET", 0.0),
            mock.patch.object(topo, "render_with_deadline", side_effect=fake),
            mock.patch.object(rep, "JOB_LOCK_POLL", 0.01),
            mock.patch("django_rq.get_queue", queue),
        ):
            r = self.client.post(
                "/api/topology/report/?print=1",
                {"views": [self.view_entry(self.dev_a)], "options": {"title": "Big"}},
                format="json",
            )
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(queue.name, "low")
        self.assertEqual(rendered[0]["timeout"], 300)
        status = self.client.get(r.json()["status"]).json()
        self.assertEqual(status["state"], "done")
        got = self.client.get(status["url"])
        self.assertEqual(got.content, b"%PDF-1.7 background")
        self.assertIn("big-", got["Content-Disposition"])
        # Another user can't read it.
        self.login(self.member("other", (["device"], ["view"])))
        self.assertEqual(self.client.get(r.json()["status"]).status_code, 404)

    def test_estimate(self):
        with mock.patch.object(topo, "render_with_deadline") as render:
            r = self.client.post(
                "/api/topology/report/?estimate=1",
                {"views": [{**self.view_entry(self.dev_a, self.dev_b), "svg": ""}]},
                format="json",
            )
        render.assert_not_called()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["mode"], "now")
        self.assertEqual(r.json()["pages"], 1)
        self.assertGreater(r.json()["cells"], 0)


class ViewListTests(_Topo):
    def test_summary_list(self):
        r = self.client.post("/api/topology-views/", {"name": "DC1", "state": {}}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        made = r.json()["id"]
        TopologyView.objects.create(tenant=self.tenant, name="DC2")
        settings_row = TenantSettings.for_tenant(self.tenant)
        settings_row.default_topology_view_id = made
        settings_row.save()
        rows = self.client.get("/api/topology-views/?summary=1").json()["results"]
        self.assertEqual([v["name"] for v in rows], ["DC1", "DC2"])
        self.assertNotIn("state", rows[0])
        self.assertTrue(rows[0]["is_default"])
        self.assertFalse(rows[1]["is_default"])
        self.assertEqual(rows[0]["created_by"], "admin")
        self.assertEqual(rows[0]["updated_by"], "admin")
        self.assertEqual(rows[1]["created_by"], "")  # no change log entry
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_type="api.topologyview", object_id=made).exists()
        )

    def test_another_tenants_views_are_not_listed(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="Globex", slug="globex")
        TopologyView.objects.create(tenant=other, name="Theirs")
        rows = self.client.get("/api/topology-views/?summary=1").json()["results"]
        self.assertNotIn("Theirs", [v["name"] for v in rows])
