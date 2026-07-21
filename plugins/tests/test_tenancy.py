"""Per-tenant plugin enable/disable — cascade, config API, and viewset gating."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from danbyte_example_plugin.models import Widget
from plugins.models import PluginConfig
from plugins.resolve import enabled_plugins, plugin_enabled

SLUG = "example"
WIDGETS_URL = "/api/plugins/example/widgets/"
CONFIG_URL = "/api/plugins/example/config/"


class EnablementCascadeTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.a = Tenant.objects.create(org=org, name="A", slug="a")
        self.b = Tenant.objects.create(org=org, name="B", slug="b")

    def test_default_enabled_with_no_rows(self):
        self.assertTrue(plugin_enabled(SLUG, self.a))
        self.assertIn(SLUG, enabled_plugins(self.a))

    def test_not_loaded_plugin_never_enabled(self):
        self.assertFalse(plugin_enabled("does-not-exist", self.a))

    def test_deployment_default_off_disables_everywhere(self):
        PluginConfig.objects.create(tenant=None, plugin_slug=SLUG, enabled=False)
        self.assertFalse(plugin_enabled(SLUG, self.a))
        self.assertFalse(plugin_enabled(SLUG, self.b))

    def test_tenant_row_overrides_deployment_default(self):
        PluginConfig.objects.create(tenant=None, plugin_slug=SLUG, enabled=False)
        PluginConfig.objects.create(tenant=self.a, plugin_slug=SLUG, enabled=True)
        self.assertTrue(plugin_enabled(SLUG, self.a))   # tenant override wins
        self.assertFalse(plugin_enabled(SLUG, self.b))  # falls to deployment off


class ConfigApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _member(self, name):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def _login(self, u):
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_get_returns_effective_state(self):
        self._login(self._member("m"))
        data = self.client.get(CONFIG_URL).json()
        self.assertEqual(data["slug"], SLUG)
        self.assertTrue(data["enabled"])

    def test_plain_member_cannot_toggle(self):
        self._login(self._member("m2"))
        r = self.client.patch(CONFIG_URL, {"enabled": False}, format="json")
        self.assertEqual(r.status_code, 403)
        r2 = self.client.patch(
            CONFIG_URL, {"enabled": False, "scope": "deployment"}, format="json"
        )
        self.assertEqual(r2.status_code, 403)

    def test_superuser_can_toggle_tenant_and_deployment(self):
        su = User.objects.create_superuser("root", "r@a.com", "pw")
        UserProfile.objects.create(user=su, role="custom").tenants.add(self.tenant)
        self._login(su)
        r = self.client.patch(CONFIG_URL, {"enabled": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(plugin_enabled(SLUG, self.tenant))
        r2 = self.client.patch(
            CONFIG_URL, {"enabled": False, "scope": "deployment"}, format="json"
        )
        self.assertEqual(r2.status_code, 200, r2.content)
        self.assertTrue(
            PluginConfig.objects.filter(plugin_slug=SLUG, tenant=None).exists()
        )


class DisabledPluginGatesApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        u = User.objects.create_user("rw", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="rw", object_types=["widget"],
            actions=["view", "add", "change", "delete"],
        )
        perm.users.add(u)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_widget_api_404s_when_plugin_disabled_for_tenant(self):
        # Enabled by default → list works.
        self.assertEqual(self.client.get(WIDGETS_URL).status_code, 200)
        PluginConfig.objects.create(
            tenant=self.tenant, plugin_slug=SLUG, enabled=False
        )
        # Disabled → the whole viewset 404s even with a full grant.
        self.assertEqual(self.client.get(WIDGETS_URL).status_code, 404)
        r = self.client.post(WIDGETS_URL, {"name": "w"}, format="json")
        self.assertEqual(r.status_code, 404)
