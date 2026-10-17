"""Rack capacity levels are a tenant setting: written through
``/api/tenant-settings/``, served to the SPA on ``/api/me/``, 80 / 95 without
a settings row, and the warning level always below the critical one."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.effective_settings import capacity_thresholds
from core.models import Organization, Tenant, TenantSettings

User = get_user_model()


class CapacityThresholdTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.client.force_login(User.objects.create_superuser("a", "a@b.c", "pw"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def put(self, body):
        return self.client.put("/api/tenant-settings/", body, format="json")

    def test_defaults_without_a_row(self):
        self.assertEqual(capacity_thresholds(self.tenant), {"warn": 80, "critical": 95})
        self.assertEqual(
            self.client.get("/api/me/").json()["capacity_thresholds"],
            {"warn": 80, "critical": 95},
        )
        self.assertFalse(TenantSettings.objects.filter(tenant=self.tenant).exists())

    def test_saved_and_served_per_tenant(self):
        r = self.put({"capacity_warn_pct": 70, "capacity_critical_pct": 90})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            (r.json()["capacity_warn_pct"], r.json()["capacity_critical_pct"]), (70, 90)
        )
        self.assertEqual(
            self.client.get("/api/me/").json()["capacity_thresholds"],
            {"warn": 70, "critical": 90},
        )
        self.assertEqual(capacity_thresholds(self.other), {"warn": 80, "critical": 95})

    def test_warning_must_sit_below_critical(self):
        for warn, crit in ((95, 95), (96, 95)):
            r = self.put({"capacity_warn_pct": warn, "capacity_critical_pct": crit})
            self.assertEqual(r.status_code, 400, (warn, crit))
            self.assertIn("capacity_critical_pct", r.json())
        # Moving one level checks it against the stored other one.
        self.assertEqual(self.put({"capacity_warn_pct": 96}).status_code, 400)

    def test_out_of_range_is_refused(self):
        for body in ({"capacity_warn_pct": 0}, {"capacity_critical_pct": 101}):
            self.assertEqual(self.put(body).status_code, 400, body)
