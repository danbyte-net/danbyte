"""#520: the stored match rank, the per-record counts and the lists read
from them - against the ground truth, under exceptions, KEV and policy
changes, for site-bound roles, and at a flat query cost."""
from __future__ import annotations

import datetime
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from api.models import Device

from . import exceptions, jobs, list_api, matching, priority, record_stats, signals, stat_lists
from .models import (
    Cve,
    VulnerabilityException,
    VulnerabilityMatch,
    VulnerabilityMatchGroup,
    VulnerabilityPolicy,
    VulnerabilityRecordStat,
)
from .tests_match_api import match_writes
from .tests_pages import PagesBase

QUERIES = [
    "",
    "f_priority=fix_first",
    "f_kev=yes",
    "f_severity=high,medium",
    "f_epss=0.5..",
    "search=0001",
    "priority=high,medium",
    "ordering=-devices",
    "ordering=first_seen",
    "ordering=severity",
    "ordering=-epss",
    "f_first_seen=7d",
    "f_excepted=yes",
    "f_excepted=yes,no&f_priority=high,fix_first",
    "f_via=platform",
    "f_confidence=exact",
    "f_site=__none__",
]


def stored(tenant):
    """The tenant's stored counts in ``record_stats.compute``'s shape."""
    stats = {r.cve_id: {f: getattr(r, f) for f in record_stats._FIELDS}
             for r in VulnerabilityRecordStat.objects.filter(tenant=tenant)}
    groups = {tuple(getattr(g, f) for f in record_stats._GROUP_KEY): g.matches
              for g in VulnerabilityMatchGroup.objects.filter(tenant=tenant)}
    return stats, groups


class StatBase(PagesBase):
    def commit(self, fn):
        # The test case is one transaction: drop the flush the setup's own
        # saves registered, so the block below gets (and runs) its own.
        connection.run_on_commit = [e for e in connection.run_on_commit
                                    if e[1] is not signals._flush]
        with self.captureOnCommitCallbacks(execute=True):
            fn()

    def assert_stats_true(self, tenant=None):
        tenant = tenant or self.tenant
        self.assertEqual(stored(tenant), record_stats.compute(tenant.pk))

    def both(self, url):
        """The answer from the per-record counts and from the matches."""
        fast = self.client.get(url)
        with mock.patch.object(stat_lists, "usable", return_value=False):
            slow = self.client.get(url)
        self.assertEqual(fast.status_code, 200, fast.content)
        self.assertEqual(slow.status_code, 200, slow.content)
        return fast.json(), slow.json()

    def assert_same_answers(self):
        self.login(self.admin)
        queries = [*QUERIES, f"f_site={self.site_b.pk}", f"f_platform={self.xe.pk}",
                   f"f_application={self.pg.pk}&f_kev=no"]
        for q in queries:
            with self.subTest(q=q):
                record_q = q.replace("f_via=platform", "").replace("f_confidence=exact", "")
                fast, slow = self.both(f"/api/vulnerabilities/?{record_q}")
                self.assertEqual(fast, slow)
                fast, slow = self.both(f"/api/vulnerabilities/facets/?{record_q}")
                self.assertEqual(_sorted(fast), _sorted(slow))
                fast, slow = self.both(f"/api/vulnerabilities/matches/facets/?{q}")
                self.assertEqual(_sorted(fast), _sorted(slow))
                if not q.startswith("ordering"):
                    fast, slow = self.both(f"/api/vulnerabilities/matches/?{q}")
                    self.assertEqual(fast["count"], slow["count"])
        fast, slow = self.both("/api/vulnerabilities/summary/")
        self.assertEqual(fast, slow)


def _sorted(body):
    return {k: sorted(v, key=lambda o: o["value"]) for k, v in body["facets"].items()}


class RankTests(StatBase):
    def test_rank_follows_priority(self):
        for m in VulnerabilityMatch.objects.all():
            self.assertEqual(m.rank, priority.RANK[m.priority])
            self.assertEqual(m.cvss_score, m.cve.cvss_score)

    def test_default_order_worst_then_score(self):
        self.login(self.admin)
        rows = self.client.get("/api/vulnerabilities/matches/?page_size=50").json()["results"]
        keys = [(priority.RANK[r["priority"]], -(Decimal(r["cve"]["cvss_score"] or -1)))
                for r in rows]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(rows[0]["cve"]["vuln_id"], "CVE-2024-0001")   # fix first, 9.8

    def test_kev_moves_rank_and_order(self):
        Cve.objects.filter(vuln_id="CVE-2024-0002").update(kev_added=datetime.date(2025, 1, 1))
        counts = matching.recompute(self.tenant)
        self.assertEqual(counts["updated"], 3)
        rows = VulnerabilityMatch.objects.filter(tenant=self.tenant,
                                                 cve__vuln_id="CVE-2024-0002",
                                                 resolved_at__isnull=True)
        self.assertEqual({(m.priority, m.rank) for m in rows}, {("fix_first", 0)})
        self.login(self.admin)
        order = [r["cve"]["vuln_id"] for r in self.client.get(
            "/api/vulnerabilities/matches/?page_size=50").json()["results"]]
        # Fix first now: 0001 (9.8), 0003 (7.5), 0002 (5.0), then high 0004.
        firsts = list(dict.fromkeys(order))
        self.assertEqual(firsts, ["CVE-2024-0001", "CVE-2024-0003", "CVE-2024-0002",
                                  "CVE-2024-0004"])
        self.assert_stats_true()
        self.assertEqual(VulnerabilityRecordStat.objects.get(
            tenant=self.tenant, cve__vuln_id="CVE-2024-0002").priority, "fix_first")

    def test_score_change_is_written(self):
        Cve.objects.filter(vuln_id="CVE-2024-0001").update(cvss_score=Decimal("9.9"))
        self.assertEqual(matching.recompute(self.tenant)["updated"], 3)
        self.assertEqual(set(VulnerabilityMatch.objects.filter(
            tenant=self.tenant, cve__vuln_id="CVE-2024-0001").values_list(
            "cvss_score", flat=True)),
            {Decimal("9.9")})

    def test_reprioritise_moves_rank_and_counts(self):
        VulnerabilityPolicy.objects.create(tenant=self.tenant, kev_is_fix_first=False)
        matching.reprioritise(self.tenant)
        # KEV no longer decides; 7.5 without EPSS is medium.
        m = VulnerabilityMatch.objects.filter(tenant=self.tenant,
                                              cve__vuln_id="CVE-2024-0003").first()
        self.assertEqual((m.priority, m.rank), ("medium", 2))
        self.assert_stats_true()

    def test_exception_leaves_the_order_and_the_counts(self):
        exc = VulnerabilityException.objects.create(
            tenant=self.tenant, cve=Cve.objects.get(vuln_id="CVE-2024-0001"),
            device=self.d_a, status="not_applicable", reason="lab")
        self.assert_stats_true()
        stat = VulnerabilityRecordStat.objects.get(tenant=self.tenant,
                                                   cve__vuln_id="CVE-2024-0001")
        self.assertEqual((stat.devices, stat.matches, stat.excepted), (1, 2, 1))
        self.login(self.admin)
        rows = self.client.get("/api/vulnerabilities/matches/?page_size=50").json()["results"]
        self.assertNotIn((str(self.d_a.pk), "CVE-2024-0001"),
                         {((r["device"] or {}).get("id"), r["cve"]["vuln_id"]) for r in rows})
        self.assert_same_answers()
        exc.delete()
        self.assert_stats_true()
        stat.refresh_from_db()
        self.assertEqual((stat.devices, stat.matches, stat.excepted), (2, 3, 0))

    def test_saved_row_gets_its_rank(self):
        m = VulnerabilityMatch.objects.filter(priority="medium").first()
        m.priority = "high"
        m.save()
        m.refresh_from_db()
        self.assertEqual(m.rank, 1)


class GroundTruthTests(StatBase):
    def test_counts_equal_the_matches(self):
        self.assert_stats_true()
        self.assert_stats_true(self.other)
        self.assert_same_answers()

    def test_after_changes(self):
        # A new host, a fixed host, a tenant-wide exception.
        Device.objects.create(tenant=self.tenant, name="n1", site=self.site_b,
                              platform=self.xe, software_version="17.9.4")
        Device.objects.filter(pk=self.d_b.pk).update(software_version="17.9.5")
        matching.recompute(self.tenant)
        self.assert_stats_true()
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=Cve.objects.get(vuln_id="CVE-2024-0003"),
            status="not_applicable", reason="lab")
        self.assert_stats_true()
        self.assert_same_answers()
        stat = VulnerabilityRecordStat.objects.get(tenant=self.tenant,
                                                   cve__vuln_id="CVE-2024-0003")
        self.assertEqual((stat.matches, stat.excepted), (0, 3))
        # Listed under excepted only.
        self.login(self.admin)
        ids = [r["id"] for r in self.client.get("/api/vulnerabilities/").json()["results"]]
        self.assertNotIn("CVE-2024-0003", ids)

    def test_old_and_new_first_seen(self):
        old = timezone.now() - datetime.timedelta(days=40)
        VulnerabilityMatch.objects.filter(cve__vuln_id="CVE-2024-0002").update(
            first_seen_at=old)
        record_stats.refresh(self.tenant.pk)
        self.assert_same_answers()

    def test_partial_recompute_refreshes_its_records(self):
        Device.objects.filter(pk=self.d_a.pk).update(software_version="17.9.5")
        matching.recompute(self.tenant, objects={"device": [self.d_a.pk]})
        self.assert_stats_true()

    def test_deleted_host_and_moved_site_queue_a_refresh(self):
        def move():
            self.d_b.site = self.site_a
            self.d_b.save()

        with mock.patch.object(jobs, "enqueue_stats") as q:
            self.commit(move)
        q.assert_called_once_with(self.tenant.pk)
        with mock.patch.object(jobs, "enqueue_stats") as q:
            self.commit(self.vm.delete)
        q.assert_called_once_with(self.tenant.pk)
        # The job brings them in line.
        self.assertNotEqual(stored(self.tenant), record_stats.compute(self.tenant.pk))
        jobs.run_stats(str(self.tenant.pk))
        self.assert_stats_true()
        self.assert_same_answers()

    def test_unrelated_save_queues_nothing(self):
        with mock.patch.object(jobs, "enqueue_stats") as q:
            self.commit(lambda: Device.objects.get(pk=self.d_b.pk).save())
        q.assert_not_called()

    def test_exceptions_apply_refreshes(self):
        VulnerabilityMatch.objects.filter(cve__vuln_id="CVE-2024-0002").update(
            excepted=None)
        exceptions.apply(self.tenant.pk, [Cve.objects.get(vuln_id="CVE-2024-0002").pk])
        self.assert_stats_true()


class NoChangeTests(StatBase):
    def test_no_change_recompute_writes_no_counts(self):
        matching.recompute(self.tenant)
        with CaptureQueriesContext(connection) as ctx:
            counts = matching.recompute(self.tenant)
        self.assertEqual(counts["record_stats"], 0)
        self.assertEqual(match_writes(ctx.captured_queries), [])
        self.assertFalse([q["sql"] for q in ctx.captured_queries
                          if "vulnerabilityrecordstat" in q["sql"]
                          and q["sql"].lstrip().split(" ", 1)[0] in ("INSERT", "UPDATE",
                                                                     "DELETE")])


class ScopeTests(StatBase):
    def test_site_role_reads_the_matches(self):
        self.member("local", ["device", "virtualmachine", "installedsoftware"], ["view"],
                    sites=[self.site_b])
        with mock.patch.object(stat_lists, "record_rows") as fast:
            rows = {x["id"]: x for x in self.client.get(
                "/api/vulnerabilities/").json()["results"]}
        fast.assert_not_called()
        self.assertEqual(rows["CVE-2024-0001"]["devices"], 1)
        self.assertNotIn("CVE-2024-0004", rows)
        body = self.client.get("/api/vulnerabilities/summary/").json()
        self.assertEqual((body["devices"], body["virtual_machines"]), (1, 1))
        f = self.client.get("/api/vulnerabilities/matches/facets/").json()["facets"]
        self.assertEqual({o["value"]: o["count"] for o in f["site"]},
                         {str(self.site_b.pk): 6})

    def test_constrained_role_reads_the_matches(self):
        user = self.member("c", ["device", "virtualmachine", "installedsoftware"], ["view"])
        perm = user.object_permissions.first()
        perm.constraints = {"name": "a1"}
        perm.save()
        self.login(user)
        r = self.client.get("/api/vulnerabilities/").json()
        self.assertEqual(r["results"][0]["devices"], 1)
        self.assertEqual(r["results"][0]["virtual_machines"], 0)

    def test_unscoped_role_reads_the_counts(self):
        self.member("all", ["device", "virtualmachine", "installedsoftware"], ["view"])
        with mock.patch.object(stat_lists, "record_rows",
                               wraps=stat_lists.record_rows) as fast:
            rows = self.client.get("/api/vulnerabilities/").json()["results"]
        fast.assert_called_once()
        self.assertEqual(len(rows), 4)

    def test_match_filters_read_the_matches(self):
        self.login(self.admin)
        # A rail selection on a match property: the record list reads the
        # matches, the rails still count the stored groups.
        for q in (f"f_site={self.site_a.pk}", "f_first_seen=7d", "f_excepted=yes,no"):
            with self.subTest(q=q), \
                    mock.patch.object(stat_lists, "record_rows") as rows, \
                    mock.patch.object(stat_lists, "facets", wraps=stat_lists.facets) as rail:
                self.client.get(f"/api/vulnerabilities/?{q}")
                self.client.get(f"/api/vulnerabilities/facets/?{q}")
                rows.assert_not_called()
                rail.assert_called_once()
        # A plain parameter on a match property: everything reads the matches.
        for q in ("excepted=all", "status=all", f"device={self.d_a.pk}",
                  f"site={self.site_a.pk}", "via=application"):
            with self.subTest(q=q), \
                    mock.patch.object(stat_lists, "record_rows") as rows, \
                    mock.patch.object(stat_lists, "facets") as rail:
                self.client.get(f"/api/vulnerabilities/?{q}")
                self.client.get(f"/api/vulnerabilities/matches/facets/?{q}")
                rows.assert_not_called()
                rail.assert_not_called()

    def test_other_tenant_counts_stay_apart(self):
        self.login(self.admin, self.other)
        rows = self.client.get("/api/vulnerabilities/").json()["results"]
        self.assertEqual({r["id"] for r in rows},
                         {"CVE-2024-0001", "CVE-2024-0002", "CVE-2024-0003"})
        self.assertEqual({r["devices"] for r in rows}, {1})


class CombinedFacetTests(StatBase):
    """The one-scan facet counter equals counting each facet on its own
    (the per-facet SQL it replaced)."""

    def reference(self, query, facets, expr, user=None):
        from .match_api import VulnerabilityViewSet

        req = Request(APIRequestFactory().get(f"/x/?{query}"))
        req.user = user or self.admin
        base = VulnerabilityViewSet()._base(req, self.tenant)
        return {fid: f.count(list_api.apply_facets(req, base, facets, skip=fid), expr,
                             self.tenant) for fid, f in facets.items()}, req, base

    def test_equal_to_one_query_per_facet(self):
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=Cve.objects.get(vuln_id="CVE-2024-0002"),
            device=self.d_b, status="not_applicable", reason="lab")
        for q in ("", f"f_site={self.site_b.pk}", "f_priority=fix_first&f_via=platform",
                  "f_excepted=yes", "f_first_seen=7d,older", f"f_application={self.pg.pk}",
                  "f_site=__none__", "excepted=all", "f_epss=..0.5&f_kev=no"):
            for facets, expr in ((list_api.RECORD_FACETS, "cve_id"),
                                 (list_api.MATCH_FACETS, "id")):
                if "f_via" in q and facets is list_api.RECORD_FACETS:
                    continue
                with self.subTest(q=q, expr=expr):
                    want, req, base = self.reference(q, facets, expr)
                    got = list_api.facet_counts(req, base, facets, expr, self.tenant)
                    self.assertEqual(_sorted({"facets": got}), _sorted({"facets": want}))


class QueryCostTests(StatBase):
    def test_lists_cost_does_not_grow(self):
        self.login(self.admin)
        urls = ["/api/vulnerabilities/", "/api/vulnerabilities/facets/",
                "/api/vulnerabilities/matches/", "/api/vulnerabilities/matches/facets/",
                "/api/vulnerabilities/summary/"]

        def cost():
            out = []
            for url in urls:
                with CaptureQueriesContext(connection) as ctx:
                    self.assertEqual(self.client.get(url).status_code, 200)
                out.append(len(ctx.captured_queries))
            return out

        small = cost()
        for i in range(25):
            Device.objects.create(tenant=self.tenant, name=f"x{i}", site=self.site_a,
                                  platform=self.xe, software_version="17.9.4")
        matching.recompute(self.tenant)
        self.assertEqual(cost(), small)
