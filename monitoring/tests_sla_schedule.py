"""Scheduled SLA reports (0.18, 8.3): slots, sends once per slot, retries a
failed send, the overview report, and who may set one up."""
from __future__ import annotations

import smtplib
from datetime import UTC, datetime, timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.core import mail
from django.utils import timezone

from auth_api.models import ObjectPermission, UserProfile

from . import sla_schedule
from .models import SlaAgreement, SlaReportSchedule
from .tests_sla_api import _WithFigures

S = "/api/monitoring/sla-report-schedules/"


def _at(*args):
    return datetime(*args, tzinfo=UTC)


def _files(message) -> dict:
    """``{filename: text}`` of a sent mail's file attachments (the logo is a
    MIME part, not a file)."""
    out = {}
    for a in message.attachments:
        if isinstance(a, tuple):
            body = a[1]
            out[a[0]] = body.decode() if isinstance(body, bytes) else body
    return out


def _drop_previous(agreement):
    """Remove the stored previous period, so "last period" has no figures."""
    from . import sla
    from .models import SlaPeriodResult

    prev = sla.previous_period(agreement, timezone.now())
    SlaPeriodResult.objects.filter(agreement=agreement, period_key=prev[0]).delete()


class SlotTests(_WithFigures):
    def sched(self, **kw):
        a = SlaAgreement.objects.get(pk=self.agreement_id)
        s = SlaReportSchedule.objects.create(
            tenant=self.tenant, agreement=a, recipients=["noc@example.com"], **kw)
        SlaReportSchedule.objects.filter(pk=s.pk).update(created_at=_at(2026, 1, 1))
        s.refresh_from_db()
        return s

    def test_weekly_slot(self):
        # 2026-10-07 is a Wednesday.
        s = self.sched(frequency="weekly", weekday=0, hour=7)
        self.assertEqual(sla_schedule.last_slot(s, _at(2026, 10, 7, 12)), _at(2026, 10, 5, 7))
        self.assertEqual(sla_schedule.last_slot(s, _at(2026, 10, 5, 6)), _at(2026, 9, 28, 7))
        self.assertEqual(sla_schedule.next_slot(s, _at(2026, 10, 7, 12)), _at(2026, 10, 12, 7))

    def test_monthly_slot_crosses_the_year(self):
        s = self.sched(frequency="monthly", day_of_month=3, hour=0)
        self.assertEqual(sla_schedule.last_slot(s, _at(2026, 1, 2)), _at(2025, 12, 3))
        self.assertEqual(sla_schedule.next_slot(s, _at(2026, 12, 4)), _at(2027, 1, 3))

    def test_due_once_per_slot_and_not_before_it_was_created(self):
        s = self.sched(frequency="weekly", weekday=0, hour=7)
        now = _at(2026, 10, 7, 12)
        self.assertTrue(sla_schedule.is_due(s, now))
        s.report_sent_at = _at(2026, 10, 5, 7, 5)
        self.assertFalse(sla_schedule.is_due(s, now))
        s.report_sent_at = None
        s.created_at = _at(2026, 10, 6)
        self.assertFalse(sla_schedule.is_due(s, now))
        s.enabled = False
        self.assertFalse(sla_schedule.is_due(s, _at(2026, 10, 13, 8)))


class RunTests(_WithFigures):
    def setUp(self):
        super().setUp()
        self.a = SlaAgreement.objects.get(pk=self.agreement_id)
        self.s = SlaReportSchedule.objects.create(
            tenant=self.tenant, agreement=self.a, frequency="weekly",
            weekday=timezone.now().weekday(), hour=0, period="current",
            recipients=["noc@example.com"], report_format="csv")
        SlaReportSchedule.objects.filter(pk=self.s.pk).update(
            created_at=timezone.now() - timedelta(days=30))

    def test_sends_once_and_stamps_the_schedule(self):
        r = sla_schedule.run_due()
        self.assertEqual(r, {"reports_sent": 1, "reports_failed": 0})
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["noc@example.com"])
        self.assertTrue(any(n.endswith(".csv") for n in _files(mail.outbox[0])))
        self.s.refresh_from_db()
        self.assertIsNotNone(self.s.report_sent_at)
        self.assertEqual(sla_schedule.run_due()["reports_sent"], 0)
        self.assertEqual(len(mail.outbox), 1)

    def test_a_failed_send_is_kept_and_retried(self):
        with mock.patch("django.core.mail.EmailMultiAlternatives.send",
                        side_effect=smtplib.SMTPException("relay refused")):
            r = sla_schedule.run_due()
        self.assertEqual(r, {"reports_sent": 0, "reports_failed": 1})
        self.s.refresh_from_db()
        self.assertIsNone(self.s.report_sent_at)
        self.assertIn("relay refused", self.s.last_error)
        self.assertEqual(self.s.failures, 1)
        # The next run tries again, and a success clears the error.
        self.assertEqual(sla_schedule.run_due()["reports_sent"], 1)
        self.s.refresh_from_db()
        self.assertEqual((self.s.last_error, self.s.failures), ("", 0))
        self.assertIsNotNone(self.s.report_sent_at)

    def test_a_claimed_slot_is_not_sent_twice(self):
        stale = SlaReportSchedule.objects.get(pk=self.s.pk)
        self.assertTrue(sla_schedule.send_now(self.s))
        # A second run that read the row before the first stamped it loses.
        self.assertFalse(sla_schedule.send_now(stale))
        self.assertEqual(len(mail.outbox), 1)

    def test_no_figures_is_a_failure_not_a_silent_skip(self):
        _drop_previous(self.a)
        SlaReportSchedule.objects.filter(pk=self.s.pk).update(period="previous")
        r = sla_schedule.run_due()
        self.assertEqual(r["reports_failed"], 1)
        self.s.refresh_from_db()
        self.assertIn("No figures", self.s.last_error)

    def test_overview_schedule(self):
        self.s.delete()
        SlaReportSchedule.objects.create(
            tenant=self.tenant, agreement=None, frequency="weekly",
            weekday=timezone.now().weekday(), hour=0, period="current",
            recipients=["boss@example.com"], report_format="csv")
        SlaReportSchedule.objects.update(created_at=timezone.now() - timedelta(days=30))
        self.assertEqual(sla_schedule.run_due()["reports_sent"], 1)
        self.assertIn("SLA overview", mail.outbox[0].subject)
        self.assertIn("Gold", "".join(_files(mail.outbox[0]).values()))


class ApiTests(_WithFigures):
    def test_create_list_and_send_now(self):
        _drop_previous(SlaAgreement.objects.get(pk=self.agreement_id))
        r = self.client.post(S, {"agreement": self.agreement_id, "frequency": "monthly",
                                 "day_of_month": 2, "recipients": ["a@example.com"]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNotNone(r.json()["next_at"])
        self.assertEqual(self.client.get(f"{S}?agreement={self.agreement_id}").json()["count"],
                         1)
        self.assertEqual(self.client.get(f"{S}?overview=1").json()["count"], 0)
        r2 = self.client.post(f"{S}{r.json()['id']}/send-now/", {"period": "current"})
        # Monthly on "previous" by default: no stored figure for last month.
        self.assertEqual(r2.status_code, 400)
        self.client.patch(f"{S}{r.json()['id']}/", {"period": "current"}, format="json")
        r2 = self.client.post(f"{S}{r.json()['id']}/send-now/")
        self.assertEqual(r2.status_code, 200, r2.content)
        self.assertEqual(len(mail.outbox), 1)
        # Sending by hand does not move the schedule.
        self.assertIsNone(SlaReportSchedule.objects.get(pk=r.json()["id"]).report_sent_at)

    def test_validation(self):
        for bad in ({"recipients": []}, {"recipients": ["not-an-address"]},
                    {"recipients": ["a@example.com"], "day_of_month": 31},
                    {"recipients": ["a@example.com"], "hour": 24}):
            r = self.client.post(S, {"agreement": self.agreement_id, **bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)

    def test_a_limited_or_credit_blind_user_cannot_schedule(self):
        u = User.objects.create_user("ops", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        p = ObjectPermission.objects.create(name="sla", object_types=["slaagreement"],
                                            actions=["view", "change"])
        p.users.add(u)
        p.tenants.add(self.tenant)
        self.login(u)
        r = self.client.post(S, {"agreement": self.agreement_id,
                                 "recipients": ["a@example.com"]}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.post(S, {"recipients": ["a@example.com"]}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(SlaReportSchedule.objects.exists())
