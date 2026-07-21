"""Service-control + plugin-apply API — superuser gating + response shape.

The actual restart/apply launches a detached systemd unit, so it is not
exercised here (no systemd in CI); these cover the security gate and payloads.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.services import pending_migrations_by_app


class ServiceControlApiTests(APITestCase):
    def setUp(self):
        self.superuser = User.objects.create_superuser("root", "r@acme.com", "pw")
        self.plain = User.objects.create_user("plain", "p@acme.com", "pw")

    def test_list_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(self.client.get("/api/services/").status_code, 403)

    def test_list_ok_for_superuser(self):
        self.client.force_login(self.superuser)
        r = self.client.get("/api/services/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("services", r.json())

    def test_restart_one_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(
            self.client.post("/api/services/web/restart/").status_code, 403
        )

    def test_restart_all_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(
            self.client.post("/api/services/restart-all/").status_code, 403
        )

    def test_anonymous_denied(self):
        self.assertIn(self.client.get("/api/services/").status_code, (401, 403))


class PluginApplyApiTests(APITestCase):
    def setUp(self):
        self.superuser = User.objects.create_superuser("root", "r@acme.com", "pw")
        self.plain = User.objects.create_user("plain", "p@acme.com", "pw")

    def test_apply_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(self.client.post("/api/plugins/apply/").status_code, 403)

    def test_plugins_list_annotates_pending_migrations(self):
        self.client.force_login(self.plain)  # any authenticated user may read
        data = self.client.get("/api/plugins/").json()
        self.assertIn("has_pending_migrations", data)
        for entry in data["plugins"]:
            self.assertIn("unapplied_migrations", entry)

    def test_pending_migrations_helper_returns_dict(self):
        # The test DB is fully migrated, so nothing is pending.
        self.assertEqual(pending_migrations_by_app(), {})
