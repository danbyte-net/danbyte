"""Oxidized nodes on virtual machines (#384).

A virtual router (MikroTik CHR, VyOS, a virtual firewall) is modelled as a
VirtualMachine. Its node matches, pins and serves configs exactly as a
device's does, behind ``virtualmachine.view_config``.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction

from api.models import (
    VRF,
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    VirtualMachine,
    VMInterface,
)
from auth_api.object_types import CAPABILITY_VERBS
from integrations.models import IntegrationSettings

from .models import OxidizedNodeLink
from .sync import sync_nodes
from .tests import FAKE, OID1, OID2, _Base, node


class _VmBase(_Base):
    def setUp(self):
        super().setUp()
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        self.vm = self.make_vm("chr1", site=self.site_a)

    def make_vm(self, name, site=None, tenant=None):
        tenant = tenant or self.tenant
        cluster = self.cluster
        if tenant != self.tenant:
            ct = ClusterType.objects.create(tenant=tenant, name=f"t-{name}", slug=f"t-{name}")
            cluster = Cluster.objects.create(tenant=tenant, name=f"c-{name}", type=ct)
        return VirtualMachine.objects.create(
            tenant=tenant, name=name, cluster=cluster, site=site
        )

    def vm_link(self, vm=None, full="chr1", how=OxidizedNodeLink.HOW_ADDRESS):
        name = full.rpartition("/")[2]
        group = full.rpartition("/")[0]
        return OxidizedNodeLink.objects.create(
            tenant=self.tenant, connection=self.conn, virtual_machine=vm or self.vm,
            full_name=full, node_name=name, node_group=group, matched_by=how,
        )

    def vrf_ip(self, addr, tenant=None, **assign):
        """An address in a VRF of its own, so it may repeat one already held
        in the global table."""
        tenant = tenant or self.tenant
        vrf = VRF.objects.create(tenant=tenant, name=f"v-{VRF.objects.count()}")
        prefix = Prefix.objects.create(tenant=tenant, cidr="10.9.0.0/24", vrf=vrf)
        return IPAddress.objects.create(
            tenant=tenant, ip_address=addr, prefix=prefix, vrf=vrf, **assign
        )

    def vm_url(self, vm=None, rest="config/"):
        return f"/api/oxidized/virtual-machines/{(vm or self.vm).id}/{rest}"


class VmModelTests(_VmBase):
    def test_a_link_needs_exactly_one_target(self):
        with transaction.atomic(), self.assertRaises(IntegrityError):
            OxidizedNodeLink.objects.create(
                tenant=self.tenant, connection=self.conn, full_name="none",
                node_name="none", matched_by="manual",
            )
        with transaction.atomic(), self.assertRaises(IntegrityError):
            OxidizedNodeLink.objects.create(
                tenant=self.tenant, connection=self.conn, device=self.device,
                virtual_machine=self.vm, full_name="both", node_name="both",
                matched_by="manual",
            )

    def test_one_vm_has_one_link_per_connection(self):
        self.vm_link(full="a")
        with transaction.atomic(), self.assertRaises(IntegrityError):
            self.vm_link(full="b")

    def test_deleting_the_vm_removes_its_link(self):
        self.vm_link()
        self.vm.delete()
        self.assertFalse(OxidizedNodeLink.objects.exists())


class VmSyncTests(_VmBase):
    def test_a_vm_matches_by_interface_assigned_and_primary_address(self):
        nic = VMInterface.objects.create(vm=self.vm, name="ether1")
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.20/24", prefix=self.prefix,
            assigned_vm_interface=nic,
        )
        vyos = self.make_vm("vyos1")
        vyos.primary_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.21/24", prefix=self.prefix,
        )
        vyos.save()
        fw = self.make_vm("fw1")
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.22/24", prefix=self.prefix, assigned_vm=fw,
        )
        FAKE["nodes"] = [
            node("router-a", ip="10.9.0.20"), node("router-b", ip="10.9.0.21"),
            node("router-c", ip="10.9.0.22"), node("sw1-node", ip="10.9.0.10"),
        ]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 4, summary)
        got = {lk.full_name: (lk.device_id, lk.virtual_machine_id, lk.matched_by)
               for lk in OxidizedNodeLink.objects.all()}
        self.assertEqual(got["router-a"], (None, self.vm.id, "address"))
        self.assertEqual(got["router-b"], (None, vyos.id, "address"))
        self.assertEqual(got["router-c"], (None, fw.id, "address"))
        self.assertEqual(got["sw1-node"], (self.device.id, None, "address"))

    def test_a_vm_matches_by_name_and_fqdn(self):
        FAKE["nodes"] = [node("CHR1.example.net", ip="192.0.2.1", group="mikrotik")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 1)
        lk = OxidizedNodeLink.objects.get()
        self.assertEqual(
            (lk.virtual_machine_id, lk.device_id, lk.matched_by, lk.node_group),
            (self.vm.id, None, "name", "mikrotik"),
        )

    def test_a_name_shared_by_a_device_and_a_vm_links_nothing(self):
        Device.objects.create(tenant=self.tenant, name="CHR1", site=self.site_b)
        FAKE["nodes"] = [node("chr1")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertIn(
            "2 devices and virtual machines share the name", summary["unmatched"][0]["reason"]
        )

    def test_two_vms_sharing_an_address_link_nothing(self):
        other = self.make_vm("chr2")
        for vm in (self.vm, other):
            self.vrf_ip("10.9.0.40/24", assigned_vm=vm)
        FAKE["nodes"] = [node("x", ip="10.9.0.40")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertIn("2 virtual machines share the address", summary["unmatched"][0]["reason"])

    def test_an_address_shared_by_a_device_and_a_vm_links_nothing(self):
        self.vrf_ip("10.9.0.10/24", assigned_vm=self.vm)
        FAKE["nodes"] = [node("x", ip="10.9.0.10")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertIn(
            "devices and virtual machines share the address", summary["unmatched"][0]["reason"]
        )

    def test_two_nodes_on_one_vm_link_neither(self):
        IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.30/24", prefix=self.prefix,
            assigned_vm=self.vm,
        )
        FAKE["nodes"] = [node("a", ip="10.9.0.30"), node("b", ip="10.9.0.30")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertIn("2 nodes match chr1", summary["unmatched"][0]["reason"])

    def test_another_tenants_vm_is_never_matched(self):
        theirs = self.make_vm("theirs", tenant=self.other_tenant)
        self.vrf_ip("10.9.0.50/24", tenant=self.other_tenant, assigned_vm=theirs)
        FAKE["nodes"] = [node("theirs"), node("y", ip="10.9.0.50")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["linked"], 0)
        self.assertEqual(summary["unmatched_count"], 2)

    def test_a_pinned_vm_is_kept_and_not_rematched(self):
        self.vm_link(full="grp/pinned", how=OxidizedNodeLink.HOW_MANUAL)
        FAKE["nodes"] = [node("pinned", group="grp"), node("chr1")]
        summary = sync_nodes(self.conn)
        self.assertEqual(summary["pinned"], 1)
        lk = OxidizedNodeLink.objects.get()
        self.assertEqual((lk.full_name, lk.virtual_machine_id), ("grp/pinned", self.vm.id))
        self.assertIsNotNone(lk.last_seen_at)
        self.assertIn(
            "virtual machine is pinned to another node", summary["unmatched"][0]["reason"]
        )

    def test_a_matched_link_moves_from_a_device_to_a_vm(self):
        self.device.name = "old"
        self.device.save()
        self.link(full="chr1")  # matched to sw1 by an earlier pass
        FAKE["nodes"] = [node("chr1")]
        sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get()
        self.assertEqual((lk.device_id, lk.virtual_machine_id), (None, self.vm.id))


class VmPinTests(_VmBase):
    def pin(self, **body):
        return self.client.post("/api/oxidized/links/", {
            "connection_id": str(self.conn.id), "full_name": "ghost", **body,
        }, format="json")

    def test_pinning_a_node_to_a_vm(self):
        FAKE["nodes"] = [node("ghost", ip="192.0.2.9", model="RouterOS")]
        sync_nodes(self.conn)
        self.login()
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["virtual_machine"], {"id": str(self.vm.id), "name": "chr1"})
        self.assertIsNone(body["device"])
        self.assertEqual((body["node_ip"], body["node_model"]), ("192.0.2.9", "RouterOS"))
        sync_nodes(self.conn)  # survives the next pass
        self.assertEqual(OxidizedNodeLink.objects.get().matched_by, "manual")
        r = self.client.get(f"/api/oxidized/links/?virtual_machine={self.vm.id}")
        self.assertEqual(r.json()["count"], 1)

    def test_pinning_replaces_the_vms_matched_link(self):
        self.vm_link(full="chr1")
        self.login()
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            list(OxidizedNodeLink.objects.values_list("full_name", flat=True)), ["ghost"]
        )

    def test_pinning_needs_exactly_one_target(self):
        self.login()
        r = self.pin()
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())
        r = self.pin(device_id=str(self.device.id), virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400)
        self.assertFalse(OxidizedNodeLink.objects.exists())

    def test_pinning_a_foreign_vm_is_refused(self):
        theirs = self.make_vm("theirs", tenant=self.other_tenant)
        self.login()
        r = self.pin(virtual_machine_id=str(theirs.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("virtual_machine_id", r.json())
        self.assertFalse(OxidizedNodeLink.objects.exists())

    def test_pinning_a_vm_the_user_cannot_see_is_refused(self):
        hidden = self.make_vm("hidden", site=self.site_b)
        user = self.member(
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
            (["virtualmachine"], ["view"], self.site_a),
        )
        self.login(user)
        r = self.pin(virtual_machine_id=str(hidden.id))
        self.assertEqual(r.status_code, 400)
        self.assertFalse(OxidizedNodeLink.objects.exists())
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_vm_already_pinned_is_refused(self):
        self.vm_link(full="other", how=OxidizedNodeLink.HOW_MANUAL)
        self.login()
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("virtual_machine_id", r.json())


class VmConfigTests(_VmBase):
    def setUp(self):
        super().setUp()
        self.vm_link()
        FAKE["configs"]["chr1"] = "/system identity set name=chr1\n/snmp community s3cret\n"
        FAKE["versions"]["chr1"] = [
            {"oid": OID2, "date": "2026-10-02 09:00:00 +0200", "author": "o", "message": "b"},
            {"oid": OID1, "date": "2026-10-01 09:00:00 +0200", "author": "o", "message": "a"},
        ]
        FAKE["blobs"] = {OID1: "one\n", OID2: "two\n"}

    def test_superuser_reads_current_history_diff_and_fetches(self):
        self.login()
        r = self.client.get(self.vm_url())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("s3cret", r.json()["config"])
        links = self.client.get(self.vm_url(rest="")).json()["links"]
        self.assertEqual([lk["full_name"] for lk in links], ["chr1"])
        r = self.client.get(self.vm_url(rest="versions/"))
        self.assertEqual([v["oid"] for v in r.json()["results"]], [OID2, OID1])
        r = self.client.get(self.vm_url(rest=f"versions/{OID1}/"))
        self.assertEqual(r.json()["config"], "one\n")
        r = self.client.get(self.vm_url(rest=f"diff/?from={OID1}&to={OID2}"))
        self.assertEqual((r.json()["added"], r.json()["removed"]), (1, 1))
        r = self.client.post(self.vm_url(rest="fetch-now/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(FAKE["next"][0][0], "/node/next/chr1.json")

    def test_the_verb_is_advertised_on_vms(self):
        self.assertIn("view_config", CAPABILITY_VERBS["virtualmachine"])

    def test_vm_view_alone_is_refused(self):
        self.login(self.member(
            (["virtualmachine"], ["view", "add", "change", "delete"], None)
        ))
        for rest in ("", "config/", "versions/", f"versions/{OID1}/",
                     f"diff/?from={OID1}&to={OID2}"):
            self.assertEqual(self.client.get(self.vm_url(rest=rest)).status_code, 403, rest)
        self.assertEqual(self.client.post(self.vm_url(rest="fetch-now/")).status_code, 403)
        self.assertEqual(FAKE["requests"], [])

    def test_device_view_config_does_not_reach_vms(self):
        self.login(self.member(
            (["virtualmachine"], ["view"], None), (["device"], ["view", "view_config"], None),
        ))
        self.assertEqual(self.client.get(self.vm_url()).status_code, 403)

    def test_the_built_in_wildcard_grants_do_not_carry_it(self):
        user = self.member((["*"], ["view", "add", "change", "delete"], None), username="w")
        self.login(user)
        self.assertEqual(self.client.get(self.vm_url()).status_code, 403)

    def test_view_config_grants_it_and_is_site_scoped(self):
        other = self.make_vm("chr9", site=self.site_b)
        self.vm_link(vm=other, full="chr9")
        FAKE["configs"]["chr9"] = "x\n"
        self.login(self.member(
            (["virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], self.site_a),
        ))
        self.assertEqual(self.client.get(self.vm_url()).status_code, 200)
        self.assertEqual(self.client.get(self.vm_url(vm=other)).status_code, 403)

    def test_a_vm_the_user_cannot_see_is_404(self):
        self.login(self.member((["virtualmachine"], ["view", "view_config"], self.site_b)))
        self.assertEqual(self.client.get(self.vm_url()).status_code, 404)

    def test_another_tenants_vm_is_404(self):
        theirs = self.make_vm("chr1", tenant=self.other_tenant)
        self.login()
        self.assertEqual(self.client.get(self.vm_url(vm=theirs)).status_code, 404)

    def test_links_cannot_be_borrowed_across_kinds(self):
        dev_link = self.link(full="sw1")
        FAKE["configs"]["sw1"] = "hostname sw1\n"
        self.login()
        r = self.client.get(self.vm_url(rest=f"config/?link={dev_link.id}"))
        self.assertEqual(r.status_code, 404)
        # Nor is a VM's id a device.
        r = self.client.get(f"/api/oxidized/devices/{self.vm.id}/config/")
        self.assertEqual(r.status_code, 404)

    def test_a_vm_without_a_node_is_404(self):
        bare = self.make_vm("bare", site=self.site_a)
        self.login()
        self.assertEqual(self.client.get(self.vm_url(vm=bare)).status_code, 404)

    def test_switched_off_the_vm_surface_is_404(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=False)
        self.login()
        self.assertEqual(self.client.get(self.vm_url()).status_code, 404)
