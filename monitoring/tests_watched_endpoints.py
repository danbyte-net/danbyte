"""Watched-endpoint poller — status mapping + stamping, no network.

``observe_endpoint`` is mocked so these run offline; the live collector itself
is covered by ``tests_certificates`` and the ``danbyte_checks`` suite.
"""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from core.models import Organization, Tenant
from monitoring import watched_endpoints as we
from monitoring.models import WatchedEndpoint


def _obs(validity="verified", expired=False, not_yet=False, error_kind=""):
    return {
        "validity": validity,
        "expired": expired,
        "not_yet_valid": not_yet,
        "self_signed": False,
        "expires_in_days": 30,
        "tls_version": "TLSv1.3",
        "error": "",
        "error_kind": error_kind,
        "chain": [{"fingerprint_sha256": "AA"}],
    }


class StatusMappingTests(TestCase):
    def test_verified_is_up(self):
        self.assertEqual(we._status(_obs()), "up")

    def test_expired_is_degraded(self):
        self.assertEqual(we._status(_obs(validity="unverified", expired=True)), "degraded")

    def test_untrusted_is_degraded(self):
        self.assertEqual(we._status(_obs(validity="unverified")), "degraded")

    def test_policy_refusal_is_unknown_not_down(self):
        self.assertEqual(we._status({"validity": "unknown", "error_kind": "policy"}), "unknown")

    def test_unreachable_is_down(self):
        self.assertEqual(we._status({"validity": "unknown", "error_kind": "connect"}), "down")


class PollerTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_run_stamps_status_and_detail(self):
        ep = WatchedEndpoint.objects.create(
            tenant=self.tenant, host="example.com", port=443
        )
        with mock.patch.object(we, "observe_endpoint", return_value=(_obs(), [])):
            status = we.run_watched_endpoint(ep)
        self.assertEqual(status, "up")
        ep.refresh_from_db()
        self.assertEqual(ep.last_status, "up")
        self.assertIsNotNone(ep.last_run_at)
        self.assertEqual(ep.last_detail["validity"], "verified")

    def test_due_poll_skips_recently_run_and_disabled(self):
        # freshly run → not due; disabled → never polled.
        ep = WatchedEndpoint.objects.create(
            tenant=self.tenant, host="a.example", port=443, interval_seconds=86400
        )
        with mock.patch.object(we, "observe_endpoint", return_value=(_obs(), [])):
            we.run_watched_endpoint(ep)  # stamps last_run_at = now
            WatchedEndpoint.objects.create(
                tenant=self.tenant, host="b.example", port=443, enabled=False
            )
            result = we.run_due_watched_endpoints()
        self.assertEqual(result["ran"], 0)

    def test_due_poll_runs_never_run_endpoint(self):
        WatchedEndpoint.objects.create(tenant=self.tenant, host="c.example", port=443)
        with mock.patch.object(we, "observe_endpoint", return_value=(_obs(), [])):
            result = we.run_due_watched_endpoints()
        self.assertEqual(result["ran"], 1)
