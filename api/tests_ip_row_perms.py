"""Nested IP lists must carry per-object `permissions` so row Edit/Delete render.

Regression: the prefix/device `ips` actions serialized IPAddressSerializer
without request context, so `permissions` came back {change:false, delete:false}
for every row and the table's row-action buttons vanished (a 2-click edit).
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, Interface, IPAddress, Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
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


class InterfaceIpsTests(APITestCase):
    """/api/interfaces/<id>/ips/ backs the interface page's IPs tab: full IP
    rows for that one interface, filtered by the viewer's IP permissions."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site_a
        )
        self.eth0 = Interface.objects.create(device=self.dev, name="eth0")
        eth1 = Interface.objects.create(device=self.dev, name="eth1")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        # Created out of order: rows come back in address order, not text.
        self.ip10 = self._ip("10.0.0.10", self.eth0, self.site_a)
        self.ip9 = self._ip("10.0.0.9", self.eth0, self.site_b)
        self._ip("10.0.0.20", eth1, self.site_a)  # the sibling's
        self.dev.primary_ip = self.ip10
        self.dev.save()

    def _ip(self, addr, iface, site):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address=addr,
            site=site, assigned_interface=iface,
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _get(self):
        r = self.client.get(f"/api/interfaces/{self.eth0.id}/ips/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_lists_only_this_interfaces_ips_in_address_order(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "pw"))
        body = self._get()
        self.assertEqual(body["count"], 2)
        rows = body["results"]
        self.assertEqual(
            [r["ip_address"] for r in rows], ["10.0.0.9", "10.0.0.10"]
        )
        by_addr = {r["ip_address"]: r for r in rows}
        self.assertTrue(by_addr["10.0.0.10"]["is_primary_for_device"])
        self.assertFalse(by_addr["10.0.0.9"]["is_primary_for_device"])
        self.assertTrue(by_addr["10.0.0.10"]["permissions"]["change"])
        self.assertEqual(
            by_addr["10.0.0.10"]["assigned_interface"]["id"], str(self.eth0.id)
        )

    def test_rows_follow_the_viewers_ip_permissions(self):
        # Interfaces and IPs viewable in Site A only: the Site B address on
        # the same interface stays out of the rows and the count.
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=["interface", "ipaddress"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        self._login(user)
        body = self._get()
        self.assertEqual(body["count"], 1)
        (row,) = body["results"]
        self.assertEqual(row["ip_address"], "10.0.0.10")
        self.assertFalse(row["permissions"]["change"])
