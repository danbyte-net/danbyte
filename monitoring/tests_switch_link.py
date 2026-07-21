"""IP → switch / switch-interface link: parse, serializer, SNMP suggest+accept."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, Interface, IPAddress, Prefix
from core.models import Organization, Tenant
from danbyte_checks.snmp_facts import parse_fdb
from monitoring.models import DeviceSnmp
from monitoring.snmp_drift import compute_device_drift


class ParseFdbTests(APITestCase):
    def test_joins_mac_octets_and_bridge_port_ifindex(self):
        # dot1dTpFdbPort: MAC octets → bridge port; base map: bridge port → ifIndex
        fdb_port = {"0.17.34.51.68.85": "3"}
        base = {"3": "10"}
        out = parse_fdb(fdb_port, base)
        self.assertEqual(out, [{"mac": "00:11:22:33:44:55", "if_index": "10"}])

    def test_drops_ports_without_ifindex(self):
        self.assertEqual(parse_fdb({"0.17.34.51.68.85": "9"}, {}), [])


def _status(tenant):
    from api.models import IPStatus

    return IPStatus.objects.create(tenant=tenant, name="Active", slug="active")


class SwitchLinkSerializerTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1")
        self.port = Interface.objects.create(device=self.sw, name="Gi0/1")
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_set_switch_interface_forces_switch(self):
        ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        r = self.client.patch(
            f"/api/ips/{ip.id}/",
            {"switch_interface_id": str(self.port.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        ip.refresh_from_db()
        self.assertEqual(ip.switch_interface_id, self.port.id)
        self.assertEqual(ip.switch_id, self.sw.id)  # derived from the port
        # serialized read exposes the nested switch + switch_interface
        body = r.json()
        self.assertEqual(body["switch"]["name"], "sw1")
        self.assertEqual(body["switch_interface"]["name"], "Gi0/1")


class SwitchLinkDriftTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.sw = Device.objects.create(tenant=self.tenant, name="sw1")
        self.port = Interface.objects.create(device=self.sw, name="Gi0/1")
        # The host IP Danbyte already tracks, sitting behind the switch port.
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address="10.0.0.5"
        )
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.sw, reachable=True,
            polled_at=timezone.now(),
            interfaces=[{"if_index": "10", "name": "Gi0/1"}],
            arp=[{"ip": "10.0.0.5", "mac": "00:11:22:33:44:55", "if_index": "10"}],
            fdb=[{"mac": "00:11:22:33:44:55", "if_index": "10"}],
        )
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_suggests_switch_link_from_arp_and_fdb(self):
        items = compute_device_drift(self.sw, self.tenant)
        sl = [i for i in items if i["kind"] == "switch_link_suggested"]
        self.assertEqual(len(sl), 1)
        self.assertEqual(sl[0]["ip"], "10.0.0.5")
        self.assertEqual(sl[0]["interface_id"], str(self.port.id))

    def test_accept_sets_the_link(self):
        items = compute_device_drift(self.sw, self.tenant)
        sl = next(i for i in items if i["kind"] == "switch_link_suggested")
        r = self.client.post(
            f"/api/monitoring/devices/{self.sw.id}/snmp/reconcile/",
            {"action": sl}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.switch_id, self.sw.id)
        self.assertEqual(self.ip.switch_interface_id, self.port.id)

    def test_no_suggestion_once_linked(self):
        self.ip.switch = self.sw
        self.ip.switch_interface = self.port
        self.ip.save()
        items = compute_device_drift(self.sw, self.tenant)
        self.assertFalse(
            [i for i in items if i["kind"] == "switch_link_suggested"]
        )
