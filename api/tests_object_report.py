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
        budget = rep.estimate_seconds(cells) + rep.SECONDS_PER_CELL / 2
        with (
            mock.patch.object(rep, "RENDER_BUDGET", budget),
            mock.patch.object(rep, "job_budget", return_value=budget),
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
        self.assertIn("details for at most 1 devices", r.json()["detail"])

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
        shape = {"rows": rows, "list_columns": cols, "pages": 0}
        r = rep.too_slow(body, shape, rep.RENDER_BUDGET)
        self.assertEqual(r.status_code, 400)
        msg = r.data["detail"]
        self.assertIn(f"at most {fit // cols:,} rows with these 9 columns", msg)
        self.assertIn(f"at most {fit // rows} columns for these 2,000 rows", msg)
        small = "<td>x</td>" * 100
        self.assertIsNone(rep.too_slow(small, {"rows": 10, "list_columns": 10, "pages": 0}))
        # By default, against the background budget.
        self.assertIsNone(rep.too_slow(body, shape))

    def test_a_report_past_the_background_budget_is_refused_before_it_renders(self):
        tiny = rep.SECONDS_BASE + rep.SECONDS_PER_CELL
        with (
            mock.patch.object(rep, "RENDER_BUDGET", tiny),
            mock.patch.object(rep, "job_budget", return_value=tiny),
            mock.patch.object(rep, "render_with_deadline") as render,
            mock.patch("django_rq.get_queue") as queue,
        ):
            r = self.client.post("/api/devices/report/", {"filters": {}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("too large to render in time", r.json()["detail"])
        self.assertIn("rows with these", r.json()["detail"])
        render.assert_not_called()
        queue.assert_not_called()

    def test_details_are_named_in_the_refusal(self):
        with (
            mock.patch.object(rep, "RENDER_BUDGET", rep.SECONDS_BASE),
            mock.patch.object(rep, "job_budget", return_value=rep.SECONDS_BASE),
        ):
            r, _ = self.html(
                "devices", {"filters": {}, "options": {"per_object": True, "list_table": False}}
            )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Or leave out the details for each object", r.json()["detail"])

    def test_the_background_budget_is_the_job_deadlines(self):
        with self.settings(REPORT_JOB_TIMEOUT=300):
            self.assertEqual(rep.job_budget(), 210)
            self.assertGreater(rep.cells_that_fit(0, rep.job_budget()), rep.cells_that_fit())
            # The owner's 48 prefixes with details and their IPs (#474 follow-up).
            self.assertLessEqual(rep.estimate_seconds(14207, 48), rep.job_budget())

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


class _Queue:
    """``django_rq.get_queue``'s stand-in: keeps each job, and runs it at
    once when ``run``."""

    def __init__(self, run=True):
        self.run = run
        self.jobs = []
        self.name = None

    def __call__(self, name="default"):
        self.name = name
        return self

    def enqueue(self, func, *args, **kwargs):
        self.jobs.append((func, args, kwargs))
        if self.run:
            func(*args)

    def work(self):
        for func, args, _kwargs in self.jobs:
            func(*args)


TINY = rep.SECONDS_BASE + rep.SECONDS_PER_CELL


class EstimateTests(_Report):
    """``?estimate=1``: the report built but not rendered."""

    def estimate(self, body, path="devices"):
        with mock.patch.object(rep, "render_with_deadline") as render:
            r = self.client.post(f"/api/{path}/report/?estimate=1", body, format="json")
        render.assert_not_called()
        return r

    def test_a_small_report_renders_now(self):
        r = self.estimate({"filters": {}, "columns": {"list": ["name", "status"]}})
        self.assertEqual(r.status_code, 200, r.content)
        got = r.json()
        self.assertEqual(got["mode"], "now")
        self.assertEqual(got["cells"], 4)
        self.assertEqual(got["pages"], 0)
        self.assertEqual(got["seconds"], round(rep.estimate_seconds(4), 1))
        self.assertEqual(got["fits"]["now"], rep.cells_that_fit())
        self.assertEqual(got["fits"]["background"], rep.cells_that_fit(0, rep.job_budget()))
        self.assertNotIn("detail", got)

    def test_details_count_as_pages(self):
        r = self.estimate({"filters": {}, "options": {"per_object": True}})
        self.assertEqual(r.json()["pages"], 2)

    def test_past_the_request_budget_it_renders_in_the_background(self):
        with mock.patch.object(rep, "RENDER_BUDGET", TINY):
            r = self.estimate({"filters": {}})
        self.assertEqual(r.json()["mode"], "background")

    def test_past_the_background_budget_it_is_too_large_and_says_why(self):
        with (
            mock.patch.object(rep, "RENDER_BUDGET", TINY),
            mock.patch.object(rep, "job_budget", return_value=TINY),
        ):
            r = self.estimate({"filters": {}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["mode"], "too_large")
        self.assertIn("too large to render in time", r.json()["detail"])

    def test_the_same_body_is_answered_from_the_cache(self):
        body = {"filters": {}, "columns": {"list": ["name"]}}
        first = self.estimate(body).json()
        with mock.patch.object(rep, "build_report") as build:
            again = self.estimate(body).json()
        build.assert_not_called()
        self.assertEqual(first, again)
        with mock.patch.object(rep, "build_report", wraps=rep.build_report) as build:
            self.estimate({"filters": {}, "columns": {"list": ["name", "site"]}})
        build.assert_called_once()

    def test_another_user_does_not_get_the_cached_estimate(self):
        body = {
            "filters": {},
            "columns": {"list": ["name"]},
            "options": {"list_table": True, "per_object": False},
        }
        self.assertEqual(self.estimate(body).json()["cells"], 2)
        self.login(self.member("ams", (["device"], ["view"]), sites=[self.ams]))
        # One AMS device, not the admin's two.
        self.assertEqual(self.estimate(body).json()["cells"], 1)

    def test_a_refusal_is_the_reports(self):
        with mock.patch.object(rep, "MAX_OBJECTS", 1):
            r = self.estimate({"filters": {}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 1 objects", r.json()["detail"])


@override_settings(CACHES=LOCMEM, REPORT_JOB_TIMEOUT=300, REPORT_JOB_KEEP=3600)
class BackgroundTests(_Report):
    """A report past the request budget renders as an RQ job."""

    def setUp(self):
        super().setUp()
        self.rendered = []

        def fake(**kwargs):
            self.rendered.append(kwargs)
            return b"%PDF-1.7 background"

        for p in (
            mock.patch.object(rep, "RENDER_BUDGET", TINY),
            mock.patch.object(rep, "render_with_deadline", side_effect=fake),
            mock.patch.object(rep, "JOB_LOCK_POLL", 0.01),
        ):
            p.start()
            self.addCleanup(p.stop)

    def post(self, body, queue, path="devices"):
        with mock.patch("django_rq.get_queue", queue):
            return self.client.post(f"/api/{path}/report/?print=1", body, format="json")

    def test_end_to_end(self):
        queue = _Queue()
        r = self.post({"filters": {}, "options": {"title": "All switches"}}, queue)
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(queue.name, "low")
        job = r.json()
        self.assertEqual(job["state"], "queued")
        self.assertTrue(job["status"].startswith("/api/devices/report/job/"))
        self.assertEqual(queue.jobs[0][2]["job_timeout"], rep._job_lifetime())
        # Rendered in the job, with the long deadline.
        self.assertEqual(self.rendered[0]["timeout"], 300)
        self.assertIn("sw-a", self.rendered[0]["html"])
        status = self.client.get(job["status"]).json()
        self.assertEqual(status["state"], "done")
        got = self.client.get(status["url"])
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, b"%PDF-1.7 background")
        self.assertTrue(got["Content-Disposition"].startswith("inline;"))
        self.assertIn("all-switches-", got["Content-Disposition"])
        saved = self.client.get(status["url"] + "?download=1")
        self.assertTrue(saved["Content-Disposition"].startswith("attachment;"))

    def test_progress_while_it_runs(self):
        job = self.post({"filters": {}}, _Queue(run=False)).json()
        self.assertEqual(self.client.get(job["status"]).json(), {"state": "queued"})
        token = job["job"]
        rep._job_update(token, state="running", started=rep.time.time() - 1, seconds=2.0)
        got = self.client.get(job["status"]).json()
        self.assertEqual(got["state"], "running")
        self.assertGreaterEqual(got["progress"], 45)
        self.assertLessEqual(got["progress"], 95)
        file_url = f"/api/devices/report/job/{token}/file/"
        self.assertEqual(self.client.get(file_url).status_code, 404)

    def test_small_reports_stay_in_the_request(self):
        queue = _Queue()
        with mock.patch.object(rep, "RENDER_BUDGET", 1000):
            r = self.post({"filters": {}}, queue)
        self.assertEqual(r.status_code, 200)
        self.assertIn("url", r.json())
        self.assertEqual(queue.jobs, [])

    def test_one_job_per_user_at_a_time(self):
        queue = _Queue(run=False)
        self.assertEqual(self.post({"filters": {}}, queue).status_code, 202)
        self.assertEqual(self.post({"filters": {}}, queue).status_code, 429)
        queue.work()
        self.assertEqual(self.post({"filters": {}}, _Queue()).status_code, 202)

    def test_only_the_owner_reads_it(self):
        job = self.post({"filters": {}}, _Queue()).json()
        token = job["job"]
        url = self.client.get(job["status"]).json()["url"]
        self.login(self.member("o", (["device"], ["view"])))
        self.assertEqual(self.client.get(job["status"]).status_code, 404)
        self.assertEqual(self.client.get(url).status_code, 404)
        # Not through another type's endpoints.
        self.login(self.admin)
        self.assertEqual(self.client.get(f"/api/ips/report/job/{token}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/ips/report/job/{token}/file/").status_code, 404)
        # Nor from another tenant.
        org = Organization.objects.create(name="X", slug="x")
        self.login(self.admin, Tenant.objects.create(org=org, name="X", slug="x"))
        self.assertEqual(self.client.get(job["status"]).status_code, 404)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_it_expires(self):
        job = self.post({"filters": {}}, _Queue()).json()
        url = self.client.get(job["status"]).json()["url"]
        later = rep.time.time() + 3601
        with mock.patch("django.core.cache.backends.locmem.time.time", return_value=later):
            self.assertEqual(self.client.get(job["status"]).status_code, 404)
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_the_job_rechecks_permissions(self):
        user = self.member("d", (["device"], ["view"]))
        self.login(user)
        queue = _Queue(run=False)
        job = self.post({"filters": {}}, queue).json()
        ObjectPermission.objects.filter(users=user).delete()
        queue.work()
        entry = rep._job_get(job["job"])
        self.assertEqual(entry["state"], "failed")
        self.assertIn("may not view devices", entry["detail"])
        self.assertEqual(self.rendered, [])

    def test_the_job_reads_the_users_current_scope(self):
        user = self.member("d", (["device"], ["view"]))
        self.login(user)
        queue = _Queue(run=False)
        job = self.post({"filters": {}}, queue).json()
        ObjectPermission.objects.get(users=user).sites.set([self.ams])
        queue.work()
        self.assertEqual(rep._job_get(job["job"])["state"], "done")
        self.assertIn("sw-a", self.rendered[0]["html"])
        self.assertNotIn("sw-b", self.rendered[0]["html"])

    def test_the_job_stops_when_the_tenant_or_user_is_gone(self):
        user = self.member("d", (["device"], ["view"]))
        self.login(user)
        queue = _Queue(run=False)
        job = self.post({"filters": {}}, queue).json()
        token = job["job"]
        self.tenant.is_active = False
        self.tenant.save()
        queue.work()
        self.assertEqual(rep._job_get(token)["state"], "failed")
        self.assertEqual(self.rendered, [])
        self.tenant.is_active = True
        self.tenant.save()
        user.is_active = False
        user.save()
        queue.work()
        self.assertIn("no longer active", rep._job_get(token)["detail"])
        self.assertEqual(self.rendered, [])

    def test_a_render_past_the_long_deadline_fails_the_job(self):
        with mock.patch.object(rep, "render_with_deadline", side_effect=rep.RenderTimeout):
            job = self.post({"filters": {}}, _Queue()).json()
        got = self.client.get(job["status"]).json()
        self.assertEqual(got["state"], "failed")
        self.assertIn("took too long to render", got["detail"])
        # The user may start another.
        self.assertEqual(self.post({"filters": {}}, _Queue()).status_code, 202)

    def test_the_job_waits_for_the_locks_and_gives_up(self):
        from .drawing_pdf import BUSY_KEY

        cache.set(BUSY_KEY.format(self.admin.pk), "someone", 60)
        with mock.patch.object(rep, "JOB_LOCK_WAIT", 0.05):
            job = self.post({"filters": {}}, _Queue()).json()
        got = self.client.get(job["status"]).json()
        self.assertEqual(got["state"], "failed")
        self.assertIn("Other PDFs are being made", got["detail"])
        self.assertEqual(self.rendered, [])

    def test_a_deleted_api_token_stops_the_job(self):
        from auth_api.models import ApiToken, generate_api_key, hash_api_key

        key = generate_api_key()
        token = ApiToken.objects.create(
            user=self.admin, tenant=self.tenant, name="ci", key_hash=hash_api_key(key)
        )
        self.client.logout()
        queue = _Queue(run=False)
        with mock.patch("django_rq.get_queue", queue):
            r = self.client.post(
                "/api/devices/report/",
                {"filters": {}},
                format="json",
                HTTP_AUTHORIZATION=f"Token {key}",
            )
        self.assertEqual(r.status_code, 202, r.content)
        token.delete()
        queue.work()
        self.assertIn("API token", rep._job_get(r.json()["job"])["detail"])
