"""Latency objectives: the rollup histogram, each objective's figure and
budget, the state when they count, alerts, reports and the analysis."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.core import mail
from rest_framework.test import APITestCase

from . import rollups, sla, sla_objectives
from .models import CheckRollupDaily, SlaPeriodResult
from .sla_report import report_csv, report_html
from .tests_rollups import H11
from .tests_rollups import NOW as NOW_R
from .tests_rollups import _Base as _RollupBase
from .tests_sla import NOW
from .tests_sla_notify import A, _Alerting


class HistogramTests(_RollupBase):
    def test_probes_land_in_every_edge_they_fit(self):
        for minute, ms in ((1, 5), (2, 15), (3, 30)):
            self.result(H11 + timedelta(minutes=minute), ms)
        row = self.hour()
        self.assertEqual(row.lat_hist_n, 3)
        self.assertEqual((row.lat_le_5, row.lat_le_10, row.lat_le_20, row.lat_le_50),
                         (1, 1, 2, 3))

    def test_a_fast_lane_row_counts_its_samples(self):
        self.result(H11 + timedelta(minutes=1), 8, agg={"samples": 10, "min_ms": 2, "max_ms": 30})
        row = self.hour()
        self.assertEqual((row.lat_hist_n, row.lat_le_10, row.lat_le_5), (10, 10, 0))


class AutomaticFillTests(_RollupBase):
    """Rows written before the histogram are rebuilt by the rollup timer."""

    def old_day(self, days_ago):
        day = (NOW_R - timedelta(days=days_ago)).replace(hour=0, minute=0)
        self.result(day + timedelta(hours=3), 12)
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=day, up_s=86400, samples=1, lat_p50=12, lat_p95=12, closed=True,
        )
        return day

    def test_a_pre_histogram_day_is_filled_in(self):
        day = self.old_day(5)
        out = rollups.refresh(now=NOW_R)
        self.assertEqual(out["histogram_days"], 1)
        row = CheckRollupDaily.objects.get(bucket=day)
        self.assertEqual((row.lat_hist_n, row.lat_le_20, row.lat_le_10), (1, 1, 0))
        # Done: the next run has nothing left.
        self.assertEqual(rollups.refresh(now=NOW_R)["histogram_days"], 0)

    def test_a_few_days_per_run_and_never_past_the_reach(self):
        for d in (4, 5, 6, 7, 40):
            self.old_day(d)
        self.assertEqual(rollups.refresh(now=NOW_R)["histogram_days"], 3)
        self.assertEqual(rollups.refresh(now=NOW_R)["histogram_days"], 1)
        self.assertEqual(rollups.refresh(now=NOW_R)["histogram_days"], 0)
        far = CheckRollupDaily.objects.get(bucket=(NOW_R - timedelta(days=40)).replace(
            hour=0, minute=0))
        self.assertEqual(far.lat_hist_n, 0)  # its raw results may be gone


class _Objectives(_Alerting):
    def setUp(self):
        super().setUp()
        self.agreement.objectives = [{"kind": "icmp", "threshold_ms": 20, "target_pct": 99.0}]
        self.agreement.save()

    def rollup(self, n, within_20, day=NOW - timedelta(days=2)):
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=day.replace(hour=0), up_s=86400, samples=n, lat_p50=5, lat_p95=25,
            lat_hist_n=n, lat_le_20=within_20, lat_le_50=n, closed=True,
        )

    def current(self):
        sla.refresh_agreement(self.agreement, now=NOW)
        return SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09").figures


class FigureTests(_Objectives):
    def test_the_share_within_and_its_budget(self):
        self.rollup(1000, 995)
        o = self.current()["objectives"][0]
        self.assertEqual((o["probes"], o["within"], o["pct"], o["state"]), (1000, 995, 99.5, "ok"))
        # 1 % of 1000 may be slow: 5 were, half the budget.
        self.assertEqual((o["budget_probes"], o["slow"], o["budget_spent_pct"]), (10, 5, 50.0))

    def test_states(self):
        self.rollup(1000, 991)
        self.assertEqual(self.current()["objectives"][0]["state"], "at_risk")
        CheckRollupDaily.objects.all().delete()
        self.rollup(1000, 900)
        self.assertEqual(self.current()["objectives"][0]["state"], "breached")
        CheckRollupDaily.objects.all().delete()
        self.assertEqual(self.current()["objectives"][0]["state"], "no_data")

    def test_the_state_only_follows_objectives_when_asked(self):
        self.rollup(1000, 900)
        f = self.current()
        self.assertEqual(f["state"], "ok")
        self.agreement.objectives_in_state = True
        self.agreement.save()
        f = self.current()
        self.assertEqual((f["state"], f["availability_state"]), ("breached", "ok"))

    def test_rows_before_the_histogram_do_not_count_as_slow(self):
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=(NOW - timedelta(days=3)).replace(hour=0), up_s=86400, samples=500,
            lat_p50=5, lat_p95=9, closed=True,
        )
        self.rollup(100, 100)
        self.assertEqual(self.current()["objectives"][0]["pct"], 100.0)


class AlertTests(_Objectives):
    def test_an_objective_breach_is_its_own_alert(self):
        self.agreement.objectives_in_state = True
        self.agreement.save()
        self.rollup(1000, 900)
        self.current()
        self.assertEqual(self.subjects(), ["SLA latency objective breached: Gold (icmp)"])


class ReportTests(_Objectives):
    def test_reports_list_the_objectives(self):
        self.rollup(1000, 995)
        self.current()
        res = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        self.assertIn("icmp within 20 ms", report_html(self.agreement, res))
        self.assertIn("objective,icmp,within_ms,20,pct,99.5", report_csv(self.agreement, res))


class ValidationTests(_Objectives, APITestCase):
    def test_objectives_are_checked(self):
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        url = f"{A}{self.agreement.id}/"
        for bad in ([{"kind": "icmp", "threshold_ms": 25, "target_pct": 99}],
                    [{"kind": "icmp", "threshold_ms": 20, "target_pct": 100}],
                    [{"kind": "icmp", "threshold_ms": 20, "target_pct": 99}] * 2):
            r = self.client.patch(url, {"objectives": bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)
        r = self.client.patch(url, {"objectives": [
            {"kind": "ICMP", "threshold_ms": "50", "target_pct": "99.9"}]}, format="json")
        self.assertEqual(r.json()["objectives"], [
            {"kind": "icmp", "threshold_ms": 50, "target_pct": 99.9}])


class WorstStateTests(_Objectives):
    def test_no_data_never_makes_it_worse(self):
        self.assertEqual(sla_objectives.worst_state("ok", [{"state": "no_data"}]), "ok")
        self.assertEqual(sla_objectives.worst_state("at_risk", [{"state": "ok"}]), "at_risk")
        self.assertEqual(sla_objectives.worst_state("ok", [{"state": "breached"}]), "breached")
