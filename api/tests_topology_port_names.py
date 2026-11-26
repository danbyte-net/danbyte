"""What the topology prints a port by (#541): the payload carries each
cabled port's label and description, and a device's own choice, without
another query; a saved view keeps its choice as ``filters.portName``."""
from __future__ import annotations

from django.db import connection
from django.test.utils import CaptureQueriesContext

from .models import Device, FrontPort, Interface, RearPort
from .tests_topology import _Base


class PortTextPayloadTests(_Base):
    def setUp(self):
        super().setUp()
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1")
        self.srv = Device.objects.create(tenant=self.tenant, name="srv1")
        self.panel = Device.objects.create(tenant=self.tenant, name="pp1")
        self.up = Interface.objects.create(
            device=self.sw, name="Gi1/0/1", label="P1",
            description="Uplink to core",
        )
        self.nic = Interface.objects.create(device=self.srv, name="eth0")
        rear = RearPort.objects.create(
            device=self.panel, name="R1", positions=1, label="Trunk A",
            description="To MDF",
        )
        self.front = FrontPort.objects.create(
            device=self.panel, name="F1", rear_port=rear,
            rear_port_position=1, description="Desk 12",
        )
        far = Interface.objects.create(device=self.sw, name="Gi1/0/2")
        self._cable(self.up, self.nic)
        self._cable(far, self.front)
        self.mdf = Interface.objects.create(device=self.srv, name="eth1")
        self._cable(rear, self.mdf)

    def _node(self, g, dev):
        return next(n for n in g["nodes"] if n["id"] == f"dev:{dev.id}")

    def _port(self, node, name):
        return next(p for p in node["data"]["ports"] if p["name"] == name)

    def test_ports_carry_label_and_description(self):
        g = self._graph()
        up = self._port(self._node(g, self.sw), "Gi1/0/1")
        self.assertEqual(up["label"], "P1")
        self.assertEqual(up["description"], "Uplink to core")
        # Empty fields are left out, not sent blank.
        nic = self._port(self._node(g, self.srv), "eth0")
        self.assertNotIn("label", nic)
        self.assertNotIn("description", nic)

    def test_a_pass_through_row_carries_its_rear_ports_too(self):
        g = self._graph("collapse_panels=0")
        row = self._port(self._node(g, self.panel), "F1")
        self.assertEqual(row["pair"], "R1")
        self.assertEqual(row["description"], "Desk 12")
        self.assertNotIn("label", row)
        self.assertEqual(row["pair_label"], "Trunk A")
        self.assertEqual(row["pair_description"], "To MDF")

    def test_device_choice_is_sent_only_when_set(self):
        g = self._graph()
        self.assertNotIn("port_name", self._node(g, self.sw)["data"])
        Device.objects.filter(pk=self.sw.pk).update(topology_port_name="label")
        g = self._graph()
        self.assertEqual(self._node(g, self.sw)["data"]["port_name"], "label")

    def test_query_count_is_unchanged_by_the_texts(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._graph("collapse_panels=0")
            return len(ctx.captured_queries)

        Interface.objects.filter(device=self.srv).update(label="", description="")
        before = count()
        # Labels and descriptions everywhere, and a device's own choice.
        Interface.objects.all().update(label="L", description="D")
        FrontPort.objects.all().update(label="L", description="D")
        RearPort.objects.all().update(label="L", description="D")
        Device.objects.all().update(topology_port_name="description")
        self.assertEqual(count(), before)


class DevicePortNameApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.dev = Device.objects.create(tenant=self.tenant, name="sw1")

    def test_set_and_clear(self):
        url = f"/api/devices/{self.dev.id}/"
        r = self.client.patch(url, {"topology_port_name": "description"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["topology_port_name"], "description")
        r = self.client.patch(url, {"topology_port_name": ""}, format="json")
        self.assertEqual(r.json()["topology_port_name"], "")

    def test_unknown_choice_is_refused(self):
        r = self.client.patch(
            f"/api/devices/{self.dev.id}/", {"topology_port_name": "alias"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("topology_port_name", r.json())

    def test_clone_carries_it(self):
        self.dev.topology_port_name = "label"
        self.dev.save()
        r = self.client.get(f"/api/devices/{self.dev.id}/clone/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["initial"]["topology_port_name"], "label")


class SavedViewPortNameTests(_Base):
    def _save(self, filters):
        return self.client.post(
            "/api/topology-views/",
            {"name": "v", "state": {"filters": filters}}, format="json",
        )

    def test_round_trips(self):
        r = self._save({"portName": "description"})
        self.assertEqual(r.status_code, 201, r.content)
        got = self.client.get(f"/api/topology-views/{r.json()['id']}/").json()
        self.assertEqual(got["state"]["filters"]["portName"], "description")

    def test_unknown_choice_is_refused(self):
        r = self._save({"portName": "alias"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("portName", str(r.content))
