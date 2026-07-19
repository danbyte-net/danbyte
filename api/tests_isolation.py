"""Tenant-isolation hardening (#59): cross-tenant FK rejection, audit IDOR,
tenant enumeration."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from django.test import Client, TestCase

from api.models import Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


def _post(client, url, **body):
    return client.post(url, data=json.dumps(body), content_type="application/json")


def _switch(client, tenant):
    s = client.session
    s["current_tenant_id"] = str(tenant.id)
    s.save()


class TenantIsolationTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.a = Tenant.objects.create(org=org, name="A", slug="a")
        self.b = Tenant.objects.create(org=org, name="B", slug="b")
        # Tenant B's objects (the things A must not touch/read).
        self.b_site = Site.objects.create(tenant=self.b, name="B-site")
        self.b_prefix = Prefix.objects.create(
            tenant=self.b, cidr="10.9.0.0/24", status=status_for(self.b)
        )

    def _superuser_in_a(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.a)
        c = Client()
        c.force_login(su)
        _switch(c, self.a)
        return c

    def test_cross_tenant_fk_rejected(self):
        # Acting in tenant A, you can't create a prefix pointing at B's site.
        c = self._superuser_in_a()
        r = _post(c, "/api/prefixes/", cidr="10.1.0.0/24", site_id=str(self.b_site.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("site_id", r.json())

    def test_audit_history_idor_blocked(self):
        # B's prefix has a create change-log entry (tenant=B). Acting in A you
        # must not be able to read it by guessing its UUID.
        c = self._superuser_in_a()
        r = c.get(f"/api/changelog/?object_id={self.b_prefix.id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 0)

    def test_tenant_enumeration_blocked(self):
        # A non-superuser member of A (with tenant view) can see A, not B.
        nu = User.objects.create_user("nu", password="x")
        UserProfile.objects.create(user=nu, role="custom").tenants.add(self.a)
        perm = ObjectPermission.objects.create(
            name="see tenants", object_types=["tenant"], actions=["view"]
        )
        perm.users.add(nu)
        c = Client()
        c.force_login(nu)
        _switch(c, self.a)
        self.assertEqual(c.get(f"/api/tenants/{self.a.id}/").status_code, 200)
        self.assertEqual(c.get(f"/api/tenants/{self.b.id}/").status_code, 404)
