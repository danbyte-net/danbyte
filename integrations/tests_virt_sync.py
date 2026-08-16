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
