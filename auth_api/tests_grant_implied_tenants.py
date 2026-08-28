"""A tenant-scoped grant IS tenant access - membership needn't be doubled up.

A user whose only route to tenant X is a grant scoped to X (held directly or
via a group) used to be locked out of X entirely: the permission gate resolved
the group fine, but user_tenants() - which every activation surface funnels
through (the switcher list, the switch action, _get_active_tenant) - read only
the manual UserProfile.tenants list. The grant was dead weight until an admin
also edited the member's profile.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import Prefix
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from auth_api.permissions import user_tenants
from core.models import Organization, Tenant


class GrantImpliedTenantTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        cls.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        Prefix.objects.create(
            tenant=cls.tenant, cidr="10.0.0.0/24", status=status_for(cls.tenant)
        )

    def _grant(self, *, tenants=(), users=(), groups=(), enabled=True):
        perm = ObjectPermission.objects.create(
            name="p", enabled=enabled,
            object_types=["prefix"], actions=["view"],
        )
        perm.tenants.set(tenants)
        perm.users.set(users)
        perm.groups.set(groups)
        return perm

    def _user(self, name, *, member_of=()):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        for t in member_of:
            prof.tenants.add(t)
        return u

    def test_a_group_held_tenant_scoped_grant_opens_the_tenant(self):
        g = Group.objects.create(name="netops")
        u = self._user("via-group")
        u.groups.add(g)
        self._grant(tenants=[self.tenant], groups=[g])

        self.assertIn(self.tenant, user_tenants(u))
        # And it works end to end: the switcher lists it, switching succeeds,
        # and the granted type is readable in it.
        self.client.force_login(u)
        r = self.client.get("/api/tenants/?picker=1")
        self.assertEqual(r.status_code, 200, r.content)
        ids = {row["id"] for row in r.json()["results"]}
        self.assertIn(str(self.tenant.id), ids)
        r = self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.assertIn(r.status_code, (200, 204), r.content)
        r = self.client.get("/api/prefixes/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["count"], 1)

    def test_a_directly_held_tenant_scoped_grant_opens_it_too(self):
        u = self._user("direct")
        self._grant(tenants=[self.tenant], users=[u])
        self.assertIn(self.tenant, user_tenants(u))

    def test_an_unscoped_grant_grants_no_tenant(self):
        # Empty tenants means "every tenant the user can access" - it defers
        # to membership, and widening it would make every unscoped grant an
        # all-tenant grant.
        u = self._user("unscoped")
        self._grant(tenants=[], users=[u])
        self.assertEqual(list(user_tenants(u)), [])

    def test_a_disabled_grant_grants_nothing(self):
        u = self._user("disabled")
        self._grant(tenants=[self.tenant], users=[u], enabled=False)
        self.assertEqual(list(user_tenants(u)), [])

    def test_the_grant_only_opens_the_tenants_it_names(self):
        u = self._user("scoped")
        self._grant(tenants=[self.tenant], users=[u])
        self.assertNotIn(self.other, user_tenants(u))

    def test_membership_and_grants_union_without_duplicates(self):
        g = Group.objects.create(name="both-paths")
        u = self._user("both", member_of=[self.tenant])
        u.groups.add(g)
        self._grant(tenants=[self.tenant], groups=[g])
        tenants = list(user_tenants(u))
        self.assertEqual(tenants.count(self.tenant), 1)

    def test_someone_elses_grant_does_not_leak(self):
        stranger = self._user("stranger")
        holder = self._user("holder")
        self._grant(tenants=[self.tenant], users=[holder])
        self.assertEqual(list(user_tenants(stranger)), [])
