"""A VM's primary IP reads back off the address (#122).

The VM model has carried ``primary_ip`` all along, but the address serializer
only reported ``is_primary_for_device`` - so the IP form had no way to know a
VM-assigned address was its VM's primary, and offered no box to set it.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cluster, ClusterType, IPAddress, Prefix, VirtualMachine

User = get_user_model()


class VMPrimaryIPTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        ct = ClusterType.objects.create(tenant=self.tenant, name="proxmox")
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="cl1", type=ct
        )
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cluster
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.250.121.0/24"
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix,
            ip_address="10.250.121.128", assigned_vm=self.vm,
        )

    def _ip(self):
        r = self.client.get(f"/api/ips/{self.ip.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_unset_reads_false(self):
        self.assertFalse(self._ip()["is_primary_for_vm"])

    def test_setting_it_on_the_vm_reads_back_on_the_address(self):
        r = self.client.patch(
            f"/api/virtual-machines/{self.vm.id}/",
            {"primary_ip_id": str(self.ip.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(self._ip()["is_primary_for_vm"])
        # A VM's primary is not a device's - the two flags stay independent.
        self.assertFalse(self._ip()["is_primary_for_device"])

    def test_clearing_it_reads_back_false(self):
        self.vm.primary_ip = self.ip
        self.vm.save(update_fields=["primary_ip"])
        r = self.client.patch(
            f"/api/virtual-machines/{self.vm.id}/",
            {"primary_ip_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(self._ip()["is_primary_for_vm"])

    def test_an_unassigned_address_is_nobodys_primary(self):
        loose = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.250.121.9"
        )
        r = self.client.get(f"/api/ips/{loose.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["is_primary_for_vm"])
