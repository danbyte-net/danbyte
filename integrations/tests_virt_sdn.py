"""Proxmox SDN (read-only): zones and VNets, cables from VNets, the network
plan, and Cable.pve_vnet."""
from __future__ import annotations

import importlib
from unittest import mock

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import (
    Cable,
    CableTermination,
    Device,
    Interface,
    Site,
    VirtualMachine,
    VirtualSwitch,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations import virt_sync
from integrations.models import (
    IntegrationSettings,
    VirtCableLink,
    VirtGuest,
    VirtNetwork,
    VirtNetworkLink,
    VirtualizationSource,
)
from integrations.virt_client import VirtAPIError

STATUS = [{"type": "cluster", "name": "LAB"}, {"type": "node", "name": "pve1", "online": 1}]


def _vm(vmid, name, nets):
    return {"vmid": vmid, "name": name, "node": "pve1", "type": "qemu",
            "status": "stopped", "maxcpu": 1, "maxmem": 1024**3, "maxdisk": 0}, nets


ZONES = [{"zone": "lab", "type": "simple"}, {"zone": "wan", "type": "vlan"}]
VNETS = [
    {"vnet": "c0001", "zone": "lab", "alias": "r1-r2"},
    {"vnet": "c0002", "zone": "lab"},
    {"vnet": "c0003", "zone": "lab"},
    {"vnet": "spare", "zone": "lab", "tag": 7},
    {"vnet": "uplink", "zone": "wan", "tag": 100, "alias": "ISP"},
]


class _Lab:
    """Three router VMs: r1-r2 share c0001, all three sit on c0002 (too many),
    r3 alone on c0003 (too few)."""

    GUESTS = [
        _vm(201, "r1", {"net0": "virtio=02:00:00:00:01:00,bridge=vmbr0",
                        "net1": "virtio=02:00:00:00:01:01,bridge=c0001",
                        "net2": "virtio=02:00:00:00:01:02,bridge=c0002"}),
        _vm(202, "r2", {"net0": "virtio=02:00:00:00:02:00,bridge=uplink",
                        "net1": "virtio=02:00:00:00:02:01,bridge=c0001",
                        "net2": "virtio=02:00:00:00:02:02,bridge=c0002"}),
        _vm(203, "r3", {"net1": "virtio=02:00:00:00:03:01,bridge=c0003",
                        "net2": "virtio=02:00:00:00:03:02,bridge=c0002"}),
    ]

    def make_get(self, sdn_error=None):
        guests = {vmid["vmid"]: cfg for vmid, cfg in self.GUESTS}

        def get(source, path):
            if path == "cluster/status":
                return STATUS
            if path == "cluster/options":
                return {}
            if path.startswith("cluster/resources"):
                return [r for r, _ in self.GUESTS]
            if path.startswith("cluster/sdn/"):
                if sdn_error:
                    raise VirtAPIError(sdn_error)
                return ZONES if path.endswith("zones") else VNETS
            if path.startswith("nodes/pve1/qemu/") and path.endswith("/config"):
                return guests[int(path.split("/")[3])]
            if path == "nodes/pve1/network":
                return []
            raise AssertionError(f"unexpected path {path}")

        return get


class SdnSyncTests(_Lab, TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="lab", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto", sync_networks=True, sync_disks=False,
        )

    def sync(self, **kw):
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=self.make_get(**kw)):
            return virt_sync.sync_proxmox(self.source)

    def routers(self):
        """Model each VM as a router device with interfaces matching its NICs."""
        out = {}
        for vm in VirtualMachine.objects.filter(tenant=self.tenant):
            dev = Device.objects.create(tenant=self.tenant, name=f"{vm.name}-dev")
            for vi in vm.interfaces.all():
                Interface.objects.create(device=dev, name=f"ge-{vi.name}",
                                         mac_address=vi.mac_address)
            vm.represents_device = dev
            vm.save(update_fields=["represents_device"])
            out[vm.name] = dev
        return out

    def test_zones_and_vnets_become_switches_and_networks(self):
        counts = self.sync()
        self.assertEqual(counts["sdn_zones"], 2)
        self.assertEqual(counts["sdn_vnets"], 5)
        lab = VirtualSwitch.objects.get(tenant=self.tenant, name="lab")
        self.assertEqual(lab.kind, "sdn-zone")
        uplink = VirtNetwork.objects.get(source=self.source, ext_key="uplink")
        self.assertEqual((uplink.sdn_zone, uplink.sdn_tag, uplink.sdn_alias),
                         ("wan", 100, "ISP"))
        self.assertEqual(uplink.vswitch.name, "wan")
        # An unused VNet still gets its row, for the plan.
        self.assertTrue(VirtNetwork.objects.filter(source=self.source, ext_key="spare").exists())
        # A NIC on a VNet links to it; no bridge switch is made for the VNet.
        link = VirtNetworkLink.objects.get(network__ext_key="c0001",
                                           vm_interface__vm__name="r1")
        self.assertEqual(link.vm_interface.name, "net1")
        self.assertFalse(VirtualSwitch.objects.filter(name="c0001").exists())
        # A plain bridge is unchanged.
        self.assertEqual(VirtualSwitch.objects.get(name="vmbr0").kind, "linux-bridge")
        # The wire is kept on the tracking row.
        g = VirtGuest.objects.get(source=self.source, vmid=201)
        self.assertEqual([n["bridge"] for n in g.nics], ["vmbr0", "c0001", "c0002"])

    def test_an_earlier_bridge_row_is_adopted(self):
        self.source.sync_networks = True
        with mock.patch("integrations.virt_sdn.fetch_sdn", return_value=({}, {}, "x")):
            self.sync()
        self.assertEqual(VirtualSwitch.objects.get(name="c0001").kind, "linux-bridge")
        self.sync()
        vn = VirtNetwork.objects.get(source=self.source, ext_key="c0001")
        self.assertEqual(vn.vswitch.name, "lab")
        self.assertEqual(vn.sdn_alias, "r1-r2")
        self.assertFalse(VirtualSwitch.objects.filter(name="c0001").exists())

    def test_no_sdn_right_skips_with_a_warning(self):
        counts = self.sync(sdn_error="Proxmox API returned 403 for cluster/sdn/zones.")
        self.source.refresh_from_db()
        self.assertEqual(self.source.last_sync_status, "ok")
        self.assertEqual(counts["vms"], 3)
        self.assertTrue(any("SDN.Audit" in w for w in self.source.last_sync_skipped))
        self.assertFalse(VirtualSwitch.objects.filter(kind="sdn-zone").exists())

    def test_cables_from_vnets_is_off_by_default(self):
        self.sync()
        self.routers()
        self.sync()
        self.assertFalse(Cable.objects.exists())

    def test_two_nics_make_a_cable_and_the_rest_are_reported(self):
        self.source.cables_from_vnets = True
        self.source.save()
        self.sync()
        devs = self.routers()
        counts = self.sync()
        self.assertEqual(counts["vnet_cables_created"], 1)
        cable = Cable.objects.get()
        self.assertEqual(cable.pve_vnet, "c0001")
        ends = {(t.end, t.interface.device.name, t.interface.name)
                for t in cable.terminations.all()}
        self.assertEqual(ends, {("A", "r1-dev", "ge-net1"), ("B", "r2-dev", "ge-net1")})
        self.assertTrue(VirtCableLink.objects.get(cable=cable).created_cable)
        self.source.refresh_from_db()
        skipped = " ".join(self.source.last_sync_skipped)
        self.assertIn("VNet c0002 has 3 NICs", skipped)
        self.assertIn("VNet c0003 has 1 NIC", skipped)
        self.assertIn("VNet uplink has 1 NIC", skipped)
        self.assertEqual(counts["vnet_findings"], 3)
        # Again: nothing new, the cable is recognised.
        counts = self.sync()
        self.assertEqual(counts["vnet_cables_created"], 0)
        self.assertEqual(counts["vnet_cables_matched"], 1)
        self.assertEqual(Cable.objects.count(), 1)
        self.assertTrue(devs)

    def test_a_disagreeing_cable_is_reported_and_left_alone(self):
        self.source.cables_from_vnets = True
        self.source.save()
        self.sync()
        devs = self.routers()
        a = devs["r1"].interfaces.get(name="ge-net1")
        other = Interface.objects.create(device=devs["r3"], name="spare")
        mine = Cable.objects.create(tenant=self.tenant, label="mine")
        CableTermination.objects.create(cable=mine, end="A", interface=a)
        CableTermination.objects.create(cable=mine, end="B", interface=other)
        counts = self.sync()
        self.assertEqual(counts["vnet_cables_created"], 0)
        self.assertEqual(Cable.objects.count(), 1)
        mine.refresh_from_db()
        self.assertEqual(mine.pve_vnet, "")
        self.source.refresh_from_db()
        self.assertIn("already on mine", " ".join(self.source.last_sync_skipped))

    def test_a_matching_cable_has_its_blank_vnet_filled(self):
        self.source.cables_from_vnets = True
        self.source.save()
        self.sync()
        devs = self.routers()
        mine = Cable.objects.create(tenant=self.tenant, label="mine")
        CableTermination.objects.create(
            cable=mine, end="A", interface=devs["r2"].interfaces.get(name="ge-net1"))
        CableTermination.objects.create(
            cable=mine, end="B", interface=devs["r1"].interfaces.get(name="ge-net1"))
        counts = self.sync()
        self.assertEqual(counts["vnet_cables_matched"], 1)
        mine.refresh_from_db()
        self.assertEqual(mine.pve_vnet, "c0001")
        self.assertFalse(VirtCableLink.objects.get(cable=mine).created_cable)


class NetworkPlanApiTests(_Lab, APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        IntegrationSettings.objects.create(tenant=self.tenant, virt_proxmox_enabled=True)
        self.source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="lab", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
            sync_mode="auto", sync_networks=True, sync_disks=False,
            vnet_zone="lab", vnet_tag_range="10-12",
        )
        with mock.patch.object(virt_sync, "proxmox_get", side_effect=self.make_get()):
            virt_sync.sync_proxmox(self.source)
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev = {}
        for vm in VirtualMachine.objects.filter(tenant=self.tenant):
            dev = Device.objects.create(
                tenant=self.tenant, name=f"{vm.name}-dev",
                site=self.site_b if vm.name == "r3" else self.site_a,
            )
            for vi in vm.interfaces.all():
                Interface.objects.create(device=dev, name=f"ge-{vi.name}",
                                         mac_address=vi.mac_address)
            vm.represents_device = dev
            vm.site = dev.site
            vm.save(update_fields=["represents_device", "site"])
            self.dev[vm.name] = dev
        # c0001 is right; r1 net2 <-> r3 net1 wants "core" (missing, wrong on
        # both ends); r2 net2 <-> r3 net2 has no VNet set.
        self.right = self.cable("r1", "ge-net1", "r2", "ge-net1", "c0001")
        self.core = self.cable("r1", "ge-net2", "r3", "ge-net1", "core")
        self.blank = self.cable("r2", "ge-net2", "r3", "ge-net2", "")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.su).tenants.add(self.tenant)

    def cable(self, a_vm, a_if, b_vm, b_if, vnet):
        c = Cable.objects.create(tenant=self.tenant, pve_vnet=vnet)
        CableTermination.objects.create(
            cable=c, end="A", interface=self.dev[a_vm].interfaces.get(name=a_if))
        CableTermination.objects.create(
            cable=c, end="B", interface=self.dev[b_vm].interfaces.get(name=b_if))
        return c

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def plan(self, query=""):
        return self.client.get(
            f"/api/virtualization-sources/{self.source.id}/network-plan/{query}")

    def test_the_plan(self):
        self.login(self.su)
        r = self.plan()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["counts"]["cables"], 3)
        self.assertEqual(body["vnets_to_create"], [{
            "name": "core", "zone": "lab", "tag": 10, "suggested": False,
            "cables": [{"id": str(self.core.id), "numid": self.core.numid, "label": ""}],
        }])
        wrong = {(w["vm"]["name"], w["nic"], w["current"], w["wanted"])
                 for w in body["nics_wrong_vnet"]}
        self.assertEqual(wrong, {("r1", "net2", "c0002", "core"),
                                 ("r3", "net1", "c0003", "core")})
        mac = next(w["mac"] for w in body["nics_wrong_vnet"] if w["vm"]["name"] == "r1")
        self.assertEqual(mac, "02:00:00:00:01:02")
        self.assertEqual({(n["vm"]["name"], n["nic"]) for n in body["nics_without_vnet"]},
                         {("r2", "net2"), ("r3", "net2")})
        # In the plan's zone, no cable wants these and no NIC sits on them.
        self.assertEqual([u["name"] for u in body["unused_vnets"]], ["spare"])

    def test_the_name_pattern_suggests_a_name(self):
        self.source.vnet_name_pattern = "x{n:04}"
        self.source.save()
        self.login(self.su)
        body = self.plan().json()
        name = f"x{self.blank.numid:04}"
        created = {v["name"]: v for v in body["vnets_to_create"]}
        self.assertTrue(created[name]["suggested"])
        self.assertEqual(body["nics_without_vnet"], [])
        self.blank.refresh_from_db()
        self.assertEqual(self.blank.pve_vnet, "")  # never written

    def test_duplicates_are_reported(self):
        self.blank.pve_vnet = "core"
        self.blank.save()
        self.login(self.su)
        dup = self.plan().json()["duplicates"]
        self.assertEqual(dup[0]["vnet"], "core")
        self.assertEqual(len(dup[0]["cables"]), 2)

    def test_device_scope_and_download(self):
        self.login(self.su)
        r = self.plan(f"?device={self.dev['r2'].id}&format=json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("attachment", r["Content-Disposition"])
        body = r.json()
        self.assertEqual(body["device"]["name"], "r2-dev")
        self.assertEqual(body["counts"]["cables"], 2)  # c0001 and the blank one
        self.assertEqual(body["vnets_to_create"], [])
        self.assertEqual(body["unused_vnets"], [])
        self.assertEqual(self.plan("?device=nope").status_code, 400)

    def test_site_scoped_reader_sees_only_their_sites(self):
        u = User.objects.create_user("site", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="a-only", object_types=["virtualizationsource", "virtualmachine",
                                         "device", "cable"],
            actions=["view"],
        )
        p.users.add(u)
        p.tenants.set([self.tenant])
        p.sites.set([self.site_a])
        self.login(u)
        r = self.plan()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        # Only r1 <-> r2 is wholly inside site A.
        self.assertEqual(body["counts"]["cables"], 1)
        names = {w["vm"]["name"] for w in body["nics_wrong_vnet"] + body["nics_without_vnet"]}
        self.assertNotIn("r3", names)
        self.assertEqual(self.plan(f"?device={self.dev['r3'].id}").status_code, 400)

    def test_needs_view_on_the_source_and_the_tenant(self):
        u = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.login(u)
        self.assertIn(self.plan().status_code, (403, 404))
        other = Tenant.objects.create(org=self.org, name="U", slug="u")
        IntegrationSettings.objects.create(tenant=other, virt_proxmox_enabled=True)
        foreign = VirtualizationSource.objects.create(
            tenant=other, name="theirs", host="192.0.2.31")
        self.login(self.su)
        r = self.client.get(f"/api/virtualization-sources/{foreign.id}/network-plan/")
        self.assertEqual(r.status_code, 404)

    def test_source_settings_are_validated(self):
        self.login(self.su)
        url = f"/api/virtualization-sources/{self.source.id}/"
        for field, bad in (("vnet_name_pattern", "C{n}"), ("vnet_name_pattern", "{n:04}"),
                           ("vnet_name_pattern", "c{x}"), ("vnet_zone", "Lab"),
                           ("vnet_tag_range", "20-10")):
            r = self.client.patch(url, {field: bad}, format="json")
            self.assertEqual(r.status_code, 400, (field, bad))
            self.assertIn(field, r.json())
        r = self.client.patch(url, {"vnet_name_pattern": "c{n:04}", "cables_from_vnets": True},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)


class CableVnetFieldTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        d = Device.objects.create(tenant=self.tenant, name="d")
        self.a = Interface.objects.create(device=d, name="a")
        self.b = Interface.objects.create(device=d, name="b")
        u = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def body(self, vnet):
        return {"a": [{"kind": "interface", "id": str(self.a.id)}],
                "b": [{"kind": "interface", "id": str(self.b.id)}], "pve_vnet": vnet}

    def test_vnet_is_validated_and_read_back(self):
        for bad in ("Vnet1", "1abc", "toolongid", "a-b"):
            r = self.client.post("/api/cables/", self.body(bad), format="json")
            self.assertEqual(r.status_code, 400, bad)
            self.assertIn("pve_vnet", r.json())
        r = self.client.post("/api/cables/", self.body("c0042"), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["pve_vnet"], "c0042")
        r = self.client.get("/api/cables/?pve_vnet=c0042")
        self.assertEqual(r.json()["count"], 1)


class CopyInterfaceVnetMigrationTests(TestCase):
    def test_copies_agreeing_values_and_skips_conflicts(self):
        mod = importlib.import_module("api.migrations.0267_cable_pve_vnet")
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        d = Device.objects.create(tenant=tenant, name="d")

        def cable(a_cf, b_cf, preset=""):
            a = Interface.objects.create(device=d, name=f"a{Cable.objects.count()}",
                                         custom_fields=a_cf)
            b = Interface.objects.create(device=d, name=f"b{Cable.objects.count()}",
                                         custom_fields=b_cf)
            c = Cable.objects.create(tenant=tenant, pve_vnet=preset)
            CableTermination.objects.create(cable=c, end="A", interface=a)
            CableTermination.objects.create(cable=c, end="B", interface=b)
            return c

        both = cable({"pve_vnet": "v1"}, {"pve_vnet": "v1"})
        one = cable({"pve_vnet": "v2"}, {})
        clash = cable({"pve_vnet": "v3"}, {"pve_vnet": "v4"})
        bad = cable({"pve_vnet": "Not-A-VNet"}, {})
        kept = cable({"pve_vnet": "v5"}, {}, preset="mine")
        with self.assertLogs("danbyte.migrations", level="WARNING") as logs:
            mod.copy_interface_vnets(django_apps, None)
        for c in (both, one, clash, bad, kept):
            c.refresh_from_db()
        self.assertEqual((both.pve_vnet, one.pve_vnet, clash.pve_vnet, bad.pve_vnet,
                          kept.pve_vnet), ("v1", "v2", "", "", "mine"))
        self.assertEqual(len(logs.output), 2)
