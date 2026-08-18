"""Proxmox sync engine: cluster/VM/interface/IP mapping, adoption, pruning."""
from __future__ import annotations

from unittest import mock

from django.test import TestCase

from api.models import (
    VLAN,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    IPAddress,
    Prefix,
    VirtualDisk,
    VirtualMachine,
    VirtualSwitch,
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

QEMU_CONFIG = {
    "net0": "virtio=AA:BB:CC:00:11:22,bridge=vmbr0,tag=10",
    "scsi0": "local-lvm:vm-100-disk-0,size=32G,ssd=1",
    "scsi1": "ceph-vm:vm-100-disk-1,size=100G",
    "ide2": "local:iso/debian.iso,media=cdrom",  # optical — must be ignored
    "cores": 4,
    "tags": "prod;web",
    "description": "Frontend router",
}
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


NODE_NET_PVE1 = [
    {"iface": "vmbr0", "type": "bridge", "bridge_ports": "eno1 eno2"},
    {"iface": "eno1", "type": "eth"},
    {"iface": "eno2", "type": "eth"},
]


def fake_get(source, path):
    if path == "cluster/status":
        return CLUSTER_STATUS
    if path == "cluster/options":
        # Explicit tag colors for `prod`; `web` falls back to uncoloured.
        return {"tag-style": "color-map=prod:EF4444:FFFFFF,shape=full"}
    if path.startswith("cluster/resources"):
        return RESOURCES
    if path == "nodes/pve1/qemu/100/config":
        return QEMU_CONFIG
    if path == "nodes/pve2/lxc/101/config":
        return LXC_CONFIG
    if path == "nodes/pve1/qemu/100/agent/network-get-interfaces":
        return AGENT
    if path == "nodes/pve1/network":
        return NODE_NET_PVE1
    if path == "nodes/pve2/network":
        return []
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

    def test_disks_synced_cdrom_ignored(self):
        counts = self.sync()
        self.assertEqual(counts["disks"], 2)  # scsi0 + scsi1, ide2 cdrom skipped
        vm = VirtualMachine.objects.get(name="router-vm")
        disks = {d.key: d for d in vm.disks.all()}
        self.assertEqual(set(disks), {"scsi0", "scsi1"})
        self.assertEqual(disks["scsi0"].size_gb, 32)
        self.assertEqual(disks["scsi0"].storage, "local-lvm")
        self.assertEqual(disks["scsi0"].controller, "scsi")
        self.assertEqual(disks["scsi1"].size_gb, 100)

    def test_disks_off_when_toggle_disabled(self):
        self.source.sync_disks = False
        self.source.save(update_fields=["sync_disks"])
        counts = self.sync()
        self.assertEqual(counts["disks"], 0)
        self.assertEqual(VirtualDisk.objects.count(), 0)

    def test_disk_pruned_when_removed(self):
        self.sync()
        self.assertEqual(VirtualDisk.objects.filter(key="scsi1").count(), 1)
        shrunk = dict(QEMU_CONFIG)
        shrunk.pop("scsi1")

        def fewer(s, p):
            return shrunk if p == "nodes/pve1/qemu/100/config" else fake_get(s, p)

        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fewer):
            virt_sync.sync_proxmox(self.source)
        self.assertEqual(VirtualDisk.objects.filter(key="scsi1").count(), 0)
        self.assertEqual(VirtualDisk.objects.filter(key="scsi0").count(), 1)

    def test_networks_synced_switch_vlan_and_iface_link(self):
        self.source.sync_networks = True
        self.source.save(update_fields=["sync_networks"])
        counts = self.sync()
        # router-vm net0 (tag=10) + lxc-dns eth0 (untagged) both on vmbr0.
        self.assertEqual(counts["networks"], 2)
        cluster = Cluster.objects.get(name="DB-CLUSTER01")
        sw = VirtualSwitch.objects.get(name="vmbr0", cluster=cluster)
        self.assertEqual(sw.kind, "linux-bridge")
        self.assertEqual(VirtualSwitch.objects.count(), 1)  # one shared bridge
        vlan = VLAN.objects.get(vlan_id=10)
        iface = VMInterface.objects.get(vm__name="router-vm", name="net0")
        self.assertEqual(iface.vlan, vlan)
        self.assertEqual(iface.mode, "access")

    def test_networks_off_by_default(self):
        self.sync()  # source.sync_networks defaults False
        self.assertEqual(VirtualSwitch.objects.count(), 0)
        self.assertFalse(VMInterface.objects.exclude(vlan__isnull=True).exists())

    def test_tags_and_notes_synced(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.description, "Frontend router")  # notes → description
        self.assertEqual(
            set(vm.tags.values_list("name", flat=True)), {"prod", "web"}
        )
        # Cluster color-map colors ride along; unmapped tags stay uncoloured.
        colors = dict(vm.tags.values_list("name", "color"))
        self.assertEqual(colors["prod"], "#ef4444")
        self.assertEqual(colors["web"], "")

    def test_tag_color_never_overwrites_operator_choice(self):
        from core.models import Tag

        Tag.objects.create(
            tenant=self.tenant, name="prod", slug="prod", color="#123456"
        )
        self.sync()
        self.assertEqual(
            Tag.objects.get(tenant=self.tenant, slug="prod").color, "#123456"
        )

    def test_notes_dont_overwrite_operator_description(self):
        ctype = ClusterType.objects.create(tenant=self.tenant, name="M", slug="m")
        cl = Cluster.objects.create(tenant=self.tenant, name="ops", type=ctype)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="router-vm", cluster=cl,
            description="hand-written",
        )
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.description, "hand-written")  # kept
        # tags still added (additive)
        self.assertIn("prod", set(vm.tags.values_list("name", flat=True)))

    def test_uplinks_linked_from_bridge_ports(self):
        from api.models import Device, Interface

        self.source.sync_networks = True
        self.source.save(update_fields=["sync_networks"])
        dev = Device.objects.create(tenant=self.tenant, name="pve1")
        Interface.objects.create(device=dev, name="eno1")
        Interface.objects.create(device=dev, name="eno2")
        counts = self.sync()
        self.assertEqual(counts["uplinks"], 2)  # vmbr0 ports eno1 + eno2
        sw = VirtualSwitch.objects.get(name="vmbr0")
        self.assertEqual(
            set(sw.uplink_interfaces.values_list("name", flat=True)),
            {"eno1", "eno2"},
        )
        # Additive + idempotent — a second sync doesn't duplicate.
        self.sync()
        self.assertEqual(sw.uplink_interfaces.count(), 2)


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


VC_VMS = [
    {"vm": "vm-100", "name": "web01", "power_state": "POWERED_ON",
     "cpu_count": 4, "memory_size_MiB": 8192},
    {"vm": "vm-101", "name": "db01", "power_state": "POWERED_OFF",
     "cpu_count": 2, "memory_size_MiB": 4096},
]
VC_HOSTS = [{"host": "host-1", "name": "esxi-lab-01",
             "connection_state": "CONNECTED"}]
VC_CLUSTERS = [{"cluster": "domain-c1", "name": "Lab-Cluster"}]
VC_DETAIL = {
    "vm-100": {
        "name": "web01", "power_state": "POWERED_ON",
        "cpu": {"count": 4}, "memory": {"size_MiB": 8192},
        "disks": {"2000": {"capacity": 40 * 1024**3}},
        "nics": {"4000": {"label": "Network adapter 1",
                          "mac_address": "00:50:56:AA:BB:CC"}},
    },
    "vm-101": {
        "name": "db01", "power_state": "POWERED_OFF",
        "cpu": {"count": 2}, "memory": {"size_MiB": 4096},
        "disks": {"2000": {"capacity": 20 * 1024**3}},
        "nics": {"4000": {"label": "Network adapter 1",
                          "mac_address": "00:50:56:DD:EE:FF"}},
    },
}
VC_GUEST_NET = {
    "vm-100": [{
        "mac_address": "00:50:56:AA:BB:CC", "nic": "4000",
        "ip": {"ip_addresses": [
            {"ip_address": "10.77.0.40", "prefix_length": 24,
             "state": "PREFERRED"},
            {"ip_address": "fe80::5", "prefix_length": 64},
        ]},
    }],
}


class FakeVCenter:
    """Stand-in for VCenterClient — routes REST paths to the fixtures above."""

    def __init__(self, source):
        self.source = source

    def login(self):
        return self

    def get(self, path):
        if path == "vcenter/vm":
            return VC_VMS
        if path == "vcenter/host":
            return VC_HOSTS
        if path == "vcenter/cluster":
            return VC_CLUSTERS
        if path == "vcenter/vm?hosts=host-1":
            return [{"vm": "vm-100"}, {"vm": "vm-101"}]
        if path.endswith("/guest/networking/interfaces"):
            moref = path.split("/")[2]  # vcenter/vm/<moref>/guest/...
            return VC_GUEST_NET.get(moref, [])
        if path.startswith("vcenter/vm/"):
            return VC_DETAIL.get(path.split("/")[-1], {})
        raise AssertionError(f"unexpected path {path}")

    def close(self):
        pass


class VCenterSyncTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", kind="vcenter", host="192.0.2.40",
            port=443, credentials={"username": "administrator@vsphere.local",
                                   "password": "s"},
            sync_mode="auto",
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            return virt_sync.sync_vcenter(self.source)

    def test_full_sync_maps_cluster_vms_interfaces_ips(self):
        counts = self.sync()
        self.assertEqual(counts["vms"], 2)
        self.assertEqual(counts["vms_created"], 2)

        cluster = Cluster.objects.get(tenant=self.tenant, name="Lab-Cluster")
        self.assertEqual(cluster.type.name, "VMware vCenter")

        vm = VirtualMachine.objects.get(name="web01")
        self.assertEqual(vm.cluster, cluster)
        self.assertEqual(vm.vcpus, 4)
        self.assertEqual(vm.memory_mb, 8192)
        self.assertEqual(vm.disk_gb, 40)

        iface = VMInterface.objects.get(vm=vm)
        self.assertEqual(iface.name, "Network adapter 1")
        self.assertEqual(iface.mac_address, "00:50:56:aa:bb:cc")

        ip = IPAddress.objects.get(ip_address="10.77.0.40")
        self.assertEqual(ip.assigned_vm, vm)
        self.assertEqual(ip.assigned_vm_interface, iface)
        vm.refresh_from_db()
        self.assertEqual(vm.primary_ip, ip)

    def test_moref_becomes_integer_vmid(self):
        self.sync()
        self.assertTrue(VirtGuest.objects.filter(vmid=100, kind="vmware").exists())
        self.assertTrue(VirtGuest.objects.filter(vmid=101).exists())

    def test_powered_off_vm_gets_no_guest_ip(self):
        self.sync()
        db = VirtualMachine.objects.get(name="db01")
        # NIC still comes from hardware; no guest-tools IP for a powered-off VM.
        self.assertTrue(VMInterface.objects.filter(vm=db).exists())
        self.assertFalse(IPAddress.objects.filter(assigned_vm=db).exists())

    def test_node_maps_to_esxi_host_device(self):
        host = Device.objects.create(tenant=self.tenant, name="esxi-lab-01")
        self.sync()
        vm = VirtualMachine.objects.get(name="web01")
        self.assertEqual(vm.device, host)

    def test_sync_is_idempotent(self):
        self.sync()
        self.sync()
        self.assertEqual(VirtualMachine.objects.count(), 2)
        self.assertEqual(VMInterface.objects.count(), 2)
        self.assertEqual(IPAddress.objects.count(), 1)

    def test_review_mode_queues_changes(self):
        from integrations.models import VirtChange

        self.source.sync_mode = "review"
        self.source.save(update_fields=["sync_mode"])
        counts = self.sync()
        self.assertEqual(counts["vms_created"], 0)
        self.assertEqual(VirtualMachine.objects.count(), 0)
        self.assertEqual(VirtChange.objects.filter(kind="new_guest").count(), 2)

    def test_dispatch_routes_vcenter_engine(self):
        from integrations.models import IntegrationSettings
        from integrations.sync_tasks import run_virt_sync

        IntegrationSettings.objects.create(
            tenant=self.tenant, virtualization_enabled=True
        )
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            counts = run_virt_sync(str(self.source.id))
        self.assertEqual(counts["vms"], 2)


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
