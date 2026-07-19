"""SSRF guard (#58) — internal addresses are rejected, allow-list overrides."""
from __future__ import annotations

import os
import socket
from unittest import mock

from django.test import TestCase

from core.ssrf import SSRFError, _allowlist, assert_public_url


def _resolves_to(ip: str):
    return mock.patch(
        "core.ssrf.socket.getaddrinfo",
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))],
    )


class SSRFGuardTests(TestCase):
    def setUp(self):
        _allowlist.cache_clear()

    def tearDown(self):
        _allowlist.cache_clear()

    def test_blocks_loopback(self):
        with _resolves_to("127.0.0.1"), self.assertRaises(SSRFError):
            assert_public_url("http://localhost/hook")

    def test_blocks_cloud_metadata(self):
        with _resolves_to("169.254.169.254"), self.assertRaises(SSRFError):
            assert_public_url("http://metadata.internal/latest/meta-data/")

    def test_blocks_rfc1918(self):
        for ip in ("10.1.2.3", "172.16.5.5", "192.168.1.10"):
            with _resolves_to(ip), self.assertRaises(SSRFError):
                assert_public_url("http://internal.example/")

    def test_rejects_non_http_scheme(self):
        with self.assertRaises(SSRFError):
            assert_public_url("file:///etc/passwd")
        with self.assertRaises(SSRFError):
            assert_public_url("gopher://x/")

    def test_allows_public(self):
        with _resolves_to("93.184.216.34"):
            assert_public_url("https://example.com/webhook")  # must not raise

    def test_allowlist_permits_internal(self):
        with mock.patch.dict(os.environ, {"DANBYTE_SSRF_ALLOWLIST": "10.0.0.0/8"}):
            _allowlist.cache_clear()
            with _resolves_to("10.1.2.3"):
                assert_public_url("http://runner.internal/deploy")  # permitted


class SiteSettingsSmtpGuardTests(TestCase):
    """A SITE admin's SMTP host is SSRF-guarded like a tenant's — local IT
    must not be able to point the mailer at internal services."""

    def test_site_smtp_host_guarded(self):
        from api.models import Site
        from core.models import Organization, SiteSettings, Tenant
        from core.ssrf import SSRFError
        from monitoring.notify import build_email_connection

        org = Organization.objects.create(name="OG", slug="og")
        tenant = Tenant.objects.create(org=org, name="TG", slug="tg")
        site = Site.objects.create(tenant=tenant, name="G1")
        ss = SiteSettings.objects.create(
            site=site, override_email=True, smtp_host="169.254.169.254"
        )
        with self.assertRaises(SSRFError):
            build_email_connection(ss)


class DbAllowlistTests(TestCase):
    """The deployment-admin-managed allowlist (Settings → Deployment) permits
    specific internal hosts without touching the env var."""

    def test_db_allowlist_permits_internal(self):
        from core.models import DeploymentSettings
        from core.ssrf import SSRFError, assert_public_host

        with self.assertRaises(SSRFError):
            assert_public_host("10.196.223.134", 443)
        dep = DeploymentSettings.load()
        dep.ssrf_allowlist = ["10.196.223.134"]
        dep.save()
        assert_public_host("10.196.223.134", 443)  # no raise
        # Other private space stays blocked.
        with self.assertRaises(SSRFError):
            assert_public_host("10.9.9.9", 443)
