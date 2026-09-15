"""A flapping check does not spam. Its changes are mailed once per episode -
a flapping notice when flagged, one when it settles or is confirmed - and in
between neither the status-change channels nor the alert channels hear about
it. Instant status-change channels also never send more often than
:data:`monitoring.notify.INSTANT_SPACING`; what arrives inside the window is
coalesced into the next message.
"""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import notify
from .alerts import process_transitions
from .flapping import clear_flapping, sweep_flapping
from .models import (
    Alert,
    AlertStatus,
    CheckKind,
    CheckState,
    CheckTemplate,
    MonitoringSettings,
    NotificationChannel,
    StateTransition,
)

User = get_user_model()


class Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.41", prefix=prefix)
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="port 9990", slug="port-9990", kind=CheckKind.TCP
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind=CheckKind.TCP, status="up",
        )
        self.channel = NotificationChannel.objects.create(
            tenant=self.tenant, name="ops", kind="email",
            config={"recipients": ["ops@example.test"]},
            send_status_changes=True, status_change_mode="instant",
        )

    def _tr(self, to_status, at=None, from_status=None):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template, kind=CheckKind.TCP,
            from_status=from_status or ("up" if to_status == "down" else "down"),
            to_status=to_status, at=at or timezone.now(), detail={},
        )

    def _flap(self, n=6, minutes=10):
        """n down/up pairs inside the window, then the sweep flags the check."""
        now = timezone.now()
        for i in range(n):
            self._tr("down", at=now - timedelta(minutes=minutes) + timedelta(seconds=i * 60))
            self._tr("up", at=now - timedelta(minutes=minutes) + timedelta(seconds=i * 60 + 20))
        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"flap_threshold": 5, "flap_window_minutes": 30}
        )
        return sweep_flapping(now)


class FlappingNoticeTests(Base):
    def test_flagging_sends_one_notice_with_the_chain(self):
        swept = self._flap()
        self.assertEqual(swept["flagged"], 1)
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertIn("Flapping: 10.0.0.41 · port 9990", msg.subject)
        self.assertIn("stopped mailing each change", msg.body)
        html = msg.alternatives[0][0]
        self.assertIn("Last changes", html)
        self.assertIn("cid:logo", html)
        # A second sweep with nothing new says nothing.
        sweep_flapping()
        self.assertEqual(len(mail.outbox), 1)

    def test_confirming_sends_the_all_clear(self):
        self._flap()
        mail.outbox.clear()
        user = User.objects.create_user("ops", "ops@example.test", "x")
        self.state.refresh_from_db()
        self.assertEqual(clear_flapping([self.state], user), 1)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Not flapping: 10.0.0.41", mail.outbox[0].subject)
        self.assertIn("ops confirmed", mail.outbox[0].body)

    def test_settling_sends_the_all_clear(self):
        self._flap()
        mail.outbox.clear()
        MonitoringSettings.objects.filter(tenant=self.tenant).update(
            auto_clear_flapping=True, auto_clear_flapping_after_minutes=30
        )
        sweep_flapping(timezone.now() + timedelta(hours=2))
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Settled: 10.0.0.41", mail.outbox[0].subject)

    def test_webhook_channels_get_an_event(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"},
            send_status_changes=True, status_change_mode="batched",
        )
        with patch("monitoring.notify.safe_post") as post:
            post.return_value.status_code = 200
            self._flap()
            post.assert_called_once()
            payload = post.call_args.kwargs["json"]
            self.assertEqual(payload["transitions"][0]["event"], "flapping")
            self.assertEqual(payload["transitions"][0]["target_ip"], "10.0.0.41")

    def test_out_of_scope_channels_are_not_told(self):
        other = Prefix.objects.create(
            tenant=self.tenant, cidr="192.168.0.0/24", status=status_for(self.tenant, "container")
        )
        self.channel.match_prefix = other
        self.channel.save()
        self._flap()
        self.assertEqual(len(mail.outbox), 0)


class QuietWhileFlappingTests(Base):
    def test_status_changes_of_a_flapping_check_are_not_mailed(self):
        self._flap()
        mail.outbox.clear()
        self.channel.status_change_last_run = timezone.now() - timedelta(minutes=5)
        self.channel.save()
        notify.dispatch_status_changes([self._tr("down"), self._tr("up")])
        self.assertEqual(len(mail.outbox), 0)
        # And the batched digest leaves them out too.
        self.channel.status_change_mode = "batched"
        self.channel.status_change_interval_minutes = 1
        self.channel.status_change_last_run = timezone.now() - timedelta(minutes=5)
        self.channel.save()
        notify.run_due_status_change_digests()
        self.assertEqual(len(mail.outbox), 0)

    def test_alerts_of_a_flapping_check_open_and_resolve_quietly(self):
        self._flap()
        mail.outbox.clear()
        with patch("monitoring.notify.notify_alert") as na, patch("monitoring.notify.notify_alert_group") as ng:
            now = timezone.now()
            process_transitions([self._tr("down", at=now)], now)
            process_transitions([self._tr("up", at=now + timedelta(seconds=20))], now + timedelta(seconds=20))
            na.assert_not_called()
            ng.assert_not_called()
        # The record is still kept, and carries the flag from the start.
        alert = Alert.objects.get(tenant=self.tenant, target_ip=self.ip)
        self.assertEqual(alert.status, AlertStatus.RESOLVED)
        self.assertTrue(alert.flapping)

    def test_a_check_that_is_not_flapping_still_announces_its_alerts(self):
        with patch("monitoring.notify.notify_alert") as na:
            now = timezone.now()
            process_transitions([self._tr("down", at=now)], now)
            self.assertEqual(na.call_count, 1)


class InstantSpacingTests(Base):
    def test_first_change_goes_out_at_once_the_rest_wait_for_the_window(self):
        now = timezone.now()
        notify.dispatch_status_changes([self._tr("down", at=now)], now)
        self.assertEqual(len(mail.outbox), 1)
        # Two more inside the window: nothing sent, nothing lost.
        notify.dispatch_status_changes([self._tr("up", at=now + timedelta(seconds=5))], now + timedelta(seconds=5))
        notify.dispatch_status_changes([self._tr("down", at=now + timedelta(seconds=30))], now + timedelta(seconds=30))
        self.assertEqual(len(mail.outbox), 1)
        # The window passes with no new batch: the beat delivers both, once.
        with patch("django.utils.timezone.now", return_value=now + timedelta(seconds=90)):
            notify.run_due_status_change_digests()
        self.assertEqual(len(mail.outbox), 2)
        self.assertIn("2 monitoring status change(s)", mail.outbox[1].subject)
        with patch("django.utils.timezone.now", return_value=now + timedelta(seconds=200)):
            notify.run_due_status_change_digests()
        self.assertEqual(len(mail.outbox), 2)

    def test_a_batch_after_the_window_carries_what_was_held(self):
        now = timezone.now()
        notify.dispatch_status_changes([self._tr("down", at=now)], now)
        notify.dispatch_status_changes([self._tr("up", at=now + timedelta(seconds=10))], now + timedelta(seconds=10))
        self.assertEqual(len(mail.outbox), 1)
        later = now + timedelta(seconds=70)
        notify.dispatch_status_changes([self._tr("down", at=later)], later)
        self.assertEqual(len(mail.outbox), 2)
        self.assertIn("2 monitoring status change(s)", mail.outbox[1].subject)
