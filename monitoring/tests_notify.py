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


class WebhookTests(Base):
    def test_webhook_fires_with_payload(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"},
        )
        tr = self._transition(to_status="down")
        with patch("monitoring.notify.safe_post") as post:
            post.return_value.status_code = 200
            notify.dispatch_transitions([tr])
            post.assert_called_once()
            payload = post.call_args.kwargs["json"]
            self.assertEqual(payload["count"], 1)
            self.assertEqual(payload["transitions"][0]["to_status"], "down")
            self.assertEqual(payload["transitions"][0]["target_ip"], "127.0.0.1")

    def test_on_statuses_filter_skips_unwanted(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"}, on_statuses=["down"],
        )
        tr = self._transition(to_status="up")  # not in [down]
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_transitions([tr])
            post.assert_not_called()

    def test_disabled_channel_skipped(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"}, enabled=False,
        )
        with patch("monitoring.notify.safe_post") as post:
            notify.dispatch_transitions([self._transition()])
            post.assert_not_called()

    def test_webhook_failure_does_not_raise(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="hook", kind="webhook",
            config={"url": "https://example.test/hook"},
        )
        with patch("monitoring.notify.safe_post", side_effect=RuntimeError("boom")):
            # Must swallow — a notifier error can't fail the check run.
            notify.dispatch_transitions([self._transition()])


class EmailDigestTests(Base):
    def test_email_digest_sent(self):
        NotificationChannel.objects.create(
            tenant=self.tenant, name="ops", kind="email",
            config={"recipients": ["ops@example.test"]},
        )
        notify.dispatch_transitions([self._transition(to_status="down")])
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertIn("ops@example.test", msg.to)
        self.assertIn("up → down", msg.body)
        self.assertIn("127.0.0.1", msg.body)


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
