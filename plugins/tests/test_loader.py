"""Plugin discovery + version gating (danbyte.plugin_loader)."""
from __future__ import annotations

from django.test import SimpleTestCase
from rest_framework.test import APITestCase
from django.contrib.auth import get_user_model

from danbyte.plugin_loader import _compatible, discover

GOOD = "plugins.tests.fixtures.good_plugin"
BROKEN = "plugins.tests.fixtures.broken_plugin"
MISSING = "plugins.tests.fixtures.does_not_exist"


class CompatibilityTests(SimpleTestCase):
    def test_within_window(self):
        self.assertEqual(_compatible("0.8.7", "0.1.0", "1.0.0"), (True, ""))

    def test_below_min(self):
        ok, why = _compatible("0.0.1", "0.1.0", "1.0.0")
        self.assertFalse(ok)
        self.assertIn(">= 0.1.0", why)

    def test_above_max(self):
        ok, why = _compatible("2.0.0", "0.1.0", "1.0.0")
        self.assertFalse(ok)
        self.assertIn("<= 1.0.0", why)

    def test_unbounded(self):
        self.assertEqual(_compatible("9.9.9", None, None), (True, ""))


class DiscoverTests(SimpleTestCase):
    def test_compatible_plugin_is_enabled(self):
        result = discover([GOOD], "0.8.7")
        self.assertEqual(
            result.enabled,
            ["plugins.tests.fixtures.good_plugin.apps.GoodPluginConfig"],
        )
        (st,) = result.report
        self.assertEqual(st.state, "loaded")
        self.assertEqual(st.slug, "good")
        self.assertEqual(st.name, "Good Plugin")
        self.assertEqual(st.version, "1.2.3")

    def test_incompatible_plugin_is_skipped(self):
        result = discover([GOOD], "0.0.1")  # below the fixture's min_version
        self.assertEqual(result.enabled, [])
        (st,) = result.report
        self.assertEqual(st.state, "incompatible")
        self.assertIn(">= 0.1.0", st.error)

    def test_broken_plugin_does_not_abort_and_is_reported(self):
        result = discover([BROKEN, GOOD], "0.8.7")
        # The good plugin still loads despite the broken one preceding it.
        self.assertEqual(
            result.enabled,
            ["plugins.tests.fixtures.good_plugin.apps.GoodPluginConfig"],
        )
        broken = next(s for s in result.report if s.module == BROKEN)
        self.assertEqual(broken.state, "error")
        self.assertIn("boom", broken.error)

    def test_missing_module_is_error(self):
        result = discover([MISSING], "0.8.7")
        self.assertEqual(result.enabled, [])
        self.assertEqual(result.report[0].state, "error")

    def test_blank_and_duplicate_entries_ignored(self):
        result = discover(["", "  ", GOOD, GOOD], "0.8.7")
        self.assertEqual(len(result.report), 1)


class PluginsListApiTests(APITestCase):
    def test_requires_authentication(self):
        r = self.client.get("/api/plugins/")
        self.assertIn(r.status_code, (401, 403))

    def test_authenticated_gets_report(self):
        user = get_user_model().objects.create_user("u", "u@acme.com", "pw")
        self.client.force_login(user)
        r = self.client.get("/api/plugins/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("plugins", r.json())
