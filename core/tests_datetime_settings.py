"""Date/time display settings - cascade resolution, /api/me/, validation.

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


class LegacyTimezoneNameTests(APITestCase):
    """Browsers still offer renamed zones (Europe/Kiev → Europe/Kyiv). A
    canonical-only tz database rejects them, so the app listed values it then
    refused to save (#31). Writes canonicalise instead of erroring, and the
    picker's list now comes from the server."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_canonicalises_even_where_the_tz_database_resolves_legacy(self):
        """Some builds ship the tzdata "backward" links and resolve
        Europe/Kiev natively; others don't. Canonicalise regardless, so the
        stored string doesn't depend on the host - a value written on one
        would otherwise fail to load on the other."""
        from unittest import mock

        import core.timezones as tzmod

        real = tzmod.ZoneInfo

        def full_db(name):
            if name in {"Europe/Kiev", "Asia/Calcutta", "US/Eastern"}:
                return None  # pretend the backward links are present
            return real(name)

        with mock.patch.object(tzmod, "ZoneInfo", full_db):
            self.assertEqual(tzmod.resolve_timezone("Europe/Kiev"), "Europe/Kyiv")
            self.assertEqual(tzmod.resolve_timezone("US/Eastern"), "America/New_York")

    def test_resolve_maps_legacy_names(self):
        from core.timezones import resolve_timezone

        self.assertEqual(resolve_timezone("Europe/Kiev"), "Europe/Kyiv")
        self.assertEqual(resolve_timezone("Asia/Calcutta"), "Asia/Kolkata")
        self.assertEqual(resolve_timezone("US/Eastern"), "America/New_York")
        # Canonical names pass straight through; blank means "inherit".
        self.assertEqual(resolve_timezone("Europe/Copenhagen"), "Europe/Copenhagen")
        self.assertEqual(resolve_timezone("  "), "")
        self.assertIsNone(resolve_timezone("Mars/Olympus"))

    def test_tenant_settings_accept_legacy_name(self):
        r = self.client.put(
            "/api/tenant-settings/",
            {"override_datetime": True, "display_timezone": "Europe/Kiev"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["display_timezone"], "Europe/Kyiv")

    def test_user_pref_rejects_bogus_and_canonicalises_legacy(self):
        bad = self.client.put(
            "/api/me/prefs/", {"timezone": "Mars/Olympus"}, format="json"
        )
        self.assertEqual(bad.status_code, 400, bad.content)
        ok = self.client.put(
            "/api/me/prefs/", {"timezone": "Europe/Kiev"}, format="json"
        )
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["values"]["timezone"], "Europe/Kyiv")

    def test_timezone_list_endpoint_matches_what_writes_accept(self):
        r = self.client.get("/api/timezones/")
        self.assertEqual(r.status_code, 200, r.content)
        zones = r.json()["timezones"]
        self.assertIn("Europe/Copenhagen", zones)
        self.assertIn("Europe/Kyiv", zones)
        # Legacy spellings never appear, even on hosts whose tz database still
        # resolves them - otherwise the picker offers a name it rewrites.
        self.assertNotIn("Europe/Kiev", zones)
        self.assertNotIn("US/Eastern", zones)
        self.assertEqual(zones, sorted(zones))
        # Every offered zone must actually save - that was the whole bug.
        from core.deployment import clean_display_timezone

        for z in zones:
            clean_display_timezone(z)
