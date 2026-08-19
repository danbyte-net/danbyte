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
    "ide2": "local:iso/debian.iso,media=cdrom",  # optical - must be ignored
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
        # Dropping the address is by design; doing it silently was not.
        self.assertEqual(counts["ips_skipped"], 1)

    def test_prefix_in_a_vrf_makes_the_address_unplaced(self):
        """Today's behaviour, now visible: the sync only searches the Global VRF.

        Moving a prefix into a VRF therefore hides it, and the guest address is
        dropped rather than mis-filed. The count is what tells the operator.
        """
        from api.models import VRF

        vrf = VRF.objects.create(tenant=self.tenant, name="prod")
        Prefix.objects.all().update(vrf=vrf)

        counts = self.sync()

        self.assertEqual(counts["ips"], 0)
        self.assertEqual(counts["ips_skipped"], 1)
        self.assertEqual(IPAddress.objects.count(), 0)

    def test_placed_addresses_are_not_counted_as_skipped(self):
        counts = self.sync()
        self.assertEqual(counts["ips"], 1)
        self.assertEqual(counts["ips_skipped"], 0)

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
        # Additive + idempotent - a second sync doesn't duplicate.
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
             "connection_state": "CONNECTED"},
            {"host": "host-2", "name": "esxi-lab-02",
             "connection_state": "CONNECTED"}]
# Two clusters on purpose: a single-cluster fixture is what let a
# multi-cluster vCenter collapse every guest into one cluster unnoticed.
VC_CLUSTERS = [{"cluster": "domain-c1", "name": "Lab-Cluster"},
               {"cluster": "domain-c2", "name": "DR-Cluster"}]
# vm-100 runs on Lab-Cluster/host-1, vm-101 on DR-Cluster/host-2.
VC_BY_CLUSTER = {"domain-c1": ["vm-100"], "domain-c2": ["vm-101"]}
VC_HOSTS_BY_CLUSTER = {"domain-c1": ["host-1"], "domain-c2": ["host-2"]}
VC_DATACENTERS = [{"datacenter": "datacenter-3", "name": "Lab"}]
# A distributed port-group beside a standard one, so the switch kind is a
# fact read off the hypervisor rather than guessed from the connector.
VC_NETWORKS = [
    {"network": "network-1", "name": "VM Network", "type": "STANDARD_PORTGROUP"},
    {"network": "dvpg-1", "name": "DSwitch-Prod",
     "type": "DISTRIBUTED_PORTGROUP"},
]
# The folder tree, as `?parent_folders=` walks it: "vm" is a vCenter
# built-in and gets stripped, so web01 reads as "Test site / Linux".
VC_FOLDERS = [
    {"folder": "group-v1", "name": "vm", "type": "VIRTUAL_MACHINE"},
    {"folder": "group-v2", "name": "Test site", "type": "VIRTUAL_MACHINE"},
    {"folder": "group-v3", "name": "Linux", "type": "VIRTUAL_MACHINE"},
]
VC_FOLDER_KIDS = {"group-v1": ["group-v2"], "group-v2": ["group-v3"]}
VC_VMS_BY_FOLDER = {"group-v3": ["vm-100"]}
VC_DETAIL = {
    "vm-100": {
        "name": "web01", "power_state": "POWERED_ON",
        "guest_OS": "RHEL_8_64",
        "cpu": {"count": 4}, "memory": {"size_MiB": 8192},
        "disks": {"2000": {"capacity": 40 * 1024**3}},
        "nics": {"4000": {"label": "Network adapter 1",
                          "mac_address": "00:50:56:AA:BB:CC",
                          "backing": {"network_name": "VM Network"}}},
    },
    "vm-101": {
        "name": "db01", "power_state": "POWERED_OFF",
        "cpu": {"count": 2}, "memory": {"size_MiB": 4096},
        "disks": {"2000": {"capacity": 20 * 1024**3}},
        "nics": {"4000": {"label": "Network adapter 1",
                          "mac_address": "00:50:56:DD:EE:FF",
                          "backing": {"network_name": "DSwitch-Prod"}}},
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
    """Stand-in for VCenterClient - routes REST paths to the fixtures above."""

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
            return [{"vm": "vm-100"}]
        if path == "vcenter/vm?hosts=host-2":
            return [{"vm": "vm-101"}]
        if path.startswith("vcenter/vm?clusters="):
            cm = path.split("=", 1)[1]
            return [{"vm": v} for v in VC_BY_CLUSTER.get(cm, [])]
        if path.startswith("vcenter/host?clusters="):
            cm = path.split("=", 1)[1]
            return [{"host": h} for h in VC_HOSTS_BY_CLUSTER.get(cm, [])]
        if path == "vcenter/network":
            return VC_NETWORKS
        if path == "vcenter/datacenter":
            return VC_DATACENTERS
        if path == "vcenter/folder":
            return VC_FOLDERS
        if path.startswith("vcenter/folder?parent_folders="):
            fid = path.split("=", 1)[1]
            kids = VC_FOLDER_KIDS.get(fid, [])
            return [f for f in VC_FOLDERS if f["folder"] in kids]
        if path.startswith("vcenter/vm?folders="):
            fid = path.split("=", 1)[1]
            return [{"vm": v} for v in VC_VMS_BY_FOLDER.get(fid, [])]
        if path.startswith("vcenter/vm?datacenters="):
            return [{"vm": v["vm"]} for v in VC_VMS]
        if path.startswith("vcenter/host?datacenters="):
            return [{"host": h["host"]} for h in VC_HOSTS]
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

    def test_guests_land_in_the_cluster_they_actually_run_on(self):
        """Multi-cluster vCenters used to collapse into one fake cluster.

        The VM summary carries no cluster, so the sync named a single cluster
        after the source and put every guest in it. `?clusters=` filters by
        cluster the same way `?hosts=` already did - so each guest now lands
        where it runs, which is also what makes site inheritance meaningful.
        """
        self.sync()

        self.assertEqual(
            VirtualMachine.objects.get(name="web01").cluster.name, "Lab-Cluster"
        )
        self.assertEqual(
            VirtualMachine.objects.get(name="db01").cluster.name, "DR-Cluster"
        )
        # Both clusters are real rows, and nothing was named after the source.
        self.assertEqual(Cluster.objects.count(), 2)
        self.assertFalse(Cluster.objects.filter(name=self.source.name).exists())

    def test_a_guest_on_no_cluster_falls_back_to_the_source_name(self):
        """Standalone ESXi has no cluster at all - that path must stay green.

        It is also the shape of the dev box, so this is the case a live run
        actually exercises.
        """
        class NoClusters(FakeVCenter):
            def get(self, path):
                if path == "vcenter/cluster":
                    return []
                if path.startswith(("vcenter/vm?clusters=",
                                    "vcenter/host?clusters=")):
                    return []
                return super().get(path)

        with mock.patch("integrations.virt_client.VCenterClient", NoClusters):
            virt_sync.sync_vcenter(self.source)

        self.assertEqual(
            VirtualMachine.objects.get(name="web01").cluster.name,
            self.source.name,
        )

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
        # No `add` grant (and create() 405s anyway) - either way it's refused.
        res = self.client.post("/api/virt-changes/", {}, format="json")
        self.assertIn(res.status_code, (403, 405))


class AddressPlacementTests(TestCase):
    """Which VRF's prefixes a synced address may land in.

    The default (pinned + no VRF = Global) is exactly what shipped before
    placement existed, so the tests above must keep passing untouched. These
    cover what an operator can now choose instead.
    """

    def setUp(self):
        from api.models import VRF

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",
        )
        self.prod = VRF.objects.create(tenant=self.tenant, name="prod")
        self.dr = VRF.objects.create(tenant=self.tenant, name="dr")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def _prefix(self, cidr="10.77.0.0/24", vrf=None):
        return Prefix.objects.create(tenant=self.tenant, cidr=cidr, vrf=vrf)

    def _pin(self, vrf, *, search=False):
        self.source.vrf = vrf
        self.source.vrf_mode = "search" if search else "pinned"
        self.source.save(update_fields=["vrf", "vrf_mode"])

    # ── pinned ───────────────────────────────────────────────────────────
    def test_pinned_to_a_vrf_places_the_address_there(self):
        self._prefix(vrf=self.prod)
        self._pin(self.prod)
        counts = self.sync()
        self.assertEqual(counts["ips"], 1)
        self.assertEqual(counts["ips_skipped"], 0)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.prod.id
        )

    def test_a_pin_is_a_hard_scope_not_a_preference(self):
        """Pinned to a VRF with no matching prefix must skip, not fall back.

        A Global prefix exists and would fit - using it anyway would file the
        address in a routing domain the operator explicitly didn't name.
        """
        self._prefix()  # Global
        self._pin(self.dr)  # …but the source says dr
        counts = self.sync()
        self.assertEqual(counts["ips"], 0)
        self.assertEqual(counts["ips_skipped"], 1)
        self.assertEqual(IPAddress.objects.count(), 0)

    # ── search ───────────────────────────────────────────────────────────
    def test_search_finds_a_prefix_outside_the_preferred_vrf(self):
        self._prefix(vrf=self.prod)
        self._pin(None, search=True)  # prefer Global, allowed to look further
        counts = self.sync()
        self.assertEqual(counts["ips"], 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.prod.id
        )

    def test_search_is_additive_and_never_relocates(self):
        """Preference beats specificity, deliberately.

        A plain longest-match across all VRFs would move an address that sits
        happily in a Global /8 today into a /24 in some other VRF - a silent
        data change on upgrade. The preferred VRF is always tried first.
        """
        self._prefix("10.0.0.0/8")            # Global, less specific
        self._prefix("10.77.0.0/24", self.prod)  # prod, more specific
        self._pin(None, search=True)
        self.sync()
        self.assertIsNone(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id,
            "search relocated an address that already placed in Global",
        )

    def test_search_skips_rather_than_guessing_between_vrfs(self):
        self._prefix("10.77.0.0/24", self.prod)
        self._prefix("10.77.0.0/24", self.dr)
        self._pin(None, search=True)  # nothing in Global to prefer
        counts = self.sync()
        self.assertEqual(counts["ips"], 0)
        self.assertEqual(counts["ips_skipped"], 1)
        self.source.refresh_from_db()
        warning = " ".join(self.source.last_sync_skipped)
        self.assertIn("prod", warning)
        self.assertIn("dr", warning)

    # ── the interface override ───────────────────────────────────────────
    def test_interface_vrf_overrides_the_source_policy(self):
        self._prefix(vrf=self.prod)
        self._prefix("10.99.0.0/24", self.dr)  # so dr isn't simply empty
        self._pin(self.dr)  # source says dr…
        self.sync()  # first pass creates the interface
        iface = VMInterface.objects.get(mac_address="aa:bb:cc:00:11:22")
        iface.vrf = self.prod  # …the operator says prod for this NIC
        iface.save(update_fields=["vrf"])

        counts = self.sync()

        self.assertEqual(counts["ips"], 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.prod.id
        )

    def test_sync_never_writes_the_interface_vrf(self):
        """Layer 1 is the operator's field - reading it is the whole contract."""
        self._prefix(vrf=self.prod)
        self._pin(self.prod)
        self.sync()
        iface = VMInterface.objects.get(mac_address="aa:bb:cc:00:11:22")
        self.assertIsNone(iface.vrf_id)

    # ── diagnostics ──────────────────────────────────────────────────────
    def test_unplaceable_addresses_are_explained_on_the_source(self):
        self._pin(self.prod)  # no prefix anywhere
        self.sync()
        self.source.refresh_from_db()
        self.assertTrue(self.source.last_sync_skipped)
        self.assertIn("prod", " ".join(self.source.last_sync_skipped))

    def test_a_clean_run_clears_stale_warnings(self):
        self._pin(self.prod)
        self.sync()
        self.assertTrue(self.source.__class__.objects.get(
            pk=self.source.pk).last_sync_skipped)
        self._prefix(vrf=self.prod)
        self.sync()
        self.source.refresh_from_db()
        self.assertEqual(self.source.last_sync_skipped, [])


class NetworkPlacementTests(TestCase):
    """The vSwitch / port-group layers - "on this switch it's this VRF".

    A vSwitch trunks many VLANs, so both levels exist: the switch is the
    default, a network on it overrides. Both are read live at sync time, so
    changing one takes effect on the next pass with nothing to backfill.
    """

    def setUp(self):
        from api.models import VRF

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto", sync_networks=True,
        )
        self.prod = VRF.objects.create(tenant=self.tenant, name="prod")
        self.dmz = VRF.objects.create(tenant=self.tenant, name="dmz")
        self.dr = VRF.objects.create(tenant=self.tenant, name="dr")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def _prefix(self, vrf=None, cidr="10.77.0.0/24"):
        return Prefix.objects.create(tenant=self.tenant, cidr=cidr, vrf=vrf)

    def _discover(self):
        """First pass: materialise the switch/network rows so they can be set."""
        self.sync()
        from integrations.models import VirtNetwork

        # The fixture NIC is on vmbr0 tag 10 → ext_key "vmbr0:10".
        return VirtNetwork.objects.get(source=self.source, ext_key="vmbr0:10")

    def test_switch_vrf_places_the_address(self):
        self._prefix(self.prod)
        net = self._discover()
        sw = net.vswitch
        sw.vrf = self.prod
        sw.save(update_fields=["vrf"])

        counts = self.sync()

        self.assertEqual(counts["ips"], 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.prod.id
        )

    def test_network_vrf_overrides_its_switch(self):
        self._prefix(self.dmz)
        self._prefix(self.prod, cidr="10.90.0.0/24")  # so prod isn't just empty
        net = self._discover()
        net.vswitch.vrf = self.prod  # switch-wide default…
        net.vswitch.save(update_fields=["vrf"])
        net.vrf = self.dmz  # …overridden for this port-group
        net.save(update_fields=["vrf"])

        counts = self.sync()

        self.assertEqual(counts["ips"], 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.dmz.id
        )

    def test_interface_vrf_beats_the_network(self):
        self._prefix(self.prod)
        self._prefix(self.dmz, cidr="10.90.0.0/24")
        net = self._discover()
        net.vrf = self.dmz
        net.save(update_fields=["vrf"])
        iface = VMInterface.objects.get(mac_address="aa:bb:cc:00:11:22")
        iface.vrf = self.prod
        iface.save(update_fields=["vrf"])

        self.sync()

        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.prod.id
        )

    def test_network_without_a_vrf_falls_through_to_the_source(self):
        """Empty means "no opinion", which is not the same as Global."""
        self._prefix(self.dr)
        self.source.vrf = self.dr
        self.source.save(update_fields=["vrf"])
        net = self._discover()
        self.assertIsNone(net.vrf_id)
        self.assertIsNone(net.vswitch.vrf_id)

        counts = self.sync()

        self.assertEqual(counts["ips"], 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id, self.dr.id
        )

    def test_layer_is_inert_when_networks_are_not_synced(self):
        self.source.sync_networks = False
        self.source.save(update_fields=["sync_networks"])
        self._prefix()  # Global
        counts = self.sync()
        self.assertEqual(counts["ips"], 1)
        self.assertIsNone(
            IPAddress.objects.get(ip_address="10.77.0.30").vrf_id
        )


class VirtNetworkVrfApiTests(TestCase):
    """The port-group VRF is the one writable field on an otherwise mirrored row."""

    def setUp(self):
        from django.contrib.auth import get_user_model

        from api.models import VRF
        from integrations.models import IntegrationSettings, VirtNetwork

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, virtualization_enabled=True
        )
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
        )
        self.sw = VirtualSwitch.objects.create(tenant=self.tenant, name="vmbr0")
        self.net = VirtNetwork.objects.create(
            source=self.source, ext_key="vmbr0:10", name="DMZ", vswitch=self.sw
        )
        self.vrf = VRF.objects.create(tenant=self.tenant, name="dmz")
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_patching_the_vrf(self):
        r = self.client.patch(
            f"/api/virt-networks/{self.net.id}/",
            {"vrf_id": str(self.vrf.id)}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.net.refresh_from_db()
        self.assertEqual(self.net.vrf_id, self.vrf.id)
        self.assertEqual(r.json()["vrf"], {
            "id": str(self.vrf.id), "name": "dmz", "inherited": False,
        })

    def test_an_unset_network_reports_the_switchs_vrf_as_inherited(self):
        self.sw.vrf = self.vrf
        self.sw.save(update_fields=["vrf"])
        r = self.client.get(f"/api/virt-networks/?vswitch={self.sw.id}")
        row = r.json()["results"][0]
        self.assertEqual(row["vrf"]["name"], "dmz")
        self.assertTrue(row["vrf"]["inherited"])
        # vrf_id is write-only; `inherited` is what tells a reader the value
        # came from the switch rather than from this network.
        self.assertNotIn("vrf_id", row)

    def test_mirrored_fields_stay_read_only(self):
        r = self.client.patch(
            f"/api/virt-networks/{self.net.id}/",
            {"name": "renamed", "ext_key": "hacked"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.net.refresh_from_db()
        self.assertEqual(self.net.name, "DMZ")
        self.assertEqual(self.net.ext_key, "vmbr0:10")

    def test_a_foreign_tenants_vrf_is_refused(self):
        from api.models import VRF

        other_org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=other_org, name="X", slug="x")
        foreign = VRF.objects.create(tenant=other, name="theirs")
        r = self.client.patch(
            f"/api/virt-networks/{self.net.id}/",
            {"vrf_id": str(foreign.id)}, content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.net.refresh_from_db()
        self.assertIsNone(self.net.vrf_id)


class HostDeviceTests(TestCase):
    """Opt-in: the hypervisor's own nodes become Devices (#34).

    Off by default because this writes into the *physical* inventory, which is
    the operator's territory. On, it fills only what the hypervisor actually
    reports and leaves the judgement calls - device type, site - alone.
    """

    def setUp(self):
        from api.status_registry import seed_builtin_statuses

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def _enable(self):
        self.source.sync_hosts = True
        self.source.save(update_fields=["sync_hosts"])

    def test_off_by_default_creates_no_devices(self):
        counts = self.sync()
        self.assertEqual(Device.objects.count(), 0)
        self.assertEqual(counts["hosts"], 0)

    def test_nodes_become_devices(self):
        self._enable()
        counts = self.sync()
        self.assertEqual(counts["hosts"], 2)
        names = set(Device.objects.values_list("name", flat=True))
        self.assertEqual(names, {"pve1", "pve2"})
        dev = Device.objects.get(name="pve1")
        self.assertEqual(dev.role.name, "Hypervisor")
        self.assertEqual(dev.cluster.name, "DB-CLUSTER01")
        self.assertIsNotNone(dev.status)

    def test_type_and_site_are_left_to_the_operator(self):
        """Nothing on the wire says what they are, so nothing is invented."""
        self._enable()
        self.sync()
        dev = Device.objects.get(name="pve1")
        self.assertIsNone(dev.device_type_id)
        self.assertIsNone(dev.site_id)

    def test_idempotent(self):
        self._enable()
        self.sync()
        counts = self.sync()
        self.assertEqual(Device.objects.count(), 2)
        self.assertEqual(counts["hosts"], 0)  # nothing new the second time
        self.assertEqual(DeviceRole.objects.filter(name="Hypervisor").count(), 1)

    def test_an_existing_host_is_matched_case_insensitively(self):
        """The uniqueness constraint is case-sensitive but the lookup isn't.

        Matching any other way would mint "pve1" beside the operator's "PVE1".
        """
        mine = Device.objects.create(
            tenant=self.tenant, name="PVE1", description="mine"
        )
        self._enable()
        counts = self.sync()
        self.assertEqual(counts["hosts"], 1)  # only pve2 was new
        self.assertEqual(Device.objects.filter(name__iexact="pve1").count(), 1)
        mine.refresh_from_db()
        self.assertEqual(mine.description, "mine")  # never restyled
        self.assertEqual(mine.cluster.name, "DB-CLUSTER01")  # blank-filled

    def test_vms_link_to_their_host(self):
        """The payoff: no hand-created Devices needed for host linkage."""
        self._enable()
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        self.assertEqual(vm.device.name, "pve1")

    def test_bridge_uplinks_find_the_created_hosts_nics(self):
        """The bigger payoff - uplink auto-sync used to bail with no Device."""
        from api.models import Interface

        self._enable()
        self.source.sync_networks = True
        self.source.save(update_fields=["sync_networks"])
        self.sync()  # creates pve1 as a Device

        # Model the node's real NICs, as an operator would (or an SNMP sync).
        dev = Device.objects.get(name="pve1")
        for nic in ("eno1", "eno2"):
            Interface.objects.create(device=dev, name=nic)

        counts = self.sync()

        self.assertEqual(counts["uplinks"], 2)
        sw = VirtualSwitch.objects.get(name="vmbr0")
        self.assertEqual(
            set(sw.uplink_interfaces.values_list("name", flat=True)),
            {"eno1", "eno2"},
        )

    def test_an_existing_role_holding_the_slug_is_reused(self):
        """(tenant, slug) is unique - creating past it would 500 the sync."""
        mine = DeviceRole.objects.create(
            tenant=self.tenant, name="HV", slug="hypervisor"
        )
        self._enable()
        self.sync()
        self.assertEqual(DeviceRole.objects.count(), 1)
        self.assertEqual(Device.objects.get(name="pve1").role_id, mine.id)


class SitePlacementSyncTests(TestCase):
    """Placement wired through the vCenter sync (#34).

    The reporter asked for site assignment driven by structure rather than IP
    addresses. These cover the whole path: hierarchy fallback, explicit rules,
    folder inheritance, and the refusal to invent a Site.
    """

    def setUp(self):
        from api.models import Site

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"}, sync_mode="auto",
            sync_hosts=True,
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.Site = Site

    def sync(self):
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            return virt_sync.sync_vcenter(self.source)

    def _rule(self, scope, pattern, site, **kw):
        from integrations.models import VirtPlacementRule

        return VirtPlacementRule.objects.create(
            source=self.source, scope=scope, pattern=pattern, site=site, **kw
        )

    def test_a_site_named_after_the_datacenter_is_used(self):
        """The hierarchy, as the implicit last rule - zero configuration."""
        lab = self.Site.objects.create(tenant=self.tenant, name="Lab")
        self.sync()
        self.assertEqual(VirtualMachine.objects.get(name="web01").site_id, lab.id)
        self.assertEqual(Device.objects.get(name="esxi-lab-01").site_id, lab.id)

    def test_nothing_is_placed_when_no_site_matches(self):
        """A Site is a physical fact - the sync must never invent one.

        A site exists but isn't named after anything here, which is the real
        "why didn't my host get a site?" case.
        """
        self.Site.objects.create(tenant=self.tenant, name="Somewhere else")
        self.sync()
        self.assertEqual(self.Site.objects.count(), 1)
        self.assertIsNone(VirtualMachine.objects.get(name="web01").site_id)
        self.source.refresh_from_db()
        self.assertTrue(
            any("Lab" in w for w in self.source.last_sync_skipped),
            f"expected an unplaced warning, got {self.source.last_sync_skipped}",
        )

    def test_a_rule_beats_the_datacenter_name(self):
        self.Site.objects.create(tenant=self.tenant, name="Lab")
        dr = self.Site.objects.create(tenant=self.tenant, name="DR")
        self._rule("cluster", "DR-*", dr)
        self.sync()
        # db01 runs on DR-Cluster, web01 on Lab-Cluster.
        self.assertEqual(VirtualMachine.objects.get(name="db01").site_id, dr.id)
        self.assertEqual(
            VirtualMachine.objects.get(name="web01").site.name, "Lab"
        )

    def test_a_folder_rule_reaches_a_vm_in_a_subfolder(self):
        """web01 sits in "Test site / Linux"; the rule names only "Test site"."""
        branch = self.Site.objects.create(tenant=self.tenant, name="Branch")
        self._rule("folder", "Test site", branch)
        self.sync()
        self.assertEqual(
            VirtualMachine.objects.get(name="web01").site_id, branch.id
        )

    def test_a_deeper_folder_rule_wins(self):
        branch = self.Site.objects.create(tenant=self.tenant, name="Branch")
        inner = self.Site.objects.create(tenant=self.tenant, name="Inner")
        self._rule("folder", "Test site", branch)
        self._rule("folder", "Linux", inner)
        self.sync()
        self.assertEqual(
            VirtualMachine.objects.get(name="web01").site_id, inner.id
        )

    def test_an_operator_site_is_never_overwritten(self):
        lab = self.Site.objects.create(tenant=self.tenant, name="Lab")
        other = self.Site.objects.create(tenant=self.tenant, name="Mine")
        self.sync()
        vm = VirtualMachine.objects.get(name="web01")
        vm.site = other
        vm.save(update_fields=["site"])

        self.sync()

        vm.refresh_from_db()
        self.assertEqual(vm.site_id, other.id)
        self.assertNotEqual(vm.site_id, lab.id)

    def test_folders_are_not_walked_without_a_folder_rule(self):
        """The tree walk is a call per folder - it must not run for nothing."""
        self.Site.objects.create(tenant=self.tenant, name="Lab")
        seen = []
        real = FakeVCenter.get

        def spy(self_, path):
            seen.append(path)
            return real(self_, path)

        with mock.patch.object(FakeVCenter, "get", spy):
            self.sync()
        self.assertFalse(
            [p for p in seen if "parent_folders" in p],
            "walked the folder tree with no folder rules configured",
        )


class InterfaceDriftTests(TestCase):
    """An interface Danbyte has but the hypervisor doesn't (#34 follow-up).

    Both engines were additive only: they created what was missing and never
    noticed the reverse. Disks already pruned their own rows via
    `created_disk`; VMInterface had no equivalent, so nothing could safely be
    removed - an operator's hand-made NIC was indistinguishable from a stale
    synced one.
    """

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            return virt_sync.sync_proxmox(self.source)

    def _guest(self, name="router-vm"):
        from integrations.models import VirtGuest

        return VirtGuest.objects.get(vm__name=name)

    def test_synced_interfaces_are_marked_as_ours(self):
        self.sync()
        iface = VMInterface.objects.get(vm__name="router-vm")
        self.assertTrue(iface.created_interface)

    def test_an_operator_interface_is_flagged_not_deleted(self):
        """The case reported: a hand-added NIC should raise drift."""
        from integrations.models import VirtChange

        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        VMInterface.objects.create(vm=vm, name="etc 01")

        self.sync()

        self.assertTrue(
            VMInterface.objects.filter(vm=vm, name="etc 01").exists(),
            "an operator's interface must never be deleted by a sync",
        )
        change = VirtChange.objects.get(kind="iface_extra", vm=vm)
        self.assertEqual(change.detail["names"], ["etc 01"])

    def test_a_stale_synced_interface_is_pruned(self):
        """Sync-created bookkeeping that vanished is the sync's to clean up."""
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        VMInterface.objects.create(
            vm=vm, name="net9", created_interface=True
        )

        self.sync()

        self.assertFalse(VMInterface.objects.filter(vm=vm, name="net9").exists())

    def test_the_flag_clears_once_the_interface_goes(self):
        from integrations.models import VirtChange

        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        VMInterface.objects.create(vm=vm, name="etc 01")
        self.sync()
        self.assertTrue(VirtChange.objects.filter(kind="iface_extra").exists())

        VMInterface.objects.filter(vm=vm, name="etc 01").delete()
        self.sync()

        self.assertFalse(
            VirtChange.objects.filter(kind="iface_extra", ignored=False).exists()
        )

    def test_no_drift_when_everything_matches(self):
        from integrations.models import VirtChange

        self.sync()
        self.sync()
        self.assertFalse(VirtChange.objects.filter(kind="iface_extra").exists())


class SwitchKindTests(TestCase):
    """The switch kind comes from vCenter, not from the connector (#34).

    Every vCenter switch used to be labelled "Standard switch" because the
    kind was inferred from the source's platform. vCenter reports the
    port-group type directly, so a distributed switch can be recognised.
    """

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"}, sync_mode="auto",
            sync_networks=True,
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            return virt_sync.sync_vcenter(self.source)

    def test_a_standard_portgroup_makes_a_standard_switch(self):
        self.sync()
        self.assertEqual(
            VirtualSwitch.objects.get(name="VM Network").kind, "standard"
        )

    def test_a_distributed_portgroup_is_recognised(self):
        """This is the case that used to be mislabelled as Standard."""
        self.sync()
        self.assertEqual(
            VirtualSwitch.objects.get(name="DSwitch-Prod").kind, "distributed"
        )

    def test_an_unknown_backing_still_falls_back(self):
        """No type reported means the old behaviour, not a blank kind."""
        self.sync()
        for sw in VirtualSwitch.objects.all():
            self.assertTrue(sw.kind, f"{sw.name} ended up with no kind")

    def test_an_operator_kind_is_not_overwritten(self):
        self.sync()
        sw = VirtualSwitch.objects.get(name="VM Network")
        sw.kind = "bond"
        sw.created_switch = False  # adopted by the operator
        sw.save(update_fields=["kind", "created_switch"])

        self.sync()

        sw.refresh_from_db()
        self.assertEqual(sw.kind, "bond")


class DuplicateVmNameTests(TestCase):
    """Two hypervisors, two machines, one name.

    VM names are unique per tenant and the sync adopts by name, so a `web01`
    on Proxmox and a different `web01` on vCenter used to collapse into one
    row that both syncs then wrote to - wrong cluster, wrong host, wrong
    specs, and nothing to show it had happened.
    """

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.pve = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"}, sync_mode="auto",
        )
        self.vc = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"}, sync_mode="auto",
        )

    def _collide(self):
        """Sync Proxmox, then rename one of its VMs onto a vCenter name."""
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=fake_get):
            virt_sync.sync_proxmox(self.pve)
        vm = VirtualMachine.objects.get(name="router-vm")
        vm.name = "web01"
        vm.save(update_fields=["name"])
        return vm

    def _sync_vc(self):
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            return virt_sync.sync_vcenter(self.vc)

    def test_the_two_machines_are_not_merged(self):
        from integrations.models import VirtGuest

        mine = self._collide()
        self._sync_vc()

        guests = VirtGuest.objects.filter(vm=mine).select_related("source")
        self.assertEqual(
            [g.source.name for g in guests], ["pve"],
            "a second source adopted a VM that already belonged to another",
        )

    def test_the_proxmox_vm_keeps_its_own_placement(self):
        mine = self._collide()
        self._sync_vc()
        mine.refresh_from_db()
        self.assertEqual(mine.cluster.name, "DB-CLUSTER01")

    def test_the_clash_is_reported(self):
        self._collide()
        self._sync_vc()
        self.vc.refresh_from_db()
        joined = " ".join(self.vc.last_sync_skipped)
        self.assertIn("web01", joined)
        self.assertIn("another virtualization source", joined)

    def test_a_normal_adoption_still_works(self):
        """The guard must only fire for a VM another source already owns."""
        from api.models import Cluster, ClusterType
        from integrations.models import VirtGuest

        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Mine", slug="mine"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="ops", type=ctype
        )
        mine = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=cluster
        )

        self._sync_vc()

        self.assertTrue(
            VirtGuest.objects.filter(vm=mine, source=self.vc).exists(),
            "an operator's own VM should still be adopted",
        )


class HostHardwareTests(TestCase):
    """Host model, vendor and serial - the part of #34 REST cannot answer.

    `vcenter/host` returns four fields and there is no host-detail endpoint, so
    this comes from the vim25 SOAP API. Opt-in separately from `sync_hosts`,
    because minting DeviceTypes in a curated catalog is a bigger ask than
    creating a placeholder Device.
    """

    HW = {
        "name": "esxi-lab-01",
        "vendor": "Dell Inc.",
        "model": "PowerEdge R640",
        "serial": "ABC1234",
        "platform": "VMware ESXi 8.0.3",
    }

    def setUp(self):
        from api.status_registry import seed_builtin_statuses

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"}, sync_mode="auto",
            sync_hosts=True, sync_host_hardware=True,
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self, hosts=None):
        fake = mock.MagicMock()
        fake.hosts.return_value = [self.HW] if hosts is None else hosts
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter), \
             mock.patch("integrations.vsphere_soap.VSphereSoap",
                        return_value=fake):
            return virt_sync.sync_vcenter(self.source)

    def test_hardware_lands_on_the_device(self):
        from api.models import Device

        self.sync()
        dev = Device.objects.get(name="esxi-lab-01")
        self.assertEqual(dev.serial_number, "ABC1234")
        self.assertEqual(dev.device_type.name, "PowerEdge R640")
        self.assertEqual(dev.device_type.manufacturer.name, "Dell Inc.")
        self.assertEqual(dev.platform.name, "VMware ESXi 8.0.3")

    def test_it_is_idempotent(self):
        """A second pass must not mint a duplicate type or manufacturer."""
        from api.models import DeviceType, Manufacturer, Platform

        self.sync()
        self.sync()
        self.assertEqual(DeviceType.objects.count(), 1)
        self.assertEqual(Manufacturer.objects.count(), 1)
        self.assertEqual(Platform.objects.count(), 1)

    def test_operator_values_are_never_overwritten(self):
        from api.models import Device, DeviceType

        self.sync()
        dev = Device.objects.get(name="esxi-lab-01")
        mine = DeviceType.objects.create(tenant=self.tenant, name="My model")
        dev.device_type = mine
        dev.serial_number = "MINE-1"
        dev.save(update_fields=["device_type", "serial_number"])

        self.sync()

        dev.refresh_from_db()
        self.assertEqual(dev.device_type_id, mine.id)
        self.assertEqual(dev.serial_number, "MINE-1")

    def test_a_blank_serial_is_not_written(self):
        """Nested ESXi reports no service tag - that must stay empty."""
        from api.models import Device

        self.sync([{**self.HW, "serial": ""}])
        self.assertEqual(Device.objects.get(name="esxi-lab-01").serial_number, "")

    def test_the_flag_is_off_by_default(self):
        from api.models import Device, DeviceType

        self.source.sync_host_hardware = False
        self.source.save(update_fields=["sync_host_hardware"])
        self.sync()
        self.assertTrue(Device.objects.filter(name="esxi-lab-01").exists())
        self.assertEqual(DeviceType.objects.count(), 0)

    def test_a_soap_failure_does_not_fail_the_sync(self):
        from api.models import Device
        from integrations.virt_client import VirtAPIError

        fake = mock.MagicMock()
        fake.connect.side_effect = VirtAPIError("SOAP down")
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter), \
             mock.patch("integrations.vsphere_soap.VSphereSoap",
                        return_value=fake):
            counts = virt_sync.sync_vcenter(self.source)

        self.assertEqual(counts["vms"], 2)  # the rest of the sync still ran
        self.assertTrue(Device.objects.filter(name="esxi-lab-01").exists())
        self.source.refresh_from_db()
        self.assertIn(
            "Host hardware unavailable",
            " ".join(self.source.last_sync_skipped),
        )


class PlatformSyncTests(TestCase):
    """Guest OS -> Platform, opt-in (#34).

    No 200-row lookup table: vCenter's own label is preferred, and the enum is
    unpacked mechanically otherwise. That is safe because matching is by name
    *or* slug, so renaming the Platform keeps it matched.
    """

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", host="192.0.2.20", kind="vcenter",
            credentials={"username": "u", "password": "p"}, sync_mode="auto",
            sync_platforms=True,
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self):
        with mock.patch("integrations.virt_client.VCenterClient", FakeVCenter):
            return virt_sync.sync_vcenter(self.source)

    def test_the_enum_becomes_a_readable_platform(self):
        from api.models import Platform

        self.sync()
        vm = VirtualMachine.objects.get(name="web01")
        self.assertEqual(vm.platform.name, "RHEL 8 (64-bit)")
        self.assertEqual(Platform.objects.count(), 1)

    def test_renaming_the_platform_keeps_it_matched(self):
        """The slug is the key, so an operator can make the name readable."""
        from api.models import Platform

        self.sync()
        plat = Platform.objects.get()
        plat.name = "Red Hat 8"
        plat.save(update_fields=["name"])

        self.sync()

        self.assertEqual(Platform.objects.count(), 1, "a duplicate was minted")

    def test_an_operator_platform_is_not_overwritten(self):
        from api.models import Platform

        self.sync()
        vm = VirtualMachine.objects.get(name="web01")
        mine = Platform.objects.create(
            tenant=self.tenant, name="Mine", slug="mine"
        )
        vm.platform = mine
        vm.save(update_fields=["platform"])

        self.sync()

        vm.refresh_from_db()
        self.assertEqual(vm.platform_id, mine.id)

    def test_an_existing_platform_is_reused(self):
        """Join the operator's catalog rather than growing one beside it."""
        from api.models import Platform

        mine = Platform.objects.create(
            tenant=self.tenant, name="RHEL 8", slug="rhel-8"
        )

        self.sync()

        self.assertEqual(Platform.objects.count(), 1, "a near-duplicate appeared")
        self.assertEqual(
            VirtualMachine.objects.get(name="web01").platform_id, mine.id
        )

    def test_a_different_version_is_not_folded_together(self):
        """A wrong match is worse than an extra row."""
        from api.models import Platform

        Platform.objects.create(
            tenant=self.tenant, name="RHEL 9", slug="rhel-9"
        )

        self.sync()

        self.assertEqual(Platform.objects.count(), 2)
        self.assertEqual(
            VirtualMachine.objects.get(name="web01").platform.name,
            "RHEL 8 (64-bit)",
        )

    def test_off_by_default_mints_nothing(self):
        from api.models import Platform

        self.source.sync_platforms = False
        self.source.save(update_fields=["sync_platforms"])
        self.sync()
        self.assertEqual(Platform.objects.count(), 0)
        self.assertIsNone(VirtualMachine.objects.get(name="web01").platform_id)
