"""Service-control + plugin-apply API - superuser gating + response shape.

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
        self.assertEqual(self.client.get("/api/system/services/").status_code, 403)

    def test_list_ok_for_superuser(self):
        self.client.force_login(self.superuser)
        r = self.client.get("/api/system/services/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("services", r.json())

    def test_restart_one_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(
            self.client.post("/api/system/services/web/restart/").status_code, 403
        )

    def test_restart_all_requires_superuser(self):
        self.client.force_login(self.plain)
        self.assertEqual(
            self.client.post("/api/system/services/restart-all/").status_code, 403
        )

    def test_anonymous_denied(self):
        self.assertIn(self.client.get("/api/system/services/").status_code, (401, 403))

    def test_units_not_in_use_are_told_apart_and_left_alone(self):
        """A dev box links gunicorn but runs the runserver: gunicorn is not a
        fault, and Restart Danbyte must not start it beside the runserver."""
        from unittest import mock

        from core import services

        def state(unit):
            return {
                "danbyte-web": ("inactive", False),
                "danbyte-backend": ("active", True),
                "danbyte-workers": ("active", True),
                "danbyte-ws": ("failed", True),
                "danbyte-frontend-prod": ("missing", False),
            }.get(unit, ("missing", False))

        with mock.patch.object(services, "_unit_state", side_effect=state):
            rows = {r["key"]: r for r in services.list_services()}
            self.assertNotIn("frontend", rows)
            self.assertFalse(rows["web"]["in_use"])
            self.assertTrue(rows["backend"]["in_use"])
            self.assertTrue(rows["ws"]["in_use"])       # failed but enabled: a fault
            with mock.patch.object(services, "restart_services", return_value={}) as rs:
                services.restart_danbyte()
            self.assertEqual(rs.call_args.args[0], ["backend", "workers", "ws"])


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
