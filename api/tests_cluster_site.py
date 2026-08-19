"""Opt-in: give a cluster's site to the VMs on it.

A cluster's site describes the cluster, so it is deliberately NOT inherited -
central compute often runs branch-office workloads (#34). Ticking
``apply_site_to_vms`` blank-fills it instead, and a site an operator set on a VM
is never overwritten.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
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


class VMInterfaceIpAssignmentTests(APITestCase):
    """An IP can be assigned to a VM interface, not only to a device (#36).

    The model and API always allowed it; the UI had no path, so these lock the
    contract the new pickers write against.
    """

    def setUp(self):
        from api.models import Prefix

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Proxmox VE", slug="proxmox-ve"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="cl1", type=ctype
        )
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cluster
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.60.0.0/24"
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _iface(self, name="eth0"):
        r = self.client.post(
            "/api/vm-interfaces/",
            {"vm_id": str(self.vm.id), "name": name}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["id"]

    def test_create_ip_on_a_vm_interface(self):
        iface = self._iface()
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "10.60.0.10", "prefix_id": str(self.prefix.id),
             "assigned_vm_id": str(self.vm.id),
             "assigned_vm_interface_id": iface},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["assigned_vm"]["id"], str(self.vm.id))
        self.assertEqual(body["assigned_vm_interface"]["id"], iface)
        # …and the interface reports it, which is what the pane renders.
        listing = self.client.get(f"/api/vm-interfaces/?vm={self.vm.id}")
        row = next(i for i in listing.json()["results"] if i["id"] == iface)
        self.assertEqual(
            [ip["ip_address"] for ip in row["ip_addresses"]], ["10.60.0.10"]
        )

    def test_assign_an_existing_ip_to_a_vm_interface(self):
        iface = self._iface("eth1")
        created = self.client.post(
            "/api/ips/",
            {"ip_address": "10.60.0.20", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(created.status_code, 201, created.content)
        ip_id = created.json()["id"]
        r = self.client.patch(
            f"/api/ips/{ip_id}/",
            {"assigned_vm_id": str(self.vm.id),
             "assigned_vm_interface_id": iface},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["assigned_vm_interface"]["id"], iface)

    def test_vm_level_assignment_without_an_interface(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "10.60.0.30", "prefix_id": str(self.prefix.id),
             "assigned_vm_id": str(self.vm.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["assigned_vm"]["id"], str(self.vm.id))
        self.assertIsNone(r.json()["assigned_vm_interface"])


class VmPowerStateTests(APITestCase):
    """The hypervisor's power state, surfaced without touching Status (#34).

    `status` is the operator's lifecycle field (staged/active/decommissioning);
    power state is the hypervisor's and it is reported separately. Writing one
    into the other would be actively wrong: `resolve_status` falls back to
    `active` for any unknown value, so "powered-off" would mark the VM Active.
    """

    def setUp(self):
        from api.models import Cluster, ClusterType

        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="VMware vCenter", slug="vmware-vcenter"
        )
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="cl1", type=ctype
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _vm(self, name):
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster
        )

    def _guest(self, vm, power):
        from django.utils import timezone

        from integrations.models import VirtGuest, VirtualizationSource

        source, _ = VirtualizationSource.objects.get_or_create(
            tenant=self.tenant, name="vc", defaults={
                "kind": "vcenter", "host": "192.0.2.20",
                "credentials": {"username": "u", "password": "p"},
            },
        )
        return VirtGuest.objects.create(
            source=source, vmid=abs(hash(vm.name)) % 10000, kind="vmware",
            vm=vm, power_state=power, last_seen_at=timezone.now(),
        )

    def test_power_state_is_reported(self):
        vm = self._vm("web01")
        self._guest(vm, "running")
        r = self.client.get(f"/api/virtual-machines/{vm.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["power_state"], "running")
        self.assertIsNotNone(r.json()["power_state_at"])

    def test_a_hand_made_vm_reports_no_power_state(self):
        """Nothing tracks it, so the field is null rather than a guess."""
        vm = self._vm("manual")
        r = self.client.get(f"/api/virtual-machines/{vm.id}/")
        self.assertIsNone(r.json()["power_state"])
        self.assertIsNone(r.json()["power_state_at"])

    def test_power_state_never_touches_status(self):
        vm = self._vm("off01")
        self._guest(vm, "stopped")
        self.client.get(f"/api/virtual-machines/{vm.id}/")
        vm.refresh_from_db()
        self.assertIsNone(vm.status_id, "power state leaked into lifecycle status")

    def test_it_is_read_only(self):
        vm = self._vm("web02")
        self._guest(vm, "running")
        r = self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"power_state": "stopped"}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["power_state"], "running")

    def test_the_list_endpoint_can_filter_by_power(self):
        self._guest(self._vm("on01"), "running")
        self._guest(self._vm("off02"), "stopped")
        r = self.client.get("/api/virtual-machines/?power=stopped")
        names = [v["name"] for v in r.json()["results"]]
        self.assertEqual(names, ["off02"])

    def test_the_list_costs_no_extra_query_per_vm(self):
        """The whole point of annotating instead of walking the relation.

        A SerializerMethodField reaching through `virt_guests` would add one
        query per row; the count must not grow with the number of VMs.
        """
        self._guest(self._vm("one"), "running")
        with CaptureQueriesContext(connection) as first:
            self.client.get("/api/virtual-machines/")
        for i in range(4):
            self._guest(self._vm(f"more{i}"), "running")
        with CaptureQueriesContext(connection) as second:
            r = self.client.get("/api/virtual-machines/")
        self.assertEqual(len(r.json()["results"]), 5)
        self.assertEqual(len(second.captured_queries), len(first.captured_queries))
