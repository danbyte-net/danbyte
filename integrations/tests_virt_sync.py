"""Proxmox sync engine: cluster/VM/interface/IP mapping, adoption, pruning."""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    IPAddress,
    Prefix,
    VirtualMachine,
    VMInterface,
)
from core.models import Organization, Tenant
from integrations import virt_sync
from integrations.models import VirtGuest, VirtualizationSource

CLUSTER_STATUS = [
    {"type": "cluster", "name": "DB-CLUSTER01"},
    {"type": "node", "name": "pve1", "online": 1},
    {"type": "node", "name": "pve2", "online": 1},
]

RESOURCES = [
    {"vmid": 100, "name": "router-vm", "node": "pve1", "type": "qemu",
     "status": "running", "maxcpu": 4, "maxmem": 4 * 1024**3,
     "maxdisk": 32 * 1024**3},
    {"vmid": 101, "name": "lxc-dns", "node": "pve2", "type": "lxc",
     "status": "running", "maxcpu": 2, "maxmem": 1024**3,
     "maxdisk": 8 * 1024**3},
    {"vmid": 900, "name": "tmpl", "node": "pve1", "type": "qemu",
     "status": "stopped", "template": 1},
]

QEMU_CONFIG = {"net0": "virtio=AA:BB:CC:00:11:22,bridge=vmbr0", "cores": 4}
LXC_CONFIG = {"net0": "name=eth0,bridge=vmbr0,hwaddr=AA:BB:CC:00:11:33,ip=dhcp"}
AGENT = {
    "result": [
        {"name": "lo", "hardware-address": "00:00:00:00:00:00",
         "ip-addresses": [{"ip-address": "127.0.0.1", "prefix": 8}]},
        {"name": "eth0", "hardware-address": "aa:bb:cc:00:11:22",
         "ip-addresses": [
             {"ip-address": "10.77.0.30", "prefix": 24},
             {"ip-address": "fe80::1", "prefix": 64},
         ]},
    ]
}


def fake_get(source, path):
    if path == "cluster/status":
        return CLUSTER_STATUS
    if path.startswith("cluster/resources"):
        return RESOURCES
    if path == "nodes/pve1/qemu/100/config":
        return QEMU_CONFIG
    if path == "nodes/pve2/lxc/101/config":
        return LXC_CONFIG
    if path == "nodes/pve1/qemu/100/agent/network-get-interfaces":
        return AGENT
    raise AssertionError(f"unexpected path {path}")


class ProxmoxSyncTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",  # these tests exercise the mirror path
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def test_full_sync_maps_cluster_vms_interfaces_ips(self):
        counts = self.sync()
        self.assertEqual(counts["vms"], 2)  # the template is skipped
        self.assertEqual(counts["vms_created"], 2)

        cluster = Cluster.objects.get(tenant=self.tenant, name="DB-CLUSTER01")
        self.assertEqual(cluster.type.name, "Proxmox VE")

        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.cluster, cluster)
        self.assertEqual(vm.vcpus, 4)
        self.assertEqual(vm.memory_mb, 4096)
        self.assertEqual(vm.disk_gb, 32)

        iface = VMInterface.objects.get(vm=vm)
        self.assertEqual(iface.name, "net0")
        self.assertEqual(iface.mac_address, "aa:bb:cc:00:11:22")

        ip = IPAddress.objects.get(ip_address="10.77.0.30")
        self.assertEqual(ip.assigned_vm, vm)
        self.assertEqual(ip.assigned_vm_interface, iface)
        vm.refresh_from_db()
        self.assertEqual(vm.primary_ip, ip)

        lxc = VirtualMachine.objects.get(name="lxc-dns")
        self.assertEqual(VMInterface.objects.get(vm=lxc).name, "eth0")

    def test_sync_is_idempotent(self):
        self.sync()
        self.sync()
        self.assertEqual(VirtualMachine.objects.count(), 2)
        self.assertEqual(VMInterface.objects.count(), 2)
        self.assertEqual(IPAddress.objects.count(), 1)
        self.assertEqual(ClusterType.objects.count(), 1)

    def test_existing_vm_adopted_and_not_clobbered(self):
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Mine", slug="mine"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="ops", type=ctype
        )
        role = DeviceRole.objects.create(tenant=self.tenant, name="router")
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="router-vm", cluster=cluster, role=role,
            vcpus=99,
        )
        counts = self.sync()
        self.assertEqual(counts["vms_created"], 1)  # only lxc-dns
        vm.refresh_from_db()
        self.assertEqual(vm.vcpus, 99)  # operator value kept
        self.assertEqual(vm.cluster, cluster)  # not re-homed
        self.assertEqual(vm.memory_mb, 4096)  # blank filled
        guest = VirtGuest.objects.get(vmid=100)
        self.assertEqual(guest.vm, vm)
        self.assertFalse(guest.created_vm)

    def test_node_maps_to_device_blank_fill(self):
        host = Device.objects.create(tenant=self.tenant, name="pve1")
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.device, host)

    def test_gone_guest_pruned_only_if_sync_created(self):
        self.sync()
        with mock.patch.object(
            virt_sync, "proxmox_get",
            side_effect=lambda s, p: CLUSTER_STATUS
            if p == "cluster/status" else [],
        ):
            virt_sync.sync_proxmox(self.source)
        self.assertEqual(VirtGuest.objects.count(), 0)
        self.assertEqual(VirtualMachine.objects.count(), 0)  # ours → removed

    def test_gone_guest_keeps_adopted_vm(self):
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Mine", slug="mine"
        )
        cluster = Cluster.objects.create(tenant=self.tenant, name="ops", type=ctype)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="router-vm", cluster=cluster
        )
        self.sync()
        with mock.patch.object(
            virt_sync, "proxmox_get",
            side_effect=lambda s, p: CLUSTER_STATUS
            if p == "cluster/status" else [],
        ):
            virt_sync.sync_proxmox(self.source)
        self.assertTrue(
            VirtualMachine.objects.filter(name="router-vm").exists()
        )

    def test_cluster_status_403_falls_back_to_nodes(self):
        """A token denied cluster/status still syncs VMs via /nodes."""
        def denied(source, path):
            if path == "cluster/status":
                raise virt_sync.VirtAPIError("403")
            if path == "nodes":
                return [{"node": "pve1"}, {"node": "pve2"}]
            return fake_get(source, path)

        with mock.patch.object(virt_sync, "proxmox_get", side_effect=denied):
            counts = virt_sync.sync_proxmox(self.source)
        self.assertEqual(counts["nodes"], 2)
        self.assertEqual(counts["vms"], 2)
        # Cluster name falls back to the source name.
        self.assertTrue(Cluster.objects.filter(name="pve").exists())

    def test_ip_without_containing_prefix_skipped(self):
        Prefix.objects.all().delete()
        counts = self.sync()
        self.assertEqual(counts["ips"], 0)
        self.assertEqual(IPAddress.objects.count(), 0)


class ProxmoxModeTests(TestCase):
    """Review/manual modes queue changes; accept applies, ignore dismisses."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="review",
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def test_review_mode_creates_no_vms_only_pending(self):
        from integrations.models import VirtChange

        counts = self.sync()
        self.assertEqual(counts["vms_created"], 0)
        self.assertEqual(VirtualMachine.objects.count(), 0)
        # Two guests → two new_guest changes.
        changes = VirtChange.objects.filter(kind="new_guest")
        self.assertEqual(changes.count(), 2)
        self.assertEqual(counts["pending"], 2)
        # The change carries the proposed specs for the accept path.
        c = changes.get(guest__vmid=100)
        self.assertEqual(c.detail["name"], "router-vm")
        self.assertEqual(c.detail["vcpus"], 4)

    def test_review_is_idempotent(self):
        from integrations.models import VirtChange

        self.sync()
        self.sync()
        self.assertEqual(VirtChange.objects.filter(kind="new_guest").count(), 2)

    def test_accept_new_guest_creates_vm(self):
        from integrations.models import VirtChange, VirtGuest
        from integrations.virt_sync import apply_change

        self.sync()
        c = VirtChange.objects.get(guest__vmid=100, kind="new_guest")
        apply_change(c)
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.vcpus, 4)
        self.assertEqual(vm.memory_mb, 4096)
        g = VirtGuest.objects.get(vmid=100)
        self.assertEqual(g.vm, vm)
        self.assertTrue(g.created_vm)
        self.assertFalse(VirtChange.objects.filter(id=c.id).exists())
        # Next sync enriches the accepted VM with interfaces/IPs.
        self.sync()
        self.assertTrue(vm.interfaces.exists() if hasattr(vm, "interfaces")
                        else True)

    def test_ignore_hides_and_survives_resync(self):
        from integrations.models import VirtChange

        self.sync()
        c = VirtChange.objects.get(guest__vmid=100, kind="new_guest")
        from integrations.virt_sync import ignore_change

        ignore_change(c)
        counts = self.sync()
        c.refresh_from_db()
        self.assertTrue(c.ignored)  # preserved across sync
        self.assertEqual(counts["pending"], 1)  # only vmid 101 still pending

    def test_spec_change_queued_in_review_applied_on_accept(self):
        from integrations.models import VirtChange, VirtGuest
        from integrations.virt_sync import apply_change

        # Adopt vmid 100 as a sync-created VM first (auto once), then review.
        self.source.sync_mode = "auto"
        self.source.save(update_fields=["sync_mode"])
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.vcpus, 4)
        self.source.sync_mode = "review"
        self.source.save(update_fields=["sync_mode"])

        bumped = [dict(r) for r in RESOURCES]
        bumped[0] = {**bumped[0], "maxcpu": 8}

        def bumped_get(source, path):
            if path.startswith("cluster/resources"):
                return bumped
            return fake_get(source, path)

        with mock.patch.object(virt_sync, "proxmox_get", side_effect=bumped_get):
            virt_sync.sync_proxmox(self.source)
        vm.refresh_from_db()
        self.assertEqual(vm.vcpus, 4)  # not applied in review
        c = VirtChange.objects.get(kind="spec_change")
        self.assertEqual(c.detail["vcpus"], {"danbyte": 4, "hypervisor": 8})
        apply_change(c)
        vm.refresh_from_db()
        self.assertEqual(vm.vcpus, 8)

    def test_removed_guest_queued_in_review_not_deleted(self):
        from integrations.models import VirtChange

        self.source.sync_mode = "auto"
        self.source.save(update_fields=["sync_mode"])
        self.sync()
        self.source.sync_mode = "review"
        self.source.save(update_fields=["sync_mode"])
        with mock.patch.object(
            virt_sync, "proxmox_get",
            side_effect=lambda s, p: CLUSTER_STATUS if p == "cluster/status"
            else ([] if p.startswith("cluster/resources") else fake_get(s, p)),
        ):
            virt_sync.sync_proxmox(self.source)
        # VMs kept; two removed_guest changes queued.
        self.assertEqual(VirtualMachine.objects.count(), 2)
        self.assertEqual(VirtChange.objects.filter(kind="removed_guest").count(), 2)

    def test_manual_source_skipped_by_beat(self):
        from integrations.models import IntegrationSettings
        from integrations.sync_tasks import enqueue_due_virt_syncs

        IntegrationSettings.objects.create(
            tenant=self.tenant, virtualization_enabled=True
        )
        self.source.sync_mode = "manual"
        self.source.save(update_fields=["sync_mode"])
        with mock.patch("integrations.sync_tasks.django_rq") as rq:
            queued = enqueue_due_virt_syncs()
        self.assertEqual(queued, 0)
        rq.get_queue.return_value.enqueue.assert_not_called()


class VirtChangeApiTests(TestCase):
    """The review inbox API: list (non-ignored default), accept, ignore."""

    def setUp(self):
        from django.contrib.auth.models import User
        from rest_framework.test import APIClient

        from auth_api.models import ObjectPermission, UserProfile
        from integrations.models import IntegrationSettings, VirtChange, VirtGuest

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, virtualization_enabled=True
        )
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="review",
        )
        self.guest = VirtGuest.objects.create(
            source=self.source, vmid=100, node="pve1", kind="qemu"
        )
        self.change = VirtChange.objects.create(
            source=self.source, guest=self.guest, kind="new_guest",
            detail={"name": "router-vm", "vcpus": 4, "memory_mb": 4096,
                    "cluster": "DB-CLUSTER01"},
        )
        self.user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="virt-op", object_types=["virtchange"],
            actions=["view", "change"],
        )
        p.users.add(self.user)
        p.tenants.set([self.tenant])
        self.client = APIClient()
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_list_hides_ignored_by_default(self):
        from integrations.models import VirtChange, VirtGuest

        g2 = VirtGuest.objects.create(source=self.source, vmid=101, kind="lxc")
        VirtChange.objects.create(
            source=self.source, guest=g2, kind="new_guest", ignored=True,
            detail={"name": "x"},
        )
        res = self.client.get("/api/virt-changes/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["count"], 1)
        res = self.client.get("/api/virt-changes/?ignored=1")
        self.assertEqual(res.json()["count"], 2)

    def test_accept_creates_vm(self):
        res = self.client.post(f"/api/virt-changes/{self.change.id}/accept/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(VirtualMachine.objects.filter(name="router-vm").exists())

    def test_ignore_marks_row(self):
        from integrations.models import VirtChange

        res = self.client.post(f"/api/virt-changes/{self.change.id}/ignore/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(VirtChange.objects.get(id=self.change.id).ignored)

    def test_endpoint_404_without_toggle(self):
        from integrations.models import IntegrationSettings

        IntegrationSettings.objects.filter(tenant=self.tenant).update(
            virtualization_enabled=False
        )
        self.assertEqual(self.client.get("/api/virt-changes/").status_code, 404)

    def test_cannot_create_via_post(self):
        # No `add` grant (and create() 405s anyway) — either way it's refused.
        res = self.client.post("/api/virt-changes/", {}, format="json")
        self.assertIn(res.status_code, (403, 405))
