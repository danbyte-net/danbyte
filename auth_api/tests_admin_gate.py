"""Admin-settings gating (#87).

`auth_api.permissions.can_manage_admin` is the single gate the deployment
(Email), LDAP, and Monitoring settings endpoints — plus `me_json`'s
`can_manage_users` — all share. These tests pin its branches and assert the
three write endpoints actually enforce it, so the unification can't silently
regress (e.g. an endpoint reverting to a bespoke check).
"""
from __future__ import annotations

from django.contrib.auth.models import AnonymousUser, User
from django.test import TestCase
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from auth_api.permissions import can_manage_admin
from core.models import Organization, Tenant


class CanManageAdminUnitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _user(self, name, **kw):
        u = User.objects.create_user(name, password="x", **kw)
        UserProfile.objects.create(user=u, role="custom")
        return u

    def test_anonymous_denied(self):
        self.assertFalse(can_manage_admin(AnonymousUser(), self.tenant))

    def test_plain_user_denied(self):
        self.assertFalse(can_manage_admin(self._user("plain"), self.tenant))

    def test_superuser_allowed(self):
        u = User.objects.create_user("root", password="x", is_superuser=True)
        self.assertTrue(can_manage_admin(u, self.tenant))

    def test_legacy_users_manage_slug_allowed(self):
        u = self._user("legacy")
        u.profile.permissions = ["users.manage"]
        u.profile.save(update_fields=["permissions"])
        self.assertTrue(can_manage_admin(u, self.tenant))

    def test_rbac_change_on_user_allowed_without_legacy_role(self):
        # Administrator provisioned purely via an (unscoped) RBAC grant — no
        # legacy `users.manage` slug. This is the case the helper exists to fix.
        u = self._user("rbacadmin")
        perm = ObjectPermission.objects.create(
            name="user admin", object_types=["user"], actions=["change"],
        )
        perm.users.add(u)
        self.assertTrue(can_manage_admin(u, self.tenant))
        # Tenant-unscoped grant resolves even without an active tenant.
        self.assertTrue(can_manage_admin(u, None))

    def test_change_on_other_type_is_not_enough(self):
        u = self._user("prefixeditor")
        perm = ObjectPermission.objects.create(
            name="prefix editor", object_types=["prefix"], actions=["change"],
        )
        perm.users.add(u)
        self.assertFalse(can_manage_admin(u, self.tenant))

    def test_view_only_on_user_is_not_enough(self):
        u = self._user("userviewer")
        perm = ObjectPermission.objects.create(
            name="user viewer", object_types=["user"], actions=["view"],
        )
        perm.users.add(u)
        self.assertFalse(can_manage_admin(u, self.tenant))


class AdminSettingsEndpointGateTests(APITestCase):
    """Every admin-settings write must 403 a non-admin and admit a superuser —
    proving each endpoint routes through `can_manage_admin`."""

    # (url, method) for each gated write.
    WRITES = [
        ("/api/deployment/email/", "put"),
        ("/api/deployment/ldap/", "put"),
        ("/api/monitoring/settings/", "patch"),
    ]

    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_non_admin_blocked_on_every_write(self):
        u = User.objects.create_user("plain", password="x")
        UserProfile.objects.create(user=u, role="custom")
        u.profile.tenants.add(self.tenant)
        self._login(u)
        for url, method in self.WRITES:
            with self.subTest(url=url):
                resp = getattr(self.client, method)(url, {}, format="json")
                self.assertEqual(resp.status_code, 403, f"{url} should 403")

    def test_superuser_passes_the_gate_on_every_write(self):
        u = User.objects.create_user("root", password="x", is_superuser=True)
        self._login(u)
        for url, method in self.WRITES:
            with self.subTest(url=url):
                resp = getattr(self.client, method)(url, {}, format="json")
                # Past the gate: anything but 403 (200 ok, or 400 on payload).
                self.assertNotEqual(
                    resp.status_code, 403, f"{url} should not 403 a superuser"
                )
