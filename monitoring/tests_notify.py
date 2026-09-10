"""Milestone 5 tests - notification channels + retention pruning."""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import Group, User
from django.core import mail
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from . import notify
from .models import (
    CheckKind,
    CheckResult,
    CheckStatus,
    CheckTemplate,
    NotificationChannel,
    NotificationSubscription,
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
            # Must swallow - a notifier error can't fail the check run.
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


class RecipientResolverTests(Base):
    def _channel(self, recipients=None):
        return NotificationChannel.objects.create(
            tenant=self.tenant, name="e", kind="email",
            config={"recipients": recipients or []},
        )

    def test_config_only_deduped_blanks_dropped(self):
        ch = self._channel(["a@x.com", "a@x.com", "", "b@x.com"])
        self.assertEqual(notify.resolve_recipients(ch), ["a@x.com", "b@x.com"])

    def test_user_and_group_members_merge(self):
        ch = self._channel(["a@x.com"])
        u = User.objects.create_user("u1", "u1@x.com", "x")
        NotificationSubscription.objects.create(
            tenant=self.tenant, channel=ch, user=u
        )
        g = Group.objects.create(name="noc")
        User.objects.create_user("m1", "m1@x.com", "x").groups.add(g)
        User.objects.create_user("m2", "", "x").groups.add(g)  # blank → skipped
        NotificationSubscription.objects.create(
            tenant=self.tenant, channel=ch, group=g
        )
        self.assertEqual(
            set(notify.resolve_recipients(ch)),
            {"a@x.com", "u1@x.com", "m1@x.com"},
        )


class GroupDeliveryTests(Base):
    def test_group_subscription_emails_members(self):
        ch = NotificationChannel.objects.create(
            tenant=self.tenant, name="noc", kind="email", config={},
            send_status_changes=True, status_change_mode="instant",
        )
        g = Group.objects.create(name="noc")
        User.objects.create_user("noc1", "noc1@x.com", "x").groups.add(g)
        NotificationSubscription.objects.create(
            tenant=self.tenant, channel=ch, group=g
        )
        notify.dispatch_status_changes([self._transition(to_status="down")])
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("noc1@x.com", mail.outbox[0].to)


class _SubApiBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _channel(self, **kw):
        base = dict(
            tenant=self.tenant, name="ops", kind="email",
            config={"recipients": []}, self_subscribable=True,
        )
        base.update(kw)
        return NotificationChannel.objects.create(**base)


class SelfServiceApiTests(_SubApiBase):
    def test_me_lists_available_self_subscribable(self):
        self._channel()
        self._login(self.admin)
        r = self.client.get("/api/monitoring/notifications/me/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["available"]), 1)
        self.assertTrue(r.json()["can_subscribe"])

    def test_subscribe_then_unsubscribe(self):
        ch = self._channel()
        self._login(self.admin)
        r = self.client.post("/api/monitoring/notifications/subscribe/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(NotificationSubscription.objects.filter(
            channel=ch, user=self.admin, mandatory=False).exists())
        me = self.client.get("/api/monitoring/notifications/me/").json()
        row = next(x for x in me["subscriptions"]
                   if x["channel"]["id"] == str(ch.id))
        self.assertEqual(row["source"], "self")
        self.assertTrue(row["can_unsubscribe"])
        r = self.client.post("/api/monitoring/notifications/unsubscribe/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(NotificationSubscription.objects.filter(
            channel=ch, user=self.admin).exists())

    def test_cannot_unsubscribe_mandatory(self):
        ch = self._channel()
        self._login(self.admin)
        NotificationSubscription.objects.create(
            tenant=self.tenant, channel=ch, user=self.admin, mandatory=True)
        r = self.client.post("/api/monitoring/notifications/unsubscribe/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(NotificationSubscription.objects.filter(
            channel=ch, user=self.admin).exists())

    def test_subscribe_requires_permission(self):
        ch = self._channel()
        self._login(User.objects.create_user("reader", "r@x.com", "x"))
        r = self.client.post("/api/monitoring/notifications/subscribe/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_cannot_subscribe_non_self_subscribable(self):
        ch = self._channel(self_subscribable=False)
        self._login(self.admin)
        r = self.client.post("/api/monitoring/notifications/subscribe/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 400)


class SubscriptionAdminApiTests(_SubApiBase):
    def test_admin_creates_group_subscription(self):
        ch = self._channel()
        g = Group.objects.create(name="noc")
        self._login(self.admin)
        r = self.client.post("/api/monitoring/subscriptions/",
                             {"channel": str(ch.id), "group": g.id,
                              "mandatory": True}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(NotificationSubscription.objects.filter(
            channel=ch, group=g, mandatory=True).exists())

    def test_exactly_one_of_user_or_group(self):
        ch = self._channel()
        self._login(self.admin)
        r = self.client.post("/api/monitoring/subscriptions/",
                             {"channel": str(ch.id)}, format="json")
        self.assertEqual(r.status_code, 400)


class WatchApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.10.0.0/16",
            status=status_for(self.tenant, "container"),
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.10.0.5", prefix=self.prefix
        )
        self.tpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP
        )
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _transition(self, ip, to_status="down"):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.tpl, kind="icmp",
            from_status="up", to_status=to_status, at=timezone.now(), detail={},
        )

    def test_watch_creates_channel_and_subscription(self):
        r = self.client.post("/api/monitoring/notifications/watch/",
                             {"prefix": str(self.prefix.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["watching"])
        ch = NotificationChannel.objects.get(
            tenant=self.tenant, auto_created=True, match_prefix=self.prefix
        )
        self.assertTrue(ch.send_status_changes)
        self.assertTrue(NotificationSubscription.objects.filter(
            channel=ch, user=self.admin).exists())
        state = self.client.get(
            "/api/monitoring/notifications/watch-state/",
            {"prefix": str(self.prefix.id)},
        ).json()
        self.assertTrue(state["watching"])

    def test_unwatch_cleans_up_empty_auto_channel(self):
        self.client.post("/api/monitoring/notifications/watch/",
                        {"prefix": str(self.prefix.id)}, format="json")
        r = self.client.post("/api/monitoring/notifications/unwatch/",
                            {"prefix": str(self.prefix.id)}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["watching"])
        self.assertFalse(NotificationChannel.objects.filter(
            tenant=self.tenant, auto_created=True, match_prefix=self.prefix
        ).exists())

    def _device(self, name="dev1", ip=None):
        from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site

        site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=dtype, site=site,
            role=role, status=status_for(self.tenant),
        )
        if ip is not None:
            ip.assigned_device = dev
            ip.save(update_fields=["assigned_device"])
        return dev

    def test_watch_device_creates_scoped_channel(self):
        dev = self._device(ip=self.ip)
        r = self.client.post("/api/monitoring/notifications/watch/",
                             {"device": str(dev.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        ch = NotificationChannel.objects.get(
            tenant=self.tenant, auto_created=True, match_device=dev
        )
        self.assertEqual(ch.name, f"Device {dev.name}")

    def test_device_scope_delivers_only_its_ips(self):
        dev = self._device(ip=self.ip)
        self.client.post("/api/monitoring/notifications/watch/",
                        {"device": str(dev.id)}, format="json")
        # The device's IP → email.
        notify.dispatch_status_changes([self._transition(self.ip)])
        self.assertEqual(len(mail.outbox), 1)
        # Another IP, not assigned to the device → nothing more.
        other = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.10.0.99", prefix=self.prefix
        )
        notify.dispatch_status_changes([self._transition(other)])
        self.assertEqual(len(mail.outbox), 1)

    def test_watch_delivers_only_in_scope(self):
        self.client.post("/api/monitoring/notifications/watch/",
                        {"prefix": str(self.prefix.id)}, format="json")
        # In-scope IP → the watcher is emailed.
        notify.dispatch_status_changes([self._transition(self.ip)])
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("a@x.com", mail.outbox[0].to)
        # Out-of-scope IP → nothing more.
        other_pfx = Prefix.objects.create(
            tenant=self.tenant, cidr="192.168.0.0/24",
            status=status_for(self.tenant, "container"),
        )
        other_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="192.168.0.9", prefix=other_pfx
        )
        notify.dispatch_status_changes([self._transition(other_ip)])
        self.assertEqual(len(mail.outbox), 1)


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


class TeamsAdaptiveCardTests(Base):
    """Teams gets an Adaptive Card, not Slack's bare {"text": ...} (#157)."""

    def _channel(self, kind):
        return NotificationChannel.objects.create(
            tenant=self.tenant, name=kind, kind=kind,
            config={"url": f"https://hooks.test/{kind}"},
        )

    def _alert(self, **kw):
        from .models import Alert

        base = dict(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", dedup_key="127.0.0.1:icmp", severity="critical",
            check_status="down",
        )
        base.update(kw)
        return Alert.objects.create(**base)

    def _base_url(self, value):
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.public_base_url = value
        dep.save(update_fields=["public_base_url"])

    def _card(self, payload):
        """Assert the message envelope and hand back the AdaptiveCard."""
        self.assertEqual(payload["type"], "message")
        self.assertEqual(len(payload["attachments"]), 1)
        att = payload["attachments"][0]
        self.assertEqual(
            att["contentType"], "application/vnd.microsoft.card.adaptive"
        )
        self.assertIsNone(att["contentUrl"])
        card = att["content"]
        self.assertEqual(card["type"], "AdaptiveCard")
        self.assertEqual(
            card["$schema"], "http://adaptivecards.io/schemas/adaptive-card.json"
        )
        self.assertEqual(card["version"], "1.4")
        self.assertEqual(card["body"][0]["type"], "TextBlock")
        self.assertTrue(card["body"][0]["wrap"])
        return card

    # ── notify_plain (generic, no Danbyte URL) ──────────────────────────────

    def test_plain_teams_sends_card_without_actions(self):
        with patch("monitoring.notify.safe_post") as post:
            notify.notify_plain(self._channel("teams"), "Backup done", "all good")
            card = self._card(post.call_args.kwargs["json"])
        self.assertEqual(card["body"][0]["text"], "Backup done\nall good")
        self.assertNotIn("actions", card)  # no Danbyte URL at this call site

    def test_plain_slack_and_discord_payloads_unchanged(self):
        with patch("monitoring.notify.safe_post") as post:
            notify.notify_plain(self._channel("slack"), "Backup done", "all good")
            self.assertEqual(
                post.call_args.kwargs["json"], {"text": "Backup done\nall good"}
            )
            notify.notify_plain(self._channel("discord"), "Backup done", "all good")
            self.assertEqual(
                post.call_args.kwargs["json"], {"content": "Backup done\nall good"}
            )

    # ── single alert ────────────────────────────────────────────────────────

    def test_alert_teams_card_carries_open_url_action(self):
        self._base_url("https://danbyte.test/")
        with patch("monitoring.notify.safe_post") as post:
            notify._dispatch_to_channel(
                self._channel("teams"), self._alert(), "firing", "127.0.0.1"
            )
            card = self._card(post.call_args.kwargs["json"])
        self.assertIn("127.0.0.1", card["body"][0]["text"])
        # The link is an action, not appended to the text like Slack does.
        self.assertNotIn("https://danbyte.test", card["body"][0]["text"])
        self.assertEqual(
            card["actions"],
            [{"type": "Action.OpenUrl", "title": "View in Danbyte",
              "url": "https://danbyte.test/alerts"}],
        )

    def test_alert_teams_card_omits_actions_without_base_url(self):
        self._base_url("")
        with patch("monitoring.notify.safe_post") as post:
            notify._dispatch_to_channel(
                self._channel("teams"), self._alert(), "firing", "127.0.0.1"
            )
            card = self._card(post.call_args.kwargs["json"])
        self.assertNotIn("actions", card)

    def test_alert_slack_and_discord_payloads_unchanged(self):
        self._base_url("https://danbyte.test/")
        alert = self._alert()
        with patch("monitoring.notify.safe_post") as post:
            notify._dispatch_to_channel(
                self._channel("slack"), alert, "firing", "127.0.0.1"
            )
            slack = post.call_args.kwargs["json"]
            notify._dispatch_to_channel(
                self._channel("discord"), alert, "firing", "127.0.0.1"
            )
            discord = post.call_args.kwargs["json"]
        self.assertEqual(set(slack), {"text"})
        self.assertTrue(slack["text"].endswith("\nhttps://danbyte.test/alerts"))
        self.assertEqual(discord, {"content": slack["text"]})

    # ── grouped alerts ──────────────────────────────────────────────────────

    def test_group_teams_card_carries_open_url_action(self):
        from core.models import DeploymentSettings

        self._base_url("https://danbyte.test/")
        dep = DeploymentSettings.load()
        with patch("monitoring.notify.safe_post") as post:
            notify._dispatch_group_to_channel(
                self._channel("teams"), [self._alert()], "firing", dep
            )
            card = self._card(post.call_args.kwargs["json"])
        self.assertIn("1 alerts", card["body"][0]["text"])
        self.assertNotIn("https://danbyte.test", card["body"][0]["text"])
        self.assertEqual(
            card["actions"],
            [{"type": "Action.OpenUrl", "title": "View in Danbyte",
              "url": "https://danbyte.test/alerts"}],
        )

    def test_group_slack_and_discord_payloads_unchanged(self):
        from core.models import DeploymentSettings

        self._base_url("https://danbyte.test/")
        dep = DeploymentSettings.load()
        alerts = [self._alert()]
        with patch("monitoring.notify.safe_post") as post:
            notify._dispatch_group_to_channel(
                self._channel("slack"), alerts, "firing", dep
            )
            slack = post.call_args.kwargs["json"]
            notify._dispatch_group_to_channel(
                self._channel("discord"), alerts, "firing", dep
            )
            discord = post.call_args.kwargs["json"]
        self.assertEqual(set(slack), {"text"})
        self.assertTrue(slack["text"].endswith("\nhttps://danbyte.test/alerts"))
        self.assertEqual(discord, {"content": slack["text"]})


class TelegramTests(Base):
    """Telegram Bot API delivery - request shape at all three dispatch sites,
    the optional topic/thread id, and ``{"ok": false}`` on an HTTP 200."""

    TOKEN = "123456:AA-BotFatherToken"
    URL = f"https://api.telegram.org/bot{TOKEN}/sendMessage"

    def _channel(self, **cfg):
        ch = NotificationChannel.objects.create(
            tenant=self.tenant, name="tg", kind="telegram",
            config={"chat_id": "-1001234567890", **cfg},
        )
        ch.secrets = {"bot_token": self.TOKEN}
        ch.save(update_fields=["secrets"])
        return ch

    def _alert(self, **kw):
        from .models import Alert

        base = dict(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", dedup_key="127.0.0.1:icmp", severity="critical",
            check_status="down",
        )
        base.update(kw)
        return Alert.objects.create(**base)

    def _post(self, ok=True, description="", status_code=200):
        """Patch safe_post with a Bot API response body - Telegram answers 200
        even when it refuses the message, so the body is what tests assert on."""
        p = patch("monitoring.notify.safe_post")
        post = p.start()
        self.addCleanup(p.stop)
        body = {"ok": ok} if ok else {"ok": False, "description": description}
        post.return_value.status_code = status_code
        post.return_value.json.return_value = body
        return post

    def _dep(self):
        from core.models import DeploymentSettings

        return DeploymentSettings.load()

    # ── request shape, all three dispatch sites ─────────────────────────────

    def test_plain_send_posts_bot_api_sendmessage(self):
        post = self._post()
        notify.notify_plain(self._channel(), "Backup done", "all good")
        self.assertEqual(post.call_args.args[0], self.URL)
        self.assertEqual(
            post.call_args.kwargs["json"],
            {"chat_id": "-1001234567890", "text": "Backup done\nall good"},
        )

    def test_alert_send_posts_plain_text_with_link(self):
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.public_base_url = "https://danbyte.test/"
        dep.save(update_fields=["public_base_url"])
        post = self._post()
        notify._dispatch_to_channel(
            self._channel(), self._alert(), "firing", "127.0.0.1"
        )
        payload = post.call_args.kwargs["json"]
        self.assertEqual(post.call_args.args[0], self.URL)
        self.assertEqual(set(payload), {"chat_id", "text"})
        self.assertIn("127.0.0.1", payload["text"])
        # Plain text, like Slack/Discord - no parse_mode to escape around.
        self.assertNotIn("parse_mode", post.call_args.kwargs)
        self.assertTrue(payload["text"].endswith("\nhttps://danbyte.test/alerts"))

    def test_group_send_posts_one_summary(self):
        post = self._post()
        notify._dispatch_group_to_channel(
            self._channel(), [self._alert()], "firing", self._dep()
        )
        self.assertEqual(post.call_count, 1)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(post.call_args.args[0], self.URL)
        self.assertEqual(set(payload), {"chat_id", "text"})
        self.assertIn("1 alerts", payload["text"])

    # ── optional topic / thread id ──────────────────────────────────────────

    def test_thread_id_is_sent_as_message_thread_id(self):
        post = self._post()
        notify.notify_plain(self._channel(message_thread_id="42"), "Hi")
        self.assertEqual(post.call_args.kwargs["json"]["message_thread_id"], 42)

    def test_thread_id_is_omitted_when_unset(self):
        post = self._post()
        notify.notify_plain(self._channel(), "Hi")
        self.assertNotIn("message_thread_id", post.call_args.kwargs["json"])
        post.reset_mock()
        notify.notify_plain(self._channel(message_thread_id=""), "Hi")
        self.assertNotIn("message_thread_id", post.call_args.kwargs["json"])

    # ── an HTTP 200 is not delivery ─────────────────────────────────────────

    def test_ok_false_raises_with_the_description(self):
        self._post(ok=False, description="Bad Request: chat not found")
        with self.assertRaises(RuntimeError) as cm:
            notify._dispatch_to_channel(
                self._channel(), self._alert(), "firing", "127.0.0.1"
            )
        self.assertIn("chat not found", str(cm.exception))

    def test_ok_false_surfaces_through_send_test(self):
        self._post(ok=False, description="Forbidden: bot is not a member")
        with self.assertRaises(RuntimeError) as cm:
            notify.send_test(self._channel())
        self.assertIn("bot is not a member", str(cm.exception))

    def test_ok_false_does_not_break_the_alert_run(self):
        self._post(ok=False, description="chat not found")
        self._channel()
        # notify_alert is best-effort: the channel logs, the run survives.
        with self.assertLogs("monitoring.notify", level="ERROR") as logs:
            notify.notify_alert(self._alert(), "firing")
        self.assertIn("alert channel tg (telegram) failed", "".join(logs.output))

    def test_transport_error_message_hides_the_bot_token(self):
        post = self._post()
        post.side_effect = RuntimeError(f"connect failed for {self.URL}")
        with self.assertRaises(RuntimeError) as cm:
            notify.send_test(self._channel())
        self.assertNotIn(self.TOKEN, str(cm.exception))

    def test_missing_token_or_chat_id_is_refused(self):
        post = self._post()
        ch = self._channel()
        ch.secrets = {}
        ch.save(update_fields=["secrets"])
        with self.assertRaises(RuntimeError):
            notify.send_test(ch)
        post.assert_not_called()


class TelegramChannelApiTests(_SubApiBase):
    """The bot token is write-only: accepted on create/update, never read back."""

    TOKEN = "123456:AA-BotFatherToken"

    def _create(self, **overrides):
        body = {
            "name": "tg", "kind": "telegram",
            "config": {"chat_id": "-1001234567890"},
            "bot_token": self.TOKEN,
        }
        body.update(overrides)
        return self.client.post(
            "/api/monitoring/channels/", body, format="json"
        )

    def test_create_stores_the_token_but_never_returns_it(self):
        self._login(self.admin)
        r = self._create()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("bot_token", r.json())
        self.assertTrue(r.json()["bot_token_set"])
        self.assertNotIn(self.TOKEN, r.content.decode())
        ch = NotificationChannel.objects.get(id=r.json()["id"])
        self.assertEqual(ch.secrets["bot_token"], self.TOKEN)
        self.assertNotIn("bot_token", ch.config)

    def test_list_and_detail_omit_the_token(self):
        self._login(self.admin)
        cid = self._create().json()["id"]
        for url in ("/api/monitoring/channels/", f"/api/monitoring/channels/{cid}/"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200)
            self.assertNotIn(self.TOKEN, r.content.decode())

    def test_patch_without_a_token_keeps_the_stored_one(self):
        self._login(self.admin)
        cid = self._create().json()["id"]
        r = self.client.patch(
            f"/api/monitoring/channels/{cid}/",
            {"config": {"chat_id": "-100999", "message_thread_id": "7"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ch = NotificationChannel.objects.get(id=cid)
        self.assertEqual(ch.secrets["bot_token"], self.TOKEN)
        self.assertEqual(ch.config["message_thread_id"], "7")

    def test_telegram_needs_a_chat_id_and_a_token(self):
        self._login(self.admin)
        r = self._create(config={})
        self.assertEqual(r.status_code, 400)
        self.assertIn("config", r.json())
        r = self._create(bot_token="")
        self.assertEqual(r.status_code, 400)
        self.assertIn("bot_token", r.json())

    def test_non_numeric_thread_id_is_refused(self):
        self._login(self.admin)
        r = self._create(config={"chat_id": "-100999", "message_thread_id": "abc"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("config", r.json())
