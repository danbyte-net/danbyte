"""Worker-pool size control (Settings → Services, superuser)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import DeploymentSettings, Organization, Tenant


class WorkerControlTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_requires_superuser(self):
        plain = User.objects.create_user("plain", "p@a.c", "pw")
        self._login(plain)
        r = self.client.post("/api/services/workers/", {"count": 4}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_rejects_out_of_range(self):
        self._login(self.admin)
        r = self.client.post("/api/services/workers/", {"count": 999}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(DeploymentSettings.load().rq_workers, 8)  # unchanged

    def test_saves_the_count(self):
        self._login(self.admin)
        r = self.client.post("/api/services/workers/", {"count": 12}, format="json")
        # In the test env systemd isn't reachable, so it can't restart — but the
        # setting is persisted regardless (saved=true), returned as 200.
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(DeploymentSettings.load().rq_workers, 12)

    def test_services_list_includes_worker_config(self):
        self._login(self.admin)
        r = self.client.get("/api/services/")
        self.assertEqual(r.status_code, 200, r.content)
        w = r.json()["workers"]
        self.assertEqual(w["rq_workers"], 8)
        self.assertIn("min", w)
        self.assertIn("max", w)
