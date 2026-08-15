"""Faceplate component-popover config: defaults, key hygiene, endpoint gating."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.test import Client, TestCase

from core.deployment import (
    COMPONENT_POPOVER_FIELD_DEFAULTS,
    clean_component_popover_fields,
)
from core.models import DeploymentSettings


class CleanComponentFieldsTests(TestCase):
    def test_drops_unknown_keys_and_dedupes_preserving_order(self):
        self.assertEqual(
            clean_component_popover_fields(["mac", "bogus", "name", "mac"]),
            ["mac", "name"],
        )
        self.assertEqual(clean_component_popover_fields("name"), [])


class ComponentPopoverEndpointTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser("root", "r@x.com", "x")
        self.member = User.objects.create_user("m", "m@x.com", "x")
        self.client = Client()

    def test_round_trip_and_unknown_keys_dropped(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/deployment/component-popover/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["is_default"])
        self.assertEqual(
            r.json()["popover_fields"], COMPONENT_POPOVER_FIELD_DEFAULTS
        )

        r = self.client.put(
            "/api/deployment/component-popover/",
            json.dumps({"popover_fields": ["name", "mac", "nope"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["popover_fields"], ["name", "mac"])
        self.assertFalse(r.json()["is_default"])
        self.assertEqual(
            DeploymentSettings.load().component_popover_fields, ["name", "mac"]
        )

    def test_member_reads_effective_but_cannot_write(self):
        DeploymentSettings.load()
        self.client.force_login(self.member)
        r = self.client.get("/api/component-popover/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["fields"], COMPONENT_POPOVER_FIELD_DEFAULTS)
        r = self.client.put(
            "/api/deployment/component-popover/",
            json.dumps({"popover_fields": ["name"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403)

    def test_anonymous_gets_401_or_403(self):
        r = self.client.get("/api/component-popover/")
        self.assertIn(r.status_code, (401, 403))
