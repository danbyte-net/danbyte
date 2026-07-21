"""Example-plugin tests — proves the framework loads a real standalone plugin.

The plugin is loaded in the test environment via ``danbyte/settings.py`` (only),
so these run as part of the normal suite.
"""
from __future__ import annotations

import asyncio

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from danbyte.plugin_loader import discover

from .models import Widget

MODULE = "danbyte_example_plugin"
WIDGETS_URL = "/api/plugins/example/widgets/"


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


class RegistrationTests(SimpleTestCase):
    """The danbyte_plugin entry point wired every backend surface."""

    def test_object_type_registered(self):
        from auth_api.object_types import is_registered

        self.assertTrue(is_registered("widget"))

    def test_reference_model_registered(self):
        from customization.object_registry import reference_model

        self.assertIsNotNone(reference_model("widget"))

    def test_audited_model_registered(self):
        from audit.registry import _DYNAMIC_AUDITED

        self.assertIn("danbyte_example_plugin.Widget", _DYNAMIC_AUDITED)

    def test_automation_provider_registered(self):
        from integrations.providers import automation_kinds, automation_provider

        self.assertIn("noop", automation_kinds())
        # Built-ins survive the registry refactor.
        self.assertLessEqual({"awx", "webhook"}, set(automation_kinds()))
        status, _ = automation_provider("noop")(None, {}, "manual")
        self.assertEqual(status, "launched")

    def test_check_kind_registered_and_runs(self):
        from monitoring.checkers import get_checker
        from monitoring.models import check_kinds

        checker = get_checker("example_ping")
        self.assertIsNotNone(checker)
        outcome = asyncio.run(checker.run("host", {"latency_ms": 5}, {}, 1000))
        self.assertEqual(outcome.status, "up")
        self.assertIn("example_ping", dict(check_kinds()))


class WidgetApiRbacTests(APITestCase):
    """Default-closed RBAC + tenant isolation for a plugin model, via the
    core TenantScopedViewSet the plugin reused."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="T2", slug="t2")

    def _user(self, name, grants=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        if grants:
            perm = ObjectPermission.objects.create(
                name=f"{name}-perm", object_types=["widget"], actions=grants
            )
            perm.users.add(u)
        return u

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_create_denied_without_grant(self):
        self._login(self._user("nogrant"))
        r = self.client.post(WIDGETS_URL, {"name": "w"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_grant_allows_crud_and_stamps_tenant(self):
        self._login(self._user("rw", grants=["view", "add", "change", "delete"]))
        r = self.client.post(
            WIDGETS_URL, {"name": "w1", "custom_fields": {"a": 1}}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        wid = r.json()["id"]
        self.assertEqual(Widget.objects.get(id=wid).tenant, self.tenant)
        self.assertEqual(self.client.get(WIDGETS_URL).json()["count"], 1)

    def test_cross_tenant_isolation(self):
        other_w = Widget.objects.create(tenant=self.other, name="secret")
        self._login(self._user("rw2", grants=["view", "add", "change", "delete"]))
        # Not enumerable, and a direct id fetch 404s (scoped to active tenant).
        self.assertEqual(self.client.get(WIDGETS_URL).json()["count"], 0)
        self.assertEqual(
            self.client.get(f"{WIDGETS_URL}{other_w.id}/").status_code, 404
        )
