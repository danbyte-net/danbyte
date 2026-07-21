"""Creating a child prefix re-homes the IPs it most-specifically contains."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant


class ReparentOnCreateTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.parent = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        self.ip_in = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.parent, ip_address="10.0.5.10"
        )
        self.ip_out = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.parent, ip_address="10.0.9.10"
        )
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_create_child_reparents_covered_ips(self):
        r = self.client.post("/api/prefixes/", {"cidr": "10.0.5.0/24"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        child_id = r.json()["id"]
        self.ip_in.refresh_from_db()
        self.ip_out.refresh_from_db()
        self.assertEqual(str(self.ip_in.prefix_id), child_id)  # moved into the /24
        self.assertEqual(self.ip_out.prefix_id, self.parent.id)  # outside → stayed

    def test_does_not_steal_from_more_specific_child(self):
        child24 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.5.0/24")
        ip24 = IPAddress.objects.create(
            tenant=self.tenant, prefix=child24, ip_address="10.0.5.20"
        )
        # Carve an intermediate /20 that also contains 10.0.5.20.
        r = self.client.post("/api/prefixes/", {"cidr": "10.0.0.0/20"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        ip24.refresh_from_db()
        # The IP belongs to the more-specific /24 — the new /20 must not steal it.
        self.assertEqual(ip24.prefix_id, child24.id)
