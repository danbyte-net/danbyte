"""SLA metrics export (0.18, 8.7): period figures as CSV or JSON, per
agreement and for every agreement, as the caller may see them."""
from __future__ import annotations

import csv
import io

from django.contrib.auth.models import User

from auth_api.models import ObjectPermission, UserProfile

from .models import SlaAgreement, SlaPeriodResult
from .tests_sla_api import A, _WithFigures


class MetricsTests(_WithFigures):
    def setUp(self):
        super().setUp()
        a = SlaAgreement.objects.get(pk=self.agreement_id)
        a.credit_tiers = [{"below": 100, "credit_pct": 10}]
        a.save()
        self.client.post(f"{A}{self.agreement_id}/recompute/")
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=a, period_key="2020-01",
            period_start="2020-01-01T00:00Z", period_end="2020-02-01T00:00Z",
            state="frozen", revision=1,
            figures={"availability": 99.5, "target": 99.9, "state": "breached",
                     "credit": {"pct": 10.0, "amount": None, "currency": ""}},
        )

    def test_json_per_agreement(self):
        rows = self.client.get(f"{A}{self.agreement_id}/metrics/").json()
        # This period, the last one (both computed), and 2020-01; newest first.
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1]["period"], "2020-01")
        self.assertEqual(rows[-1]["availability_pct"], 99.5)
        self.assertEqual(rows[-1]["credit_pct"], 10.0)
        self.assertEqual(rows[0]["agreement"], "Gold")
        self.assertIsNone(rows[0]["hidden_members"])

    def test_csv_and_date_filter(self):
        r = self.client.get(f"{A}{self.agreement_id}/metrics/?file=csv&since=2025-01-01")
        self.assertEqual(r["Content-Type"], "text/csv")
        self.assertIn("attachment", r["Content-Disposition"])
        lines = list(csv.DictReader(io.StringIO(r.content.decode())))
        self.assertEqual(len(lines), 2)
        self.assertNotIn("2020-01", [x["period"] for x in lines])
        r = self.client.get(f"{A}{self.agreement_id}/metrics/?until=2020-12-31")
        self.assertEqual([x["period"] for x in r.json()], ["2020-01"])
        self.assertEqual(self.client.get(f"{A}{self.agreement_id}/metrics/?since=x").status_code,
                         400)

    def test_bulk_skips_drafts(self):
        self.agreement(name="Draft", status="draft")
        rows = self.client.get(f"{A}metrics/").json()
        self.assertEqual({r["agreement"] for r in rows}, {"Gold"})
        r = self.client.get(f"{A}metrics/?file=csv")
        self.assertIn("agreement_id,agreement,for,period", r.content.decode())

    def test_a_limited_viewer_gets_partial_figures_without_credit(self):
        u = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="sla", object_types=["slaagreement"],
                                            actions=["view", "view_credits"])
        p.users.add(u)
        p.tenants.add(self.tenant)
        d = ObjectPermission.objects.create(name="dev", object_types=["device"],
                                            actions=["view"])
        d.users.add(u)
        d.tenants.add(self.tenant)
        d.sites.add(self.site_a)
        self.login(u)
        rows = self.client.get(f"{A}metrics/").json()
        current = next(r for r in rows if r["period"] != "2020-01")
        self.assertEqual(current["hidden_members"], 1)
        self.assertEqual(current["availability_pct"], 100.0)
        self.assertIsNone(current["credit_pct"])

    def test_no_sla_permission_no_metrics(self):
        u = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        self.login(u)
        self.assertEqual(self.client.get(f"{A}metrics/").status_code, 403)
        self.assertEqual(self.client.get(f"{A}{self.agreement_id}/metrics/").status_code, 403)
