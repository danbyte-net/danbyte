"""SSRF guard (#58) - internal addresses are rejected, allow-list overrides."""
from __future__ import annotations

import http.client
import os
import socket
import ssl
from unittest import mock

import requests
from django.test import SimpleTestCase, TestCase
from requests.adapters import HTTPAdapter

from core.ssrf import (
    SafeSession,
    SSRFError,
    _allowlist,
    _PinnedSNIAdapter,
    assert_public_url,
    pinned_ssl_context,
    pinned_url,
    safe_request,
)


def _resolves_to(ip: str):
    return mock.patch(
        "core.ssrf.socket.getaddrinfo",
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))],
    )


def _response(request, status=200, headers=None, body=b"{}"):
    r = requests.Response()
    r.status_code = status
    r.headers.update(headers or {})
    r._content = body
    r.request = request
    r.url = request.url
    return r


class _Wire:
    """Replaces the adapter's ``send`` so nothing touches a socket, recording
    what ``requests`` tried to put on the wire - including any redirect hop it
    would have followed on its own."""

    def __init__(self, status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.sent: list[tuple[HTTPAdapter, requests.PreparedRequest, dict]] = []

    def __call__(self, adapter, request, **kw):
        self.sent.append((adapter, request, kw))
        return _response(request, self.status, self.headers)

    def patch(self):
        # A function, so it binds and receives the adapter as ``self``.
        return mock.patch.object(
            HTTPAdapter, "send", lambda adapter, request, **kw: self(adapter, request, **kw)
        )


class SafeTransportTests(TestCase):
    """The pinned, redirect-refusing transport behind ``safe_request`` and the
    reusable ``SafeSession`` (#321)."""

    def test_pins_the_connection_to_the_validated_ip(self):
        wire = _Wire()
        with _resolves_to("93.184.216.34"), wire.patch():
            safe_request("GET", "https://hook.example:8443/x?y=1", headers={"X-A": "1"})
        adapter, req, kw = wire.sent[0]
        self.assertEqual(req.url, "https://93.184.216.34:8443/x?y=1")
        self.assertEqual(req.headers["Host"], "hook.example:8443")
        self.assertEqual(req.headers["X-A"], "1")
        self.assertIsInstance(adapter, _PinnedSNIAdapter)
        self.assertEqual(adapter._sni, "hook.example")
        self.assertTrue(kw["verify"])

    def test_never_follows_a_redirect_even_when_asked_to(self):
        wire = _Wire(302, {"Location": "http://127.0.0.1:9/secret"})
        with _resolves_to("93.184.216.34"), wire.patch():
            r = safe_request("GET", "https://hook.example/x", allow_redirects=True)
        self.assertEqual(r.status_code, 302)
        self.assertEqual(len(wire.sent), 1)

    def test_session_keeps_its_state_and_pins_every_request(self):
        wire = _Wire(302, {"Location": "http://169.254.169.254/latest/"})
        sess = SafeSession()
        sess.headers["Authorization"] = "Bearer t"
        sess.verify = False
        with _resolves_to("93.184.216.34"), wire.patch():
            sess.get("https://vc.example/api/a")  # Session.get defaults redirects ON
            sess.post("https://vc.example/api/b", json={"k": 1})
        self.assertEqual(len(wire.sent), 2)  # one each, no hop to the metadata IP
        urls = [req.url for _, req, _ in wire.sent]
        self.assertEqual(
            urls, ["https://93.184.216.34/api/a", "https://93.184.216.34/api/b"]
        )
        for _adapter, req, kw in wire.sent:
            self.assertEqual(req.headers["Authorization"], "Bearer t")
            self.assertEqual(req.headers["Host"], "vc.example")
            self.assertFalse(kw["verify"])
        # The same pinned adapter serves both calls - no pool churn per request.
        self.assertIs(wire.sent[0][0], wire.sent[1][0])

    def test_default_port_is_left_out_of_the_host_header(self):
        wire = _Wire()
        with _resolves_to("93.184.216.34"), wire.patch():
            safe_request("GET", "https://vc.example:443/api")
            safe_request("GET", "http://vc.example:80/api")
        self.assertEqual([r.headers["Host"] for _, r, _ in wire.sent],
                         ["vc.example", "vc.example"])

    def test_a_similar_ip_does_not_reuse_the_pinned_adapter(self):
        """Mount prefixes end in "/" so 1.2.3.4's adapter (and SNI) never
        serves 1.2.3.45."""
        wire = _Wire()
        sess = SafeSession()
        with wire.patch():
            with _resolves_to("93.184.216.3"):
                sess.get("https://a.example/x")
            with _resolves_to("93.184.216.34"):
                sess.get("https://b.example/x")
        self.assertEqual([a._sni for a, _, _ in wire.sent], ["a.example", "b.example"])

    def test_proxied_tls_is_still_checked_against_the_hostname(self):
        adapter = _PinnedSNIAdapter("vc.example")
        manager = adapter.proxy_manager_for("http://proxy.internal:3128")
        self.assertEqual(manager.connection_pool_kw["server_hostname"], "vc.example")
        self.assertEqual(manager.connection_pool_kw["assert_hostname"], "vc.example")

    def test_no_proxy_is_matched_on_the_hostname_not_the_pinned_ip(self):
        wire = _Wire()
        env = {"HTTPS_PROXY": "http://proxy.internal:3128", "NO_PROXY": "vc.example"}
        with mock.patch.dict(os.environ, env), _resolves_to("93.184.216.34"), wire.patch():
            safe_request("GET", "https://vc.example/api")
            safe_request("GET", "https://other.example/api")
        exempt, proxied = (kw["proxies"] for _, _, kw in wire.sent)
        self.assertNotIn("https", exempt)
        self.assertEqual(proxied["https"], "http://proxy.internal:3128")

    def test_session_refuses_a_host_that_resolves_internal(self):
        wire = _Wire()
        with _resolves_to("10.0.0.5"), wire.patch(), self.assertRaises(SSRFError):
            SafeSession().get("https://vc.example/api/a")
        self.assertEqual(wire.sent, [])


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
    """A SITE admin's SMTP host is SSRF-guarded like a tenant's - local IT
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
            assert_public_host("10.0.0.100", 443)
        dep = DeploymentSettings.load()
        dep.ssrf_allowlist = ["10.0.0.100"]
        dep.save()
        assert_public_host("10.0.0.100", 443)  # no raise
        # Other private space stays blocked.
        with self.assertRaises(SSRFError):
            assert_public_host("10.9.9.9", 443)


class PinningHelperTests(SimpleTestCase):
    """The pieces non-requests clients (WinRM, vSphere SOAP) pin with (#321)."""

    def test_pinned_url_keeps_path_port_and_host_header(self):
        self.assertEqual(
            pinned_url("http://dc.example:5985/wsman?a=1", "93.184.216.34"),
            ("http://93.184.216.34:5985/wsman?a=1", "dc.example:5985"),
        )
        self.assertEqual(
            pinned_url("https://vc.example/sdk", "2001:db8::1"),
            ("https://[2001:db8::1]/sdk", "vc.example"),
        )

    def test_ssl_context_sends_the_name_to_an_address(self):
        """http.client wraps the socket for the host it dialled (the pinned
        address); SNI and the certificate check use the name instead."""
        ctx = pinned_ssl_context("vc.example")
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        with mock.patch("socket.create_connection") as dial, \
                mock.patch.object(ssl.SSLContext, "wrap_socket") as wrap:
            http.client.HTTPSConnection("93.184.216.34", 443, context=ctx).connect()
        self.assertEqual(dial.call_args.args[0], ("93.184.216.34", 443))
        self.assertEqual(wrap.call_args.kwargs["server_hostname"], "vc.example")

    def test_unverified_context_checks_no_certificate(self):
        ctx = pinned_ssl_context("vc.example", verify=False)
        self.assertFalse(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)
