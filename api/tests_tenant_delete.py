"""Tenant force-delete (cascades through PROTECT) + bulk delete/update."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db.models.deletion import ProtectedError
from rest_framework.test import APITestCase

from api.models import Prefix, Status
from core.models import Organization, Tenant, TenantGroup


class TenantForceDeleteTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="Doomed", slug="doomed")
        # A per-tenant Status PROTECTs the tenant; a Prefix references the Status,
        # so a plain delete raises ProtectedError (the bug we're fixing).
        st = Status.objects.create(tenant=self.tenant, name="Active", slug="active")
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=st)
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_plain_delete_is_protected(self):
        with self.assertRaises(ProtectedError):
            Tenant.objects.get(pk=self.tenant.pk).delete()

    def test_api_delete_force_cascades(self):
        r = self.client.delete(f"/api/tenants/{self.tenant.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(Tenant.objects.filter(pk=self.tenant.pk).exists())
        self.assertFalse(Prefix.objects.filter(tenant_id=self.tenant.id).exists())
        self.assertFalse(Status.objects.filter(tenant_id=self.tenant.id).exists())

    def test_bulk_delete(self):
        r = self.client.post(
            "/api/tenants/bulk-delete/", {"ids": [str(self.tenant.id)]}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(Tenant.objects.filter(pk=self.tenant.pk).exists())

    def test_bulk_update_group_and_active(self):
        g = TenantGroup.objects.create(org=self.org, name="G", slug="g")
        r = self.client.post(
            "/api/tenants/bulk-update/",
            {"ids": [str(self.tenant.id)],
             "fields": {"group_id": str(g.id), "is_active": False}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.tenant.refresh_from_db()
        self.assertEqual(self.tenant.group_id, g.id)
        self.assertFalse(self.tenant.is_active)

    def test_delete_requires_permission(self):
        plain = User.objects.create_user("plain", "p@a.c", "pw")
        from auth_api.models import UserProfile

        UserProfile.objects.create(user=plain, role="custom").tenants.add(self.tenant)
        self.client.force_login(plain)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.delete(f"/api/tenants/{self.tenant.id}/")
        self.assertIn(r.status_code, (403, 404))
        self.assertTrue(Tenant.objects.filter(pk=self.tenant.pk).exists())
