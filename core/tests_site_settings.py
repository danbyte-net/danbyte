"""Per-site settings (email v1) — resolution chain + site-admin gating."""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import Site
from auth_api.models import ObjectPermission, UserProfile
from core.effective_settings import effective_email
from core.models import (
    DeploymentSettings,
    Organization,
    SiteSettings,
    Tenant,
    TenantSettings,
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="OSS", slug="oss")
        self.tenant = Tenant.objects.create(org=org, name="TSS", slug="tss")
        self.s1 = Site.objects.create(tenant=self.tenant, name="S1")
        self.s2 = Site.objects.create(tenant=self.tenant, name="S2")
        self.dep = DeploymentSettings.load()
        self.dep.smtp_host = "dep.example.com"
        self.dep.allow_site_settings = True
        self.dep.save()

    def _user(self, name, *, editor_of=None, sitesettings_of=None, admin=False):
        u = User.objects.create_user(name, password="x", email=f"{name}@x.dk")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        if admin:
            p = ObjectPermission.objects.create(
                name=f"{name}-admin", object_types=["user"], actions=["change"]
            )
            p.users.add(u)
            p.tenants.set([self.tenant])
        if editor_of is not None:
            p = ObjectPermission.objects.create(
                name=f"{name}-edit", object_types=["device"],
                actions=["view", "add", "change"],
            )
            p.users.add(u)
            p.sites.set([editor_of])
        if sitesettings_of is not None:
            p = ObjectPermission.objects.create(
                name=f"{name}-ss", object_types=["sitesettings"],
                actions=["view", "change"],
            )
            p.users.add(u)
            p.sites.set([sitesettings_of])
        return u

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")


class ResolutionTests(_Base):
    def test_chain_site_tenant_deployment(self):
        # No rows anywhere → deployment.
        self.assertIsInstance(effective_email(self.tenant, site=self.s1),
                              DeploymentSettings)
        # Tenant override on → tenant.
        ts = TenantSettings.for_tenant(self.tenant)
        ts.override_email = True
        ts.smtp_host = "tenant.example.com"
        ts.save()
        self.assertIsInstance(effective_email(self.tenant, site=self.s1),
                              TenantSettings)
        # Site override on → site wins.
        ss = SiteSettings.for_site(self.s1)
        ss.override_email = True
        ss.smtp_host = "site.example.com"
        ss.save()
        eff = effective_email(self.tenant, site=self.s1)
        self.assertIsInstance(eff, SiteSettings)
        self.assertEqual(eff.smtp_host, "site.example.com")
        # Other site keeps inheriting the tenant.
        self.assertIsInstance(effective_email(self.tenant, site=self.s2),
                              TenantSettings)
        # No-site callers untouched.
        self.assertIsInstance(effective_email(self.tenant), TenantSettings)

    def test_site_row_with_toggle_off_inherits(self):
        SiteSettings.objects.create(site=self.s1, smtp_host="ignored")
        self.assertIsInstance(effective_email(self.tenant, site=self.s1),
                              DeploymentSettings)


class GatingTests(_Base):
    def test_site_editor_edits_own_site_only(self):
        ed = self._user("ed", editor_of=self.s1)
        self._login(ed)
        res = self.client.get(f"/api/sites/{self.s1.id}/settings/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("parent_defaults", res.json())
        res = self.client.put(
            f"/api/sites/{self.s1.id}/settings/",
            {"override_email": True, "smtp_host": "s1.example.com"},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(
            SiteSettings.objects.get(site=self.s1).smtp_host, "s1.example.com"
        )
        res = self.client.get(f"/api/sites/{self.s2.id}/settings/")
        self.assertEqual(res.status_code, 403)

    def test_explicit_sitesettings_grant_works_via_group_too(self):
        u = User.objects.create_user("grp", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        g = Group.objects.create(name="S2 settings admins")
        u.groups.add(g)
        p = ObjectPermission.objects.create(
            name="s2-ss", object_types=["sitesettings"],
            actions=["view", "change"],
        )
        p.groups.add(g)
        p.sites.set([self.s2])
        self._login(u)
        self.assertEqual(
            self.client.get(f"/api/sites/{self.s2.id}/settings/").status_code, 200
        )
        self.assertEqual(
            self.client.get(f"/api/sites/{self.s1.id}/settings/").status_code, 403
        )

    def test_allow_switch_off_blocks_non_admins(self):
        self.dep.allow_site_settings = False
        self.dep.save()
        ed = self._user("ed2", editor_of=self.s1)
        self._login(ed)
        res = self.client.get(f"/api/sites/{self.s1.id}/settings/")
        self.assertEqual(res.status_code, 403)

    def test_tenant_admin_bypasses_allow_switch(self):
        self.dep.allow_site_settings = False
        self.dep.save()
        adm = self._user("adm", admin=True)
        self._login(adm)
        res = self.client.get(f"/api/sites/{self.s1.id}/settings/")
        self.assertEqual(res.status_code, 200)

    def test_plain_member_blocked(self):
        u = self._user("pl")
        self._login(u)
        self.assertEqual(
            self.client.get(f"/api/sites/{self.s1.id}/settings/").status_code, 403
        )

    def test_secrets_never_echoed(self):
        adm = self._user("adm2", admin=True)
        self._login(adm)
        res = self.client.put(
            f"/api/sites/{self.s1.id}/settings/",
            {"override_email": True, "smtp_password": "hunter2"},
            format="json",
        )
        body = res.json()
        self.assertNotIn("hunter2", str(body))
        self.assertTrue(body["smtp_password_set"])
        # Blank on a later PUT leaves the stored password untouched.
        self.client.put(
            f"/api/sites/{self.s1.id}/settings/",
            {"smtp_password": ""}, format="json",
        )
        self.assertEqual(
            SiteSettings.objects.get(site=self.s1).secrets.get("password"),
            "hunter2",
        )

    def test_settings_admin_is_not_a_site_editor(self):
        # A sitesettings grant must not leak infrastructure-editor powers.
        from auth_api import rbac

        u = self._user("ssonly", sitesettings_of=self.s1)
        self.assertEqual(rbac.editable_sites(u, self.tenant), set())

    def test_me_payload(self):
        ed = self._user("edme", editor_of=self.s1)
        self._login(ed)
        me = self.client.get("/api/me/").json()
        self.assertTrue(me["site_settings_enabled"])
        self.assertEqual(me["settings_sites"], [str(self.s1.id)])
