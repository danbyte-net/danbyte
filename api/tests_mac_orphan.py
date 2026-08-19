"""Deleting an interface must not deadlock on the MAC uniqueness constraint.

``MACAddress.assigned_interface`` is SET_NULL so a MAC survives the port that
bore it, but ``uniq_macaddress_tenant_addr_iface`` is ``nulls_distinct=False``
- only one unassigned row per (tenant, address). Orphaning a MAC that already
exists unassigned used to raise IntegrityError, surfacing as a 409 the user
could never get past.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Device, DeviceRole, DeviceType, Interface, MACAddress, Manufacturer, Site,
)
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant

MAC = "08:94:ef:00:dd:cc"


class MacOrphanOnInterfaceDeleteTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Lenovo", slug="lenovo")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="x3650")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Server", slug="server")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="srv1", device_type=dt, site=site,
            role=role, status=status_for(self.tenant),
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _iface(self, name: str) -> Interface:
        return Interface.objects.create(device=self.dev, name=name)

    def test_delete_drops_mac_that_already_exists_unassigned(self):
        """The reported case: discovery left both an assigned and a free row."""
        MACAddress.objects.create(tenant=self.tenant, mac_address=MAC)
        iface = self._iface("eth0")
        MACAddress.objects.create(
            tenant=self.tenant, mac_address=MAC, assigned_interface=iface
        )

        resp = self.client.delete(f"/api/interfaces/{iface.id}/")

        self.assertEqual(resp.status_code, 204, resp.content)
        self.assertFalse(Interface.objects.filter(pk=iface.pk).exists())
        # The address stays on file exactly once, unassigned.
        remaining = MACAddress.objects.filter(tenant=self.tenant, mac_address=MAC)
        self.assertEqual(remaining.count(), 1)
        self.assertIsNone(remaining.get().assigned_interface_id)

    def test_delete_keeps_a_mac_with_no_unassigned_twin(self):
        """SET_NULL semantics still hold - the MAC outlives its port."""
        iface = self._iface("eth0")
        MACAddress.objects.create(
            tenant=self.tenant, mac_address=MAC, assigned_interface=iface
        )

        resp = self.client.delete(f"/api/interfaces/{iface.id}/")

        self.assertEqual(resp.status_code, 204, resp.content)
        mac = MACAddress.objects.get(tenant=self.tenant, mac_address=MAC)
        self.assertIsNone(mac.assigned_interface_id)

    def test_bulk_delete_of_two_interfaces_sharing_one_mac(self):
        """Both rows would orphan to NULL and collide with each other."""
        a, b = self._iface("eth0"), self._iface("eth1")
        for iface in (a, b):
            MACAddress.objects.create(
                tenant=self.tenant, mac_address=MAC, assigned_interface=iface
            )

        resp = self.client.post(
            "/api/interfaces/bulk-delete/",
            {"ids": [str(a.id), str(b.id)]},
            format="json",
        )

        self.assertIn(resp.status_code, (200, 204), resp.content)
        self.assertEqual(Interface.objects.filter(device=self.dev).count(), 0)
        remaining = MACAddress.objects.filter(tenant=self.tenant, mac_address=MAC)
        self.assertEqual(remaining.count(), 1)
        self.assertIsNone(remaining.get().assigned_interface_id)

    def test_device_delete_cascades_without_colliding(self):
        """Interfaces vanish via cascade, which fires the same receiver."""
        MACAddress.objects.create(tenant=self.tenant, mac_address=MAC)
        iface = self._iface("eth0")
        MACAddress.objects.create(
            tenant=self.tenant, mac_address=MAC, assigned_interface=iface
        )

        self.dev.delete()

        remaining = MACAddress.objects.filter(tenant=self.tenant, mac_address=MAC)
        self.assertEqual(remaining.count(), 1)
        self.assertIsNone(remaining.get().assigned_interface_id)
