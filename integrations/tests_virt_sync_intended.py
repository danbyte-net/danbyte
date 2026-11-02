"""Virtualization sync and intended VMs (``VirtualMachine.intended``).

Danbyte holds an intended VM's intent: sync adopts it (by VMID, then name),
re-links it after a rebuild, diffs and queues drift, but never overwrites its
fields, never deletes it and never prunes its NICs or disks. A VM without the
flag behaves as before; the contrast cases pin that.
"""
from __future__ import annotations

import copy
from unittest import mock

from django.test import TestCase

from api.models import Cluster, ClusterType, VirtualDisk, VirtualMachine, VMInterface
from core.models import Organization, Tenant
from integrations import virt_sync
from integrations.models import VirtChange, VirtGuest, VirtualizationSource

CLUSTER = "LAB-CLUSTER"

QEMU = {
    "ostype": "l26",
    "net0": "virtio=AA:BB:CC:00:11:22,bridge=vmbr0,tag=10",
    "net1": "e1000=AA:BB:CC:00:11:23,bridge=vnet-wan",
    "scsi0": "local-lvm:vm-100-disk-0,size=32G",
}


def _guest(vmid, name, cpus=4, mem_gb=4, disk_gb=32):
    return {"vmid": vmid, "name": name, "node": "pve1", "type": "qemu",
            "status": "stopped", "maxcpu": cpus, "maxmem": mem_gb * 1024**3,
            "maxdisk": disk_gb * 1024**3}


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",
        )
        self.resources = [_guest(100, "edge-r1")]
        self.configs = {100: copy.deepcopy(QEMU)}

    def fake_get(self, source, path):
        if path == "cluster/status":
            return [{"type": "cluster", "name": CLUSTER},
                    {"type": "node", "name": "pve1", "online": 1}]
        if path == "cluster/options":
            return {}
        if path.startswith("cluster/resources"):
            return self.resources
        if path.startswith("nodes/pve1/qemu/") and path.endswith("/config"):
            return self.configs.get(int(path.split("/")[3]), {})
        if path == "nodes/pve1/network":
            return []
        raise AssertionError(f"unexpected path {path}")

    def sync(self):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=self.fake_get):
            return virt_sync.sync_proxmox(self.source)

    def cluster(self):
        ctype, _ = ClusterType.objects.get_or_create(
            tenant=self.tenant, slug="proxmox-ve", defaults={"name": "Proxmox VE"},
        )
        cl, _ = Cluster.objects.get_or_create(
            tenant=self.tenant, name=CLUSTER, defaults={"type": ctype},
        )
        return cl

    def intended_vm(self, name="edge-r1", **kw):
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster(), intended=True, **kw,
        )

    def prune_now(self):
        self.source.auto_prune = True
        self.source.auto_prune_after_days = 0
        self.source.save(update_fields=["auto_prune", "auto_prune_after_days"])


class AdoptionTests(_Base):
    def test_adopted_by_vmid_before_name(self):
        vm = self.intended_vm(name="edge-router-1", vmid=100)
        self.sync()
        guest = VirtGuest.objects.get(source=self.source, vmid=100)
        self.assertEqual(guest.vm_id, vm.pk)
        self.assertFalse(guest.created_vm)
        self.assertEqual(VirtualMachine.objects.count(), 1)

    def test_vmid_is_blank_filled_on_an_intended_vm(self):
        vm = self.intended_vm()
        self.sync()
        self.sync()
        vm.refresh_from_db()
        self.assertEqual(vm.vmid, 100)

    def test_a_vm_without_the_flag_is_not_matched_by_vmid(self):
        VirtualMachine.objects.create(
            tenant=self.tenant, name="other-name", cluster=self.cluster(), vmid=100,
        )
        self.sync()
        guest = VirtGuest.objects.get(source=self.source, vmid=100)
        self.assertEqual(guest.vm.name, "edge-r1")
        self.assertTrue(guest.created_vm)


class DriftTests(_Base):
    def test_spec_drift_is_queued_not_applied_in_auto_mode(self):
        vm = self.intended_vm(vcpus=2, memory_mb=2048)
        self.sync()
        self.sync()
        vm.refresh_from_db()
        self.assertEqual((vm.vcpus, vm.memory_mb), (2, 2048))
        change = VirtChange.objects.get(vm=vm, kind="spec_change")
        self.assertEqual(change.detail["vcpus"], {"danbyte": 2, "hypervisor": 4})

    def test_a_sync_created_vm_marked_intended_stops_following(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="edge-r1")
        self.assertEqual(vm.vcpus, 4)
        vm.intended = True
        vm.save(update_fields=["intended"])
        self.resources = [_guest(100, "edge-r1", cpus=8)]
        self.sync()
        vm.refresh_from_db()
        self.assertEqual(vm.vcpus, 4)
        self.assertTrue(VirtChange.objects.filter(vm=vm, kind="spec_change").exists())

    def test_a_vm_without_the_flag_still_follows_in_auto_mode(self):
        self.sync()
        self.resources = [_guest(100, "edge-r1", cpus=8)]
        self.sync()
        self.assertEqual(VirtualMachine.objects.get(name="edge-r1").vcpus, 8)

    def test_vmid_drift_is_raised(self):
        vm = self.intended_vm(vmid=150)
        self.sync()  # adopted by name: vmid 150 is not on the hypervisor
        self.sync()
        vm.refresh_from_db()
        self.assertEqual(vm.vmid, 150)
        change = VirtChange.objects.get(vm=vm, kind="spec_change")
        self.assertEqual(change.detail["vmid"], {"danbyte": 150, "hypervisor": 100})


class NeverDeletedTests(_Base):
    def test_an_intended_vm_survives_auto_prune(self):
        self.prune_now()
        self.sync()
        vm = VirtualMachine.objects.get(name="edge-r1")
        vm.intended = True
        vm.save(update_fields=["intended"])
        self.resources = []
        counts = self.sync()
        self.sync()
        self.assertTrue(VirtualMachine.objects.filter(pk=vm.pk).exists())
        self.assertEqual(counts.get("vms_missing_intended"), 1)
        guest = VirtGuest.objects.get(vm=vm)
        self.assertIsNotNone(guest.missing_since)
        self.assertFalse(VirtChange.objects.filter(kind="removed_guest").exists())

    def test_an_intended_vm_is_not_proposed_for_removal_in_review_mode(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="edge-r1")
        vm.intended = True
        vm.save(update_fields=["intended"])
        self.source.sync_mode = "review"
        self.source.auto_prune_after_days = 0
        self.source.save(update_fields=["sync_mode", "auto_prune_after_days"])
        self.resources = []
        self.sync()
        self.assertFalse(VirtChange.objects.filter(kind="removed_guest").exists())
        self.assertTrue(VirtualMachine.objects.filter(pk=vm.pk).exists())

    def test_the_same_vm_without_the_flag_is_pruned(self):
        self.prune_now()
        self.sync()
        self.resources = []
        self.sync()
        self.assertFalse(VirtualMachine.objects.filter(name="edge-r1").exists())

    def test_accepting_a_stale_removal_keeps_an_intended_vm(self):
        self.sync()
        guest = VirtGuest.objects.get(vmid=100)
        change = VirtChange.objects.create(
            source=self.source, guest=guest, vm=guest.vm, kind="removed_guest",
        )
        VirtualMachine.objects.filter(pk=guest.vm_id).update(intended=True)
        virt_sync.apply_change(VirtChange.objects.get(pk=change.pk))
        self.assertTrue(VirtualMachine.objects.filter(name="edge-r1").exists())


class RebuildTests(_Base):
    def test_a_rebuild_with_a_new_vmid_relinks(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="edge-r1")
        vm.intended = True
        vm.save(update_fields=["intended"])
        self.resources = [_guest(105, "edge-r1")]
        self.configs = {105: copy.deepcopy(QEMU)}
        counts = self.sync()
        self.assertEqual(counts.get("vms_relinked"), 1)
        self.assertEqual(VirtualMachine.objects.count(), 1)
        self.assertEqual(VirtGuest.objects.get(vm=vm).vmid, 105)
        self.assertFalse(VirtGuest.objects.filter(vmid=100).exists())

    def test_a_rebuild_with_a_new_vmid_is_found_by_its_intended_vmid(self):
        vm = self.intended_vm(name="edge-r1", vmid=100)
        self.sync()
        vm.vmid = 105
        vm.save(update_fields=["vmid"])
        self.resources = [_guest(105, "freshly-cloned")]
        self.configs = {105: copy.deepcopy(QEMU)}
        self.sync()
        self.assertEqual(VirtGuest.objects.get(vm=vm).vmid, 105)
        self.assertEqual(VirtualMachine.objects.count(), 1)

    def test_a_rebuild_while_the_old_guest_still_runs_is_refused(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="edge-r1")
        vm.intended = True
        vm.save(update_fields=["intended"])
        self.resources = [_guest(105, "edge-r1"), _guest(100, "edge-r1")]
        self.configs[105] = copy.deepcopy(QEMU)
        self.sync()
        self.assertEqual(VirtGuest.objects.get(vm=vm).vmid, 100)
        self.assertIsNone(VirtGuest.objects.get(vmid=105).vm_id)

    def test_a_rebuild_with_the_same_vmid_keeps_the_link(self):
        vm = self.intended_vm(vmid=100)
        self.sync()
        guest = VirtGuest.objects.get(vm=vm)
        self.resources = []
        self.sync()
        self.resources = [_guest(100, "edge-r1")]
        self.sync()
        guest.refresh_from_db()
        self.assertEqual(guest.vm_id, vm.pk)
        self.assertIsNone(guest.missing_since)

    def test_without_the_flag_the_new_guest_is_still_skipped(self):
        self.sync()  # sync-created, prune off: the old guest keeps its link
        self.resources = [_guest(105, "edge-r1")]
        self.configs = {105: copy.deepcopy(QEMU)}
        self.sync()
        self.assertEqual(VirtGuest.objects.get(vmid=100).vm.name, "edge-r1")
        self.assertIsNone(VirtGuest.objects.get(vmid=105).vm_id)


class InterfaceTests(_Base):
    def test_model_bridge_and_index_are_blank_filled_on_an_intended_vm(self):
        vm = self.intended_vm()
        self.sync()
        net1 = VMInterface.objects.get(vm=vm, name="net1")
        self.assertEqual((net1.index, net1.model, net1.bridge), (1, "e1000", "vnet-wan"))

    def test_a_vm_without_the_flag_keeps_no_build_fields(self):
        self.sync()
        net1 = VMInterface.objects.get(vm__name="edge-r1", name="net1")
        self.assertEqual((net1.index, net1.model, net1.bridge), (None, "", ""))

    def test_nic_drift_is_raised_not_applied(self):
        vm = self.intended_vm()
        VMInterface.objects.create(
            vm=vm, name="net0", index=0, model="vmxnet3", bridge="vmbr9",
            created_interface=True,
        )
        self.sync()
        nic = VMInterface.objects.get(vm=vm, name="net0")
        self.assertEqual((nic.model, nic.bridge), ("vmxnet3", "vmbr9"))
        change = VirtChange.objects.get(vm=vm, kind="iface_change")
        self.assertEqual(
            change.detail["interfaces"]["net0"]["bridge"],
            {"danbyte": "vmbr9", "hypervisor": "vmbr0"},
        )
        self.assertEqual(
            change.detail["interfaces"]["net0"]["model"],
            {"danbyte": "vmxnet3", "hypervisor": "virtio"},
        )

    def test_nics_are_never_pruned_on_an_intended_vm(self):
        self.prune_now()
        vm = self.intended_vm()
        self.sync()
        del self.configs[100]["net1"]
        self.sync()
        self.assertTrue(VMInterface.objects.filter(vm=vm, name="net1").exists())
        change = VirtChange.objects.get(vm=vm, kind="iface_extra")
        self.assertEqual(change.detail["names"], ["net1"])

    def test_a_vm_without_the_flag_still_prunes_its_synced_nics(self):
        self.sync()
        del self.configs[100]["net1"]
        self.sync()
        self.assertFalse(VMInterface.objects.filter(name="net1").exists())

    def test_disks_are_never_pruned_or_rewritten_on_an_intended_vm(self):
        vm = self.intended_vm()
        self.sync()
        disk = VirtualDisk.objects.get(vm=vm, key="scsi0")
        disk.size_gb = 64
        disk.save(update_fields=["size_gb"])
        self.configs[100]["scsi1"] = "local-lvm:vm-100-disk-1,size=8G"
        self.sync()
        del self.configs[100]["scsi1"]
        self.sync()
        self.assertEqual(VirtualDisk.objects.get(vm=vm, key="scsi0").size_gb, 64)
        self.assertTrue(VirtualDisk.objects.filter(vm=vm, key="scsi1").exists())
