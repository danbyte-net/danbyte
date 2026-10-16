"""A circuit end on a virtual machine interface (#432).

A cloud router - a CHR, pfSense or VyOS VM - takes the provider's link on a
virtual NIC. That NIC is never cabled, so the circuit end binds to it
directly: the VM interface stands where the cable to a device port would.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Cluster,
    ClusterType,
    Device,
    Interface,
    Provider,
    ProviderNetwork,
    Site,
    VirtualMachine,
    VMInterface,
)

User = get_user_model()

URL = "/api/circuit-terminations/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        ctype = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ctype)
        self.chr = VirtualMachine.objects.create(
            tenant=self.tenant, name="chr-a", cluster=self.cluster, site=self.site_a
        )
        self.ether1 = VMInterface.objects.create(vm=self.chr, name="ether1")
        self.ether2 = VMInterface.objects.create(vm=self.chr, name="ether2")
        self.vm_b = VirtualMachine.objects.create(
            tenant=self.tenant, name="chr-b", cluster=self.cluster, site=self.site_b
        )
        self.vmi_b = VMInterface.objects.create(vm=self.vm_b, name="ether1")
        self.provider = Provider.objects.create(
            tenant=self.tenant, name="ISP", slug="isp"
        )
        self.pn = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="Internet"
        )
        self.circuit = Circuit.objects.create(
            tenant=self.tenant, cid="INET-1", provider=self.provider
        )
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, **body):
        return self.client.post(
            URL, {"circuit_id": str(self.circuit.id), "term_side": "Z", **body},
            format="json",
        )


class ModelTests(_Base):
    def test_one_circuit_end_per_vm_interface(self):
        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_a,
            vm_interface=self.ether1,
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CircuitTermination.objects.create(
                circuit=self.circuit, term_side="Z", site=self.site_a,
                vm_interface=self.ether1,
            )

    def test_the_site_or_provider_network_rule_still_holds(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            CircuitTermination.objects.create(
                circuit=self.circuit, term_side="A", vm_interface=self.ether1
            )

    def test_deleting_the_vm_keeps_the_circuit_end(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_a,
            vm_interface=self.ether1,
        )
        self.chr.delete()
        t.refresh_from_db()
        self.assertIsNone(t.vm_interface_id)
        self.assertEqual(t.site_id, self.site_a.id)


class ApiTests(_Base):
    def test_create_on_a_vm_interface_lands_at_the_vms_site(self):
        r = self._post(vm_interface_id=str(self.ether1.id))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["site"]["id"], str(self.site_a.id))
        self.assertEqual(body["vm_interface"], {
            "id": str(self.ether1.id), "name": "ether1",
            "vm": {"id": str(self.chr.id), "name": "chr-a"},
        })
        self.assertIsNone(body["cable"])

    def test_create_at_a_provider_network_keeps_it(self):
        r = self._post(
            provider_network_id=str(self.pn.id), vm_interface_id=str(self.ether1.id)
        )
        self.assertEqual(r.status_code, 201, r.content)
        t = CircuitTermination.objects.get(pk=r.json()["id"])
        self.assertIsNone(t.site_id)
        self.assertEqual(t.provider_network_id, self.pn.id)
        self.assertEqual(t.vm_interface_id, self.ether1.id)

    def test_a_vm_at_another_site_is_refused(self):
        r = self._post(site_id=str(self.site_b.id), vm_interface_id=str(self.ether1.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("vm_interface_id", r.json())
        self.assertFalse(CircuitTermination.objects.exists())

    def test_a_vm_without_a_site_needs_one_given(self):
        self.chr.site = None
        self.chr.save()
        self.assertEqual(self._post(vm_interface_id=str(self.ether1.id)).status_code, 400)
        r = self._post(site_id=str(self.site_b.id), vm_interface_id=str(self.ether1.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_update_moves_and_clears_the_vm_interface(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="Z", site=self.site_a
        )
        r = self.client.patch(
            f"{URL}{t.id}/", {"vm_interface_id": str(self.ether2.id)}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["vm_interface"]["name"], "ether2")
        r = self.client.patch(f"{URL}{t.id}/", {"vm_interface_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        t.refresh_from_db()
        self.assertIsNone(t.vm_interface_id)

    def test_a_vm_interface_takes_one_circuit_end(self):
        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_a,
            vm_interface=self.ether1,
        )
        r = self._post(vm_interface_id=str(self.ether1.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("INET-1 side A", str(r.json()["vm_interface_id"]))

    def test_a_cabled_end_cannot_also_take_a_vm_interface(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="Z", site=self.site_a
        )
        dev = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        port = Interface.objects.create(device=dev, name="Et1")
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", circuit_termination=t)
        CableTermination.objects.create(cable=cable, end="B", interface=port)
        r = self.client.patch(
            f"{URL}{t.id}/", {"vm_interface_id": str(self.ether1.id)}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)
        t.refresh_from_db()
        self.assertIsNone(t.vm_interface_id)
        # The cabled end still edits as before.
        r = self.client.patch(f"{URL}{t.id}/", {"xconnect_id": "XC-9"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_end_on_a_vm_interface_takes_no_cable(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="Z", site=self.site_a,
            vm_interface=self.ether1,
        )
        dev = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        port = Interface.objects.create(device=dev, name="Et1")
        r = self.client.post("/api/cables/", {
            "type": "cat6",
            "a": [{"kind": "circuit_termination", "id": str(t.id)}],
            "b": [{"kind": "interface", "id": str(port.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(Cable.objects.exists())

    def test_another_tenants_vm_interface_is_refused(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        ctype = ClusterType.objects.create(tenant=other, name="kvm", slug="kvm")
        cl = Cluster.objects.create(tenant=other, name="c", type=ctype)
        vm = VirtualMachine.objects.create(tenant=other, name="theirs", cluster=cl)
        vmi = VMInterface.objects.create(vm=vm, name="eth0")
        r = self._post(site_id=str(self.site_a.id), vm_interface_id=str(vmi.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("vm_interface_id", r.json())
        self.assertFalse(CircuitTermination.objects.exists())

    def test_circuit_detail_lists_the_vm_end(self):
        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_b
        )
        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="Z", site=self.site_a,
            vm_interface=self.ether1,
        )
        ends = {
            t["term_side"]: t
            for t in self.client.get(f"/api/circuits/{self.circuit.id}/").json()["terminations"]
        }
        self.assertIsNone(ends["A"]["vm_interface"])
        self.assertEqual(ends["Z"]["vm_interface"]["vm"]["name"], "chr-a")

    def test_vm_interfaces_show_their_circuit(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="Z", site=self.site_a,
            vm_interface=self.ether1,
        )
        r = self.client.get(f"/api/vm-interfaces/?vm={self.chr.id}")
        self.assertEqual(r.status_code, 200, r.content)
        rows = {i["name"]: i for i in r.json()["results"]}
        self.assertEqual(rows["ether1"]["circuit_termination"], {
            "id": str(t.id), "side": "Z",
            "circuit": {"id": str(self.circuit.id), "cid": "INET-1"},
        })
        self.assertIsNone(rows["ether2"]["circuit_termination"])

    def test_the_vm_interface_list_stays_flat_with_circuits(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        def count():
            url = f"/api/vm-interfaces/?vm={self.chr.id}"
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get(url).status_code, 200)
            return len(ctx.captured_queries)

        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_a,
            vm_interface=self.ether1,
        )
        before = count()
        for i in range(4):
            circuit = Circuit.objects.create(
                tenant=self.tenant, cid=f"INET-{i + 10}", provider=self.provider
            )
            CircuitTermination.objects.create(
                circuit=circuit, term_side="A", site=self.site_a,
                vm_interface=VMInterface.objects.create(vm=self.chr, name=f"ether{i + 3}"),
            )
        self.assertEqual(count(), before)

    def test_the_change_log_records_the_vm_interface_and_its_site(self):
        r = self._post(
            provider_network_id=str(self.pn.id), vm_interface_id=str(self.ether1.id)
        )
        self.assertEqual(r.status_code, 201, r.content)
        entry = ChangeLogEntry.objects.get(
            object_type="api.circuittermination", object_id=r.json()["id"]
        )
        # A provider-network end takes its site from the VM it lands on.
        self.assertEqual(entry.object_site_id, self.site_a.id)
        self.assertEqual(
            str(entry.post_change["vm_interface"]), str(self.ether1.id)
        )


class SiteLimitedTests(_Base):
    """A user limited to site A, writing circuit ends."""

    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="g", object_types=["*"], actions=["view", "add", "change", "delete"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set([self.site_a])
        self._login(self.user)

    def _ids(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 200, r.content)
        return {row["id"] for row in r.json()["results"]}

    def test_a_vm_end_follows_the_vms_site(self):
        own = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", provider_network=self.pn,
            vm_interface=self.ether1,
        )
        circuit2 = Circuit.objects.create(
            tenant=self.tenant, cid="INET-2", provider=self.provider
        )
        theirs = CircuitTermination.objects.create(
            circuit=circuit2, term_side="A", provider_network=self.pn,
            vm_interface=self.vmi_b, xconnect_id="B-secret",
        )
        ids = self._ids()
        self.assertIn(str(own.id), ids)
        self.assertNotIn(str(theirs.id), ids)
        self.assertEqual(self.client.get(f"{URL}{theirs.id}/").status_code, 404)
        r = self.client.patch(f"{URL}{theirs.id}/", {"xconnect_id": "x"}, format="json")
        self.assertEqual(r.status_code, 404)
        self.assertNotIn(
            "B-secret", self.client.get(f"/api/circuits/{circuit2.id}/").content.decode()
        )

    def test_landing_on_another_sites_vm_is_refused(self):
        r = self._post(
            provider_network_id=str(self.pn.id), vm_interface_id=str(self.vmi_b.id)
        )
        self.assertIn(r.status_code, (400, 403), r.content)
        self.assertFalse(CircuitTermination.objects.exists())
        r = self._post(vm_interface_id=str(self.vmi_b.id))
        self.assertIn(r.status_code, (400, 403), r.content)
        self.assertFalse(CircuitTermination.objects.exists())

    def test_moving_an_own_end_onto_another_sites_vm_is_refused(self):
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", provider_network=self.pn,
            vm_interface=self.ether1,
        )
        r = self.client.patch(
            f"{URL}{t.id}/", {"vm_interface_id": str(self.vmi_b.id)}, format="json"
        )
        self.assertIn(r.status_code, (400, 403), r.content)
        t.refresh_from_db()
        self.assertEqual(t.vm_interface_id, self.ether1.id)

    def test_landing_on_an_own_vm_works(self):
        r = self._post(vm_interface_id=str(self.ether1.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_vm_interface_hides_a_circuit_end_the_user_cannot_view(self):
        # The VM moved to site A after its NIC took site B's circuit end.
        t = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site_b,
            vm_interface=self.vmi_b,
        )
        self.vm_b.site = self.site_a
        self.vm_b.save()
        r = self.client.get(f"/api/vm-interfaces/?vm={self.vm_b.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["results"][0]["circuit_termination"])
        self.assertNotIn(str(t.id), r.content.decode())
