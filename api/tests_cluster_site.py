"""Opt-in: give a cluster's site to the VMs on it.

A cluster's site describes the cluster, so it is deliberately NOT inherited —
central compute often runs branch-office workloads (#34). Ticking
``apply_site_to_vms`` blank-fills it instead, and a site an operator set on a VM
is never overwritten.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Cluster, ClusterType, Site, VirtualMachine
from core.models import Organization, Tenant


class ClusterSiteInheritanceTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dc = Site.objects.create(tenant=self.tenant, name="DC1")
        self.branch = Site.objects.create(
            tenant=self.tenant, name="Branch"
        )
        self.ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Proxmox VE", slug="proxmox-ve"
        )
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="cl1", type=self.ctype, site=self.dc
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _vm(self, name, **kw):
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster, **kw
        )

    def test_off_by_default_site_is_not_inherited(self):
        vm = self._vm("vm1")
        self.assertFalse(self.cluster.apply_site_to_vms)
        self.assertIsNone(vm.site_id)
        # Saving the cluster changes nothing while the toggle is off.
        r = self.client.patch(
            f"/api/clusters/{self.cluster.id}/",
            {"site_id": str(self.dc.id)}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        vm.refresh_from_db()
        self.assertIsNone(vm.site_id)

    def test_ticking_it_backfills_vms_without_a_site(self):
        blank = self._vm("blank")
        owned = self._vm("owned", site=self.branch)
        r = self.client.patch(
            f"/api/clusters/{self.cluster.id}/",
            {"apply_site_to_vms": True}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        blank.refresh_from_db()
        owned.refresh_from_db()
        self.assertEqual(blank.site_id, self.dc.id)
        # A site the operator chose is never overwritten.
        self.assertEqual(owned.site_id, self.branch.id)

    def test_new_vm_on_an_opted_in_cluster_gets_the_site(self):
        self.cluster.apply_site_to_vms = True
        self.cluster.save(update_fields=["apply_site_to_vms"])
        r = self.client.post(
            "/api/virtual-machines/",
            {"name": "fresh", "cluster_id": str(self.cluster.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            VirtualMachine.objects.get(name="fresh").site_id, self.dc.id
        )

    def test_explicit_site_wins_on_create(self):
        self.cluster.apply_site_to_vms = True
        self.cluster.save(update_fields=["apply_site_to_vms"])
        r = self.client.post(
            "/api/virtual-machines/",
            {"name": "pinned", "cluster_id": str(self.cluster.id),
             "site_id": str(self.branch.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            VirtualMachine.objects.get(name="pinned").site_id, self.branch.id
        )

    def test_clearing_the_cluster_site_leaves_vms_alone(self):
        self.cluster.apply_site_to_vms = True
        self.cluster.save(update_fields=["apply_site_to_vms"])
        vm = self._vm("vm1")
        self.client.patch(
            f"/api/clusters/{self.cluster.id}/",
            {"apply_site_to_vms": True}, format="json",
        )
        vm.refresh_from_db()
        self.assertEqual(vm.site_id, self.dc.id)
        # Blank-fill only: removing the cluster's site doesn't unset the VMs'.
        r = self.client.patch(
            f"/api/clusters/{self.cluster.id}/", {"site_id": None}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        vm.refresh_from_db()
        self.assertEqual(vm.site_id, self.dc.id)

    def test_sync_blank_fills_the_site_when_opted_in(self):
        """The hypervisor sync uses the same rule via its blank-fill path."""
        from integrations.models import VirtGuest, VirtualizationSource
        from integrations.virt_sync import _blank_fill

        self.cluster.apply_site_to_vms = True
        self.cluster.save(update_fields=["apply_site_to_vms"])
        source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
        )
        vm = self._vm("synced")
        guest = VirtGuest.objects.create(
            source=source, vmid=100, kind="qemu", vm=vm, created_vm=True
        )
        _blank_fill(vm, {}, source, guest)
        vm.refresh_from_db()
        self.assertEqual(vm.site_id, self.dc.id)
