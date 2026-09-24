"""SLA alerts (once per period, to the agreement's channels) and reports
(PDF/CSV, emailed when a period freezes, downloadable, the overview)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from django.contrib.auth.models import User
from django.core import mail
from rest_framework.test import APITestCase

from . import sla
from .models import CheckRollupDaily, NotificationChannel, SlaPeriodResult
from .tests_sla import NOW, SEP, _Base

A = "/api/monitoring/sla-agreements/"


class _Alerting(_Base):
    def setUp(self):
        super().setUp()
        self.channel = NotificationChannel.objects.create(
            tenant=self.tenant, name="noc", kind="email",
            config={"recipients": ["noc@example.com"]},
        )
        self.agreement.notify_channels.add(self.channel)
        self.dev, self.ip = self.device("leaf1", 1)
        self.member(self.dev)

    def subjects(self):
        return [m.subject for m in mail.outbox]


class AlertTests(_Alerting):
    def test_breached_goes_once_per_period(self):
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "down")
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertIn("SLA breached: Gold", self.subjects())
        n = len(mail.outbox)
        sla.refresh_agreement(self.agreement, now=NOW + timedelta(hours=1))
        self.assertEqual(len(mail.outbox), n)

    def test_fast_burn_is_at_risk(self):
        # An hour down in ten days: 1.4 % of a 99 % budget - on target, but
        # burning faster than a 0.1x threshold.
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(self.ip, self.ping, SEP + timedelta(days=2, hours=1), "up")
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(self.subjects(), [])
        self.agreement.alert_burn_rate = 0.1
        self.agreement.save()
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(self.subjects(), ["SLA at risk: Gold"])

    def test_coverage_waits_for_a_tenth_of_the_period(self):
        self.agreement.alert_coverage_pct = Decimal("90")
        self.agreement.save()
        self.tr(self.ip, self.ping, SEP + timedelta(hours=1), "stale")
        sla.refresh_agreement(self.agreement, now=SEP + timedelta(days=1))
        self.assertEqual(self.subjects(), [])
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(self.subjects(), ["SLA coverage low: Gold"])

    def test_latency_objective(self):
        self.agreement.latency_objectives = {"icmp": 5}
        self.agreement.save()
        CheckRollupDaily.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=NOW - timedelta(days=1), up_s=86400, samples=10, lat_p50=8, lat_p95=12,
            closed=True,
        )
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(self.subjects(), ["SLA latency objective missed: Gold (icmp)"])

    def test_a_breach_in_the_last_minutes_is_still_reported(self):
        sla.refresh_agreement(self.agreement, now=NOW)  # September open, fine
        self.assertEqual(self.subjects(), [])
        # Down for the final day, and the next run is after the month ended.
        self.tr(self.ip, self.ping, datetime(2026, 9, 29, tzinfo=UTC), "down")
        sla.refresh_agreement(self.agreement, now=datetime(2026, 10, 1, 0, 10, tzinfo=UTC))
        self.assertIn("SLA breached: Gold", self.subjects())

    def test_no_channels_no_alerts(self):
        self.agreement.notify_channels.clear()
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "down")
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(mail.outbox, [])


class ReportDeliveryTests(_Alerting):
    def test_frozen_period_is_emailed_once_with_the_pdf(self):
        self.agreement.report_recipients = ["boss@example.com"]
        self.agreement.report_format = "both"
        self.agreement.save()
        oct3 = datetime(2026, 10, 3, tzinfo=UTC)
        sla.refresh_agreement(self.agreement, now=NOW)  # September open
        # August froze at once (the agreement is new): no report for it.
        self.assertEqual([m for m in mail.outbox if "report" in m.subject], [])
        sla.refresh_agreement(self.agreement, now=oct3)  # September closed
        sla.refresh_agreement(self.agreement, now=oct3 + timedelta(days=6))  # frozen
        reports = [m for m in mail.outbox if m.subject.startswith("SLA report")]
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0].to, ["boss@example.com"])
        # The inline logo rides along as a MIME part; the files are tuples.
        files = [a for a in reports[0].attachments if isinstance(a, tuple)]
        self.assertEqual([f[0] for f in files], ["sla-gold-2026-09.pdf", "sla-gold-2026-09.csv"])
        self.assertTrue(files[0][1].startswith(b"%PDF"))
        sep = SlaPeriodResult.objects.get(period_key="2026-09")
        self.assertIsNotNone(sep.report_sent_at)


class ReportEndpointTests(_Alerting, APITestCase):
    def setUp(self):
        super().setUp()
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.tr(self.ip, self.ping, SEP + timedelta(days=2), "down")
        sla.refresh_agreement(self.agreement, now=NOW)
        self.key = "2026-09"

    def test_pdf_and_csv(self):
        r = self.client.get(f"{A}{self.agreement.id}/report/?period={self.key}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        r = self.client.get(f"{A}{self.agreement.id}/report/?period={self.key}&file=csv")
        body = r.content.decode()
        self.assertIn("leaf1", body)
        self.assertIn("availability_pct", body)

    def test_overview(self):
        r = self.client.get(f"{A}overview-report/?period={self.key}&file=csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Gold", r.content.decode())
        r = self.client.get(f"{A}overview-report/?period={self.key}")
        self.assertTrue(r.content.startswith(b"%PDF"))

    def test_send_now(self):
        mail.outbox = []
        r = self.client.post(f"{A}{self.agreement.id}/send-report/",
                             {"period": self.key, "recipients": ["x@example.com"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(mail.outbox[-1].to, ["x@example.com"])
        bad = self.client.post(f"{A}{self.agreement.id}/send-report/",
                               {"period": self.key, "recipients": ["nope"]}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("recipients", bad.json())
