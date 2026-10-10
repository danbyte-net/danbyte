"""Virtualization sync, phase B of #98: Proxmox pools and vCenter folders as
VM groups, Cloud Director NICs read per vApp, and the vCenter Tools OS name.

Fixtures and fakes are shared with tests_virt_sync so every backend is
exercised against the same stand-ins its own suite uses.
"""
from __future__ import annotations

from functools import partialmethod
from unittest import mock
from urllib.parse import urlsplit

from django.test import TestCase

from api.models import (
    IPAddress,
    Prefix,
    VirtualMachine,
    VirtualMachineGroup,
    VMInterface,
)
from core.models import Organization, Tenant
from integrations import vcloud_client, virt_sync
from integrations.models import VirtGuest, VirtualizationSource
from integrations.tests_virt_sync import (
    RESOURCES,
    VCD_A,
    VCD_B,
    VCD_BASE,
    VCD_C,
    FakeVCenter,
    _Resp,
    _Session,
    _vcd_detail,
    _vcd_record,
    fake_get,
)
from integrations.virt_client import VirtAPIError


def _tenant():
    org = Organization.objects.create(name="O", slug="o")
    return Tenant.objects.create(org=org, name="T", slug="t")


# ─── Cloud Director: NICs per vApp ──────────────────────────────────────────


def _vapp_child(urn, name, *conns, description=""):
    """A VM as a vApp representation embeds it under ``children.vm``."""
    body = _vcd_detail(*conns, description=description)
    body.update({"href": f"{VCD_BASE}/{urn}", "name": name})
    return body


def _nic(index, ip, mac, network="lan_2"):
    return {"networkConnectionIndex": index, "network": network,
            "ipAddress": ip, "externalIpAddress": "",
            "macAddress": mac, "isConnected": "true"}


VAPP_1 = "vapp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
VAPP_2 = "vapp-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
VCD_D = "vm-55555555-5555-5555-5555-555555555555"
VCD_E = "vm-66666666-6666-6666-6666-666666666666"


class VCloudBatchedNicTests(TestCase):
    """NICs come from one read per vApp, not one per VM (#98).

    Runs the real client against a fake appliance so the query pagination,
    the href guard and the fallback all take part.
    """

    def setUp(self):
        self.tenant = _tenant()
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vcd", kind="vcloud",
            host="vcd.example.net", port=443,
            credentials={"username": "sync@acme", "password": "s"},
            sync_mode="auto",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        v1 = f"https://vcd.example.net/api/vApp/{VAPP_1}"
        v2 = f"https://vcd.example.net/api/vApp/{VAPP_2}"
        self.records = [
            _vcd_record(VCD_A, "web01", "web-stack", container=v1,
                        description="from the record"),
            _vcd_record(VCD_B, "web02", "web-stack", container=v1),
            _vcd_record(VCD_C, "db01", "db-stack", container=v2),
            # No container at all: an appliance that leaves the field out.
            _vcd_record(VCD_D, "loner", "solo"),
            # Names a vApp that does not list it.
            _vcd_record(VCD_E, "ghost", "web-stack", container=v1),
        ]
        self.vapps = {
            VAPP_1: {"name": "web-stack", "children": {"vm": [
                _vapp_child(VCD_A, "web01",
                            _nic(0, "10.77.0.10", "02:00:00:00:00:0a"),
                            description="the web head"),
                _vapp_child(VCD_B, "web02",
                            _nic(0, "10.77.0.11", "02:00:00:00:00:0b")),
            ]}},
            # A single child arriving unwrapped rather than as a list.
            VAPP_2: {"name": "db-stack", "children": {"vm": _vapp_child(
                VCD_C, "db01", _nic(0, "10.77.0.12", "02:00:00:00:00:0c"),
            )}},
        }
        self.vm_details = {
            VCD_A: _vcd_detail(_nic(0, "10.77.0.10", "02:00:00:00:00:0a")),
            VCD_B: _vcd_detail(_nic(0, "10.77.0.11", "02:00:00:00:00:0b")),
            VCD_C: _vcd_detail(_nic(0, "10.77.0.12", "02:00:00:00:00:0c")),
            VCD_D: _vcd_detail(_nic(0, "10.77.0.13", "02:00:00:00:00:0d")),
            VCD_E: _vcd_detail(_nic(0, "10.77.0.14", "02:00:00:00:00:0e")),
        }
        self.denied: set = set()
        self.session = None

    def handler(self, method, url, kw):
        path = urlsplit(url).path
        if path == "/api/versions":
            return _Resp(body={"versionInfo": [{"version": "38.1"}]})
        if path == "/cloudapi/1.0.0/sessions":
            return _Resp(headers={"X-VMWARE-VCLOUD-ACCESS-TOKEN": "tok"})
        if path == "/api/query":
            p = kw["params"]
            size, page = p["pageSize"], p["page"]
            chunk = self.records[(page - 1) * size: page * size]
            if not chunk:
                return _Resp(status=400)
            return _Resp(body={"record": chunk, "total": len(self.records)})
        tail = path.rsplit("/", 1)[-1]
        if tail in self.denied:
            return _Resp(status=403)
        if tail in self.vapps:
            return _Resp(body=self.vapps[tail])
        if tail in self.vm_details:
            return _Resp(body=self.vm_details[tail])
        raise AssertionError(f"unexpected {method} {url}")

    def sync(self):
        def session():
            self.session = _Session(self.handler)
            return self.session

        with mock.patch.object(vcloud_client, "assert_public_host"), \
                mock.patch.object(vcloud_client, "SafeSession", session), \
                mock.patch.object(
                    vcloud_client.VCloudClient, "query",
                    partialmethod(vcloud_client.VCloudClient.query, page_size=2),
                ):
            return virt_sync.sync_vcloud(self.source)

    def gets(self, tail):
        return [u for m, u, _ in self.session.calls
                if m == "GET" and u.endswith(tail)]

    def test_each_vapp_is_read_once_and_its_vms_are_not(self):
        with self.assertLogs("danbyte.virt_sync", "INFO") as logs:
            counts = self.sync()

        self.assertEqual(len(self.gets(VAPP_1)), 1)
        self.assertEqual(len(self.gets(VAPP_2)), 1)
        for urn in (VCD_A, VCD_B, VCD_C):
            self.assertEqual(self.gets(urn), [], f"{urn} was read on its own")
        # The two the vApps cannot answer for fall back to their own read.
        self.assertEqual(len(self.gets(VCD_D)), 1)
        self.assertEqual(len(self.gets(VCD_E)), 1)
        self.assertEqual(counts["nic_reads"], 4)
        self.assertTrue(
            any("per-vApp + per-VM path" in line for line in logs.output),
            logs.output,
        )

    def test_addresses_and_notes_arrive_through_the_vapp(self):
        self.sync()

        web = VirtualMachine.objects.get(name="web01")
        iface = VMInterface.objects.get(vm=web)
        self.assertEqual(iface.name, "nic0")
        self.assertEqual(iface.mac_address, "02:00:00:00:00:0a")
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.10").assigned_vm_id,
            web.id,
        )
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.12").assigned_vm.name,
            "db01",
        )
        # The vApp's copy of the VM wins over the query record's text.
        self.assertEqual(web.description, "the web head")

    def test_the_query_is_walked_page_by_page(self):
        self.sync()

        pages = [kw["params"]["page"] for _, u, kw in self.session.calls
                 if u.endswith("/api/query")]
        self.assertEqual(pages, [1, 2, 3])
        self.assertEqual(VirtualMachine.objects.count(), 5)

    def test_an_unreadable_vapp_falls_back_to_per_vm_reads(self):
        self.denied = {VAPP_1}

        with self.assertLogs("danbyte.virt_sync", "INFO") as logs:
            self.sync()

        for urn in (VCD_A, VCD_B, VCD_E):
            self.assertEqual(len(self.gets(urn)), 1)
        self.assertEqual(
            IPAddress.objects.get(ip_address="10.77.0.10").assigned_vm.name,
            "web01",
        )
        self.assertTrue(any("unreadable" in line for line in logs.output))

    def test_an_account_that_reads_no_vapp_stops_trying_after_three(self):
        many = []
        for i in range(5):
            vapp = f"vapp-{i:08d}-cccc-cccc-cccc-cccccccccccc"
            urn = f"vm-{i:08d}-dddd-dddd-dddd-dddddddddddd"
            many.append(_vcd_record(
                urn, f"vm{i}", f"stack{i}",
                container=f"https://vcd.example.net/api/vApp/{vapp}",
            ))
            self.denied.add(vapp)
            self.vm_details[urn] = _vcd_detail()
        self.records = many

        with self.assertLogs("danbyte.virt_sync", "INFO") as logs:
            self.sync()

        vapp_reads = [u for m, u, _ in self.session.calls
                      if m == "GET" and "/api/vApp/vapp-" in u]
        self.assertEqual(len(vapp_reads), 3)
        self.assertEqual(VirtualMachine.objects.count(), 5)
        self.assertTrue(any(" per-VM path" in line for line in logs.output))

    def test_missing_fields_are_tolerated(self):
        """Field names were assumed from the record type, so a thin record
        or a child with no sections must not stop the pass."""
        self.records = [
            {"href": f"{VCD_BASE}/{VCD_A}", "name": "bare",
             "container": f"https://vcd.example.net/api/vApp/{VAPP_1}"},
        ]
        self.vapps[VAPP_1] = {"children": {"vm": [
            {"href": f"{VCD_BASE}/{VCD_A}", "name": "bare"},
        ]}}

        self.sync()

        vm = VirtualMachine.objects.get(name="bare")
        self.assertFalse(VMInterface.objects.filter(vm=vm).exists())
        self.assertEqual(self.gets(VCD_A), [])


class VCloudContainerHrefTests(TestCase):
    def test_container_shapes(self):
        href = virt_sync._vcloud_container_href
        uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        self.assertEqual(
            href({"container": f"https://vcd/api/vApp/vapp-{uuid}"}),
            f"https://vcd/api/vApp/vapp-{uuid}",
        )
        self.assertEqual(href({"container": f"urn:vcloud:vapp:{uuid}"}),
                         f"/api/vApp/vapp-{uuid}")
        self.assertEqual(
            href({"container": f"urn:vcloud:vapptemplate:{uuid}"}),
            f"/api/vAppTemplate/vappTemplate-{uuid}",
        )
        self.assertEqual(href({"container": "../../etc/passwd"}), "")
        self.assertEqual(href({"container": None}), "")
        self.assertEqual(href({}), "")


# ─── Proxmox pools ──────────────────────────────────────────────────────────


class ProxmoxPoolGroupTests(TestCase):
    """Proxmox resource pools become VM groups of kind "pool" (#98)."""

    def setUp(self):
        self.tenant = _tenant()
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.pools = {100: "prod"}

    def sync(self):
        def get(source, path):
            if path.startswith("cluster/resources"):
                return [
                    {**r, **({"pool": self.pools[r["vmid"]]}
                             if r["vmid"] in self.pools else {})}
                    for r in RESOURCES
                ]
            # Membership rides on cluster/resources; fake_get refuses any
            # other path, so /pools being read would fail the test.
            return fake_get(source, path)

        with mock.patch.object(virt_sync, "proxmox_get", side_effect=get):
            return virt_sync.sync_proxmox(self.source)

    def test_a_pool_becomes_a_group_on_the_cluster(self):
        self.sync()

        group = VirtualMachineGroup.objects.get()
        self.assertEqual((group.name, group.kind), ("prod", "pool"))
        self.assertEqual(group.cluster.name, "DB-CLUSTER01")
        self.assertEqual(
            VirtualMachine.objects.get(name="router-vm").group_id, group.id
        )
        self.assertIsNone(VirtualMachine.objects.get(name="lxc-dns").group_id)

    def test_off_when_the_switch_is(self):
        self.source.sync_vm_groups = False
        self.source.save(update_fields=["sync_vm_groups"])

        self.sync()

        self.assertEqual(VirtualMachineGroup.objects.count(), 0)

    def test_a_synced_vm_follows_its_guest_out_of_the_pool(self):
        self.sync()
        self.pools = {}

        self.sync()

        self.assertIsNone(
            VirtualMachine.objects.get(name="router-vm").group_id
        )

    def test_a_synced_vm_follows_its_guest_to_another_pool(self):
        self.sync()
        self.pools = {100: "dev"}

        self.sync()

        self.assertEqual(
            VirtualMachine.objects.get(name="router-vm").group.name, "dev"
        )

    def test_a_hand_made_group_is_never_cleared(self):
        self.sync()
        vm = VirtualMachine.objects.get(name="lxc-dns")
        mine = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=vm.cluster, name="mine"
        )
        vm.group = mine
        vm.save(update_fields=["group"])

        self.sync()

        vm.refresh_from_db()
        self.assertEqual(vm.group_id, mine.id)

    def test_an_adopted_vm_keeps_the_group_it_has(self):
        """Blank-fill only for a VM the operator already had."""
        self.sync()
        vm = VirtualMachine.objects.get(name="router-vm")
        other = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=vm.cluster, name="hand", kind="pool"
        )
        vm.group = other
        vm.save(update_fields=["group"])
        VirtGuest.objects.filter(vm=vm).update(created_vm=False)
        self.pools = {}

        self.sync()

        vm.refresh_from_db()
        self.assertEqual(vm.group_id, other.id)


# ─── vCenter folders ────────────────────────────────────────────────────────


class VCenterFolderGroupTests(TestCase):
    """vCenter VM folders become VM groups of kind "folder" (#98)."""

    def setUp(self):
        self.tenant = _tenant()
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", kind="vcenter", host="192.0.2.40",
            port=443, credentials={"username": "u", "password": "p"},
            sync_mode="auto",
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")

    def sync(self, cls=FakeVCenter):
        with mock.patch("integrations.virt_client.VCenterClient", cls):
            return virt_sync.sync_vcenter(self.source)

    def test_the_folder_path_names_the_group(self):
        """Named by the whole path, so two "Linux" folders stay two groups."""
        self.sync()

        web = VirtualMachine.objects.get(name="web01")
        self.assertEqual(web.group.name, "Test site / Linux")
        self.assertEqual(web.group.kind, "folder")
        self.assertEqual(web.group.cluster.name, "Lab-Cluster")
        # In the root VM folder only - no group.
        self.assertIsNone(VirtualMachine.objects.get(name="db01").group_id)

    def test_off_when_the_switch_is(self):
        self.source.sync_vm_groups = False
        self.source.save(update_fields=["sync_vm_groups"])

        self.sync()

        self.assertEqual(VirtualMachineGroup.objects.count(), 0)

    def test_a_failed_folder_read_does_not_ungroup_anything(self):
        self.sync()

        class Broken(FakeVCenter):
            def get(self, path):
                if path.startswith("vcenter/vm?folders="):
                    raise VirtAPIError("vCenter API returned 500")
                return super().get(path)

        self.sync(Broken)

        self.assertEqual(
            VirtualMachine.objects.get(name="web01").group.name,
            "Test site / Linux",
        )

    def test_a_vm_moved_to_the_root_folder_leaves_its_group(self):
        self.sync()

        class Moved(FakeVCenter):
            def get(self, path):
                if path.startswith("vcenter/vm?folders="):
                    return []
                return super().get(path)

        self.sync(Moved)

        self.assertIsNone(VirtualMachine.objects.get(name="web01").group_id)


# ─── vCenter: the OS name from VMware Tools ─────────────────────────────────

#: The shape a real vCenter 8.0.3 returns for its own appliance VM.
PHOTON_IDENTITY = {
    "family": "LINUX", "full_name": "VMware Photon OS (64-bit)",
    "host_name": "vcsa", "ip_address": "10.77.0.40",
    "name": "VMWARE_PHOTON_64",
}


class VCenterToolsOsNameTests(TestCase):
    """The platform name comes from /guest/identity, not the VM detail.

    The detail's ``identity`` is the VM's (bios/instance uuid, name), so the
    old reader always came back empty and every platform was derived from
    the guest_OS enum.
    """

    def setUp(self):
        self.tenant = _tenant()
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="vc", kind="vcenter", host="192.0.2.40",
            port=443, credentials={"username": "u", "password": "p"},
            sync_mode="auto", sync_platforms=True,
        )
        Prefix.objects.create(tenant=self.tenant, cidr="10.77.0.0/24")
        self.seen: list = []

    def sync(self, identities=None, fail=None, nets_fail=False):
        seen = self.seen

        class Fake(FakeVCenter):
            def get(self, path):
                seen.append(path)
                if fail and path.endswith("/guest/identity"):
                    raise VirtAPIError(
                        f"vCenter API returned {fail} for {path}."
                    )
                if nets_fail and path.endswith(
                    "/guest/networking/interfaces"
                ):
                    raise VirtAPIError("vCenter API returned 503")
                return super().get(path)

        Fake.identities = identities or {}
        with mock.patch("integrations.virt_client.VCenterClient", Fake):
            return virt_sync.sync_vcenter(self.source)

    def platform(self, name="web01"):
        return VirtualMachine.objects.get(name=name).platform

    def test_the_tools_name_wins(self):
        counts = self.sync({"vm-100": PHOTON_IDENTITY})

        self.assertEqual(self.platform().name, "VMware Photon OS (64-bit)")
        self.assertEqual(counts["vms_no_tools_identity"], 0)

    def test_a_localisable_message_is_read_too(self):
        body = {**PHOTON_IDENTITY, "full_name": {
            "id": "vmsg.guestos.photon",
            "default_message": "VMware Photon OS (64-bit)", "args": []}}

        self.sync({"vm-100": body})

        self.assertEqual(self.platform().name, "VMware Photon OS (64-bit)")

    def test_tools_not_running_falls_back_to_the_enum(self):
        for status in (503, 404):
            with self.subTest(status=status):
                VirtualMachine.objects.all().delete()
                VirtGuest.objects.all().delete()

                counts = self.sync(fail=status)

                self.assertEqual(self.platform().name, "RHEL 8 (64-bit)")
                self.assertEqual(counts["vms_no_tools_identity"], 1)

    def test_a_powered_off_vm_is_never_asked(self):
        self.sync({"vm-100": PHOTON_IDENTITY})

        self.assertNotIn("vcenter/vm/vm-101/guest/identity", self.seen)
        self.assertIn("vcenter/vm/vm-100/guest/identity", self.seen)

    def test_no_identity_call_when_tools_already_failed(self):
        self.sync({"vm-100": PHOTON_IDENTITY}, nets_fail=True)

        self.assertNotIn("vcenter/vm/vm-100/guest/identity", self.seen)
        self.assertEqual(self.platform().name, "RHEL 8 (64-bit)")

    def test_an_enum_platform_moves_to_the_tools_name(self):
        """A platform an earlier pass named after the enum is upgraded once
        Tools reports, so installs synced before the fix get the real name."""
        self.sync(fail=503)
        self.assertEqual(self.platform().name, "RHEL 8 (64-bit)")

        self.sync({"vm-100": PHOTON_IDENTITY})

        self.assertEqual(self.platform().name, "VMware Photon OS (64-bit)")

    def test_a_hand_picked_platform_is_kept(self):
        from api.models import Platform

        self.sync(fail=503)
        mine = Platform.objects.create(tenant=self.tenant, name="Appliance", slug="appliance")
        VirtualMachine.objects.filter(name="web01").update(platform=mine)

        self.sync({"vm-100": PHOTON_IDENTITY})

        self.assertEqual(self.platform().id, mine.id)

    def test_a_tools_name_matching_the_enum_name_changes_nothing(self):
        self.sync(fail=503)
        first = self.platform()

        self.sync({"vm-100": {**PHOTON_IDENTITY, "full_name": "RHEL 8 (64-bit)"}})

        self.assertEqual(self.platform().id, first.id)

    def test_the_vm_detail_identity_is_not_an_os_name(self):
        detail_identity = {"bios_uuid": "4211", "instance_uuid": "5011",
                           "name": "web01"}
        self.assertEqual(virt_sync._vc_full_name(detail_identity), "")
        self.assertEqual(virt_sync._vc_full_name(None), "")
