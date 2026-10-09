"""The call log must never hold a credential, wherever it sat in the call (#326).

A write's values arrive inside ``payload``, so masking only the top-level
argument names stored every password an assistant was asked to set - and
a tenant admin reads the log at ``/api/agent/calls/``.
"""
from __future__ import annotations

import importlib
import json

from django.apps import apps
from django.contrib.auth import get_user_model

from integrations.models import IntegrationSettings

from .models import AgentCall
from .tests_mcp import _Base
from .views import _digest

SECRET = "S3cret!xyz-777"
REMASK = importlib.import_module("agents.migrations.0002_mask_call_arguments")


class NestedMaskingTests(_Base):
    def setUp(self):
        super().setUp()
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=True)

    def _stored(self, tool: str) -> dict:
        return AgentCall.objects.get(tool=tool).arguments

    def test_a_secret_inside_a_create_payload_is_masked(self):
        self.tool("create", {"type": "site", "payload": {
            "name": "Masked", "password": SECRET, "api_token": "tok-123",
        }})
        stored = self._stored("create")
        self.assertNotIn(SECRET, json.dumps(stored))
        self.assertNotIn("tok-123", json.dumps(stored))
        self.assertEqual(stored["payload"]["password"], "•••")
        self.assertEqual(stored["payload"]["api_token"], "•••")
        self.assertEqual(stored["payload"]["name"], "Masked")

    def test_a_refused_write_is_masked_too(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=False)
        refused = self.tool("update", {"type": "site", "id": str(self.site.id),
                                       "payload": {"password": SECRET}})
        self.assertIn("read only", refused["error"])
        stored = self._stored("update")
        self.assertEqual(stored["payload"]["password"], "•••")
        self.assertNotIn(SECRET, json.dumps(stored))

    def test_a_write_the_api_refuses_is_masked_too(self):
        # No such site: the tool fails after the lookup, and that path logs
        # the arguments as well.
        refused = self.tool("update", {"type": "site", "id": "no-such-site",
                                       "payload": {"secret": SECRET}})
        self.assertIn("error", refused)
        self.assertNotIn(SECRET, json.dumps(self._stored("update")))

    def test_lists_and_deeper_levels_are_masked(self):
        stored = _digest({"type": "site", "payload": {
            "ends": [{"id": "1", "psk": SECRET}, "plain"],
            "deep": {"deeper": {"secret_params": {"community": SECRET}}},
        }})
        self.assertNotIn(SECRET, json.dumps(stored))
        self.assertEqual(stored["payload"]["ends"][0]["psk"], "•••")
        self.assertEqual(stored["payload"]["ends"][1], "plain")
        self.assertEqual(stored["payload"]["deep"]["deeper"]["secret_params"], "•••")

    def test_fields_the_classifier_marks_secret_for_the_type_are_masked(self):
        # NotificationChannel.config carries routing keys and webhook URLs.
        # Its name does not say so; core.secret_fields does.
        stored = _digest({"type": "notificationchannel", "payload": {
            "name": "ops", "config": {"url": "https://hooks.example/abc"},
        }})
        self.assertEqual(stored["payload"]["config"], "•••")
        self.assertEqual(stored["payload"]["name"], "ops")
        # The same key on a type where it is plain data stays readable.
        plain = _digest({"type": "site", "payload": {"config": {"url": "x"}}})
        self.assertEqual(plain["payload"]["config"], {"url": "x"})

    def test_the_type_is_normalised_before_asking_the_classifier(self):
        stored = _digest({"type": "Notification Channels",
                          "payload": {"config": {"url": "u"}}})
        self.assertEqual(stored["payload"]["config"], "•••")

    def test_a_payload_sent_as_json_text_is_masked(self):
        stored = _digest({"type": "site",
                          "payload": json.dumps({"name": "n", "password": SECRET})})
        self.assertNotIn(SECRET, json.dumps(stored))
        self.assertEqual(stored["payload"], {"name": "n", "password": "•••"})
        # Text with nothing to mask is kept as it came.
        self.assertEqual(_digest({"q": "[core]"})["q"], "[core]")

    def test_plain_arguments_are_stored_as_before(self):
        stored = _digest({"type": "device", "id": "x", "token": "t",
                          "filters": {"site": "Aarhus"}, "limit": 5})
        self.assertEqual(stored, {"type": "device", "id": "x", "token": "•••",
                                  "filters": {"site": "Aarhus"}, "limit": 5})

    def test_the_log_endpoint_serves_the_masked_form(self):
        self.tool("create", {"type": "site", "payload": {"name": "M2", "password": SECRET}})
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(admin)
        body = self.client.get("/api/agent/calls/").json()
        self.assertNotIn(SECRET, json.dumps(body))
        self.assertEqual(body["results"][0]["arguments"]["payload"]["password"], "•••")


class RemaskMigrationTests(_Base):
    """Rows written before the fix are masked once, in place."""

    def _row(self, **kw) -> AgentCall:
        base = {"tenant": self.tenant, "tool": "update", "object_type": "user"}
        return AgentCall.objects.create(**{**base, **kw})

    def test_existing_rows_are_remasked(self):
        row = self._row(arguments={"id": "6", "type": "user",
                                   "payload": {"password": SECRET, "name": "n"}})
        listed = self._row(tool="create", arguments={"type": "site", "payload": {
            "members": [{"api_token": "tok-1"}, {"name": "ok"}],
        }})
        channel = self._row(tool="create", object_type="notificationchannel",
                            arguments={"type": "notificationchannel",
                                       "payload": {"config": {"url": "u"}}})
        clean = self._row(tool="list", object_type="device", arguments={"type": "device"})

        self.assertEqual(REMASK.remask(apps, None), 3)
        for r in (row, listed, channel, clean):
            r.refresh_from_db()
        self.assertEqual(row.arguments["payload"], {"password": "•••", "name": "n"})
        self.assertEqual(listed.arguments["payload"]["members"],
                         [{"api_token": "•••"}, {"name": "ok"}])
        self.assertEqual(channel.arguments["payload"]["config"], "•••")
        self.assertEqual(clean.arguments, {"type": "device"})
        self.assertNotIn(SECRET, json.dumps(list(AgentCall.objects.values_list(
            "arguments", flat=True))))

    def test_a_payload_stored_as_json_text_is_remasked(self):
        row = self._row(arguments={"type": "site",
                                   "payload": json.dumps({"password": SECRET})})
        self.assertEqual(REMASK.remask(apps, None), 1)
        row.refresh_from_db()
        self.assertNotIn(SECRET, json.dumps(row.arguments))

    def test_running_it_again_changes_nothing(self):
        self._row(arguments={"type": "user", "payload": {"password": SECRET}})
        self.assertEqual(REMASK.remask(apps, None), 1)
        self.assertEqual(REMASK.remask(apps, None), 0)
