"""Object reports: ``/api/devices/report/``, ``/api/prefixes/report/`` and
``/api/ips/report/`` - what a report can hold, each type's sections, the
columns picked, the caps, the reader's object permissions (a section the
reader may not view left out, ids outside their scope ignored and never
named), the tenant fence, and a real render."""

from __future__ import annotations

import re
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from audit.models import JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from customization.models import CustomField

from . import object_report as rep
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    IPRange,
    IPRole,
    NATRule,
    Prefix,
    Site,
    Status,
)
from .tests_elevation_pdf import _pdf_objects

User = get_user_model()
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


@override_settings(CACHES=LOCMEM)
class _Report(APITestCase):
    """Two sites; sw-a (AMS) with two interfaces, an address, a cable to
    sw-b (LON), a journal note and a custom field; a /24 with a child /28,
    two addresses and a range."""

    def setUp(self):
        cache.clear()
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.active = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active", color="#16a34a"
        )
        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned", color="#fde047"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Leaf", slug="leaf", color="#2563eb"
        )
        self.dtype = DeviceType.objects.create(tenant=self.tenant, name="1U", u_height=1)
        CustomField.objects.create(
            tenant=self.tenant,
            key="owner_team",
            label="Owner team",
            type="text",
            applies_to=["device"],
        )
        self.dev_a = Device.objects.create(
            tenant=self.tenant,
            name="sw-a",
            site=self.ams,
            device_type=self.dtype,
            role=self.role,
            status=self.active,
            serial_number="SN-A1",
            custom_fields={"owner_team": "Core net"},
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant,
            name="sw-b",
            site=self.lon,
            device_type=self.dtype,
            status=self.planned,
            serial_number="SN-B1",
        )
        self.if_a = Interface.objects.create(device=self.dev_a, name="eth-uplink")
        Interface.objects.create(device=self.dev_a, name="eth-spare")
        self.if_b = Interface.objects.create(device=self.dev_b, name="eth-down")
        self.cable = Cable.objects.create(tenant=self.tenant, label="C-77")
        CableTermination.objects.create(cable=self.cable, end="A", interface=self.if_a)
        CableTermination.objects.create(cable=self.cable, end="B", interface=self.if_b)
        self.net = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", status=self.active, site=self.ams
        )
        self.child = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.16/28", status=self.planned, site=self.ams
        )
        self.ip_role = IPRole.objects.create(
            tenant=self.tenant, name="Gateway", slug="gateway", color="#7c3aed"
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant,
            ip_address="10.9.0.1",
            prefix=self.net,
            status=self.active,
            role=self.ip_role,
            dns_name="gw.ams.example",
            assigned_device=self.dev_a,
            assigned_interface=self.if_a,
        )
        self.ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.40", prefix=self.net, status=self.planned
        )
        IPRange.objects.create(
            tenant=self.tenant,
            start_address="10.9.0.100",
            end_address="10.9.0.120",
            prefix=self.net,
        )
        JournalEntry.objects.create(
            tenant=self.tenant,
            object_type="api.device",
            object_id=str(self.dev_a.pk),
            comments="Swapped PSU 2",
            kind="info",
        )
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, name, *grants, sites=()):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            p = ObjectPermission.objects.create(
                name=f"{name}-{i}",
                object_types=list(types),
                actions=list(actions),
            )
            p.users.add(u)
            p.tenants.add(self.tenant)
            if sites:
                p.sites.set(sites)
        return u

    def html(self, path, body, query=""):
        """The page the report would render, and the response."""
        seen = {}

        def fake(**kwargs):
            seen["html"] = kwargs["html"]
            return b"%PDF-1.7 fake"

        with mock.patch.object(rep, "render_with_deadline", side_effect=fake):
            r = self.client.post(f"/api/{path}/report/{query}", body, format="json")
        return r, seen.get("html", "")

    def ok(self, path, body):
        r, html = self.html(path, body)
        self.assertEqual(r.status_code, 200, r.content[:500])
        self.assertEqual(r["Content-Type"], "application/pdf")
        return html


class DescribeTests(_Report):
    def test_each_type_lists_its_columns_and_sections(self):
        for path, section in (
            ("devices", "interfaces"),
            ("prefixes", "child_prefixes"),
            ("ips", "nat"),
        ):
            with self.subTest(path=path):
                r = self.client.get(f"/api/{path}/report/")
                self.assertEqual(r.status_code, 200, r.content)
                body = r.json()
                self.assertTrue(body["default_columns"])
                keys = {s["key"]: s for s in body["sections"]}
                self.assertIn("overview", keys)
                self.assertTrue(keys[section]["available"])
                self.assertTrue(keys[section]["columns"])
                self.assertEqual(body["limits"]["objects"], rep.MAX_OBJECTS)

    def test_custom_fields_are_columns(self):
        body = self.client.get("/api/devices/report/").json()
        self.assertIn("cf.owner_team", [c["key"] for c in body["columns"]])

    def test_a_section_the_reader_may_not_view_is_marked(self):
        self.login(self.member("d", (["device"], ["view"])))
        body = self.client.get("/api/devices/report/").json()
        keys = {s["key"]: s for s in body["sections"]}
        self.assertFalse(keys["interfaces"]["available"])
        self.assertEqual(keys["interfaces"]["columns"], [])
        self.assertTrue(keys["overview"]["available"])

    def test_no_view_on_the_type_is_refused(self):
        self.login(self.member("p", (["prefix"], ["view"])))
        self.assertEqual(self.client.get("/api/devices/report/").status_code, 403)
        r, _ = self.html("devices", {"ids": [str(self.dev_a.pk)]})
        self.assertEqual(r.status_code, 403)


class DeviceTests(_Report):
    def test_one_device_with_its_sections(self):
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk)],
                "sections": ["overview", "interfaces", "ip_addresses", "cables", "journal"],
            },
        )
        self.assertIn("Device sw-a", html)
        for text in (
            "eth-uplink",
            "eth-spare",
            "10.9.0.1",
            "C-77",
            "Swapped PSU 2",
            "Core net",
            "SN-A1",
            "Acme",
        ):
            self.assertIn(text, html)
        # The cable's far end, and the status and role as their badges.
        self.assertIn("sw-b · eth-down", html)
        self.assertIn("background:#16a34a", html)
        self.assertIn("background:#2563eb", html)
        # One object: no list table.
        self.assertNotIn("section class='list'", html)

    def test_sections_left_out_are_not_printed(self):
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["overview"]})
        self.assertNotIn("eth-uplink", html)
        self.assertNotIn("Swapped PSU 2", html)

    def test_columns_are_the_ones_picked_in_order(self):
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk), str(self.dev_b.pk)],
                "columns": {"list": ["serial_number", "name", "cf.owner_team", "nope"]},
            },
        )
        head = re.search(r"<section class='list'>.*?<thead><tr>(.*?)</tr>", html).group(1)
        self.assertEqual(
            re.findall(r"<th(?: [^>]*)?>(.*?)</th>", head), ["Serial number", "Name", "Owner team"]
        )
        self.assertIn("Core net", html)

    def test_section_columns(self):
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk)],
                "sections": ["interfaces"],
                "columns": {"interfaces": ["name", "description"]},
            },
        )
        self.assertEqual(
            re.findall(r"<th(?: [^>]*)?>(.*?)</th>", html)[:2], ["Name", "Description"]
        )

    def test_the_list_with_a_summary_and_groups(self):
        html = self.ok(
            "devices",
            {
                "filters": {},
                "options": {"include_summary": True, "group_by": "site"},
            },
        )
        self.assertIn("By status", html)
        self.assertIn("Devices by site", html)
        self.assertIn("<h3>AMS", html)
        self.assertIn("<h3>LON", html)

    def test_filters_are_the_lists(self):
        html = self.ok("devices", {"filters": {"search": "sw-b"}})
        self.assertIn("sw-b", html)
        self.assertNotIn("SN-A1", html)

    def test_pages_per_object(self):
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk), str(self.dev_b.pk)],
                "sections": ["interfaces"],
                "options": {"per_object": True},
            },
        )
        self.assertEqual(html.count("<section class='object"), 2)
        self.assertIn("eth-down", html)


class PrefixAndIpTests(_Report):
    def test_a_prefix(self):
        html = self.ok(
            "prefixes",
            {
                "ids": [str(self.net.pk)],
                "sections": ["overview", "utilisation", "child_prefixes", "ip_addresses", "ranges"],
            },
        )
        self.assertIn("Prefix 10.9.0.0/24", html)
        for text in (
            "10.9.0.16/28",
            "10.9.0.1",
            "10.9.0.40",
            "gw.ams.example",
            "10.9.0.100",
            "Usable addresses",
            "254",
            "class='ubar'",
        ):
            self.assertIn(text, html)
        self.assertIn("background:#7c3aed", html)  # the IP role's badge

    def test_the_list_shows_each_prefixs_ips(self):
        ids = [str(self.net.pk), str(self.child.pk)]
        html = self.ok("prefixes", {"ids": ids})
        self.assertNotIn("table class='grid ips'", html)
        html = self.ok("prefixes", {"ids": ids, "options": {"show_ips": True, "list_table": True}})
        self.assertEqual(html.count("table class='grid ips'"), 1)  # the /28 has none
        for text in ("gw.ams.example", "10.9.0.40", "sw-a · eth-uplink", "Assigned to"):
            self.assertIn(text, html)
        self.assertIn("background:#7c3aed", html)
        self.assertTrue(self.client.get("/api/prefixes/report/").json()["show_ips"])
        self.assertFalse(self.client.get("/api/devices/report/").json()["show_ips"])

    def test_show_ips_counts_against_the_row_caps(self):
        with mock.patch.object(rep, "MAX_SECTION_ROWS", 1):
            html = self.ok(
                "prefixes",
                {"ids": [str(self.net.pk)], "options": {"show_ips": True, "list_table": True}},
            )
        self.assertIn("Only the first 1 of 2 IP addresses are listed.", html)
        with mock.patch.object(rep, "MAX_TOTAL_ROWS", 0):
            html = self.ok(
                "prefixes",
                {"ids": [str(self.net.pk)], "options": {"show_ips": True, "list_table": True}},
            )
        self.assertNotIn("gw.ams.example", html)

    def test_show_ips_cells_count_in_the_estimate(self):
        lean = {"list_table": True, "per_object": False}
        body = {"ids": [str(self.net.pk)], "options": {**lean, "show_ips": True}}
        _, plain = self.html("prefixes", {**body, "options": lean})
        _, more = self.html("prefixes", body)
        cells = plain.count("<td")
        self.assertGreater(more.count("<td"), cells)
        with mock.patch.object(
            rep, "RENDER_BUDGET", rep.estimate_seconds(cells) + rep.SECONDS_PER_CELL / 2
        ):
            self.ok("prefixes", {**body, "options": lean})
            r, _ = self.html("prefixes", body)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Or leave out Show IPs", r.json()["detail"])

    def test_show_ips_needs_view_on_ips(self):
        self.login(self.member("p", (["prefix"], ["view"])))
        self.assertFalse(self.client.get("/api/prefixes/report/").json()["show_ips"])
        html = self.ok(
            "prefixes",
            {"ids": [str(self.net.pk)], "options": {"show_ips": True, "list_table": True}},
        )
        self.assertIn("10.9.0.0/24", html)
        self.assertNotIn("gw.ams.example", html)

    def test_an_ip(self):
        NATRule.objects.create(
            tenant=self.tenant, name="web-in", external_ip=self.ip, internal_ip=self.ip2
        )
        html = self.ok(
            "ips",
            {"ids": [str(self.ip.pk)], "sections": ["overview", "assignment", "nat", "history"]},
        )
        self.assertIn("IP address 10.9.0.1", html)
        self.assertIn("sw-a", html)
        self.assertIn("eth-uplink", html)
        self.assertIn("web-in", html)


class LimitTests(_Report):
    def test_too_many_ids(self):
        with mock.patch.object(rep, "MAX_OBJECTS", 1):
            r, _ = self.html("devices", {"ids": [str(self.dev_a.pk), str(self.dev_b.pk)]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 1 objects", r.content.decode())

    def test_too_many_rows_matched(self):
        with mock.patch.object(rep, "MAX_OBJECTS", 1):
            r, _ = self.html("devices", {"filters": {}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 1 objects; this one has 2", r.json()["detail"])

    def test_too_many_pages(self):
        with mock.patch.object(rep, "MAX_OBJECT_PAGES", 1):
            r, _ = self.html("devices", {"filters": {}, "options": {"per_object": True}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 1 objects", r.json()["detail"])

    def test_section_rows_are_capped_with_a_note(self):
        with mock.patch.object(rep, "MAX_SECTION_ROWS", 1):
            html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["interfaces"]})
        self.assertIn("Only the first 1 of 2 interfaces are listed.", html)

    def test_journal_takes_the_latest(self):
        JournalEntry.objects.create(
            tenant=self.tenant,
            object_type="api.device",
            object_id=str(self.dev_a.pk),
            comments="Newer note",
            kind="info",
        )
        html = self.ok(
            "devices",
            {"ids": [str(self.dev_a.pk)], "sections": ["journal"], "options": {"last": 1}},
        )
        self.assertIn("Newer note", html)
        self.assertNotIn("Swapped PSU 2", html)
        self.assertIn("The latest 1 of 2.", html)

    def test_unknown_section_and_bad_filters(self):
        r, _ = self.html("devices", {"ids": [str(self.dev_a.pk)], "sections": ["nope"]})
        self.assertEqual(r.status_code, 400)
        r, _ = self.html("devices", {"filters": {"search": {"x": 1}}})
        self.assertEqual(r.status_code, 400)

    def test_paging_filters_are_ignored(self):
        html = self.ok("devices", {"filters": {"page_size": "1", "picker": "palette"}})
        self.assertIn("sw-a", html)
        self.assertIn("sw-b", html)

    def test_print_link(self):
        r, _ = self.html("devices", {"ids": [str(self.dev_a.pk)]}, query="?print=1")
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()["url"]
        self.assertTrue(url.startswith("/api/devices/report/file/"))
        got = self.client.get(url)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 fake")
        self.login(self.member("o", (["device"], ["view"])))
        self.assertEqual(self.client.get(url).status_code, 404)


class ScopeTests(_Report):
    def test_a_section_the_reader_may_not_view_is_left_out_with_a_note(self):
        self.login(self.member("d", (["device"], ["view"])))
        html = self.ok(
            "devices",
            {"ids": [str(self.dev_a.pk)], "sections": ["overview", "interfaces", "cables"]},
        )
        self.assertIn("sw-a", html)
        self.assertNotIn("eth-uplink", html)
        self.assertNotIn("C-77", html)
        self.assertIn("Interfaces left out: you may not view interfaces.", html)

    def test_site_scoped_reader_sees_only_their_rows(self):
        user = self.member(
            "ams", (["device", "interface", "cable", "ipaddress"], ["view"]), sites=[self.ams]
        )
        self.login(user)
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk), str(self.dev_b.pk)],
                "options": {"per_object": True},
                "sections": ["interfaces"],
                "columns": {"interfaces": ["name", "type"]},
            },
        )
        self.assertIn("sw-a", html)
        # LON's device is ignored, as the list ignores it, and never named.
        self.assertNotIn("sw-b", html)
        self.assertNotIn("SN-B1", html)
        self.assertNotIn("eth-down", html)
        r, _ = self.html("devices", {"ids": [str(self.dev_b.pk)]})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("sw-b", r.content.decode())

    def test_another_tenants_ids_are_ignored(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        site = Site.objects.create(tenant=other, name="FAR")
        theirs = Device.objects.create(
            tenant=other, name="far-sw", site=site, device_type=self.dtype
        )
        html = self.ok("devices", {"ids": [str(self.dev_a.pk), str(theirs.pk)]})
        self.assertNotIn("far-sw", html)
        r, _ = self.html("devices", {"ids": [str(theirs.pk)]})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("far-sw", r.content.decode())


class RenderTests(_Report):
    def test_a_real_render(self):
        r = self.client.post(
            "/api/devices/report/",
            {
                "filters": {},
                "sections": [
                    "overview",
                    "interfaces",
                    "ip_addresses",
                    "cables",
                    "journal",
                    "monitoring",
                    "photo",
                ],
                "options": {
                    "include_summary": True,
                    "per_object": True,
                    "paper": "letter",
                    "orientation": "landscape",
                    "title": "Switches",
                },
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF-"))
        self.assertIn("switches-", r["Content-Disposition"])
        objects = _pdf_objects(r.content)
        pages = len(re.findall(rb"/Type\s*/Page(?![s\w])", objects))
        # The list and summary, then a page for each device.
        self.assertGreaterEqual(pages, 3)

    def test_a_real_render_of_an_ip(self):
        r = self.client.post("/api/ips/report/", {"ids": [str(self.ip.pk)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF-"))


class RenderCostTests(_Report):
    """The estimate a report is refused on before it renders (#474)."""

    def test_the_estimate_grows_with_cells_and_pages(self):
        self.assertLess(rep.estimate_seconds(100), rep.estimate_seconds(1000))
        self.assertLess(rep.estimate_seconds(100), rep.estimate_seconds(100, pages=10))
        fit = rep.cells_that_fit()
        self.assertLessEqual(rep.estimate_seconds(fit), rep.RENDER_BUDGET)
        self.assertGreater(rep.estimate_seconds(fit + 10), rep.RENDER_BUDGET)
        self.assertLess(rep.cells_that_fit(pages=50), fit)
        self.assertLess(rep.RENDER_BUDGET, rep.RENDER_TIMEOUT)

    def test_too_slow_says_what_fits(self):
        fit = rep.cells_that_fit()
        rows, cols = 2000, 9
        body = "<td>x</td>" * (rows * cols)
        r = rep.too_slow(body, {"rows": rows, "list_columns": cols, "pages": 0})
        self.assertEqual(r.status_code, 400)
        msg = r.data["detail"]
        self.assertIn(f"at most {fit // cols:,} rows with these 9 columns", msg)
        self.assertIn(f"at most {fit // rows} columns for these 2,000 rows", msg)
        small = "<td>x</td>" * 100
        self.assertIsNone(rep.too_slow(small, {"rows": 10, "list_columns": 10, "pages": 0}))

    def test_a_report_past_the_budget_is_refused_before_it_renders(self):
        with (
            mock.patch.object(rep, "RENDER_BUDGET", rep.SECONDS_BASE + rep.SECONDS_PER_CELL),
            mock.patch.object(rep, "render_with_deadline") as render,
        ):
            r = self.client.post("/api/devices/report/", {"filters": {}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("too large to render in time", r.json()["detail"])
        self.assertIn("rows with these", r.json()["detail"])
        render.assert_not_called()

    def test_pages_per_object_are_named_in_the_refusal(self):
        with mock.patch.object(rep, "RENDER_BUDGET", rep.SECONDS_BASE):
            r, _ = self.html(
                "devices", {"filters": {}, "options": {"per_object": True, "list_table": False}}
            )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Or leave out the pages per object", r.json()["detail"])

    def test_a_render_past_the_deadline_is_503(self):
        with mock.patch.object(rep, "render_with_deadline", side_effect=rep.RenderTimeout):
            r = self.client.post("/api/devices/report/", {"filters": {}}, format="json")
        self.assertEqual(r.status_code, 503)
        self.assertIn("took too long to render", r.json()["detail"])

    def test_describe_says_how_many_cells_fit(self):
        r = self.client.get("/api/ips/report/")
        self.assertEqual(r.json()["limits"]["cells"], rep.cells_that_fit())

    def test_rows_render_within_the_estimate(self):
        import time

        from django.utils import timezone

        cols = [rep.Column(f"c{i}", f"Column {i}", "text", f"c{i}") for i in range(9)]
        cols[1] = rep.Column("status", "Status", "object", "status")
        rows = [
            {
                **{f"c{i}": f"value-{n}-{i}" for i in range(9)},
                "status": {"name": "Active", "color": "#16a34a"},
            }
            for n in range(150)
        ]
        body = rep.table_html(rows, cols)
        self.assertIn("width:", body.split("</thead>")[0])
        html = rep.report_html(
            title="t",
            tenant="t",
            generated=timezone.now(),
            paper="a4",
            orientation="landscape",
            body=body,
        )
        self.assertIn("table-layout:fixed", html)
        rep.render_report_pdf(b"", html="<p>warm</p>")
        start = time.perf_counter()
        pdf = rep.render_report_pdf(b"", html=html)
        took = time.perf_counter() - start
        self.assertTrue(pdf.startswith(b"%PDF-"))
        # Generous: a loaded test box is slower than the calibration box.
        self.assertLess(took, rep.estimate_seconds(body.count("<td")) * 2)
