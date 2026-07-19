"""Per-tenant settings overrides — resolution, gating, secrets hygiene."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.effective_settings import (
    effective_device_fields,
    effective_email,
    effective_sharing,
    effective_ui,
)
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings


class ResolutionTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dep = DeploymentSettings.load()
        self.dep.smtp_host = "dep.example.com"
        self.dep.human_ids_enabled = True
        self.dep.save()

    def test_no_row_inherits_deployment(self):
        self.assertIsInstance(effective_email(self.t), DeploymentSettings)
        self.assertIsInstance(effective_ui(self.t), DeploymentSettings)
        self.assertIsInstance(effective_sharing(self.t), DeploymentSettings)

    def test_toggle_off_inherits(self):
        TenantSettings.objects.create(tenant=self.t, smtp_host="tenant.example.com")
        self.assertEqual(effective_email(self.t).smtp_host, "dep.example.com")

    def test_toggle_on_wins(self):
        TenantSettings.objects.create(
            tenant=self.t, override_email=True, smtp_host="tenant.example.com",
        )
        self.assertEqual(effective_email(self.t).smtp_host, "tenant.example.com")
        # UI group not overridden → still deployment.
        self.assertIsInstance(effective_ui(self.t), DeploymentSettings)

    def test_none_tenant_is_deployment(self):
        self.assertIsInstance(effective_email(None), DeploymentSettings)

    def test_device_fields_merge(self):
        self.dep.device_field_visibility = {"cluster": True}
        self.dep.save()
        # No override → deployment stored value over defaults.
        merged = effective_device_fields(self.t)
        self.assertTrue(merged["cluster"])
        self.assertTrue(merged["comments"])  # server default
        # Tenant override flips it back off.
        TenantSettings.objects.create(
            tenant=self.t, override_ui=True,
            device_field_visibility={"cluster": False, "airflow": True},
        )
        merged = effective_device_fields(self.t)
        self.assertFalse(merged["cluster"])
        self.assertTrue(merged["airflow"])


class EndpointGatingTests(APITestCase):
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
        """A users.manage-equivalent grant NARROWED to the tenant — passes
        can_manage_admin in the tenant but NOT can_manage_deployment."""
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.t)
        perm = ObjectPermission.objects.create(
            name="tadmin", object_types=["user"], actions=["change"]
        )
        perm.users.add(u)
        perm.tenants.add(self.t)
        return u

    def test_member_cannot_read_or_write(self):
        self._login(self._member("m"))
        self.assertEqual(self.client.get("/api/tenant-settings/").status_code, 403)
        self.assertEqual(
            self.client.put(
                "/api/tenant-settings/", {"override_email": True}, format="json"
            ).status_code,
            403,
        )

    def test_tenant_admin_can_edit_tenant_but_not_deployment(self):
        self._login(self._tenant_admin("ta"))
        r = self.client.get("/api/tenant-settings/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("deployment_defaults", r.json())
        r = self.client.put(
            "/api/tenant-settings/",
            {"override_email": True, "smtp_host": "t.example.com"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # Deployment surfaces refuse the narrowed grant.
        self.assertEqual(self.client.get("/api/deployment/email/").status_code, 403)
        self.assertEqual(self.client.get("/api/deployment/ldap/").status_code, 403)
        self.assertEqual(self.client.get("/api/system/updates/").status_code, 403)

    def test_superuser_passes_both_tiers(self):
        su = User.objects.create_superuser("root", "r@x", "x")
        self._login(su)
        self.assertEqual(self.client.get("/api/tenant-settings/").status_code, 200)
        self.assertEqual(self.client.get("/api/deployment/email/").status_code, 200)

    def test_secrets_never_serialized(self):
        self._login(self._tenant_admin("ta2"))
        self.client.put(
            "/api/tenant-settings/",
            {"override_email": True, "smtp_password": "hunter2"},
            format="json",
        )
        data = self.client.get("/api/tenant-settings/").json()
        self.assertNotIn("secrets", data)
        self.assertNotIn("smtp_password", data)
        self.assertTrue(data["smtp_password_set"])
        ts = TenantSettings.objects.get(tenant=self.t)
        self.assertEqual((ts.secrets or {}).get("password"), "hunter2")

    def test_device_fields_readable_by_any_member(self):
        self._login(self._member("m2"))
        r = self.client.get("/api/device-fields/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("comments", r.json())

    def test_me_flags(self):
        self._login(self._tenant_admin("ta3"))
        me = self.client.get("/api/me/").json()
        self.assertTrue(me["can_manage_users"])
        self.assertFalse(me["can_manage_deployment"])
        su = User.objects.create_superuser("root2", "r@x", "x")
        self._login(su)
        me = self.client.get("/api/me/").json()
        self.assertTrue(me["can_manage_deployment"])


class SeparationResolutionTests(APITestCase):
    """`effective_separation` — its own override group, independent of
    sharing/UI."""

    def setUp(self):
        org = Organization.objects.create(name="OS", slug="os")
        self.t = Tenant.objects.create(org=org, name="Sep", slug="sep")
        self.dep = DeploymentSettings.load()

    def test_defaults_off_and_inherit(self):
        from core.effective_settings import effective_separation, separation_enabled

        self.assertIsInstance(effective_separation(self.t), DeploymentSettings)
        self.assertFalse(separation_enabled(self.t))

    def test_deployment_flag_flows_to_tenant(self):
        from core.effective_settings import separation_enabled

        self.dep.enhanced_site_separation = True
        self.dep.save()
        self.assertTrue(separation_enabled(self.t))

    def test_tenant_override_wins_both_ways(self):
        from core.effective_settings import effective_separation, separation_enabled

        ts = TenantSettings.for_tenant(self.t)
        ts.enhanced_site_separation = True
        ts.save()
        # Toggle off → still inheriting (deployment says off).
        self.assertFalse(separation_enabled(self.t))
        ts.override_separation = True
        ts.save()
        self.assertTrue(separation_enabled(self.t))
        self.assertIsInstance(effective_separation(self.t), TenantSettings)
        # Override ON with the flag off beats a deployment ON.
        self.dep.enhanced_site_separation = True
        self.dep.save()
        ts.enhanced_site_separation = False
        ts.save()
        self.assertFalse(separation_enabled(self.t))

    def test_separation_override_does_not_touch_sharing(self):
        ts = TenantSettings.for_tenant(self.t)
        ts.override_separation = True
        ts.save()
        self.dep.save()
        # Sharing still inherits from deployment despite the separation override.
