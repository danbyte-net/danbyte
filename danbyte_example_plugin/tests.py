"""Example-plugin tests — proves the framework loads a real standalone plugin.

The plugin is loaded in the test environment via ``danbyte/settings.py`` (only),
so these run as part of the normal suite.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from danbyte.plugin_loader import discover

from .models import Widget

MODULE = "danbyte_example_plugin"


class ExamplePluginLoadTests(APITestCase):
    def test_appears_as_loaded_in_report(self):
        user = get_user_model().objects.create_user("u", "u@acme.com", "pw")
        self.client.force_login(user)
        report = self.client.get("/api/plugins/").json()["plugins"]
        example = next((p for p in report if p["slug"] == "example"), None)
        self.assertIsNotNone(example, "example plugin missing from /api/plugins/")
        self.assertEqual(example["state"], "loaded")
        self.assertEqual(example["version"], "1.0.0")
        self.assertEqual(example["module"], MODULE)


class ExamplePluginVersionGateTests(SimpleTestCase):
    def test_loads_within_window(self):
        result = discover([MODULE], "0.8.7")
        self.assertEqual(
            result.enabled, ["danbyte_example_plugin.apps.ExamplePluginConfig"]
        )
        self.assertEqual(result.report[0].state, "loaded")

    def test_incompatible_below_min_version(self):
        result = discover([MODULE], "0.7.0")  # plugin requires >= 0.8.0
        self.assertEqual(result.enabled, [])
        self.assertEqual(result.report[0].state, "incompatible")


class WidgetModelTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_widget_supports_custom_fields_and_tags(self):
        w = Widget.objects.create(
            tenant=self.tenant, name="w1", custom_fields={"k": "v"}
        )
        w.tags.add("blue")
        self.assertEqual(w.custom_fields["k"], "v")
        self.assertIn("blue", [t.name for t in w.tags.all()])
