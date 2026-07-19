"""Tier-1 NetBox-parity tests: circuit/tunnel terminations, console + device
power components (incl. cable termination arms), and device-type component
template materialization."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Circuit, CircuitTermination, ConsolePort, ConsolePortTemplate, Device,
    DeviceType, FrontPortTemplate, Interface, InterfaceTemplate, IPAddress,
    PowerOutletTemplate, PowerPortTemplate, Prefix, Provider, ProviderNetwork,
    RearPortTemplate, Tunnel, TunnelTermination,
)
from core.models import Organization, Tenant


class _TenantAPITestCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class CircuitTerminationTests(_TenantAPITestCase):
    def setUp(self):
        super().setUp()
        self.provider = Provider.objects.create(
            tenant=self.tenant, name="Telia", slug="telia"
        )
        self.circuit = Circuit.objects.create(
            tenant=self.tenant, cid="CID-1", provider=self.provider
        )
        from api.models import Site
        self.site = Site.objects.create(tenant=self.tenant, name="DC1")
        self.pn = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="Telia IP transit"
        )

    def test_terminate_a_on_site_z_on_provider_network(self):
        a = self.client.post("/api/circuit-terminations/", {
            "circuit_id": str(self.circuit.id), "term_side": "A",
            "site_id": str(self.site.id), "port_speed_kbps": 1000000,
            "xconnect_id": "XC-77",
        }, format="json")
        self.assertEqual(a.status_code, 201, a.content)
        z = self.client.post("/api/circuit-terminations/", {
            "circuit_id": str(self.circuit.id), "term_side": "Z",
            "provider_network_id": str(self.pn.id),
        }, format="json")
        self.assertEqual(z.status_code, 201, z.content)
        # Nested read on the circuit carries both ends.
        body = self.client.get(f"/api/circuits/{self.circuit.id}/").json()
        sides = {t["term_side"]: t for t in body["terminations"]}
        self.assertEqual(sides["A"]["site"]["id"], str(self.site.id))
        self.assertEqual(sides["A"]["xconnect_id"], "XC-77")
        self.assertEqual(
            sides["Z"]["provider_network"]["id"], str(self.pn.id)
        )

    def test_exactly_one_endpoint_enforced(self):
        r = self.client.post("/api/circuit-terminations/", {
            "circuit_id": str(self.circuit.id), "term_side": "A",
            "site_id": str(self.site.id),
            "provider_network_id": str(self.pn.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/circuit-terminations/", {
            "circuit_id": str(self.circuit.id), "term_side": "A",
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_one_termination_per_side(self):
        CircuitTermination.objects.create(
            circuit=self.circuit, term_side="A", site=self.site
        )
        r = self.client.post("/api/circuit-terminations/", {
            "circuit_id": str(self.circuit.id), "term_side": "A",
            "site_id": str(self.site.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)


class TunnelTerminationTests(_TenantAPITestCase):
    def setUp(self):
        super().setUp()
        self.tunnel = Tunnel.objects.create(tenant=self.tenant, name="vpn-1")
        self.dev = Device.objects.create(tenant=self.tenant, name="fw1")
        self.iface = Interface.objects.create(device=self.dev, name="wan0")
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="203.0.113.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address="203.0.113.10",
            assigned_device=self.dev, assigned_interface=self.iface,
        )

    def test_terminate_on_interface_with_outside_ip(self):
        r = self.client.post("/api/tunnel-terminations/", {
            "tunnel_id": str(self.tunnel.id), "role": "hub",
            "interface_id": str(self.iface.id),
            "outside_ip_id": str(self.ip.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = self.client.get(f"/api/tunnels/{self.tunnel.id}/").json()
        (t,) = body["terminations"]
        self.assertEqual(t["role"], "hub")
        self.assertEqual(t["interface"]["id"], str(self.iface.id))
        self.assertEqual(t["interface"]["device"]["name"], "fw1")
        self.assertEqual(t["outside_ip"]["ip_address"], "203.0.113.10")

    def test_exactly_one_interface_enforced(self):
        r = self.client.post("/api/tunnel-terminations/", {
            "tunnel_id": str(self.tunnel.id), "role": "peer",
        }, format="json")
        self.assertEqual(r.status_code, 400)


class ConsolePowerComponentTests(_TenantAPITestCase):
    def setUp(self):
        super().setUp()
        self.dev = Device.objects.create(tenant=self.tenant, name="sw1")
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu1")

    def test_console_port_crud(self):
        r = self.client.post("/api/console-ports/", {
            "device_id": str(self.dev.id), "name": "con0", "type": "rj-45",
            "speed": 115200,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["type_display"], "RJ-45")

    def test_power_outlet_requires_same_device_inlet(self):
        inlet = self.client.post("/api/power-ports/", {
            "device_id": str(self.pdu.id), "name": "inlet1",
            "type": "iec-60320-c14", "maximum_draw": 3000,
        }, format="json")
        self.assertEqual(inlet.status_code, 201, inlet.content)
        ok = self.client.post("/api/power-outlets/", {
            "device_id": str(self.pdu.id), "name": "out1",
            "type": "iec-60320-c13", "power_port_id": inlet.json()["id"],
        }, format="json")
        self.assertEqual(ok.status_code, 201, ok.content)
        # An inlet on a different device is rejected.
        bad = self.client.post("/api/power-outlets/", {
            "device_id": str(self.dev.id), "name": "out1",
            "power_port_id": inlet.json()["id"],
        }, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_cable_terminates_console_and_power(self):
        con = ConsolePort.objects.create(device=self.dev, name="con0")
        srv = Device.objects.create(tenant=self.tenant, name="ts1")
        cs = self.client.post("/api/console-server-ports/", {
            "device_id": str(srv.id), "name": "port7",
        }, format="json")
        self.assertEqual(cs.status_code, 201, cs.content)
        r = self.client.post("/api/cables/", {
            "a": [{"kind": "console_port", "id": str(con.id)}],
            "b": [{"kind": "console_server_port", "id": cs.json()["id"]}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        kinds = {t["kind"] for t in
                 r.json()["a_terminations"] + r.json()["b_terminations"]}
        self.assertEqual(kinds, {"console_port", "console_server_port"})
        # The same console port can't be cabled twice.
        again = self.client.post("/api/cables/", {
            "a": [{"kind": "console_port", "id": str(con.id)}],
            "b": [{"kind": "console_server_port", "id": cs.json()["id"]}],
        }, format="json")
        self.assertEqual(again.status_code, 400)

    def test_cable_terminates_aux_port(self):
        # A USB console cable: aux port (usb-c) ↔ aux port (usb-a).
        from .models import AuxPort
        a = AuxPort.objects.create(device=self.dev, name="usb-console",
                                   type="usb-c")
        laptop = Device.objects.create(tenant=self.tenant, name="crash-cart")
        b = AuxPort.objects.create(device=laptop, name="usb1", type="usb-a")
        r = self.client.post("/api/cables/", {
            "a": [{"kind": "aux_port", "id": str(a.id)}],
            "b": [{"kind": "aux_port", "id": str(b.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["a_terminations"][0]["kind"], "aux_port")
        # The aux-port serializer now reports its cable.
        port = self.client.get(f"/api/aux-ports/{a.id}/").json()
        self.assertEqual(port["cable"]["id"], r.json()["id"])
        # A port is cabled at most once.
        again = self.client.post("/api/cables/", {
            "a": [{"kind": "aux_port", "id": str(a.id)}],
            "b": [{"kind": "aux_port", "id": str(b.id)}],
        }, format="json")
        self.assertEqual(again.status_code, 400)

    def test_cable_terminates_power_feed_to_power_port(self):
        from api.models import PowerFeed, PowerPanel, PowerPort, Site
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        panel = PowerPanel.objects.create(
            tenant=self.tenant, site=site, name="PP-1"
        )
        feed = PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, name="FEED-A"
        )
        inlet = PowerPort.objects.create(device=self.pdu, name="inlet1")
        r = self.client.post("/api/cables/", {
            "a": [{"kind": "power_feed", "id": str(feed.id)}],
            "b": [{"kind": "power_port", "id": str(inlet.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        (a,) = r.json()["a_terminations"]
        # The feed's "device" slot carries its panel, keeping one read shape.
        self.assertEqual(a["device"]["name"], "PP-1")


class ComponentTemplateMaterializationTests(_TenantAPITestCase):
    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300-48P", u_height=1
        )
        for i in range(1, 4):
            InterfaceTemplate.objects.create(
                device_type=self.dt, name=f"Gi1/0/{i}", type="1000base-t"
            )
        ConsolePortTemplate.objects.create(
            device_type=self.dt, name="con0", type="rj-45"
        )
        psu = PowerPortTemplate.objects.create(
            device_type=self.dt, name="PS1", type="iec-60320-c14",
            maximum_draw=715,
        )
        PowerOutletTemplate.objects.create(
            device_type=self.dt, name="out1", power_port_template=psu
        )
        rear = RearPortTemplate.objects.create(
            device_type=self.dt, name="R1", positions=6
        )
        FrontPortTemplate.objects.create(
            device_type=self.dt, name="F1", rear_port_template=rear,
            rear_port_position=2,
        )

    def test_interface_extras_roundtrip_and_stamp(self):
        from .models import InterfaceTemplate

        # Template carries PoE + mgmt; stamping copies them to the device.
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="ge-0/0/1", type="1000base-t",
            mgmt_only=True, poe_mode="pse", poe_type="type2-ieee802.3at",
        )
        r = self.client.post("/api/devices/", {
            "name": "poe-sw", "device_type_id": str(self.dt.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        iface = self.client.get(
            f"/api/interfaces/?device={r.json()['id']}&search=ge-0/0/1"
        ).json()["results"][0]
        self.assertTrue(iface["mgmt_only"])
        self.assertEqual(iface["poe_mode"], "pse")
        self.assertEqual(iface["poe_type"], "type2-ieee802.3at")
        # Extras are writable on the concrete interface.
        upd = self.client.patch(f"/api/interfaces/{iface['id']}/", {
            "duplex": "full", "wwn": "10:00:00:90:fa:12:34:56",
        }, format="json")
        self.assertEqual(upd.status_code, 200, upd.content)
        self.assertEqual(upd.json()["duplex"], "full")
        self.assertEqual(upd.json()["wwn"], "10:00:00:90:fa:12:34:56")

    def test_device_create_materializes_components(self):
        r = self.client.post("/api/devices/", {
            "name": "access-sw-1", "device_type_id": str(self.dt.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        dev = Device.objects.get(name="access-sw-1")
        self.assertEqual(dev.interfaces.count(), 3)
        self.assertEqual(dev.console_ports.count(), 1)
        self.assertEqual(dev.power_ports.count(), 1)
        self.assertEqual(dev.power_ports.get().maximum_draw, 715)
        outlet = dev.power_outlets.get()
        self.assertEqual(outlet.power_port, dev.power_ports.get())
        front = dev.front_ports.get()
        self.assertEqual(front.rear_port, dev.rear_ports.get())
        self.assertEqual(front.rear_port_position, 2)

    def test_materialization_skips_existing_names(self):
        from api.models import materialize_device_components
        dev = Device.objects.create(
            tenant=self.tenant, name="pre", device_type=self.dt
        )
        Interface.objects.create(device=dev, name="Gi1/0/1", type="custom")
        created = materialize_device_components(dev)
        self.assertEqual(created["interfaces"], 2)  # 3 templates − 1 existing
        self.assertEqual(dev.interfaces.get(name="Gi1/0/1").type, "custom")
        # Idempotent: a second run creates nothing.
        again = materialize_device_components(dev)
        self.assertEqual(sum(again.values()), 0)

    def test_device_without_type_materializes_nothing(self):
        r = self.client.post("/api/devices/", {"name": "bare"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        dev = Device.objects.get(name="bare")
        self.assertEqual(dev.interfaces.count(), 0)
        self.assertEqual(dev.console_ports.count(), 0)
