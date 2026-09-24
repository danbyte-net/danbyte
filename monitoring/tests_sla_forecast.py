"""The end-of-period forecast and the finished-periods history."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from . import sla
from .models import SlaPeriodResult
from .tests_sla import NOW, SEP, _Base

A = "/api/monitoring/sla-agreements/"


class ForecastTests(_Base):
    def setUp(self):
        super().setUp()
        self.dev, self.ip = self.device("leaf1", 1)
        self.member(self.dev)

    def current(self, now=NOW):
        sla.refresh_agreement(self.agreement, now=now)
        return SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")

    def test_a_bad_start_and_a_clean_week_forecast_between(self):
        # A day down early in September, clean since: 90 % after ten days, and
        # the rest of the month is expected to go like the clean week.
        self.tr(self.ip, self.ping, SEP + timedelta(days=1), "down")
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "up")
        f = self.current().figures
        self.assertAlmostEqual(f["availability"], 90.0, places=2)
        fc = f["forecast"]
        self.assertEqual(fc["trailing"], 100.0)
        self.assertAlmostEqual(fc["availability"], 90 / 3 + 100 * 2 / 3, places=1)
        self.assertEqual(fc["state"], "breached")  # 96.7 against 99

    def test_a_recent_outage_drags_the_forecast_below_the_figure(self):
        self.tr(self.ip, self.ping, NOW - timedelta(hours=12), "down")
        f = self.current().figures
        self.assertLess(f["forecast"]["availability"], f["availability"])

    def test_too_early_to_forecast(self):
        f = self.current(SEP + timedelta(days=2)).figures  # under 10 % gone
        self.assertIsNone(f["forecast"])

    def test_a_closed_period_has_no_forecast(self):
        self.current()
        sla.refresh_agreement(self.agreement, now=SEP + timedelta(days=31))
        closed = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        self.assertEqual(closed.state, "closed")
        self.assertNotIn("forecast", closed.figures)


class HistoryTests(_Base, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        dev, _ip = self.device("leaf1", 1)
        self.member(dev)
        sla.refresh_agreement(self.agreement, now=NOW)
        # Only the rows each test writes; the refresh also froze August.
        SlaPeriodResult.objects.exclude(period_key="2026-09").delete()

    def past(self, month, state, stored="frozen"):
        start = SEP.replace(year=2025 + (month + 8) // 12, month=(month + 8) % 12 + 1)
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=self.agreement, period_key=f"p{month:02d}",
            period_start=start, period_end=start + timedelta(days=28), state=stored,
            figures={"state": state},
        )

    def history(self):
        rows = self.client.get(A).json()["results"]
        return next(r for r in rows if r["id"] == str(self.agreement.id))["current"]["history"]

    def test_counts_the_last_twelve_finished_periods(self):
        # Fourteen months back: the two oldest breached and fall outside.
        for m in range(14):
            self.past(m, "breached" if m < 2 else "ok" if m % 3 else "at_risk")
        self.assertEqual(self.history(), {"met": 12, "of": 12})

    def test_breaches_and_no_data(self):
        self.past(1, "ok")
        self.past(2, "breached", stored="closed")
        self.past(3, "no_data")
        self.assertEqual(self.history(), {"met": 1, "of": 2})
