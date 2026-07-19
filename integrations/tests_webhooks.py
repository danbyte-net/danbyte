"""Webhook matching + delivery (signing) tests — no real network."""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest import mock

from django.test import TestCase

from core.models import Organization, Tenant
from integrations.models import Webhook
from integrations import webhooks as wh


class WebhookMatchTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _hook(self, **kw):
        defaults = dict(
            tenant=self.tenant, name="h", payload_url="http://x.test/h",
            object_types=["prefix"], on_create=True, on_update=True,
            on_delete=False,
        )
        defaults.update(kw)
        return Webhook.objects.create(**defaults)

    def test_matches_event_and_type(self):
        h = self._hook()
        self.assertTrue(h.matches("prefix", "created"))
        self.assertTrue(h.matches("prefix", "updated"))
        self.assertFalse(h.matches("prefix", "deleted"))  # on_delete off
        self.assertFalse(h.matches("device", "created"))  # type not listed

    def test_wildcard_and_disabled(self):
        h = self._hook(object_types=["*"])
        self.assertTrue(h.matches("device", "created"))
        h.enabled = False
        self.assertFalse(h.matches("device", "created"))

    def test_delivery_signs_payload(self):
        h = self._hook(secret="s3cr3t")
        captured = {}

        class Resp:
            status_code = 200

        def fake_request(method, url, data=None, headers=None, **kw):
            captured["method"] = method
            captured["url"] = url
            captured["data"] = data
            captured["headers"] = headers
            return Resp()

        with mock.patch("integrations.webhooks.safe_request", side_effect=fake_request):
            res = wh.deliver_webhook(
                str(h.id), "created", "prefix", "abc", {"cidr": "10.0.0.0/24"}
            )

        self.assertTrue(res["ok"])
        self.assertEqual(res["status_code"], 200)
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["url"], "http://x.test/h")
        payload = json.loads(captured["data"])
        self.assertEqual(payload["event"], "created")
        self.assertEqual(payload["model"], "prefix")
        self.assertEqual(payload["data"]["cidr"], "10.0.0.0/24")
        expect = "sha512=" + hmac.new(
            b"s3cr3t", captured["data"], hashlib.sha512
        ).hexdigest()
        self.assertEqual(captured["headers"]["X-Danbyte-Signature"], expect)
        self.assertEqual(captured["headers"]["X-Danbyte-Event"], "created")

    def test_delivery_error_is_graceful(self):
        h = self._hook()
        with mock.patch("integrations.webhooks.safe_request", side_effect=OSError("boom")):
            res = wh.deliver_webhook(str(h.id), "created", "prefix", "x", {})
        self.assertFalse(res["ok"])
        self.assertIn("boom", res["error"])
