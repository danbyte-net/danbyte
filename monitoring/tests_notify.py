"""Milestone 5 tests — notification channels + retention pruning."""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.core import mail
from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from . import notify
from .models import (
    CheckKind,
    CheckResult,
    CheckStatus,
    CheckTemplate,
    NotificationChannel,
    StateTransition,
)
from .retention import prune


from api.test_utils import status_for


class Base(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="127.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="127.0.0.1", prefix=self.prefix
        )
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP
        )

    def _transition(self, to_status="down", from_status="up"):
        return StateTransition.objects.create(
            tenant=self.tenant,
            target_ip=self.ip,
            template=self.template,
            kind="icmp",
            from_status=from_status,
            to_status=to_status,
            at=timezone.now(),
            detail={},
        )


class StatusChangeInstantTests(Base):
    """Opt-in raw status changes, instant mode (dispatch_status_changes)."""

    def _channel(self, **kw):
        base = dict(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"},
            send_status_changes=True, status_change_mode="instant",
        )
        base.update(kw)
        return NotificationChannel.objects.create(**base)

    def test_webhook_fires_with_payload(self):
        self._channel()
        tr = self._transition(to_status="down")
        with patch("monitoring.notify.safe_post") as post:
            post.return_value.status_code = 200
            notify.dispatch_status_changes([tr])
            post.assert_called_once()
            payload = post.call_args.kwargs["json"]
            self.assertEqual(payload["count"], 1)
            self.assertEqual(payload["transitions"][0]["to_status"], "down")
            self.assertEqual(payload["transitions"][0]["target_ip"], "127.0.0.1")

    def test_not_opted_in_channel_is_skipped(self):
        self._channel(send_status_changes=False)
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_status_changes([self._transition(to_status="down")])
            post.assert_not_called()

    def test_batched_channel_not_sent_instantly(self):
        self._channel(status_change_mode="batched")
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_status_changes([self._transition(to_status="down")])
            post.assert_not_called()

    def test_on_statuses_filter_skips_unwanted(self):
        self._channel(on_statuses=["down"])
        tr = self._transition(to_status="up")  # not in [down]
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_status_changes([tr])
            post.assert_not_called()

    def test_prefix_scope_filters_out_other_subnets(self):
        other = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/16",
            status=status_for(self.tenant, "container"),
        )
        self._channel(match_prefix=other)  # our IP is 127.0.0.1, not in 10.9/16
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_status_changes([self._transition(to_status="down")])
            post.assert_not_called()

    def test_disabled_channel_skipped(self):
        self._channel(enabled=False)
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_status_changes([self._transition()])
            post.assert_not_called()

    def test_webhook_failure_does_not_raise(self):
        self._channel()
        with patch("monitoring.notify.safe_post", side_effect=RuntimeError("boom")):
            # Must swallow — a notifier error can't fail the check run.
            notify.dispatch_status_changes([self._transition()])

    def test_instant_email_sent(self):
        self._channel(kind="email", config={"recipients": ["ops@example.test"]})
        notify.dispatch_status_changes([self._transition(to_status="down")])
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertIn("ops@example.test", msg.to)
        self.assertIn("up → down", msg.body)
        self.assertIn("127.0.0.1", msg.body)


class StatusChangeBatchedTests(Base):
    """Batched mini-digest (run_due_status_change_digests)."""

    def test_batched_digest_sends_and_stamps_last_run(self):
        ch = NotificationChannel.objects.create(
            tenant=self.tenant, name="ops", kind="email",
            config={"recipients": ["ops@example.test"]},
            send_status_changes=True, status_change_mode="batched",
            status_change_interval_minutes=30,
        )
        self._transition(to_status="down")
        sent = notify.run_due_status_change_digests()
        self.assertEqual(sent, 1)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("status change", mail.outbox[0].subject.lower())
        ch.refresh_from_db()
        self.assertIsNotNone(ch.status_change_last_run)
        # Second run inside the interval → nothing (last_run gates it).
        self.assertEqual(notify.run_due_status_change_digests(), 0)


class RetentionTests(Base):
    def _result(self, days_old):
        return CheckResult.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", status=CheckStatus.UP,
            timestamp=timezone.now() - timedelta(days=days_old),
        )

    def test_prune_deletes_old_results_keeps_recent(self):
        self._result(120)  # older than 90d default → pruned
        self._result(120)
        self._result(1)  # recent → kept
        out = prune()
        self.assertEqual(out["results_deleted"], 2)
        self.assertEqual(CheckResult.objects.count(), 1)

    def test_prune_keeps_transitions_longer(self):
        # 120 days old: past result retention (90) but inside transition (365).
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", from_status="up", to_status="down",
            at=timezone.now() - timedelta(days=120),
        )
        out = prune()
        self.assertEqual(out["transitions_deleted"], 0)
        self.assertEqual(StateTransition.objects.count(), 1)
