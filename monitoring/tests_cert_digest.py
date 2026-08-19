"""Certificate digest - summary counts, rendering, and independent scheduling."""
from __future__ import annotations

import datetime as dt

from django.core import mail
from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant, TenantSettings

from .cert_digest import (
    cert_summary,
    has_content,
    render_html,
    run_scheduled_cert_digests,
    send_cert_digest,
)
from .models import Certificate, CertificateBinding


def _fp(seed: str) -> str:
    return (seed * 64)[:64].lower().replace(" ", "0")


class CertDigestTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )

    def _cert(self, days_after, *, seed="a", cn="svc.example.net"):
        now = timezone.now()
        return Certificate.objects.create(
            tenant=self.tenant, fingerprint_sha256=_fp(seed), subject_cn=cn,
            not_before=now - dt.timedelta(days=30),
            not_after=now + dt.timedelta(days=days_after),
            observed=True, uploaded=False,
            pem="-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
        )

    def _binding(self, cert, *, port=443, sni="svc.example.net", last_seen=None):
        now = timezone.now()
        key = f"{self.ip.id}:{port}:{sni}"
        return CertificateBinding.objects.create(
            tenant=self.tenant, certificate=cert, target_ip=self.ip, port=port,
            server_name=sni, endpoint_key=key, chain_depth=0, chain_verified=True,
            first_seen=last_seen or now, last_seen=last_seen or now,
        )

    def test_summary_buckets_expiring_and_expired(self):
        self._binding(self._cert(-2, seed="a", cn="expired.example.net"),
                      port=443, sni="expired.example.net")
        self._binding(self._cert(4, seed="b", cn="crit.example.net"),
                      port=444, sni="crit.example.net")
        self._binding(self._cert(20, seed="c", cn="warn.example.net"),
                      port=445, sni="warn.example.net")
        self._binding(self._cert(200, seed="d", cn="healthy.example.net"),
                      port=446, sni="healthy.example.net")
        s = cert_summary(self.tenant)
        self.assertEqual(s["expired"], 1)
        self.assertEqual(s["expiring_critical"], 1)
        self.assertEqual(s["expiring_warning"], 1)
        self.assertTrue(has_content(s))

    def test_healthy_estate_has_no_content(self):
        self._binding(self._cert(300, seed="h"))
        s = cert_summary(self.tenant)
        self.assertFalse(has_content(s))

    def test_render_html_is_a_full_document(self):
        self._binding(self._cert(3, seed="b"))
        html = render_html(cert_summary(self.tenant), self.tenant.name, "Danbyte")
        self.assertTrue(html.startswith("<!doctype html>"))
        self.assertIn("Certificate digest", html)

    def test_send_is_gated_by_flag_and_empty(self):
        # No cert content, flag off → nothing.
        self.assertFalse(send_cert_digest(self.tenant, recipients=["a@b.com"]))
        # Force sends even when empty.
        self.assertTrue(send_cert_digest(self.tenant, force=True,
                                         recipients=["a@b.com"]))
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("certificate digest", mail.outbox[0].subject.lower())

    def test_scheduled_run_respects_enabled_and_recipients(self):
        self._binding(self._cert(3, seed="b"))
        ts = TenantSettings.for_tenant(self.tenant)
        ts.cert_digest_enabled = True
        ts.cert_digest_recipients = "sec@acme.com"
        ts.override_digest = True
        ts.digest_frequency = "daily"
        ts.save()
        sent = run_scheduled_cert_digests()
        self.assertEqual(sent, 1)
        self.assertEqual(len(mail.outbox), 1)
        # Second run same day → gated by cert_digest_last_run.
        self.assertEqual(run_scheduled_cert_digests(), 0)
