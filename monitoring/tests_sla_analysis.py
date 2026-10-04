"""The SLA analysis view: live figures sliced by filter and bucket."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from . import sla_analysis
from .models import SlaCheckGroup, SlaCheckItem
from .tests_sla import DAY, NOW, SEP, _Base

A = "/api/monitoring/sla-agreements/"


class _Seeded(_Base):
    def setUp(self):
        super().setUp()
        self.a1, self.ip1 = self.device("leaf1", 1)
        self.a2, self.ip2 = self.device("leaf2", 2)
        self.member(self.a1)
        self.member(self.a2)
        # leaf1 down two hours on the 3rd, a Thursday, 10:00-12:00 UTC.
        self.tr(self.ip1, self.ping, SEP + timedelta(days=2, hours=10), "down")
        self.tr(self.ip1, self.ping, SEP + timedelta(days=2, hours=12), "up")

    def run_analysis(self, **kw):
        return sla_analysis.analyse(self.agreement, SEP, SEP + timedelta(days=30), now=NOW, **kw)


class AnalysisTests(_Seeded):
    def test_series_burn_and_breakdowns(self):
        out = self.run_analysis()
        self.assertEqual(len(out["series"]), 10)
        day3 = out["series"][2]
        self.assertEqual(day3["incidents"], 1)
        self.assertEqual(day3["down_s"], 3600)  # two hours over two units
        self.assertAlmostEqual(day3["availability"], 100 * (2 * DAY - 7200) / (2 * DAY), places=3)
        self.assertEqual(out["burn"][-1]["spent_s"], 3600)
        self.assertEqual([m["name"] for m in out["by_member"]], ["leaf1", "leaf2"])
        self.assertEqual(out["by_kind"][0]["key"], "icmp")
        self.assertEqual(out["heatmap"], [{"dow": 3, "hour": 10, "down_s": 3600},
                                          {"dow": 3, "hour": 11, "down_s": 3600}])
        self.assertEqual(out["durations"][2], {"label": "30 min-2 h", "count": 0})
        self.assertEqual(out["durations"][3], {"label": "2-8 h", "count": 1})
        self.assertEqual(len(out["strips"]), 2)

    def test_hourly_buckets(self):
        out = sla_analysis.analyse(self.agreement, SEP + timedelta(days=2),
                                   SEP + timedelta(days=3), now=NOW, bucket="hour")
        self.assertEqual(len(out["series"]), 24)
        self.assertEqual(out["series"][10]["down_s"], 1800)

    def test_member_filter(self):
        out = self.run_analysis(filters={"member": [str(self.a2.id)]})
        self.assertEqual(out["figures"]["availability"], 100.0)
        self.assertEqual([m["name"] for m in out["by_member"]], ["leaf2"])

    def test_kind_filter_drops_other_checks(self):
        SlaCheckItem.objects.create(group=self.group, template=self.ssh)
        out = self.run_analysis(filters={"kind": ["ssh"]})
        self.assertEqual(out["figures"]["availability"], 100.0)

    def test_group_filter(self):
        other = SlaCheckGroup.objects.create(tenant=self.tenant, agreement=self.agreement, name="Other")
        out = self.run_analysis(filters={"group": [str(other.id)]})
        self.assertEqual(out["figures"]["members"], 0)


class AnalysisApiTests(_Seeded, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_endpoint_range_and_options(self):
        r = self.client.get(f"{A}{self.agreement.id}/analysis/?since=2026-09-01&until=2026-09-05")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["options"]["groups"][0]["name"], "Leafs")
        self.assertEqual(len(body["options"]["members"]), 2)
        self.assertFalse(body["limited"])
        # Four days before: the tail of August, no outage there.
        self.assertEqual(body["previous"]["since"][:10], "2026-08-27")

    def test_provided_for_needs_what_it_names(self):
        base = {"name": "X", "target_pct": "99.9"}
        for extra, field in (({"provided_for": "sites"}, "sites"),
                             ({"provided_for": "contact"}, "customer"),
                             ({"provided_for": "name"}, "customer_name")):
            r = self.client.post(A, {**base, **extra}, format="json")
            self.assertEqual(r.status_code, 400, extra)
            self.assertIn(field, r.json())
        r = self.client.post(A, {**base, "provided_for": "sites", "sites": [str(self.site.id)]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["for_label"], "HQ")

    def test_bad_ranges(self):
        for q in ("since=2026-09-05&until=2026-09-01", "since=nope",
                  "since=2025-01-01&until=2026-09-01&bucket=hour"):
            self.assertEqual(self.client.get(f"{A}{self.agreement.id}/analysis/?{q}").status_code,
                             400, q)
