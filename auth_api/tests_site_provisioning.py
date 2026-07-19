"""One-click site-scoped user/group provisioning + the access summary.

Creating a site-scoped user used to be: make the user, then hand-build
ObjectPermissions, then wire them. Now a `site_role` on user/group create
assembles the grants in one step (via `assemble_site_role`), and an
access-summary endpoint reads them back in plain language.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from api.test_utils import status_for


class _AdminBase(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.s1 = Site.objects.create(tenant=self.tenant, name="S1")
        self.s2 = Site.objects.create(tenant=self.tenant, name="S2")
        # A deployment admin (user creation is deployment-admin gated).
        self.admin = User.objects.create_user("root", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _grants_for(self, user):
        return ObjectPermission.objects.filter(users=user)


class UserProvisioningTests(_AdminBase):
    def test_editor_site_role_assembles_grants(self):
        res = self.client.post(
            "/api/users/",
            {"username": "site1", "password": "x",
             "tenant_ids": [str(self.tenant.id)],
             "site_role": {"role": "editor", "site_ids": [str(self.s1.id)]}},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        user = User.objects.get(username="site1")
        grants = list(self._grants_for(user))
        # editor = one site-scoped write grant + one unscoped read-all grant.
        write = [g for g in grants if "add" in g.actions]
        readall = [g for g in grants if g.object_types == ["*"] and g.actions == ["view"]]
        self.assertEqual(len(write), 1)
        self.assertEqual(len(readall), 1)
        self.assertEqual({s.id for s in write[0].sites.all()}, {self.s1.id})
        self.assertIn("prefix", write[0].object_types)
        self.assertFalse(readall[0].sites.exists())  # read-all is unscoped

    def test_silo_editor_has_no_readall(self):
        res = self.client.post(
            "/api/users/",
            {"username": "silo", "password": "x",
             "tenant_ids": [str(self.tenant.id)],
             "site_role": {"role": "editor", "site_ids": [str(self.s1.id)],
                           "silo": True}},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        grants = list(self._grants_for(User.objects.get(username="silo")))
        self.assertFalse(any(g.object_types == ["*"] for g in grants))

    def test_viewer_is_read_only(self):
        self.client.post(
            "/api/users/",
            {"username": "ro", "password": "x",
             "tenant_ids": [str(self.tenant.id)],
             "site_role": {"role": "viewer", "site_ids": [str(self.s1.id)]}},
            format="json",
        )
        grants = list(self._grants_for(User.objects.get(username="ro")))
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0].actions, ["view"])
        self.assertEqual({s.id for s in grants[0].sites.all()}, {self.s1.id})

    def test_catalog_types_included_when_separation_on(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.client.post(
            "/api/users/",
            {"username": "sep", "password": "x",
             "tenant_ids": [str(self.tenant.id)],
             "site_role": {"role": "editor", "site_ids": [str(self.s1.id)]}},
            format="json",
        )
        write = self._grants_for(User.objects.get(username="sep")).filter(
            actions__contains=["add"]
        ).first()
        # tag/devicetype/zone are catalog types — present only when separation on.
        self.assertIn("zone", write.object_types)
        self.assertIn("tag", write.object_types)

    def test_bad_role_rolls_back_user(self):
        res = self.client.post(
            "/api/users/",
            {"username": "bad", "password": "x",
             "tenant_ids": [str(self.tenant.id)],
             "site_role": {"role": "nonsense", "site_ids": [str(self.s1.id)]}},
            format="json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertFalse(User.objects.filter(username="bad").exists())  # rolled back

    def test_no_site_role_is_a_plain_user(self):
        res = self.client.post(
            "/api/users/",
            {"username": "plain", "password": "x",
             "tenant_ids": [str(self.tenant.id)]},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        self.assertFalse(self._grants_for(User.objects.get(username="plain")).exists())


class GroupProvisioningTests(_AdminBase):
    def test_group_site_role(self):
        res = self.client.post(
            "/api/groups/",
            {"name": "S1 editors",
             "site_role": {"role": "editor", "site_ids": [str(self.s1.id)]}},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        g = Group.objects.get(name="S1 editors")
        grants = ObjectPermission.objects.filter(groups=g)
        self.assertTrue(grants.filter(actions__contains=["add"]).exists())
        self.assertTrue(grants.filter(object_types=["*"]).exists())


class AccessSummaryTests(_AdminBase):
    def _make_site_user(self, name, sites):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        from auth_api.api import assemble_site_role

        assemble_site_role(self.tenant, "editor", sites, user_ids=[u.id])
        return u

    def test_site_editor_summary(self):
        u = self._make_site_user("ed", [self.s1])
        res = self.client.get(f"/api/users/{u.id}/access-summary/")
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertFalse(body["is_admin"])
        self.assertEqual(body["edit_scope"], "sites")
        self.assertEqual(body["read_scope"], "all")  # editor reads everything
        self.assertEqual([s["name"] for s in body["editable_sites"]], ["S1"])

    def test_admin_summary(self):
        res = self.client.get(f"/api/users/{self.admin.id}/access-summary/")
        self.assertTrue(res.json()["is_admin"])

    def test_summary_requires_admin(self):
        member = User.objects.create_user("mem", password="x")
        UserProfile.objects.create(user=member).tenants.add(self.tenant)
        self.client.force_login(member)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        res = self.client.get(f"/api/users/{self.admin.id}/access-summary/")
        self.assertEqual(res.status_code, 403)


class PrefixErrorTests(_AdminBase):
    """The bug the owner hit: a duplicate/overlapping prefix must be a clean
    4xx, never a 500."""

    def test_duplicate_prefix_is_400_not_500(self):
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.196.192.0/18",
            status=status_for(self.tenant),
        )
        res = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.196.192.0/18", "status": "active"},
            format="json",
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("already exists", str(res.json()).lower())

    def test_enforce_unique_rejects_partial_overlap(self):
        # Same VRF, enforce_unique on (default). A partial overlap (neither
        # contains the other) is a real collision.
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/23",
            status=status_for(self.tenant),
        )
        res = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.0.1.0/23", "status": "active"},  # overlaps 10.0.0.0/23
            format="json",
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_nested_prefix_is_allowed(self):
        # A /24 inside a /16 is normal hierarchy, not a collision.
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.5.0.0/16",
            status=status_for(self.tenant),
        )
        res = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.5.1.0/24", "status": "active"},
            format="json",
        )
        self.assertIn(res.status_code, (200, 201), res.content)
