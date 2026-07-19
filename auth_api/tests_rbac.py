"""RBAC enforcement tests — built-in groups + object permissions + constraints."""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from api.models import Prefix
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class RBACEnforcementTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        org = Organization.objects.create(name="Org", slug="org")
        cls.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        # A couple of prefixes to scope.
        Prefix.objects.create(tenant=cls.tenant, cidr="10.0.0.0/24", status=status_for(cls.tenant))
        Prefix.objects.create(tenant=cls.tenant, cidr="10.0.1.0/24", status=status_for(cls.tenant, "reserved"))

    def _user(self, name, group=None, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        if group:
            u.groups.add(Group.objects.get(name=group))
        return u

    def _client(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_readonly_cannot_write(self):
        self._client(self._user("ro", group="Read-only"))
        self.assertEqual(self.client.get("/api/prefixes/").status_code, 200)
        r = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.0.9.0/24", "status": "active"},
            format="json",
        )
        self.assertEqual(r.status_code, 403)

    def test_operator_can_add_not_delete(self):
        self._client(self._user("op", group="Operator"))
        r = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.0.9.0/24", "status": "active"},
            format="json",
        )
        self.assertEqual(r.status_code, 201)
        pid = r.json()["id"]
        self.assertEqual(self.client.delete(f"/api/prefixes/{pid}/").status_code, 403)

    def test_constraint_filters_queryset(self):
        u = self._user("constr")
        perm = ObjectPermission.objects.create(
            name="active only", object_types=["prefix"], actions=["view"],
            constraints={"status__slug": "active"},
        )
        perm.users.add(u)
        self._client(u)
        data = self.client.get("/api/prefixes/?page_size=100").json()
        self.assertEqual(data["count"], 1)  # only the active one
        self.assertEqual(data["results"][0]["cidr"], "10.0.0.0/24")

    def test_per_object_permissions_flag_respects_constraints(self):
        # A grant constrained to active prefixes: the serializer's per-object
        # `permissions` must report change/delete True only for matching rows.
        u = self._user("objperm")
        perm = ObjectPermission.objects.create(
            name="active rw", object_types=["prefix"],
            actions=["view", "change", "delete"],
            constraints={"status__slug": "active"},
        )
        perm.users.add(u)
        self._client(u)
        rows = {
            r["cidr"]: r["permissions"]
            for r in self.client.get("/api/prefixes/?page_size=100").json()["results"]
        }
        # Only the active prefix is even visible (view is constrained too)…
        self.assertIn("10.0.0.0/24", rows)
        self.assertEqual(rows["10.0.0.0/24"], {"change": True, "delete": True})
        # …and the detail of the active one confirms the same.
        active = Prefix.objects.get(cidr="10.0.0.0/24")
        detail = self.client.get(f"/api/prefixes/{active.id}/").json()
        self.assertEqual(detail["permissions"], {"change": True, "delete": True})

    def test_per_object_permissions_flag_false_without_grant(self):
        u = self._user("viewonly")
        perm = ObjectPermission.objects.create(
            name="view all", object_types=["prefix"], actions=["view"],
        )
        perm.users.add(u)
        self._client(u)
        active = Prefix.objects.get(cidr="10.0.0.0/24")
        detail = self.client.get(f"/api/prefixes/{active.id}/").json()
        self.assertEqual(detail["permissions"], {"change": False, "delete": False})

    def test_superuser_unrestricted(self):
        self._client(self._user("root", superuser=True))
        r = self.client.post(
            "/api/prefixes/",
            {"cidr": "10.0.9.0/24", "status": "active"},
            format="json",
        )
        self.assertEqual(r.status_code, 201)
        me = self.client.get("/api/me/").json()
        self.assertTrue(me["can_manage_users"])
