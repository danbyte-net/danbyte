"""The cable list's search box and ``?device=`` filter."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    ConsolePort,
    ConsoleServerPort,
    Device,
    Interface,
    PowerOutlet,
    PowerPort,
)

User = get_user_model()


class CableListFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _dev(self, name):
        return Device.objects.create(tenant=self.tenant, name=name)

    def _cable(self, a, b, **kw):
        cable = Cable.objects.create(tenant=self.tenant, **kw)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)
        return cable

    def _ids(self, query):
        r = self.client.get(f"/api/cables/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return {row["id"] for row in r.json()["results"]}

    def test_search_finds_a_cable_by_label(self):
        sw = self._dev("sw1")
        rtr = self._dev("rtr1")
        cable = self._cable(
            {"interface": Interface.objects.create(device=sw, name="Gi1")},
            {"interface": Interface.objects.create(device=rtr, name="Gi2")},
            label="TDC-F06", type="cat6",
        )
        self._cable(
            {"interface": Interface.objects.create(device=sw, name="Gi3")},
            {"interface": Interface.objects.create(device=rtr, name="Gi4")},
            label="other", type="cat6",
        )
        self.assertEqual(self._ids("search=TDC-F06"), {str(cable.id)})
        self.assertEqual(self._ids("search=tdc-f0"), {str(cable.id)})
        self.assertEqual(self._ids("search=TDC-F06&view=table"), {str(cable.id)})

    def test_device_filter_covers_every_end_kind(self):
        pdu = self._dev("pdu1")
        srv = self._dev("srv1")
        sw_a = self._dev("sw-a")
        sw_b = self._dev("sw-b")
        con = self._dev("con1")
        other = self._dev("other")

        inlet = PowerPort.objects.create(device=pdu, name="Inlet")
        outlet = PowerOutlet.objects.create(device=pdu, name="Out1", power_port=inlet)
        cord = self._cable(
            {"power_outlet": outlet},
            {"power_port": PowerPort.objects.create(device=srv, name="PSU1")},
            type="power",
        )
        stack = self._cable(
            {"power_port": PowerPort.objects.create(
                device=sw_a, name="SP1", type="cisco-stackpower")},
            {"power_port": PowerPort.objects.create(
                device=sw_b, name="SP1", type="cisco-stackpower")},
            type="stack-power",
        )
        console = self._cable(
            {"console_port": ConsolePort.objects.create(device=sw_a, name="con0")},
            {"console_server_port": ConsoleServerPort.objects.create(
                device=con, name="p1")},
        )
        data = self._cable(
            {"interface": Interface.objects.create(device=sw_a, name="Gi1")},
            {"interface": Interface.objects.create(device=other, name="Gi1")},
            type="cat6",
        )

        self.assertEqual(self._ids(f"device={pdu.id}"), {str(cord.id)})
        self.assertEqual(self._ids(f"device={srv.id}"), {str(cord.id)})
        self.assertEqual(self._ids(f"device={sw_b.id}"), {str(stack.id)})
        self.assertEqual(self._ids(f"device={con.id}"), {str(console.id)})
        self.assertEqual(
            self._ids(f"device={sw_a.id}"),
            {str(stack.id), str(console.id), str(data.id)},
        )
        self.assertEqual(
            self._ids(f"device={sw_a.id}&view=table"),
            {str(stack.id), str(console.id), str(data.id)},
        )
        self.assertEqual(self._ids(f"device_id={pdu.id}"), {str(cord.id)})

    def test_device_filter_rejects_a_bad_id(self):
        r = self.client.get("/api/cables/?device=nope")
        self.assertEqual(r.status_code, 400)

    def test_device_filter_stays_in_the_tenant(self):
        org = Organization.objects.create(name="Other", slug="other")
        foreign = Tenant.objects.create(org=org, name="Other", slug="other")
        dev = Device.objects.create(tenant=foreign, name="pdu-x")
        far = Device.objects.create(tenant=foreign, name="srv-x")
        inlet = PowerPort.objects.create(device=dev, name="Inlet")
        cable = Cable.objects.create(tenant=foreign, type="power")
        CableTermination.objects.create(
            cable=cable, end="A",
            power_outlet=PowerOutlet.objects.create(device=dev, name="o", power_port=inlet))
        CableTermination.objects.create(
            cable=cable, end="B", power_port=PowerPort.objects.create(device=far, name="p"))
        self.assertEqual(self._ids(f"device={dev.id}"), set())
