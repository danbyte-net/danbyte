"""Admin-settings gating: an Administrator provisioned purely through an RBAC
group (no legacy role) can reach the admin surfaces, while a plain user can't."""
from __future__ import annotations

import json

from django.contrib.auth.models import Group, User
from django.test import TestCase

from auth_api.models import UserProfile
from auth_api.permissions import can_manage_admin
from core.models import Organization, Tenant


class AdminGatingTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _user(self, name, *, group=None, role="custom"):
        u = User.objects.create_user(name, password="pw12345!")
        prof = UserProfile.objects.create(user=u, role=role)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        if group:
            u.groups.add(Group.objects.get(name=group))
        return u

    def test_rbac_only_administrator_can_manage(self):
        # role="custom" (NOT legacy admin) + the seeded Administrator RBAC group.
        u = self._user("rbacadmin", group="Administrator", role="custom")
        # No legacy users.manage slug…
        from auth_api.permissions import user_has_perm

        self.assertFalse(user_has_perm(u, "users.manage"))
        # …but RBAC change-on-user grants admin access.
        self.assertTrue(can_manage_admin(u, self.tenant))

    def test_plain_user_cannot_manage(self):
        u = self._user("reader", role="reader")
        self.assertFalse(can_manage_admin(u, self.tenant))

    def test_superuser_can_manage(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        self.assertTrue(can_manage_admin(su, self.tenant))

    def test_monitoring_settings_write_gated_via_rbac(self):
        from django.test import Client

        u = self._user("rbacadmin2", group="Administrator", role="custom")
        c = Client()
        c.force_login(u)
        c.post(f"/api/tenants/{self.tenant.id}/switch/")
        # RBAC-only admin can PATCH monitoring settings…
        r = c.patch(
            "/api/monitoring/settings/",
            data=json.dumps({"default_interval_seconds": 300}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)

        # …a plain reader is blocked.
        reader = self._user("reader2", role="reader")
        rc = Client()
        rc.force_login(reader)
        rc.post(f"/api/tenants/{self.tenant.id}/switch/")
        rr = rc.patch(
            "/api/monitoring/settings/",
            data=json.dumps({"default_interval_seconds": 300}),
            content_type="application/json",
        )
        self.assertEqual(rr.status_code, 403)
