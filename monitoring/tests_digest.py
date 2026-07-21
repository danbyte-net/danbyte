"""Scheduled email digest — build, schedule gate, send, and the test endpoint."""
from __future__ import annotations

from datetime import datetime, timezone as dt_timezone

from django.contrib.auth.models import User
from django.core import mail
from django.test import TestCase, override_settings
from rest_framework.test import APITestCase

from core.models import DeploymentSettings, Organization, Tenant, TenantSettings
from monitoring.digest import build_digest, run_scheduled_digests, send_tenant_digest

LOCMEM = "django.core.mail.backends.locmem.EmailBackend"
# A fixed Monday for deterministic weekday tests.
MONDAY = datetime(2026, 7, 20, 7, 0, tzinfo=dt_timezone.utc)


def _digest_config(**kw):
    ds = DeploymentSettings.load()
    ds.digest_enabled = kw.get("enabled", True)
    ds.digest_frequency = kw.get("frequency", "daily")
    ds.digest_weekday = kw.get("weekday", 0)
    ds.digest_recipients = kw.get("recipients", "ops@acme.com")
    ds.email_from = "danbyte@acme.com"
    ds.save()
    return ds


@override_settings(EMAIL_BACKEND=LOCMEM)
class DigestScheduleTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def test_daily_digest_sends_html_and_text(self):
        _digest_config(frequency="daily")
        sent = run_scheduled_digests(now=MONDAY)
        self.assertEqual(sent, 1)
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertIn("Acme", msg.subject)
        self.assertEqual(msg.to, ["ops@acme.com"])
        # multipart: plain-text body + an HTML alternative
        self.assertTrue(any(ct == "text/html" for _, ct in msg.alternatives))

    def test_weekly_only_fires_on_configured_weekday(self):
        _digest_config(frequency="weekly", weekday=2)  # Wednesday
        self.assertEqual(run_scheduled_digests(now=MONDAY), 0)  # Monday ≠ Wed
        _digest_config(frequency="weekly", weekday=0)  # Monday
        self.assertEqual(run_scheduled_digests(now=MONDAY), 1)

    def test_not_sent_twice_same_day(self):
        _digest_config(frequency="daily")
        self.assertEqual(run_scheduled_digests(now=MONDAY), 1)
        self.assertEqual(run_scheduled_digests(now=MONDAY), 0)  # already sent today
        self.assertTrue(
            TenantSettings.objects.get(tenant=self.tenant).digest_last_run
        )

    def test_disabled_does_not_send(self):
        _digest_config(enabled=False)
        self.assertEqual(run_scheduled_digests(now=MONDAY), 0)
        self.assertEqual(len(mail.outbox), 0)

    def test_no_recipients_does_not_send(self):
        _digest_config(recipients="")
        self.assertEqual(run_scheduled_digests(now=MONDAY), 0)

    def test_tenant_override_recipients_win(self):
        _digest_config(enabled=False)  # deployment default off
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_digest = True
        ts.digest_enabled = True
        ts.digest_frequency = "daily"
        ts.digest_recipients = "team@acme.com"
        ts.save()
        self.assertEqual(run_scheduled_digests(now=MONDAY), 1)
        self.assertEqual(mail.outbox[0].to, ["team@acme.com"])


class DigestBuildTests(TestCase):
    def test_build_digest_empty_is_safe(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        from django.utils import timezone

        data = build_digest(tenant, timezone.now())
        self.assertEqual(data["total"], 0)
        self.assertIsNone(data["reachable_pct"])
        self.assertEqual(data["firing_total"], 0)
        self.assertEqual(data["transitions"], [])


@override_settings(EMAIL_BACKEND=LOCMEM)
class DigestTestEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        _digest_config()
        self.admin = User.objects.create_superuser("root", "root@acme.com", "pw")

    def _login(self):
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_send_test_digest_now(self):
        self._login()
        r = self.client.post(
            "/api/tenant-settings/digest/test/", {"to": "me@acme.com"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["me@acme.com"])

    def test_requires_tenant_admin(self):
        plain = User.objects.create_user("plain", "p@acme.com", "pw")
        from auth_api.models import UserProfile

        UserProfile.objects.create(user=plain, role="custom").tenants.add(self.tenant)
        self.client.force_login(plain)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.post("/api/tenant-settings/digest/test/", {}, format="json")
        self.assertEqual(r.status_code, 403)
