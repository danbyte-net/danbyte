"""Date/time display settings — cascade resolution, /api/me/, validation.

Three layers, most specific wins:

  user pref (auth_api.user_prefs, "auto" = inherit)
    → tenant override (TenantSettings.override_datetime)
      → deployment default (DeploymentSettings, blank tz = server TIME_ZONE)
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import override_settings
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from auth_api.user_prefs import datetime_prefs, set_user
from core.effective_settings import effective_datetime, effective_datetime_values
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings


class DatetimeResolutionTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.u = User.objects.create_user("alice", password="x")
        prof = UserProfile.objects.create(user=self.u, role="reader")
        prof.tenants.add(self.t)

    def test_deployment_default_when_no_tenant_row(self):
        self.assertIsInstance(effective_datetime(self.t), DeploymentSettings)
        vals = effective_datetime_values(self.t)
        self.assertEqual(vals["date_format"], "YYYY-MM-DD")
        self.assertEqual(vals["time_style"], "24h")
        # Blank stored timezone resolves to the server TIME_ZONE.
        with override_settings(TIME_ZONE="Europe/Copenhagen"):
            self.assertEqual(
                effective_datetime_values(self.t)["timezone"], "Europe/Copenhagen"
            )

    def test_deployment_stored_values_flow_through(self):
        dep = DeploymentSettings.load()
        dep.date_format = "MM/DD/YYYY"
        dep.time_style = "12h"
        dep.display_timezone = "America/New_York"
        dep.save()
        vals = datetime_prefs(self.u, self.t)
        self.assertEqual(vals["date_format"], "MM/DD/YYYY")
        self.assertEqual(vals["time_style"], "12h")
        self.assertEqual(vals["timezone"], "America/New_York")

    def test_tenant_override_needs_toggle(self):
        TenantSettings.objects.create(
            tenant=self.t, date_format="DD.MM.YYYY", time_style="12h",
            display_timezone="Europe/Berlin",
        )
        # Toggle off → still the deployment default.
        self.assertEqual(
            effective_datetime_values(self.t)["date_format"], "YYYY-MM-DD"
        )
        TenantSettings.objects.filter(tenant=self.t).update(override_datetime=True)
        vals = effective_datetime_values(self.t)
        self.assertEqual(vals["date_format"], "DD.MM.YYYY")
        self.assertEqual(vals["time_style"], "12h")
        self.assertEqual(vals["timezone"], "Europe/Berlin")

    def test_user_override_wins_and_auto_falls_through(self):
        TenantSettings.objects.create(
            tenant=self.t, override_datetime=True,
            date_format="DD.MM.YYYY", time_style="24h",
            display_timezone="Europe/Berlin",
        )
        # All-auto user → the tenant values.
        vals = datetime_prefs(self.u, self.t)
        self.assertEqual(vals["date_format"], "DD.MM.YYYY")
        self.assertEqual(vals["timezone"], "Europe/Berlin")
        # Explicit user prefs win per key; untouched keys keep inheriting.
        set_user(self.u, "date_format", "MM/DD/YYYY")
        set_user(self.u, "timezone", "Asia/Tokyo")
        vals = datetime_prefs(self.u, self.t)
        self.assertEqual(vals["date_format"], "MM/DD/YYYY")
        self.assertEqual(vals["time_style"], "24h")  # still tenant/deployment
        self.assertEqual(vals["timezone"], "Asia/Tokyo")
        # Back to auto → tenant again.
        set_user(self.u, "date_format", "auto")
        self.assertEqual(datetime_prefs(self.u, self.t)["date_format"], "DD.MM.YYYY")

    def test_invalid_user_values_degrade_to_effective(self):
        set_user(self.u, "date_format", "QQ-QQ-QQ")
        set_user(self.u, "time_style", "13h")
        set_user(self.u, "timezone", "Not/AZone")
        vals = datetime_prefs(self.u, self.t)
        self.assertEqual(vals["date_format"], "YYYY-MM-DD")
        self.assertEqual(vals["time_style"], "24h")
        self.assertEqual(vals["timezone"], "UTC")

    def test_anonymous_and_no_tenant(self):
        # Login page / background callers: no user prefs, no tenant → the
        # deployment defaults, never an error.
        vals = datetime_prefs(None, None)
        self.assertEqual(vals["date_format"], "YYYY-MM-DD")


class DatetimeEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def _member(self, name):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="reader")
        prof.tenants.add(self.t)
        return u

    def _tenant_admin(self, name):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.t)
        perm = ObjectPermission.objects.create(
            name="tadmin", object_types=["user"], actions=["change"]
        )
        perm.users.add(u)
        perm.tenants.add(self.t)
        return u

    def test_me_returns_resolved_datetime(self):
        TenantSettings.objects.create(
            tenant=self.t, override_datetime=True,
            date_format="DD.MM.YYYY", display_timezone="Europe/Copenhagen",
        )
        user = self._member("m")
        set_user(user, "time_style", "12h")
        self._login(user)
        me = self.client.get("/api/me/").json()
        self.assertEqual(
            me["datetime"],
            {
                "date_format": "DD.MM.YYYY",   # tenant override
                "time_style": "12h",           # user override
                "timezone": "Europe/Copenhagen",
            },
        )

    def test_me_prefs_roundtrip(self):
        self._login(self._member("m2"))
        r = self.client.put(
            "/api/me/prefs/", {"timezone": "Asia/Tokyo"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["values"]["timezone"], "Asia/Tokyo")
        self.assertIn("timezone", body["user_set"])
        self.assertEqual(body["defaults"]["date_format"], "auto")

    def test_tenant_settings_carry_group_and_validate_tz(self):
        self._login(self._tenant_admin("ta"))
        r = self.client.put(
            "/api/tenant-settings/",
            {"override_datetime": True, "date_format": "MM/DD/YYYY",
             "display_timezone": "America/Chicago"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertTrue(data["override_datetime"])
        self.assertEqual(data["date_format"], "MM/DD/YYYY")
        self.assertIn("date_format", data["deployment_defaults"])
        # Bogus values are actionable field errors, not 500s.
        r = self.client.put(
            "/api/tenant-settings/", {"display_timezone": "Mars/Olympus"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("display_timezone", r.json())
        r = self.client.put(
            "/api/tenant-settings/", {"date_format": "bogus"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
