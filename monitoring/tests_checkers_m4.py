"""Milestone 4 tests — HTTP/UDP/SSH/SNMP/Telnet checkers.

Live checks use loopback fixtures (a throwaway HTTP server, a closed UDP port)
so they need no external network. Auth-bearing protocols (SSH/SNMP) are tested
for param validation and graceful classification of an absent server.
"""
from __future__ import annotations

import asyncio
import http.server
import socket
import threading

from django.test import TestCase

from .checkers import CHECKER_REGISTRY, CheckConfigError, get_checker


def _run(kind, target, params, timeout=1500, secret=None):
    return asyncio.run(get_checker(kind).run(target, params, secret or {}, timeout))


class RegistryM4Tests(TestCase):
    def test_all_kinds_registered(self):
        self.assertEqual(
            set(CHECKER_REGISTRY),
            {"icmp", "tcp", "udp", "http", "snmp", "ssh", "telnet", "exec"},
        )


class HttpCheckerTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"hello-danbyte")

            def log_message(self, *a):
                pass

        cls.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        super().tearDownClass()

    def test_expected_status_up(self):
        oc = _run("http", "127.0.0.1", {"port": self.port, "expected_status": [200]})
        self.assertEqual(oc.status, "up")
        self.assertEqual(oc.detail["status_code"], 200)

    def test_wrong_status_is_degraded(self):
        oc = _run("http", "127.0.0.1", {"port": self.port, "expected_status": [500]})
        self.assertEqual(oc.status, "degraded")

    def test_body_regex_match(self):
        oc = _run(
            "http", "127.0.0.1",
            {"port": self.port, "expected_status": [200], "expected_body_regex": "danbyte"},
        )
        self.assertEqual(oc.status, "up")

    def test_body_regex_mismatch_degraded(self):
        oc = _run(
            "http", "127.0.0.1",
            {"port": self.port, "expected_status": [200], "expected_body_regex": "NOPE"},
        )
        self.assertEqual(oc.status, "degraded")

    def test_closed_is_down(self):
        oc = _run("http", "127.0.0.1", {"port": 9})
        self.assertEqual(oc.status, "down")

    def test_validate_scheme(self):
        with self.assertRaises(CheckConfigError):
            get_checker("http").validate_params({"scheme": "ftp"})

    def test_cloud_metadata_endpoint_refused(self):
        # SSRF guard: the link-local metadata address is never a legitimate
        # target and must be refused without dialing it.
        oc = _run("http", "169.254.169.254", {"port": 80})
        self.assertEqual(oc.status, "down")
        self.assertEqual(oc.detail.get("error"), "target address not permitted")

    def test_loopback_still_allowed(self):
        # On-prem monitoring of local services stays permitted (only link-local
        # / unspecified are blocked).
        oc = _run("http", "127.0.0.1", {"port": self.port, "expected_status": [200]})
        self.assertEqual(oc.status, "up")


class NetguardPolicyTests(TestCase):
    """The check-engine target policy: permissive by default (outpost), strict
    when the central server opts in via configure()."""

    def tearDown(self):
        # Policy is process-global — restore the permissive default so the
        # HTTP-checker tests (which dial 127.0.0.1) keep working.
        from danbyte_checks import netguard

        netguard.configure(block_internal=False, allowlist=None)

    def test_default_blocks_only_metadata_and_unspecified(self):
        from danbyte_checks import netguard

        netguard.configure(block_internal=False)
        self.assertTrue(netguard.target_blocked("169.254.169.254"))
        self.assertTrue(netguard.target_blocked("0.0.0.0"))
        self.assertFalse(netguard.target_blocked("127.0.0.1"))
        self.assertFalse(netguard.target_blocked("10.0.0.1"))
        self.assertFalse(netguard.target_blocked("8.8.8.8"))

    def test_block_internal_refuses_loopback_and_private(self):
        from danbyte_checks import netguard

        netguard.configure(block_internal=True)
        self.assertTrue(netguard.target_blocked("127.0.0.1"))
        self.assertTrue(netguard.target_blocked("10.0.0.1"))
        self.assertTrue(netguard.target_blocked("169.254.169.254"))
        self.assertFalse(netguard.target_blocked("8.8.8.8"))

    def test_allowlist_overrides_block_internal(self):
        from danbyte_checks import netguard

        netguard.configure(block_internal=True, allowlist=["10.1.2.0/24"])
        self.assertFalse(netguard.target_blocked("10.1.2.5"))
        self.assertTrue(netguard.target_blocked("10.9.9.9"))
        # Metadata is never allowlist-exempt in practice, but link-local isn't
        # in the allowlist here so it stays blocked.
        self.assertTrue(netguard.target_blocked("169.254.169.254"))

    def test_hostname_target_not_blocked_here(self):
        from danbyte_checks import netguard

        netguard.configure(block_internal=True)
        # Non-literal targets pass this stage (resolution happens elsewhere).
        self.assertFalse(netguard.target_blocked("example.com"))


class CSPReportTests(TestCase):
    def test_report_uri_shape_logged_and_204(self):
        from django.test import Client

        c = Client()
        res = c.post(
            "/api/csp-report/",
            data='{"csp-report": {"violated-directive": "script-src",'
                 ' "blocked-uri": "https://evil.example"}}',
            content_type="application/csp-report",
        )
        self.assertEqual(res.status_code, 204)

    def test_malformed_body_is_ignored(self):
        from django.test import Client

        c = Client()
        res = c.post(
            "/api/csp-report/", data="not json", content_type="application/csp-report"
        )
        self.assertEqual(res.status_code, 204)

    def test_get_not_allowed(self):
        from django.test import Client

        self.assertEqual(Client().get("/api/csp-report/").status_code, 405)


class UdpCheckerTests(TestCase):
    def test_closed_udp_is_down_or_unknown(self):
        # A closed loopback UDP port returns ICMP unreachable → down on Linux;
        # accept unknown too (no-reply ≠ down is the contract for the silent
        # case) so the test is portable.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        oc = _run("udp", "127.0.0.1", {"port": port}, timeout=600)
        self.assertIn(oc.status, ("down", "unknown"))

    def test_validate_requires_port(self):
        with self.assertRaises(CheckConfigError):
            get_checker("udp").validate_params({})


class SshCheckerTests(TestCase):
    def test_no_username_does_not_crash(self):
        # Connect to a closed port without creds — must be a clean down, never
        # an exception (regression: asyncssh rejects username=None).
        oc = _run("ssh", "127.0.0.1", {"port": 9})
        self.assertEqual(oc.status, "down")

    def test_validate_output_regex(self):
        with self.assertRaises(CheckConfigError):
            get_checker("ssh").validate_params({"expected_output_regex": "("})


class SnmpCheckerTests(TestCase):
    def test_no_agent_is_down(self):
        # Nothing listening → timeout → down (reachability failure), not unknown.
        oc = _run(
            "snmp", "127.0.0.1", {"version": "v2c", "port": 1610},
            secret={"community": "public"}, timeout=700,
        )
        self.assertEqual(oc.status, "down")

    def test_validate_version_and_comparator(self):
        c = get_checker("snmp")
        with self.assertRaises(CheckConfigError):
            c.validate_params({"version": "v9"})
        with self.assertRaises(CheckConfigError):
            c.validate_params({"comparator": "approx"})
        c.validate_params({"version": "v2c", "comparator": "gt"})


class TelnetCheckerTests(TestCase):
    def test_open_tcp_port_is_up(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        s.listen(4)
        port = s.getsockname()[1]
        try:
            oc = _run("telnet", "127.0.0.1", {"port": port})
            self.assertEqual(oc.status, "up")
        finally:
            s.close()

    def test_closed_is_down(self):
        oc = _run("telnet", "127.0.0.1", {"port": 9})
        self.assertEqual(oc.status, "down")
