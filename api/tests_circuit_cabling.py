"""Cabling a circuit's end to a device port (#118).

The provider hands off at a demarc, and that handoff lands on a real switch
port. Before this, a circuit end was only reachable as free text in
``pp_info``; now it's a cable endpoint like any other, so the trace runs from
the interface all the way out to the circuit.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.utils import IntegrityError
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Device,
    DeviceType,
    Interface,
    PortReservation,
    Provider,
    Site,
)

User = get_user_model()


class CircuitCablingTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=self.site
        )
        self.port = Interface.objects.create(device=self.sw, name="Et1/1")
        self.other = Interface.objects.create(device=self.sw, name="Et1/2")

        prov = Provider.objects.create(tenant=self.tenant, name="Telco", slug="telco")
        self.circuit = Circuit.objects.create(
            tenant=self.tenant, cid="ACME-1234", provider=prov
        )
        self.term = CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site
        )

    def _cable(self, a_kind, a_id, b_kind, b_id):
        return self.client.post(
            "/api/cables/",
            {
                "type": "cat6",
                "a": [{"kind": a_kind, "id": str(a_id)}],
                "b": [{"kind": b_kind, "id": str(b_id)}],
            },
            format="json",
        )

    def test_circuit_end_cables_to_an_interface(self):
        r = self._cable("circuit_termination", self.term.id, "interface", self.port.id)
        self.assertEqual(r.status_code, 201, r.content)
        a = r.json()["a_terminations"][0]
        self.assertEqual(a["kind"], "circuit_termination")
        # A circuit end has no device and no name of its own: it reads as its
        # circuit plus the side, so the cable UI renders one shape per end.
        self.assertEqual(a["name"], "Side A")
        self.assertEqual(a["device"]["name"], "ACME-1234")

    def test_a_circuit_end_takes_one_cable_only(self):
        self.assertEqual(
            self._cable(
                "circuit_termination", self.term.id, "interface", self.port.id
            ).status_code,
            201,
        )
        r = self._cable(
            "circuit_termination", self.term.id, "interface", self.other.id
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("already cabled", str(r.content))

    def test_one_end_stays_one_kind(self):
        r = self.client.post(
            "/api/cables/",
            {
                "type": "cat6",
                "a": [
                    {"kind": "circuit_termination", "id": str(self.term.id)},
                    {"kind": "interface", "id": str(self.other.id)},
                ],
                "b": [{"kind": "interface", "id": str(self.port.id)}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_cross_tenant_circuit_is_refused(self):
        org = Organization.objects.create(name="Other", slug="other")
        other_tenant = Tenant.objects.create(org=org, name="Other", slug="other")
        prov = Provider.objects.create(
            tenant=other_tenant, name="Telco2", slug="telco2"
        )
        circuit = Circuit.objects.create(
            tenant=other_tenant, cid="OTHER-1", provider=prov
        )
        term = CircuitTermination.objects.create(
            circuit=circuit,
            term_side="A",
            site=Site.objects.create(tenant=other_tenant, name="dc2"),
        )
        r = self._cable("circuit_termination", term.id, "interface", self.port.id)
        self.assertEqual(r.status_code, 400, r.content)

    def test_trace_reaches_the_circuit_and_is_complete(self):
        self.assertEqual(
            self._cable(
                "circuit_termination", self.term.id, "interface", self.port.id
            ).status_code,
            201,
        )
        r = self.client.get(f"/api/interfaces/{self.port.id}/trace/")
        self.assertEqual(r.status_code, 200, r.content)
        g = r.json()
        self.assertTrue(g["complete"])
        node = next(n for n in g["nodes"] if n["type"] == "circuit_termination")
        self.assertEqual(node["data"]["name"], "Side A")
        self.assertEqual(node["data"]["device_name"], "ACME-1234")
        # No membership edge: a circuit isn't a device, so it gets no device
        # box on the canvas to be grouped under.
        self.assertIsNone(node["data"]["device_id"])

    def test_device_paths_shows_the_circuit_run(self):
        """The device page's runs list said "nothing cabled" for a port whose
        far end is a circuit - the link walk dropped endpoints without a
        device_id. The circuit is the far chip now."""
        self.assertEqual(
            self._cable(
                "circuit_termination", self.term.id, "interface", self.port.id
            ).status_code,
            201,
        )
        r = self.client.get(f"/api/devices/{self.sw.id}/paths/")
        self.assertEqual(r.status_code, 200, r.content)
        runs = r.json()["runs"]
        self.assertEqual(len(runs), 1)
        chips = [st for st in runs[0]["steps"] if st["t"] == "chip"]
        far = next(c for c in chips if c.get("circuit"))
        self.assertEqual(far["device"], "ACME-1234")
        self.assertEqual(far["ports"][0]["name"], "Side A")

    def test_termination_endpoint_reports_its_cable(self):
        self.assertEqual(
            self._cable(
                "circuit_termination", self.term.id, "interface", self.port.id
            ).status_code,
            201,
        )
        r = self.client.get(f"/api/circuit-terminations/?circuit={self.circuit.id}")
        self.assertEqual(r.status_code, 200, r.content)
        row = r.json()["results"][0]
        self.assertEqual(row["circuit"]["cid"], "ACME-1234")
        self.assertIsNotNone(row["cable"])
        # The far end of the run - the switch port the handoff lands on -
        # rides along so the circuit page can show it (#118 follow-up).
        far = row["connected_to"]
        self.assertEqual(far["kind"], "interface")
        self.assertEqual(far["device"]["name"], self.sw.name)
        self.assertEqual(far["name"], self.port.name)

    def test_a_circuit_end_cannot_be_reserved(self):
        # You reserve a port on a box; PortReservation has no FK for a circuit
        # end, and its constraints must not reach for one.
        self.assertNotIn("circuit_termination", PortReservation.POINT_FIELDS)
        names = {c.name for c in PortReservation._meta.constraints}
        self.assertNotIn("uniq_reservation_circuit_termination", names)

    def test_a_termination_still_holds_exactly_one_point(self):
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        with self.assertRaises(IntegrityError):
            CableTermination.objects.create(
                cable=cable,
                end="A",
                interface=self.port,
                circuit_termination=self.term,
            )
