"""The maintenance flag turns every request into a 503 except the probes
the restore UI and health checks need."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase

from backups import maintenance


class MaintenanceMiddlewareTests(TestCase):
    def setUp(self):
        self.addCleanup(maintenance.leave)
        self.client.force_login(User.objects.create_superuser("root", "r@e.com", "x"))

    def test_off_by_default(self):
        self.assertEqual(self.client.get("/api/me/").status_code, 200)

    def test_flag_holds_the_site(self):
        maintenance.enter("restore in progress", "abc")
        r = self.client.get("/api/me/")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r["Retry-After"], "30")
        self.assertIn("restore in progress", r.json()["detail"])
        self.assertEqual(r.json()["maintenance"]["run_id"], "abc")
        # exempt: health and the restore-run status
        self.assertNotEqual(self.client.get("/api/health/").status_code, 503)
        self.assertNotEqual(self.client.get("/api/backups/restore-runs/").status_code, 503)
        maintenance.leave()
        self.assertEqual(self.client.get("/api/me/").status_code, 200)

    def test_active_run_is_served_from_the_mirror(self):
        maintenance.enter("restore in progress", "abc")
        maintenance.set_progress("abc", {"id": "abc", "status": "running", "steps": [{"name": "database"}]})
        r = self.client.get("/api/backups/restore-runs/abc/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["steps"][0]["name"], "database")
        # another id still goes to the view (and is not blocked by the flag)
        self.assertNotEqual(self.client.get("/api/backups/restore-runs/other/").status_code, 503)
