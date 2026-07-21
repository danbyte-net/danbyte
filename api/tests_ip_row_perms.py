"""Nested IP lists must carry per-object `permissions` so row Edit/Delete render.

Regression: the prefix/device `ips` actions serialized IPAddressSerializer
without request context, so `permissions` came back {change:false, delete:false}
for every row and the table's row-action buttons vanished (a 2-click edit).
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix
from core.models import Organization, Tenant


class NestedIpPermsTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_prefix_ips_include_object_permissions(self):
        r = self.client.get(f"/api/prefixes/{self.prefix.id}/ips/")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertTrue(rows)
        perms = rows[0]["permissions"]
        # Superuser → editable; the key point is these are True, not the
        # context-less {change:false, delete:false} that hid the row buttons.
        self.assertTrue(perms["change"])
        self.assertTrue(perms["delete"])

    def test_device_ips_include_object_permissions(self):
        dev = Device.objects.create(tenant=self.tenant, name="sw1")
        self.ip.assigned_device = dev
        self.ip.save()
        r = self.client.get(f"/api/devices/{dev.id}/ips/")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertTrue(rows)
        self.assertTrue(rows[0]["permissions"]["change"])
