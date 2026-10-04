"""Nested IP lists must carry per-object `permissions` so row Edit/Delete render.

Regression: the prefix/device `ips` actions serialized IPAddressSerializer
without request context, so `permissions` came back {change:false, delete:false}
for every row and the table's row-action buttons vanished (a 2-click edit).
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import (
    VLAN,
    VRF,
    Device,
    Interface,
    IPAddress,
    IPRole,
    Prefix,
    Site,
    VirtualChassis,
    Zone,
)
from api.test_utils import status_for
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


class NestedIpQueryCountTests(APITestCase):
    """The device and interface IP tabs cost the same number of queries for
    one row as for many: every relation a row serializes is joined."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=t, name="HQ")
        zone = Zone.objects.create(tenant=t, name="dmz", slug="dmz")
        vlan = VLAN.objects.create(tenant=t, vlan_id=10, name="v10", zone=zone)
        vrf = VRF.objects.create(tenant=t, name="blue")
        self.prefix = Prefix.objects.create(
            tenant=t, cidr="10.0.0.0/24", site=site, vlan=vlan, vrf=vrf
        )
        self.role = IPRole.objects.create(tenant=t, name="loop", slug="loop")
        self.status = status_for(t)
        vc = VirtualChassis.objects.create(tenant=t, name="stack1")
        switch = Device.objects.create(
            tenant=t, name="sw1", site=site, virtual_chassis=vc, vc_position=1
        )
        self.uplink = Interface.objects.create(device=switch, name="Gi1/0/1")
        self.dev = Device.objects.create(tenant=t, name="host1", site=site)
        self.eth0 = Interface.objects.create(device=self.dev, name="eth0")
        self.host = 1
        self._add(1)
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(t.id)
        s.save()

    def _add(self, n):
        for _ in range(n):
            self.host += 1
            IPAddress.objects.create(
                tenant=self.tenant, prefix=self.prefix,
                ip_address=f"10.0.0.{self.host}", site=self.prefix.site,
                status=self.status, role=self.role,
                assigned_interface=self.eth0, switch_interface=self.uplink,
            )

    def _queries(self, url):
        self.client.get(url)  # the first request pays one-off lookups
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()

    def _assert_flat(self, url):
        one, _ = self._queries(url)
        self._add(5)
        many, body = self._queries(url)
        self.assertEqual(len(body["results"]), 6)
        self.assertEqual(one, many, "more rows must not cost more queries")
        row = body["results"][0]
        self.assertEqual(row["switch_interface"]["virtual_chassis"]["name"], "stack1")
        self.assertEqual(row["prefix"]["vlan"]["zone"]["name"], "dmz")
        self.assertEqual(row["assigned_interface"]["device"]["name"], "host1")

    def test_device_ips_cost_is_flat(self):
        self._assert_flat(f"/api/devices/{self.dev.id}/ips/")

    def test_interface_ips_cost_is_flat(self):
        self._assert_flat(f"/api/interfaces/{self.eth0.id}/ips/")

    def test_device_ips_stay_in_the_devices_tenant(self):
        # An address in another tenant pointing at this device is not its row.
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        stray_prefix = Prefix.objects.create(tenant=other, cidr="10.9.0.0/24")
        IPAddress.objects.create(
            tenant=other, prefix=stray_prefix, ip_address="10.9.0.1",
            assigned_device=self.dev,
        )
        r = self.client.get(f"/api/devices/{self.dev.id}/ips/")
        self.assertEqual(r.status_code, 200, r.content)
        addrs = [row["ip_address"] for row in r.json()["results"]]
        self.assertEqual(addrs, ["10.0.0.2"])
