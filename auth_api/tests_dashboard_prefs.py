"""The server-side dashboard layout endpoint (#41)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import UserPreference

User = get_user_model()

LAYOUT = {"v": 2, "items": [{"id": "changelog", "x": 0, "y": 0, "w": 3, "h": 3}]}


class DashboardPrefTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u", "u@x.dk", "pw")
        from .models import UserProfile

        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _put(self, body):
        return self.client.put(
            "/api/prefs/dashboard/", body, content_type="application/json",
            format=None,
        )

    def test_round_trip(self):
        import json

        r = self.client.put(
            "/api/prefs/dashboard/", json.dumps(LAYOUT),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        got = self.client.get("/api/prefs/dashboard/").json()
        self.assertEqual(got["source"], "user")
        self.assertEqual(got["data"], LAYOUT)

    def test_delete_resets_to_tenant_default(self):
        import json

        UserPreference.objects.create(
            tenant=self.tenant, user=None, table_id="dashboard",
            data={"v": 2, "items": []},
        )
        self.client.put("/api/prefs/dashboard/", json.dumps(LAYOUT),
                        content_type="application/json")
        self.client.delete("/api/prefs/dashboard/")
        got = self.client.get("/api/prefs/dashboard/").json()
        self.assertEqual(got["source"], "default")

    def test_no_pref_reads_as_none(self):
        got = self.client.get("/api/prefs/dashboard/").json()
        self.assertEqual(got, {"source": "none", "data": None})

    def test_rejects_bad_shapes(self):
        import json

        for bad in (
            ["changelog"],                                  # v1 belongs client-side
            {"v": 2, "items": [{"id": 5, "x": 0, "y": 0, "w": 1, "h": 1}]},
            {"v": 2, "items": [{"id": "a", "x": -1, "y": 0, "w": 1, "h": 1}]},
            {"v": 2, "items": [{"id": "a", "x": 0, "y": 0, "w": 99, "h": 1}]},
            {"v": 3, "items": []},
        ):
            r = self.client.put("/api/prefs/dashboard/", json.dumps(bad),
                                content_type="application/json")
            self.assertEqual(r.status_code, 400, bad)

    def test_scoped_to_the_tenant(self):
        """A second tenant sees no layout - prefs never bleed across."""
        import json

        self.client.put("/api/prefs/dashboard/", json.dumps(LAYOUT),
                        content_type="application/json")
        org2 = Organization.objects.create(name="O2", slug="o2")
        t2 = Tenant.objects.create(org=org2, name="T2", slug="t2")
        self.user.profile.tenants.add(t2)
        s = self.client.session
        s["current_tenant_id"] = str(t2.id)
        s.save()
        got = self.client.get("/api/prefs/dashboard/").json()
        self.assertEqual(got["source"], "none")

    def test_requires_login(self):
        self.client.logout()
        r = self.client.get("/api/prefs/dashboard/")
        self.assertIn(r.status_code, (302, 401, 403))
