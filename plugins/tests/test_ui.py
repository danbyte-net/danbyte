"""Server-driven UI metadata endpoint (/api/plugins/ui/)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant
from plugins.models import PluginConfig

UI_URL = "/api/plugins/ui/"


class PluginUiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        u = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_returns_example_specs_when_enabled(self):
        data = self.client.get(UI_URL).json()
        nav_titles = [n["title"] for n in data["nav"]]
        self.assertIn("Widgets", nav_titles)
        kinds = sorted(p["kind"] for p in data["pages"] if p["plugin"] == "example")
        self.assertEqual(kinds, ["detail", "list"])
        self.assertTrue(any(p["plugin"] == "example" for p in data["panels"]))
        # A nav item carries its RBAC gate for the frontend.
        widgets = next(n for n in data["nav"] if n["title"] == "Widgets")
        self.assertEqual(widgets["object_type"], "widget")

    def test_empty_when_plugin_disabled_for_tenant(self):
        PluginConfig.objects.create(
            tenant=self.tenant, plugin_slug="example", enabled=False
        )
        data = self.client.get(UI_URL).json()
        self.assertFalse(any(n["plugin"] == "example" for n in data["nav"]))
        self.assertFalse(any(p["plugin"] == "example" for p in data["pages"]))
        self.assertFalse(any(p["plugin"] == "example" for p in data["panels"]))

    def test_requires_auth(self):
        self.client.logout()
        self.assertIn(self.client.get(UI_URL).status_code, (401, 403))
