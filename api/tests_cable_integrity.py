"""A cable keeps two ends of compatible ports (#378): an update cannot empty
an end, the two ends must be kinds that plug into each other, and deleting a
device or a port does not leave the cable behind with one end."""
from __future__ import annotations

from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import call_command
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .cable_points import compatible_ends
from .models import (
    AuxPort,
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    ConsolePort,
    ConsoleServerPort,
    Device,
    DeviceType,
    FrontPort,
    Interface,
    PowerFeed,
    PowerOutlet,
    PowerPanel,
    PowerPort,
    Provider,
    RearPort,
    Site,
)

KINDS = (
    "interface", "front_port", "rear_port", "console_port", "console_server_port",
    "power_port", "power_outlet", "power_feed", "aux_port", "circuit_termination",
)

# The pairs a cable may join, either way round.
ALLOWED = {
    frozenset(p) for p in [
        ("interface", "interface"), ("interface", "front_port"),
        ("interface", "rear_port"), ("interface", "circuit_termination"),
        ("front_port", "front_port"), ("front_port", "rear_port"),
        ("rear_port", "rear_port"),
        ("front_port", "console_port"), ("front_port", "console_server_port"),
        ("front_port", "aux_port"), ("front_port", "circuit_termination"),
        ("rear_port", "console_port"), ("rear_port", "console_server_port"),
        ("rear_port", "aux_port"), ("rear_port", "circuit_termination"),
        ("console_port", "console_server_port"),
        ("aux_port", "aux_port"), ("aux_port", "console_port"),
        ("aux_port", "console_server_port"),
        ("circuit_termination", "circuit_termination"),
        ("power_port", "power_outlet"), ("power_port", "power_feed"),
    ]
}


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = get_user_model().objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.sw1 = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt,
                                         site=self.site)
        self.sw2 = Device.objects.create(tenant=self.tenant, name="sw2", device_type=dt,
                                         site=self.site)
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu1", device_type=dt,
                                         site=self.site)
        self.gi1 = Interface.objects.create(device=self.sw1, name="Gi1")
        self.gi2 = Interface.objects.create(device=self.sw2, name="Gi1")
        self.gi3 = Interface.objects.create(device=self.sw2, name="Gi2")
        self.out1 = PowerOutlet.objects.create(device=self.pdu, name="Out1")

    def cable(self, a, b):
        return self.client.post("/api/cables/", {
            "type": "cat6",
            "a": [{"kind": k, "id": str(o.id)} for k, o in a],
            "b": [{"kind": k, "id": str(o.id)} for k, o in b],
        }, format="json")

    def link(self):
        r = self.cable([("interface", self.gi1)], [("interface", self.gi2)])
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["id"]


class EmptyEndTests(_Case):
    """#378 case 1 - an update cannot leave a side empty."""

    def test_clearing_end_a_refused(self):
        cid = self.link()
        r = self.client.patch(f"/api/cables/{cid}/", {"a": []}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"a": ["Both ends need at least one port."]})
        self.assertEqual(CableTermination.objects.filter(cable_id=cid).count(), 2)

    def test_clearing_end_b_refused(self):
        cid = self.link()
        r = self.client.patch(f"/api/cables/{cid}/", {"b": []}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"b": ["Both ends need at least one port."]})

    def test_replacing_an_end_keeps_the_cable(self):
        cid = self.link()
        r = self.client.patch(f"/api/cables/{cid}/", {
            "b": [{"kind": "interface", "id": str(self.gi3.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["b_terminations"][0]["id"], str(self.gi3.id))
        self.assertTrue(Cable.objects.filter(pk=cid).exists())

    def test_existing_one_ended_cable_stays_editable(self):
        cid = self.link()
        CableTermination.objects.filter(cable_id=cid, end="A").delete()
        self.assertTrue(Cable.objects.filter(pk=cid).exists())
        r = self.client.patch(f"/api/cables/{cid}/", {"label": "fix me"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["a_terminations"], [])
        r = self.client.patch(f"/api/cables/{cid}/", {
            "a": [{"kind": "interface", "id": str(self.gi1.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)


class CompatibilityTests(_Case):
    """#378 case 2 - the two ends must be kinds that plug into each other."""

    def test_interface_to_power_outlet_refused(self):
        r = self.cable([("interface", self.gi1)], [("power_outlet", self.out1)])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"b": ["An interface can't be cabled to a power outlet."]})
        self.assertFalse(Cable.objects.exists())

    def test_the_rule_table(self):
        for a in KINDS:
            for b in KINDS:
                with self.subTest(a=a, b=b):
                    self.assertEqual(compatible_ends(a, b), frozenset((a, b)) in ALLOWED)

    def test_every_pair_through_the_api(self):
        rp = RearPort.objects.create(device=self.sw1, name="R1", positions=2)
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="P1")
        provider = Provider.objects.create(tenant=self.tenant, name="T", slug="t")
        circuit = Circuit.objects.create(tenant=self.tenant, cid="C1", provider=provider)

        def fresh(kind, n):
            dev = Device.objects.create(tenant=self.tenant, name=f"d-{kind}-{n}",
                                        site=self.site)
            name = f"p{n}"
            if kind == "interface":
                return Interface.objects.create(device=dev, name=name)
            if kind == "front_port":
                rear = RearPort.objects.create(device=dev, name=f"r{n}")
                return FrontPort.objects.create(device=dev, name=name, rear_port=rear,
                                                rear_port_position=1)
            if kind == "rear_port":
                return RearPort.objects.create(device=dev, name=name)
            if kind == "console_port":
                return ConsolePort.objects.create(device=dev, name=name)
            if kind == "console_server_port":
                return ConsoleServerPort.objects.create(device=dev, name=name)
            if kind == "power_port":
                return PowerPort.objects.create(device=dev, name=name)
            if kind == "power_outlet":
                return PowerOutlet.objects.create(device=dev, name=name)
            if kind == "aux_port":
                return AuxPort.objects.create(device=dev, name=name)
            if kind == "power_feed":
                return PowerFeed.objects.create(tenant=self.tenant, power_panel=panel,
                                                name=f"f-{dev.name}")
            return CircuitTermination.objects.create(
                circuit=Circuit.objects.create(tenant=self.tenant, cid=f"C-{dev.name}",
                                               provider=provider),
                term_side="A", site=self.site)

        del rp, circuit
        n = 0
        for a in KINDS:
            for b in KINDS:
                n += 1
                with self.subTest(a=a, b=b):
                    r = self.cable([(a, fresh(a, n))], [(b, fresh(b, n + 1000))])
                    want = 201 if frozenset((a, b)) in ALLOWED else 400
                    self.assertEqual(r.status_code, want, r.content)

    def test_changing_one_end_to_an_incompatible_kind_refused(self):
        cid = self.link()
        r = self.client.patch(f"/api/cables/{cid}/", {
            "b": [{"kind": "power_outlet", "id": str(self.out1.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_existing_incompatible_cable_stays_editable(self):
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", interface=self.gi1)
        CableTermination.objects.create(cable=cable, end="B", power_outlet=self.out1)
        r = self.client.patch(f"/api/cables/{cable.id}/", {"label": "check"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get(f"/api/cables/{cable.id}/").status_code, 200)

    def test_discovered_link_still_cables_two_interfaces(self):
        # The monitoring drift "connect" path runs the same serializer.
        r = self.cable([("interface", self.gi1)], [("interface", self.gi3)])
        self.assertEqual(r.status_code, 201, r.content)


class DeleteTests(_Case):
    """#378 case 3 - removing a device or a port removes the cables it leaves
    with an empty end."""

    def test_deleting_a_device_removes_its_cables(self):
        cid = self.link()
        r = self.client.delete(f"/api/devices/{self.sw1.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(Cable.objects.filter(pk=cid).exists())
        self.assertFalse(CableTermination.objects.filter(cable_id=cid).exists())
        self.assertTrue(Interface.objects.filter(pk=self.gi2.pk).exists())

    def test_deleting_an_interface_removes_its_cable(self):
        cid = self.link()
        r = self.client.delete(f"/api/interfaces/{self.gi2.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(Cable.objects.filter(pk=cid).exists())

    def test_a_breakout_keeps_its_other_legs(self):
        r = self.cable([("interface", self.gi1)],
                       [("interface", self.gi2), ("interface", self.gi3)])
        cid = r.json()["id"]
        self.gi3.delete()
        self.assertTrue(Cable.objects.filter(pk=cid).exists())
        self.assertEqual(CableTermination.objects.filter(cable_id=cid).count(), 2)
        self.sw2.delete()
        self.assertFalse(Cable.objects.filter(pk=cid).exists())

    def test_a_loop_on_one_device_goes_with_it(self):
        lo = Interface.objects.create(device=self.sw1, name="Gi9")
        r = self.cable([("interface", self.gi1)], [("interface", lo)])
        cid = r.json()["id"]
        self.sw1.delete()
        self.assertFalse(Cable.objects.filter(pk=cid).exists())

    def test_queryset_delete_of_devices(self):
        cid = self.link()
        Device.objects.filter(pk__in=[self.sw1.pk]).delete()
        self.assertFalse(Cable.objects.filter(pk=cid).exists())

    def test_cable_removal_is_in_the_change_log(self):
        from audit.models import ChangeLogEntry

        cid = self.link()
        self.client.delete(f"/api/devices/{self.sw1.id}/")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(cid), action="delete").exists())


class FindCommandTests(_Case):
    def test_lists_one_ended_and_incompatible_cables(self):
        cid = self.link()
        CableTermination.objects.filter(cable_id=cid, end="A").delete()
        bad = Cable.objects.create(tenant=self.tenant, type="cat6", label="bad")
        CableTermination.objects.create(cable=bad, end="A", interface=self.gi1)
        CableTermination.objects.create(cable=bad, end="B", power_outlet=self.out1)
        out = StringIO()
        call_command("check_dcim_integrity", stdout=out)
        text = out.getvalue()
        self.assertIn("no A end", text)
        self.assertIn("bad", text)
        self.assertIn("interface to power outlet", text)
        # Read-only: nothing is changed.
        self.assertTrue(Cable.objects.filter(pk=cid).exists())
        self.assertTrue(Cable.objects.filter(pk=bad.pk).exists())
