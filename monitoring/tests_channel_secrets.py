"""Notification channel credentials are write-only and encrypted at rest.

The webhook URL of a Slack, Teams, Discord or webhook channel and the
PagerDuty routing key are credentials: whoever holds one can post into the
team's channel or open and resolve incidents. They are never returned by the
API, for any role, and live in the encrypted ``secrets`` column.
"""
from __future__ import annotations

import importlib
from unittest.mock import patch

from django.apps import apps as global_apps
from django.contrib.auth.models import Group, User
from django.db import connection
from django.test import TestCase
from rest_framework.test import APITestCase

from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from . import notify
from .models import NotificationChannel

SLACK = "https://hooks.slack.example/services/ZZSECRET"
ROUTING = "ZZROUTINGKEY"
URL_KINDS = ("slack", "teams", "discord", "webhook")


def _raw_columns(ch) -> str:
    with connection.cursor() as cur:
        cur.execute(
            "SELECT secrets, config::text FROM monitoring_notificationchannel "
            "WHERE id = %s", [ch.pk],
        )
        return " ".join(cur.fetchone())


class ChannelSecretApiTests(APITestCase):
    def setUp(self):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.root = User.objects.create_superuser("root", "root@e.com", "x")
        UserProfile.objects.create(user=self.root).tenants.add(self.tenant)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.pk)
        s.save()

    def _member(self, name, group):
        u = User.objects.create_user(name, f"{name}@e.com", "x")
        u.groups.add(Group.objects.get(name=group))
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        return u

    def _seed(self):
        slack = NotificationChannel.objects.create(
            tenant=self.tenant, name="slack", kind="slack", config={"url": SLACK}
        )
        pd = NotificationChannel.objects.create(
            tenant=self.tenant, name="pd", kind="pagerduty",
            config={"routing_key": ROUTING},
        )
        return slack, pd

    def _assert_hidden(self, user):
        self._login(user)
        slack, pd = self._seed()
        r = self.client.get("/api/monitoring/channels/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.content.decode()
        self.assertNotIn("ZZSECRET", body)
        self.assertNotIn(ROUTING, body)
        rows = {row["name"]: row for row in r.json()["results"]}
        self.assertTrue(rows["slack"]["url_set"])
        self.assertNotIn("url", rows["slack"]["config"])
        self.assertTrue(rows["pd"]["routing_key_set"])
        self.assertFalse(rows["pd"]["url_set"])
        self.assertNotIn("routing_key", rows["pd"]["config"])
        for ch in (slack, pd):
            r = self.client.get(f"/api/monitoring/channels/{ch.pk}/")
            self.assertEqual(r.status_code, 200)
            self.assertNotIn("ZZSECRET", r.content.decode())
            self.assertNotIn(ROUTING, r.content.decode())

    def test_read_only_role_gets_no_secret(self):
        self._assert_hidden(self._member("ro", "Read-only"))

    def test_operator_gets_no_secret(self):
        self._assert_hidden(self._member("op", "Operator"))

    def test_superuser_gets_no_secret(self):
        self._assert_hidden(self.root)

    def test_orm_write_is_encrypted_at_rest(self):
        slack, pd = self._seed()
        slack.refresh_from_db()
        self.assertEqual(slack.config, {})
        self.assertEqual(slack.secrets, {"url": SLACK})
        raw = _raw_columns(slack) + _raw_columns(pd)
        self.assertNotIn("ZZSECRET", raw)
        self.assertNotIn(ROUTING, raw)

    def _create(self, kind, config):
        return self.client.post(
            "/api/monitoring/channels/",
            {"name": kind, "kind": kind, "config": config}, format="json",
        )

    def test_url_kinds_round_trip(self):
        self._login(self.root)
        for kind in URL_KINDS:
            with self.subTest(kind=kind):
                url = f"https://hooks.example.com/{kind}/ZZSECRET"
                r = self._create(kind, {"url": url})
                self.assertEqual(r.status_code, 201, r.content)
                self.assertNotIn("ZZSECRET", r.content.decode())
                self.assertTrue(r.json()["url_set"])
                cid = r.json()["id"]
                ch = NotificationChannel.objects.get(pk=cid)
                self.assertEqual(ch.secrets, {"url": url})
                self.assertNotIn("url", ch.config)
                # Absent keeps it.
                r = self.client.patch(
                    f"/api/monitoring/channels/{cid}/",
                    {"name": f"{kind}-2", "config": {}}, format="json",
                )
                self.assertEqual(r.status_code, 200, r.content)
                ch.refresh_from_db()
                self.assertEqual(ch.secrets["url"], url)
                # Present replaces it.
                new = f"https://hooks.example.com/{kind}/ZZNEW"
                r = self.client.patch(
                    f"/api/monitoring/channels/{cid}/",
                    {"config": {"url": new}}, format="json",
                )
                self.assertEqual(r.status_code, 200, r.content)
                self.assertNotIn("ZZNEW", r.content.decode())
                ch.refresh_from_db()
                self.assertEqual(ch.secrets["url"], new)
                # Empty clears it, and these kinds need one.
                r = self.client.patch(
                    f"/api/monitoring/channels/{cid}/",
                    {"config": {"url": ""}}, format="json",
                )
                self.assertEqual(r.status_code, 400)
                self.assertIn("config", r.json())
                ch.refresh_from_db()
                self.assertEqual(ch.secrets["url"], new)

    def test_url_is_required_on_create(self):
        self._login(self.root)
        r = self._create("slack", {})
        self.assertEqual(r.status_code, 400)
        self.assertIn("url", r.json()["config"][0])

    def test_pagerduty_round_trip(self):
        self._login(self.root)
        r = self._create("pagerduty", {"routing_key": ROUTING})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn(ROUTING, r.content.decode())
        self.assertTrue(r.json()["routing_key_set"])
        cid = r.json()["id"]
        r = self.client.patch(
            f"/api/monitoring/channels/{cid}/", {"enabled": False}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        ch = NotificationChannel.objects.get(pk=cid)
        self.assertEqual(ch.secrets, {"routing_key": ROUTING})
        r = self.client.patch(
            f"/api/monitoring/channels/{cid}/",
            {"config": {"routing_key": "ZZOTHER"}}, format="json",
        )
        self.assertEqual(r.status_code, 200)
        ch.refresh_from_db()
        self.assertEqual(ch.secrets, {"routing_key": "ZZOTHER"})
        r = self.client.patch(
            f"/api/monitoring/channels/{cid}/",
            {"config": {"routing_key": ""}}, format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("routing_key", r.json()["config"][0])

    def test_changing_kind_drops_the_old_credential(self):
        self._login(self.root)
        cid = self._create("slack", {"url": SLACK}).json()["id"]
        r = self.client.patch(
            f"/api/monitoring/channels/{cid}/",
            {"kind": "pagerduty", "config": {"routing_key": ROUTING}}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ch = NotificationChannel.objects.get(pk=cid)
        self.assertEqual(ch.secrets, {"routing_key": ROUTING})

    def test_test_send_error_does_not_echo_the_url(self):
        import requests

        self._login(self.root)
        slack, _ = self._seed()
        boom = requests.ConnectionError(
            "HTTPSConnectionPool(host='hooks.slack.example', port=443): Max "
            "retries exceeded with url: /services/ZZSECRET (Caused by timeout)"
        )
        with patch("monitoring.notify.safe_post", side_effect=boom):
            r = self.client.post(f"/api/monitoring/channels/{slack.pk}/test/")
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("ZZSECRET", r.content.decode())


class ChannelSecretDeliveryTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_senders_use_the_stored_secret(self):
        for kind in (*URL_KINDS, "pagerduty"):
            with self.subTest(kind=kind):
                cfg = {"routing_key": ROUTING} if kind == "pagerduty" else {"url": SLACK}
                ch = NotificationChannel.objects.create(
                    tenant=self.tenant, name=kind, kind=kind, config=cfg
                )
                ch = NotificationChannel.objects.get(pk=ch.pk)
                self.assertEqual(ch.config, {})
                with patch("monitoring.notify.safe_post") as post:
                    post.return_value.status_code = 200
                    notify.send_test(ch)
                    notify.notify_plain(ch, "hello")
                self.assertEqual(post.call_count, 2)
                for call in post.call_args_list:
                    if kind == "pagerduty":
                        self.assertEqual(call.kwargs["json"]["routing_key"], ROUTING)
                    else:
                        self.assertEqual(call.args[0], SLACK)


class ChannelSecretMigrationTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_plain_rows_are_sealed_idempotently(self):
        mig = importlib.import_module(
            "monitoring.migrations.0115_notificationchannel_seal_credentials"
        )
        slack = NotificationChannel.objects.create(
            tenant=self.tenant, name="s", kind="slack", config={}
        )
        pd = NotificationChannel.objects.create(
            tenant=self.tenant, name="p", kind="pagerduty", config={}
        )
        tg = NotificationChannel.objects.create(
            tenant=self.tenant, name="t", kind="telegram", config={"chat_id": "1"},
            secrets={"bot_token": "TOK"},
        )
        # Rows written before the change: the credential in the plain column.
        NotificationChannel.objects.filter(pk=slack.pk).update(
            config={"url": SLACK, "extra": 1}
        )
        NotificationChannel.objects.filter(pk=pd.pk).update(
            config={"routing_key": ROUTING}
        )
        for _ in range(2):
            mig.seal(global_apps, None)
        slack.refresh_from_db()
        pd.refresh_from_db()
        tg.refresh_from_db()
        self.assertEqual(slack.config, {"extra": 1})
        self.assertEqual(slack.secrets, {"url": SLACK})
        self.assertEqual(pd.config, {})
        self.assertEqual(pd.secrets, {"routing_key": ROUTING})
        self.assertEqual(tg.secrets, {"bot_token": "TOK"})
        self.assertNotIn("ZZSECRET", _raw_columns(slack))
        mig.unseal(global_apps, None)
        slack.refresh_from_db()
        self.assertEqual(slack.config, {"extra": 1, "url": SLACK})
