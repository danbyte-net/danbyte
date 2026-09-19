"""Webhook matching + delivery (signing) tests - no real network."""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

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


class WebhookHeaderSecrecyTests(APITestCase):
    """Additional headers carry Authorization values, so the API never reads
    them back (#191): a webhook says whether headers are set and names them;
    a blank write keeps them, null clears them."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = get_user_model().objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.hook = Webhook.objects.create(
            tenant=self.tenant, name="h", payload_url="http://x.test/h",
            object_types=["prefix"],
            additional_headers="Authorization: Bearer s3cret\nX-Env: prod",
        )

    def test_headers_are_never_returned(self):
        for url in (f"/api/webhooks/{self.hook.id}/", "/api/webhooks/"):
            body = self.client.get(url).json()
            row = body["results"][0] if "results" in body else body
            self.assertNotIn("s3cret", str(row))
            self.assertNotIn("additional_headers", row)
            self.assertTrue(row["additional_headers_set"])
            self.assertEqual(row["additional_header_names"], ["Authorization", "X-Env"])

    def test_blank_keeps_null_clears_text_replaces(self):
        url = f"/api/webhooks/{self.hook.id}/"
        r = self.client.patch(url, {"name": "h2", "additional_headers": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.hook.refresh_from_db()
        self.assertIn("s3cret", self.hook.additional_headers)
        r = self.client.patch(url, {"additional_headers": "X-Key: new"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.hook.refresh_from_db()
        self.assertEqual(self.hook.additional_headers, "X-Key: new")
        r = self.client.patch(url, {"additional_headers": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.hook.refresh_from_db()
        self.assertEqual(self.hook.additional_headers, "")
        self.assertFalse(r.json()["additional_headers_set"])

    def test_create_stores_headers(self):
        r = self.client.post(
            "/api/webhooks/",
            {"name": "n", "payload_url": "http://x.test/n", "object_types": ["prefix"],
             "additional_headers": "X-Key: abc"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Webhook.objects.get(name="n").additional_headers, "X-Key: abc")
        self.assertNotIn("additional_headers", r.json())

    def test_a_line_without_a_colon_is_not_a_name(self):
        self.hook.additional_headers = "Authorization: Bearer\n  eyJTOKEN.sig\nX-Api-Key: abc"
        self.hook.save()
        row = self.client.get(f"/api/webhooks/{self.hook.id}/").json()
        self.assertEqual(row["additional_header_names"], ["Authorization", "X-Api-Key"])
        self.assertNotIn("eyJTOKEN", str(row))
