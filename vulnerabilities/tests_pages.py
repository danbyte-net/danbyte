"""Phase 7 (#451): the Vulnerabilities page's lists and facets, the
summary's new-this-week count, the Vulnerabilities column and filters on the
Devices and VMs lists, and the SBOM's VEX section - scoping, numbers and
query counts."""
from __future__ import annotations

import datetime
import json

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from api.models import (
    Application,
    Cluster,
    ClusterType,
    Device,
    InstalledSoftware,
    VirtualMachine,
)

from . import matching, vex
from .models import ProductMapping, VulnerabilityMatch, VulnerabilitySettings
from .tests_match_api import HEADER, ApiBase
from .tests_matching import make_cve, xe_range


def pg_range(end):
    m = {"vulnerable": True, "criteria": "cpe:2.3:a:postgresql:postgresql:*:*:*:*:*:*:*:*",
         "versionEndExcluding": end}
    return [{"nodes": [{"operator": "OR", "negate": False, "cpeMatch": [m]}]}]


class PagesBase(ApiBase):
    """Two devices (site A, site B) and a VM (site B) on IOS-XE 17.9.4, and a
    PostgreSQL 16.4 install on the site A device. Records: 0001 fix first
    (9.8, EPSS 0.9), 0002 medium (5.0), 0003 KEV (7.5), 0004 PostgreSQL
    (8.8, EPSS 0.2: high)."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        make_cve("CVE-2024-0003", xe_range("17.9.5"), score=7.5, kev=True)
        ct = ClusterType.objects.create(tenant=cls.tenant, name="CT", slug="ct")
        cluster = Cluster.objects.create(tenant=cls.tenant, name="pve", type=ct)
        cls.vm = VirtualMachine.objects.create(
            tenant=cls.tenant, name="vm1", cluster=cluster, site=cls.site_b,
            platform=cls.xe, software_version="17.9.4")
        cls.pg = Application.objects.create(tenant=cls.tenant, name="PostgreSQL",
                                            slug="postgresql")
        ProductMapping.objects.create(tenant=cls.tenant, application=cls.pg, kind="cpe",
                                      part="a", vendor="postgresql", product="postgresql")
        make_cve("CVE-2024-0004", pg_range("16.5"), score=8.8, epss=0.2)
        cls.inst = InstalledSoftware.objects.create(
            tenant=cls.tenant, application=cls.pg, device=cls.d_a, version="16.4")
        # A clean device: no version, nothing matches.
        cls.d_clean = Device.objects.create(tenant=cls.tenant, name="c1", site=cls.site_a)
        # The other tenant's device on the same product never shows up.
        other_xe = cls.xe.__class__.objects.create(tenant=cls.other, name="XE", slug="xe")
        ProductMapping.objects.create(tenant=cls.other, platform=other_xe, kind="cpe",
                                      part="o", vendor="cisco", product="ios_xe")
        cls.d_other = Device.objects.create(tenant=cls.other, name="o1", platform=other_xe,
                                            software_version="17.9.4")
        matching.recompute(cls.tenant)
        matching.recompute(cls.other)


class RecordListTests(PagesBase):
    def test_rows_counts_and_order(self):
        self.login(self.admin)
        r = self.client.get("/api/vulnerabilities/")
        self.assertEqual(r.status_code, 200)
        rows = {x["id"]: x for x in r.json()["results"]}
        self.assertEqual(list(rows), ["CVE-2024-0001", "CVE-2024-0003", "CVE-2024-0004",
                                      "CVE-2024-0002"])
        self.assertEqual(rows["CVE-2024-0001"]["devices"], 2)
        self.assertEqual(rows["CVE-2024-0001"]["virtual_machines"], 1)
        self.assertEqual(rows["CVE-2024-0001"]["installs"], 0)
        self.assertEqual(rows["CVE-2024-0004"]["installs"], 1)
        self.assertEqual(rows["CVE-2024-0003"]["priority"], "fix_first")
        self.assertTrue(rows["CVE-2024-0003"]["kev"])

    def test_facet_params_search_and_ordering(self):
        self.login(self.admin)
        get = lambda q: [x["id"] for x in self.client.get(  # noqa: E731
            f"/api/vulnerabilities/?{q}").json()["results"]]
        self.assertEqual(get("f_kev=yes"), ["CVE-2024-0003"])
        self.assertEqual(get("f_priority=high,medium"), ["CVE-2024-0004", "CVE-2024-0002"])
        self.assertEqual(get(f"f_application={self.pg.pk}"), ["CVE-2024-0004"])
        self.assertEqual(get("search=0002"), ["CVE-2024-0002"])
        self.assertEqual(get("ordering=score"),
                         ["CVE-2024-0002", "CVE-2024-0003", "CVE-2024-0004", "CVE-2024-0001"])
        self.assertEqual(get("ordering=-virtual_machines&f_priority=fix_first"),
                         ["CVE-2024-0001", "CVE-2024-0003"])
        self.assertEqual(get("f_epss=0.5.."), ["CVE-2024-0001"])
        self.assertEqual(get("f_epss=..0.5&f_priority=high"), ["CVE-2024-0004"])
        self.assertEqual(get("f_first_seen=older"), [])
        self.assertEqual(len(get("f_first_seen=7d")), 4)
        self.assertEqual(self.client.get("/api/vulnerabilities/?f_nope=1").status_code, 400)
        self.assertEqual(self.client.get("/api/vulnerabilities/?ordering=zz").status_code, 400)

    def test_facets_count_records_over_the_other_filters(self):
        self.login(self.admin)
        r = self.client.get("/api/vulnerabilities/facets/?f_priority=fix_first")
        self.assertEqual(r.status_code, 200)
        f = r.json()["facets"]
        counts = {k: {o["value"]: o["count"] for o in v} for k, v in f.items()}
        # Priority ignores its own selection.
        self.assertEqual(counts["priority"], {"fix_first": 2, "high": 1, "medium": 1})
        # Everything else counts fix-first records only.
        self.assertEqual(counts["kev"], {"yes": 1, "no": 1})
        self.assertEqual(counts["site"], {str(self.site_a.pk): 2, str(self.site_b.pk): 2})
        self.assertEqual(counts["platform"], {str(self.xe.pk): 2})
        labels = {o["value"]: o["label"] for o in f["site"]}
        self.assertEqual(labels[str(self.site_a.pk)], "HQ")
        self.assertIn("priority", r.json()["sortable"])

    def test_site_role_and_tenant_scoping(self):
        self.member("local", ["device", "virtualmachine", "installedsoftware"], ["view"],
                    sites=[self.site_b])
        rows = {x["id"]: x for x in self.client.get("/api/vulnerabilities/").json()["results"]}
        self.assertNotIn("CVE-2024-0004", rows)   # the install is in site A
        self.assertEqual(rows["CVE-2024-0001"]["devices"], 1)
        self.assertEqual(rows["CVE-2024-0001"]["virtual_machines"], 1)
        f = self.client.get("/api/vulnerabilities/facets/").json()["facets"]
        self.assertEqual({o["value"] for o in f["site"]}, {str(self.site_b.pk)})
        self.assertEqual(f["application"], [])

    def test_other_tenant_sees_its_own(self):
        self.login(self.admin, self.other)
        r = self.client.get("/api/vulnerabilities/matches/")
        self.assertEqual({m["device"]["id"] for m in r.json()["results"]},
                         {str(self.d_other.pk)})

    def test_off_is_404(self):
        self.login(self.admin)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        for url in ("/api/vulnerabilities/facets/", "/api/vulnerabilities/matches/facets/"):
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_known_params_raise_no_header(self):
        self.login(self.admin)
        for url in (
            "/api/vulnerabilities/?view=table&page=1&page_size=25&ordering=-score"
            "&search=x&f_priority=high&include=",
            "/api/vulnerabilities/matches/?view=table&ordering=host&f_via=platform"
            "&search=x&status=all",
        ):
            with self.subTest(url=url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                self.assertNotIn(HEADER, r)


class MatchListTests(PagesBase):
    def test_facets_count_matches_and_order_by_host(self):
        self.login(self.admin)
        f = self.client.get("/api/vulnerabilities/matches/facets/").json()["facets"]
        counts = {k: {o["value"]: o["count"] for o in v} for k, v in f.items()}
        # 3 hosts x 3 IOS-XE records + 1 install record.
        self.assertEqual(sum(counts["priority"].values()), 10)
        self.assertEqual(counts["via"], {"platform": 9, "application": 1})
        r = self.client.get("/api/vulnerabilities/matches/?ordering=host&f_kev=yes")
        names = [(m["device"] or m["virtual_machine"])["name"] for m in r.json()["results"]]
        self.assertEqual(names, ["a1", "b1", "vm1"])

    def test_record_history_for_the_detail_page(self):
        self.login(self.admin)
        Device.objects.filter(pk=self.d_b.pk).update(software_version="17.9.5")
        matching.recompute(self.tenant)
        r = self.client.get("/api/vulnerabilities/matches/?cve=CVE-2024-0001&status=all")
        rows = {(m["device"] or m["virtual_machine"])["name"]: m for m in r.json()["results"]}
        self.assertIsNotNone(rows["b1"]["resolved_at"])
        self.assertIsNone(rows["a1"]["resolved_at"])


class SummaryTests(PagesBase):
    def test_widget_numbers(self):
        self.login(self.admin)
        old = timezone.now() - datetime.timedelta(days=40)
        VulnerabilityMatch.objects.filter(cve__vuln_id="CVE-2024-0002").update(
            first_seen_at=old)
        body = self.client.get("/api/vulnerabilities/summary/").json()
        self.assertEqual(body["by_priority"],
                         {"fix_first": 2, "high": 1, "medium": 1, "low": 0})
        self.assertEqual(body["kev"], 1)
        self.assertEqual(body["new_this_week"], 3)
        # The list's facet agrees with the number the widget links to.
        r = self.client.get("/api/vulnerabilities/?f_first_seen=7d")
        self.assertEqual(r.json()["count"], 3)


def _rows(client, url):
    return {r["name"]: r for r in client.get(url).json()["results"]}


class HostColumnTests(PagesBase):
    def test_device_rows_carry_the_column(self):
        self.login(self.admin)
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertEqual(rows["a1"]["vulnerabilities"],
                         {"open": 4, "priority": "fix_first", "kev": True})
        self.assertEqual(rows["c1"]["vulnerabilities"],
                         {"open": 0, "priority": "", "kev": False})
        # The plain list stays as it was.
        plain = _rows(self.client, "/api/devices/?page_size=50")
        self.assertIsNone(plain["a1"]["vulnerabilities"])
        vms = _rows(self.client, "/api/virtual-machines/?view=table&page_size=50")
        self.assertEqual(vms["vm1"]["vulnerabilities"]["open"], 3)

    def test_install_needs_its_own_view(self):
        self.member("dev", ["device"], ["view"])
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertEqual(rows["a1"]["vulnerabilities"]["open"], 3)

    def test_page_cost_is_flat(self):
        self.login(self.admin)
        for i in range(12):
            Device.objects.create(tenant=self.tenant, name=f"x{i:02d}", site=self.site_a,
                                  platform=self.xe, software_version="17.9.4")
        matching.recompute(self.tenant)
        for base in ("/api/devices/?view=table", "/api/virtual-machines/?view=table"):
            with self.subTest(base=base):
                with CaptureQueriesContext(connection) as small:
                    self.client.get(f"{base}&page_size=2&ordering=vulnerabilities")
                with CaptureQueriesContext(connection) as big:
                    r = self.client.get(f"{base}&page_size=15&ordering=vulnerabilities")
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(small), len(big))
        self.member("site", ["device", "installedsoftware"], ["view"], sites=[self.site_a])
        with CaptureQueriesContext(connection) as small:
            self.client.get("/api/devices/?view=table&page_size=2")
        with CaptureQueriesContext(connection) as big:
            self.client.get("/api/devices/?view=table&page_size=15")
        self.assertEqual(len(small), len(big))

    def test_facets_sort_and_filters(self):
        self.login(self.admin)
        f = self.client.get("/api/devices/facets/").json()["facets"]
        counts = {o["value"]: o["count"] for o in f["vulnerabilities"]}
        self.assertEqual(counts, {"fix_first": 2, "none": 1})
        self.assertEqual({o["value"]: o["count"] for o in f["vuln_kev"]}, {"yes": 2, "no": 1})
        rows = self.client.get(
            "/api/devices/?view=table&f_vulnerabilities=none").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["c1"])
        names = [r["name"] for r in self.client.get(
            "/api/devices/?view=table&ordering=vulnerabilities").json()["results"]]
        self.assertEqual(names, ["a1", "b1", "c1"])
        get = lambda q: sorted(r["name"] for r in self.client.get(  # noqa: E731
            f"/api/devices/?{q}").json()["results"])
        self.assertEqual(get("vuln_priority=fix_first"), ["a1", "b1"])
        self.assertEqual(get("vuln_priority=none"), ["c1"])
        self.assertEqual(get("vuln_kev=false"), ["c1"])
        self.assertEqual(get("cve_severity=high"), ["a1", "b1"])   # 0003 (7.5) on both
        self.assertEqual(sorted(r["name"] for r in self.client.get(
            "/api/virtual-machines/?vuln_kev=true").json()["results"]), ["vm1"])
        self.assertEqual(self.client.get("/api/devices/?vuln_priority=zz").status_code, 400)
        r = self.client.get("/api/devices/?vuln_priority=high&vuln_kev=1&cve_severity=low")
        self.assertNotIn(HEADER, r)

    def test_off_leaves_lists_alone(self):
        self.login(self.admin)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertIsNone(rows["a1"]["vulnerabilities"])
        f = self.client.get("/api/devices/facets/").json()["facets"]
        self.assertEqual(f["vulnerabilities"], [])
        self.assertEqual(len(_rows(self.client, "/api/devices/?vuln_priority=fix_first")), 3)
        self.assertEqual(self.client.get(
            "/api/devices/?view=table&ordering=vulnerabilities").status_code, 200)


class HostSummaryTests(PagesBase):
    """``vulnerability_summary`` on the device and VM table rows and detail
    reads: the open matches the host's Vulnerabilities tab lists by default."""

    def _exception(self):
        from .models import VulnerabilityException

        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=self.cve, device=self.d_b, status="not_applicable",
            reason="Web UI off", owner=self.admin, owner_name="root",
            analysis_justification="code_not_reachable")

    def test_table_rows_and_detail(self):
        self.login(self.admin)
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        full = {"open": 4, "worst_severity": "critical", "max_cvss": 9.8, "fix_first": 2,
                "kev": 1}
        self.assertEqual(rows["a1"]["vulnerability_summary"], full)
        self.assertEqual(rows["c1"]["vulnerability_summary"],
                         {"open": 0, "worst_severity": "", "max_cvss": None, "fix_first": 0,
                          "kev": 0})
        r = self.client.get(f"/api/devices/{self.d_a.pk}/")
        self.assertEqual(r.json()["vulnerability_summary"], full)
        # The tab's open rows are the same matches.
        tab = self.client.get(f"/api/devices/{self.d_a.pk}/vulnerabilities/").json()
        self.assertEqual(tab["count"], full["open"])
        self.assertIsNone(_rows(self.client, "/api/devices/?page_size=50")["a1"]
                          ["vulnerability_summary"])
        vm = self.client.get(f"/api/virtual-machines/{self.vm.pk}/").json()
        self.assertEqual(vm["vulnerability_summary"],
                         {"open": 3, "worst_severity": "critical", "max_cvss": 9.8,
                          "fix_first": 2, "kev": 1})
        vms = _rows(self.client, "/api/virtual-machines/?view=table&page_size=50")
        self.assertEqual(vms["vm1"]["vulnerability_summary"]["open"], 3)

    def test_exception_is_left_out(self):
        self._exception()
        self.login(self.admin)
        r = self.client.get(f"/api/devices/{self.d_b.pk}/").json()
        self.assertEqual(r["vulnerability_summary"],
                         {"open": 2, "worst_severity": "high", "max_cvss": 7.5,
                          "fix_first": 1, "kev": 1})
        tab = self.client.get(f"/api/devices/{self.d_b.pk}/vulnerabilities/").json()
        self.assertEqual(tab["count"], 2)

    def test_install_needs_its_own_view(self):
        self.member("dev", ["device"], ["view"])
        r = self.client.get(f"/api/devices/{self.d_a.pk}/").json()
        self.assertEqual(r["vulnerability_summary"]["open"], 3)
        self.assertEqual(r["vulnerability_summary"]["max_cvss"], 9.8)

    def test_tenant_isolation(self):
        self.login(self.admin, self.other)
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertEqual(set(rows), {"o1"})
        self.assertEqual(rows["o1"]["vulnerability_summary"]["open"], 3)
        self.assertEqual(self.client.get(f"/api/devices/{self.d_a.pk}/").status_code, 404)

    def test_off_is_null(self):
        self.login(self.admin)
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertIsNone(rows["a1"]["vulnerability_summary"])
        self.assertIsNone(
            self.client.get(f"/api/devices/{self.d_a.pk}/").json()["vulnerability_summary"])
        self.assertIsNone(
            self.client.get(f"/api/virtual-machines/{self.vm.pk}/").json()
            ["vulnerability_summary"])
        self.assertEqual(self.client.get(
            "/api/devices/?view=table&ordering=vuln_score").status_code, 200)

    def test_order_by_top_score(self):
        self._exception()
        self.login(self.admin)
        names = lambda o: [r["name"] for r in self.client.get(  # noqa: E731
            f"/api/devices/?view=table&ordering={o}").json()["results"]]
        self.assertEqual(names("-vuln_score"), ["a1", "b1", "c1"])
        self.assertEqual(names("vuln_score"), ["b1", "a1", "c1"])

    def test_page_cost_is_flat(self):
        for i in range(12):
            Device.objects.create(tenant=self.tenant, name=f"x{i:02d}", site=self.site_a,
                                  platform=self.xe, software_version="17.9.4")
        matching.recompute(self.tenant)
        for user in (self.admin, None):
            if user:
                self.login(user)
            else:
                self.member("site", ["device", "virtualmachine", "installedsoftware"],
                            ["view"], sites=[self.site_a])
            for base in ("/api/devices/?view=table&ordering=-vuln_score",
                         "/api/virtual-machines/?view=table&ordering=-vuln_score"):
                with self.subTest(base=base, superuser=bool(user)):
                    with CaptureQueriesContext(connection) as small:
                        self.client.get(f"{base}&page_size=2")
                    with self.assertNumQueries(len(small)):
                        r = self.client.get(f"{base}&page_size=15")
                    self.assertEqual(r.status_code, 200)


class VexTests(PagesBase):
    def doc(self, query="vex=1"):
        r = self.client.get(f"/api/sbom/?{query}")
        self.assertEqual(r.status_code, 200)
        return json.loads(r.content)

    def test_section_names_the_document_components(self):
        self.login(self.admin)
        doc = self.doc()
        refs = {c["bom-ref"] for c in doc["components"]}
        refs |= {k["bom-ref"] for c in doc["components"] for k in c.get("components", [])}
        vulns = {v["id"]: v for v in doc["vulnerabilities"]}
        self.assertEqual(set(vulns), {"CVE-2024-0001", "CVE-2024-0002", "CVE-2024-0003",
                                      "CVE-2024-0004"})
        affects = {a["ref"] for v in doc["vulnerabilities"] for a in v["affects"]}
        self.assertLessEqual(affects, refs)
        one = vulns["CVE-2024-0001"]
        self.assertEqual({a["ref"] for a in one["affects"]}, {
            f"danbyte:device:{self.d_a.pk}:os", f"danbyte:device:{self.d_b.pk}:os",
            f"danbyte:virtual_machine:{self.vm.pk}:os"})
        self.assertEqual(one["affects"][0]["versions"], [{"version": "17.9.4",
                                                          "status": "affected"}])
        self.assertEqual(one["ratings"][0]["score"], 9.8)
        self.assertEqual(one["ratings"][0]["severity"], "critical")
        self.assertEqual(one["analysis"], {"state": "in_triage"})
        self.assertEqual(vulns["CVE-2024-0003"]["analysis"]["state"], "exploitable")
        self.assertEqual(vulns["CVE-2024-0004"]["affects"],
                         [{"ref": f"danbyte:installedsoftware:{self.inst.pk}",
                           "versions": [{"version": "16.4", "status": "affected"}]}])
        self.assertIn({"name": "danbyte:priority", "value": "fix_first"}, one["properties"])

    def test_opt_in_and_off(self):
        self.login(self.admin)
        self.assertNotIn("vulnerabilities", self.doc(""))
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        self.assertNotIn("vulnerabilities", self.doc())

    def test_filters_and_scope(self):
        self.login(self.admin)
        doc = self.doc(f"vex=1&device={self.d_b.pk}")
        affects = {a["ref"] for v in doc["vulnerabilities"] for a in v["affects"]}
        self.assertEqual(affects, {f"danbyte:device:{self.d_b.pk}:os"})
        # A site-scoped reader without installs: no other site, no install.
        self.member("local", ["device", "virtualmachine"], ["view"], sites=[self.site_a])
        doc = self.doc()
        affects = {a["ref"] for v in doc["vulnerabilities"] for a in v["affects"]}
        self.assertEqual(affects, {f"danbyte:device:{self.d_a.pk}:os"})
        text = json.dumps(doc)
        self.assertNotIn(str(self.d_b.pk), text)
        self.assertNotIn(str(self.inst.pk), text)

    def test_provider_splits_entries(self):
        self.login(self.admin)

        def provider(m):
            if m.device_id == self.d_b.pk and m.cve.vuln_id == "CVE-2024-0001":
                return {"state": "not_affected", "justification": "code_not_reachable"}
            return None

        vex.register_analysis(provider)
        try:
            doc = self.doc()
        finally:
            vex.unregister_analysis(provider)
        ones = [v for v in doc["vulnerabilities"] if v["id"] == "CVE-2024-0001"]
        self.assertEqual(len(ones), 2)
        states = {v["analysis"]["state"]: {a["ref"] for a in v["affects"]} for v in ones}
        self.assertEqual(states["not_affected"], {f"danbyte:device:{self.d_b.pk}:os"})
        self.assertEqual(len({v["bom-ref"] for v in ones}), 2)


class ExceptedTests(PagesBase):
    """An exception (Phase 8) on CVE-2024-0001 for b1: out of the counts,
    the column and the open work; in the Excepted facet and the VEX."""

    def setUp(self):
        from .models import VulnerabilityException

        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=self.cve, device=self.d_b, status="not_applicable",
            reason="Web UI off", owner=self.admin, owner_name="root",
            analysis_justification="code_not_reachable")
        self.login(self.admin)

    def test_record_list_and_facet(self):
        rows = {x["id"]: x for x in self.client.get("/api/vulnerabilities/").json()["results"]}
        self.assertEqual(rows["CVE-2024-0001"]["devices"], 1)
        self.assertEqual(rows["CVE-2024-0001"]["excepted"], 1)
        r = self.client.get("/api/vulnerabilities/?f_excepted=yes").json()["results"]
        self.assertEqual([(x["id"], x["devices"]) for x in r], [("CVE-2024-0001", 1)])
        f = self.client.get("/api/vulnerabilities/facets/").json()["facets"]
        self.assertEqual({o["value"]: o["count"] for o in f["excepted"]}, {"yes": 1, "no": 4})
        m = self.client.get("/api/vulnerabilities/matches/?f_excepted=yes").json()
        self.assertEqual(m["count"], 1)
        self.assertEqual(m["results"][0]["exception"]["status"], "not_applicable")
        self.assertEqual(self.client.get("/api/vulnerabilities/matches/").json()["count"], 9)

    def test_column_leaves_it_out(self):
        rows = _rows(self.client, "/api/devices/?view=table&page_size=50")
        self.assertEqual(rows["b1"]["vulnerabilities"]["open"], 2)
        self.assertEqual(rows["a1"]["vulnerabilities"]["open"], 4)

    def test_vex_takes_the_exception(self):
        doc = json.loads(self.client.get("/api/sbom/?vex=1").content)
        ones = [v for v in doc["vulnerabilities"] if v["id"] == "CVE-2024-0001"]
        states = {v["analysis"]["state"]: v for v in ones}
        self.assertEqual({a["ref"] for a in states["not_affected"]["affects"]},
                         {f"danbyte:device:{self.d_b.pk}:os"})
        self.assertEqual(states["not_affected"]["analysis"]["justification"],
                         "code_not_reachable")
