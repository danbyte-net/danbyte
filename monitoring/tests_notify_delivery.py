"""Notification delivery: HTTP errors are failures (#358) and a status change
is sent once across workers (#359)."""
from __future__ import annotations

import smtplib
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.core import mail
from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import notify
from .models import CheckKind, CheckTemplate, NotificationChannel, StateTransition

HOOK = "https://hooks.test/T000/B000/secret-token"


def _resp(code):
    return SimpleNamespace(status_code=code, json=lambda: {})


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/16", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.1", prefix=prefix
        )
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP
        )
        self.now = timezone.now()

    def channel(self, **kw):
        base = dict(
            tenant=self.tenant, name="hook", kind="webhook", config={"url": HOOK},
            send_status_changes=True, status_change_mode="instant",
        )
        base.update(kw)
        return NotificationChannel.objects.create(**base)

    def transition(self, at=None, to_status="down", from_status="up"):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template, kind="icmp",
            from_status=from_status, to_status=to_status,
            at=at or self.now - timedelta(seconds=1),
        )

    def post(self, *answers):
        """Patch the outbound POST; each call takes the next answer (a status
        code or an exception), the last one repeating."""
        answers = list(answers)
        calls = []

        def fake(url, **kwargs):
            calls.append(kwargs.get("json"))
            a = answers.pop(0) if len(answers) > 1 else answers[0]
            if isinstance(a, BaseException):
                raise a
            return _resp(a)

        p = patch("monitoring.notify.safe_post", side_effect=fake)
        p.start()
        self.addCleanup(p.stop)
        return calls


class SendTestTests(_Base):
    def test_http_error_is_reported_for_every_http_channel(self):
        self.post(500)
        for kind, cfg in (
            ("webhook", {"url": HOOK}), ("slack", {"url": HOOK}), ("teams", {"url": HOOK}),
            ("discord", {"url": HOOK}), ("pagerduty", {"routing_key": "rk"}),
        ):
            ch = NotificationChannel.objects.create(
                tenant=self.tenant, name=kind, kind=kind, config=cfg
            )
            with self.subTest(kind=kind), self.assertRaises(notify.DeliveryError) as cm:
                notify.send_test(ch)
            self.assertIn("HTTP 500", str(cm.exception))
            self.assertNotIn("secret-token", str(cm.exception))

    def test_success_and_other_2xx_pass(self):
        for code in (200, 202, 204):
            self.post(code)
            notify.send_test(self.channel(name=f"h{code}", send_status_changes=False))

    def test_redirect_is_not_delivery(self):
        self.post(302)
        with self.assertRaises(notify.DeliveryError):
            notify.send_test(self.channel(send_status_changes=False))

    def test_connection_error_is_reported(self):
        self.post(ConnectionError("refused"))
        with self.assertRaises(ConnectionError):
            notify.send_test(self.channel(send_status_changes=False))

    def test_endpoint_returns_the_failure(self):
        from django.contrib.auth.models import User
        from rest_framework.test import APIClient

        self.post(500)
        ch = self.channel(send_status_changes=False)
        client = APIClient()
        client.force_login(User.objects.create_superuser("admin", "a@x.com", "x"))
        session = client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        r = client.post(f"/api/monitoring/channels/{ch.id}/test/")
        self.assertEqual(r.status_code, 502, r.content)
        self.assertFalse(r.json()["ok"])
        self.assertIn("HTTP 500", r.json()["detail"])
        self.assertNotIn("secret-token", r.content.decode())


class InstantRetryTests(_Base):
    def test_failed_delivery_is_sent_again_after_recovery(self):
        ch = self.channel()
        tr = self.transition()
        calls = self.post(500, 200)

        notify.dispatch_status_changes([tr], self.now)
        self.assertEqual(len(calls), 1)
        ch.refresh_from_db()
        self.assertLess(ch.status_change_last_run, tr.at)

        sent = notify.run_due_status_change_digests(self.now + timedelta(seconds=5))
        self.assertEqual(sent, 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["transitions"][0]["to_status"], "down")
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, self.now + timedelta(seconds=5))

    def test_connection_error_keeps_the_change(self):
        previous = self.now - timedelta(minutes=10)
        ch = self.channel(status_change_last_run=previous)
        tr = self.transition()
        calls = self.post(ConnectionError("refused"), 200)

        notify.dispatch_status_changes([tr], self.now)
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, previous)

        notify.dispatch_status_changes([tr], self.now + timedelta(seconds=2))
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(calls[1]["transitions"]), 1)

    def test_success_stamps_the_send(self):
        ch = self.channel()
        tr = self.transition()
        self.post(200)
        notify.dispatch_status_changes([tr], self.now)
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, self.now)

    def test_smtp_failure_is_retried(self):
        ch = self.channel(kind="email", config={"recipients": ["ops@example.test"]})
        tr = self.transition()
        with patch("django.core.mail.EmailMultiAlternatives.send",
                   side_effect=smtplib.SMTPException("421 try later")):
            notify.dispatch_status_changes([tr], self.now)
        ch.refresh_from_db()
        self.assertLess(ch.status_change_last_run, tr.at)
        notify.run_due_status_change_digests(self.now + timedelta(seconds=5))
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("10.9.0.1", mail.outbox[0].body)


class BatchedRetryTests(_Base):
    def batched(self, **kw):
        return self.channel(status_change_mode="batched", status_change_interval_minutes=30, **kw)

    def test_refused_digest_is_not_stamped_and_goes_out_next_tick(self):
        ch = self.batched()
        self.transition()
        calls = self.post(ConnectionError("refused"), 200)

        self.assertEqual(notify.run_due_status_change_digests(self.now), 0)
        ch.refresh_from_db()
        self.assertLess(ch.status_change_last_run, self.now - timedelta(minutes=29))

        self.assertEqual(notify.run_due_status_change_digests(self.now + timedelta(minutes=1)), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["transitions"][0]["to_status"], "down")
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, self.now + timedelta(minutes=1))

    def test_http_500_keeps_the_previous_window(self):
        previous = self.now - timedelta(minutes=45)
        ch = self.batched(status_change_last_run=previous)
        self.transition()
        self.post(500)
        notify.run_due_status_change_digests(self.now)
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, previous)

    def test_empty_window_is_still_stamped(self):
        ch = self.batched()
        calls = self.post(200)
        self.assertEqual(notify.run_due_status_change_digests(self.now), 0)
        self.assertEqual(calls, [])
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, self.now)

    def test_one_failing_channel_does_not_hold_back_another(self):
        bad = self.batched(name="bad", config={"url": "https://bad.test/h"})
        good = self.batched(name="good")
        self.transition()

        def fake(url, **kwargs):
            return _resp(500 if "bad.test" in url else 200)

        with patch("monitoring.notify.safe_post", side_effect=fake):
            self.assertEqual(notify.run_due_status_change_digests(self.now), 1)
        bad.refresh_from_db()
        good.refresh_from_db()
        self.assertLess(bad.status_change_last_run, self.now)
        self.assertEqual(good.status_change_last_run, self.now)


class SingleSendTests(_Base):
    """The window is claimed before the slow send (#359)."""

    def test_worker_arriving_during_a_send_sends_nothing(self):
        self.channel()
        tr = self.transition()
        calls = []

        def slow(url, **kwargs):
            calls.append(kwargs.get("json"))
            if len(calls) == 1:
                # A second worker picks up the same change mid-delivery.
                notify.dispatch_status_changes([tr], self.now + timedelta(milliseconds=300))
            return _resp(200)

        with patch("monitoring.notify.safe_post", side_effect=slow):
            notify.dispatch_status_changes([tr], self.now)
        self.assertEqual(len(calls), 1)

    def test_two_workers_that_read_the_channel_before_either_claims(self):
        ch = self.channel()
        tr = self.transition()
        calls = self.post(200)
        first = NotificationChannel.objects.get(pk=ch.pk)
        second = NotificationChannel.objects.get(pk=ch.pk)
        since = self.now - notify.INSTANT_SPACING

        self.assertTrue(notify._send_instant(first, since, self.now))
        self.assertFalse(
            notify._send_instant(second, since, self.now + timedelta(milliseconds=300))
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["transitions"][0]["at"], tr.at.isoformat())

    def test_beat_and_batch_do_not_both_send(self):
        previous = self.now - timedelta(minutes=5)
        self.channel(status_change_last_run=previous)
        tr = self.transition()
        calls = []

        def slow(url, **kwargs):
            calls.append(kwargs.get("json"))
            if len(calls) == 1:
                notify.run_due_status_change_digests(self.now + timedelta(milliseconds=300))
            return _resp(200)

        with patch("monitoring.notify.safe_post", side_effect=slow):
            notify.dispatch_status_changes([tr], self.now)
        self.assertEqual(len(calls), 1)

    def test_batched_digest_is_claimed_too(self):
        self.channel(status_change_mode="batched", status_change_interval_minutes=30)
        self.transition()
        calls = []

        def slow(url, **kwargs):
            calls.append(kwargs.get("json"))
            if len(calls) == 1:
                notify.run_due_status_change_digests(self.now + timedelta(milliseconds=300))
            return _resp(200)

        with patch("monitoring.notify.safe_post", side_effect=slow):
            notify.run_due_status_change_digests(self.now)
        self.assertEqual(len(calls), 1)

    def test_failed_claim_is_released_for_a_retry(self):
        ch = self.channel()
        tr = self.transition()
        calls = self.post(500, 200)
        notify.dispatch_status_changes([tr], self.now)
        notify.dispatch_status_changes([tr], self.now + timedelta(seconds=1))
        self.assertEqual(len(calls), 2)
        ch.refresh_from_db()
        self.assertEqual(ch.status_change_last_run, self.now + timedelta(seconds=1))


def _resp_h(code, headers=None):
    return SimpleNamespace(status_code=code, headers=headers or {}, json=lambda: {})


class GroupedPagerDutyTests(_Base):
    """A grouped burst sends one PagerDuty event per alert. One refused event
    must not drop the rest, and refused ones are sent again (#369)."""

    def setUp(self):
        super().setUp()
        from .models import Alert

        self.alerts = []
        for n in range(1, 4):
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.9.1.{n}", prefix=self.ip.prefix
            )
            self.alerts.append(Alert.objects.create(
                tenant=self.tenant, target_ip=ip, template=self.template, kind="icmp",
                dedup_key=f"10.9.1.{n}:icmp", severity="critical", check_status="down",
            ))
        self.pd = NotificationChannel.objects.create(
            tenant=self.tenant, name="pd", kind="pagerduty",
            config={"routing_key": "R0UT1NG"},
        )
        sleeper = patch("monitoring.notify._wait")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def answers(self, *answers):
        """Each outbound POST takes the next answer: a status code, a
        ``(code, headers)`` pair or an exception; the last one repeats."""
        answers = list(answers)
        calls = []

        def fake(url, **kwargs):
            calls.append(kwargs.get("json"))
            a = answers.pop(0) if len(answers) > 1 else answers[0]
            if isinstance(a, BaseException):
                raise a
            if isinstance(a, tuple):
                return _resp_h(*a)
            return _resp_h(a)

        p = patch("monitoring.notify.safe_post", side_effect=fake)
        p.start()
        self.addCleanup(p.stop)
        return calls

    def keys(self, calls):
        return [c["dedup_key"] for c in calls if c and "dedup_key" in c]

    def test_one_refused_event_does_not_drop_the_rest(self):
        calls = self.answers(429, 202, 202, 202)
        notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertEqual(
            self.keys(calls),
            ["10.9.1.1:icmp", "10.9.1.2:icmp", "10.9.1.3:icmp", "10.9.1.1:icmp"],
        )

    def test_events_that_went_through_are_not_sent_twice(self):
        calls = self.answers(202, 500, 202, 202)
        notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        keys = self.keys(calls)
        self.assertEqual(keys.count("10.9.1.1:icmp"), 1)
        self.assertEqual(keys.count("10.9.1.2:icmp"), 2)
        self.assertEqual(keys.count("10.9.1.3:icmp"), 1)

    def test_retry_after_is_respected(self):
        self.answers((429, {"Retry-After": "7"}), 202)
        notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.sleep.assert_called_once_with(7)

    def test_retry_after_beyond_the_budget_is_not_retried_early(self):
        calls = self.answers((429, {"Retry-After": "3600"}), 202)
        with self.assertLogs("monitoring.notify", "ERROR"):
            notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertEqual(len(self.keys(calls)), 3)
        self.sleep.assert_not_called()

    def test_connection_error_is_retried(self):
        calls = self.answers(ConnectionError("reset"), 202)
        notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertEqual(self.keys(calls).count("10.9.1.1:icmp"), 2)

    def test_a_rejected_event_is_not_retried(self):
        calls = self.answers(400, 202)
        with self.assertLogs("monitoring.notify", "ERROR"):
            notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertEqual(len(self.keys(calls)), 3)
        self.sleep.assert_not_called()

    def test_gives_up_after_the_last_attempt_and_logs(self):
        calls = self.answers(503)
        with self.assertLogs("monitoring.notify", "ERROR") as logs:
            notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertEqual(len(self.keys(calls)), 3 * notify.GROUP_SEND_ATTEMPTS)
        self.assertIn("3 of 3", "\n".join(logs.output))

    def test_other_channels_still_get_the_summary(self):
        self.channel(send_status_changes=False)
        calls = self.answers(503)
        with self.assertLogs("monitoring.notify", "ERROR"):
            notify.notify_alert_group(self.tenant.id, self.alerts, "firing")
        self.assertTrue(any(c and c.get("count") == 3 for c in calls))

    def test_retry_after_is_parsed_from_seconds_and_dates(self):
        from email.utils import format_datetime

        self.assertEqual(notify._retry_after({"Retry-After": "12"}), 12)
        self.assertIsNone(notify._retry_after({}))
        self.assertIsNone(notify._retry_after({"Retry-After": "soon"}))
        later = format_datetime(timezone.now() + timedelta(seconds=30), usegmt=True)
        self.assertTrue(25 <= notify._retry_after({"Retry-After": later}) <= 31)
