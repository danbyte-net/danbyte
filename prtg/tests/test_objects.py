"""What a PRTG sensor watches: the address, interface and service links.

db-dev01's sensors are the ones recorded from the lab PRTG 26.3
(``table_sensors_db_dev01.json``: Ping v2, HTTP v2, HTTPS v2, SSL Security
Check (Port 443), SSL Certificate Sensor (Port 443)); the SNMP traffic
sensors are made up in PRTG's naming, because the lab has none.
"""
from __future__ import annotations

from django.test import SimpleTestCase

from api.models import Interface, IPAddress, Service, VirtualMachine, VMInterface
from monitoring.models import DeviceSnmp
from prtg.models import PrtgSensor
from prtg.objects import parse_traffic_name, service_port

from .fake_server import load_fixture, sensor_row
from .test_sensors import _Lab

DEV01 = 2081


def traffic(objid, name, parent=DEV01, device="db-dev01"):
    row = sensor_row(objid, name, device=device, parent=parent, value="12 kbit/s")
    row.update(type="SNMP Traffic", type_raw="snmptraffic")
    return row


class ParsingTests(SimpleTestCase):
    def test_traffic_names(self):
        self.assertEqual(parse_traffic_name("(001) GigabitEthernet0/1 Traffic"),
                         ("1", "GigabitEthernet0/1"))
        self.assertEqual(parse_traffic_name("(10101) Gi1/0/1 Traffic"), ("10101", "Gi1/0/1"))
        self.assertEqual(parse_traffic_name("eth0 Traffic"), ("", "eth0"))
        self.assertEqual(parse_traffic_name("Traffic eth0"), ("", "eth0"))

    def test_ports(self):
        self.assertEqual(service_port("paessler.http.http_sensor.51", "HTTP v2"), 80)
        self.assertEqual(service_port("paessler.http.http_sensor.51", "HTTPS v2"), 443)
        self.assertEqual(service_port("http", "HTTP (Port 8080)"), 8080)
        self.assertEqual(service_port("http", "api:8443"), 8443)
        self.assertEqual(service_port("ssl", "SSL Security Check (Port 443)"), 443)
        self.assertEqual(service_port("sslcertificate", "SSL Certificate"), 443)
        self.assertIsNone(service_port("paessler.icmp.ping_sensor.48", "Ping v2"))


class _Objects(_Lab):
    def setUp(self):
        super().setUp()
        rows = [r for r in self.fake.tables["sensors"] if r.get("parentid") != DEV01]
        self.fake.tables["sensors"] = rows + load_fixture(
            "table_sensors_db_dev01.json")["sensors"]

    def add(self, *rows):
        self.fake.tables["sensors"].extend(rows)

    def sensor(self, objid) -> PrtgSensor:
        return PrtgSensor.objects.get(objid=str(objid))

    def service(self, owner, name, port, ip=None, tenant=None):
        parent = (
            {"virtual_machine": owner} if isinstance(owner, VirtualMachine) else {"device": owner}
        )
        return Service.objects.create(
            tenant=tenant or self.tenant, name=name, protocol="tcp", ports=[port],
            ip_address=ip, **parent,
        )


class AddressTests(_Objects):
    def test_every_sensor_gets_the_host_address(self):
        dev = self.device("db-dev01", "10.0.0.41", "10.0.0.141")
        self.read()
        ip = IPAddress.objects.get(ip_address="10.0.0.41")
        for objid in (2089, 2090, 2091, 2093, 2094):
            self.assertEqual(self.sensor(objid).ip_address_id, ip.id, objid)
        self.assertEqual(PrtgSensor.objects.filter(device=dev).count(), 5)

    def test_dns_name_host(self):
        self.fake.device(DEV01).update(host="db-dev01.danbyte.lan", host_raw="db-dev01.danbyte.lan")
        self.device("db-dev01", "10.0.0.41")
        IPAddress.objects.filter(ip_address="10.0.0.41").update(dns_name="DB-dev01.danbyte.lan.")
        self.read()
        self.assertEqual(str(self.sensor(2089).ip_address.ip_address), "10.0.0.41")

    def test_two_addresses_with_the_name_is_none(self):
        self.fake.device(DEV01).update(host="db-dev01.danbyte.lan", host_raw="db-dev01.danbyte.lan")
        self.device("db-dev01", "10.0.0.41", "10.0.0.42")
        IPAddress.objects.update(dns_name="db-dev01.danbyte.lan")
        self.read()
        self.assertIsNone(self.sensor(2089).ip_address_id)

    def test_another_tenants_address_is_not_used(self):
        dev = self.device("db-dev01")
        from api.models import Prefix

        prefix = Prefix.objects.create(tenant=self.other, cidr="10.0.0.0/24")
        IPAddress.objects.create(
            tenant=self.other, ip_address="10.0.0.41/24", prefix=prefix, assigned_device=dev,
        )
        self.read()
        self.assertTrue(PrtgSensor.objects.filter(device=dev).exists())
        self.assertFalse(PrtgSensor.objects.filter(ip_address__isnull=False).exists())

    def test_a_moved_address_follows(self):
        self.device("db-dev01", "10.0.0.41")
        self.read()
        IPAddress.objects.all().delete()
        self.read()
        self.assertIsNone(self.sensor(2089).ip_address_id)


class ServiceTests(_Objects):
    def test_http_https_and_ssl_find_their_services(self):
        dev = self.device("db-dev01", "10.0.0.41")
        web = self.service(dev, "HTTP", 80)
        tls = self.service(dev, "HTTPS", 443)
        self.read()
        self.assertEqual(self.sensor(2093).service_id, web.id)   # HTTP v2
        self.assertEqual(self.sensor(2094).service_id, tls.id)   # HTTPS v2
        self.assertEqual(self.sensor(2090).service_id, tls.id)   # SSL Security Check (Port 443)
        self.assertEqual(self.sensor(2091).service_id, tls.id)   # SSL Certificate Sensor
        self.assertIsNone(self.sensor(2089).service_id)          # Ping v2

    def test_two_services_on_the_port_is_none(self):
        dev = self.device("db-dev01", "10.0.0.41")
        self.service(dev, "HTTPS", 443)
        self.service(dev, "Admin", 443)
        self.read()
        self.assertIsNone(self.sensor(2094).service_id)

    def test_the_address_decides_between_two(self):
        dev = self.device("db-dev01", "10.0.0.41", "10.0.0.141")
        ip = IPAddress.objects.get(ip_address="10.0.0.41")
        other = IPAddress.objects.get(ip_address="10.0.0.141")
        mine = self.service(dev, "HTTPS", 443, ip=ip)
        self.service(dev, "Admin", 443, ip=other)
        self.read()
        self.assertEqual(self.sensor(2094).service_id, mine.id)

    def test_another_tenants_service_is_not_used(self):
        dev = self.device("db-dev01", "10.0.0.41")
        self.service(dev, "HTTPS", 443, tenant=self.other)
        self.read()
        self.assertIsNone(self.sensor(2094).service_id)


class InterfaceTests(_Objects):
    def setUp(self):
        super().setUp()
        self.dev = self.device("db-dev01", "10.0.0.41")
        self.gi1 = Interface.objects.create(device=self.dev, name="GigabitEthernet1/0/1")
        self.gi2 = Interface.objects.create(device=self.dev, name="GigabitEthernet1/0/2")
        DeviceSnmp.objects.create(tenant=self.tenant, device=self.dev, interfaces=[
            {"if_index": "1", "name": "Gi1/0/1", "descr": "GigabitEthernet1/0/1",
             "alias": "uplink"},
            {"if_index": "2", "name": "Gi1/0/2", "descr": "GigabitEthernet1/0/2", "alias": ""},
        ])

    def test_by_index(self):
        self.add(traffic(3001, "(001) Gi1/0/1 Traffic"))
        self.read()
        self.assertEqual(self.sensor(3001).interface_id, self.gi1.id)

    def test_the_index_wins_over_the_name(self):
        self.add(traffic(3002, "(002) GigabitEthernet1/0/1 Traffic"))
        self.read()
        self.assertEqual(self.sensor(3002).interface_id, self.gi2.id)

    def test_by_name_and_alias(self):
        self.add(traffic(3003, "GigabitEthernet1/0/2 Traffic"), traffic(3004, "uplink Traffic"))
        self.read()
        self.assertEqual(self.sensor(3003).interface_id, self.gi2.id)
        self.assertEqual(self.sensor(3004).interface_id, self.gi1.id)

    def test_ambiguous_name_is_none(self):
        Interface.objects.filter(id__in=[self.gi1.id, self.gi2.id]).update(label="Port")
        self.add(traffic(3005, "(099) Port Traffic"))
        self.read()
        self.assertIsNone(self.sensor(3005).interface_id)

    def test_only_traffic_sensors(self):
        row = sensor_row(3006, "Gi1/0/1", device="db-dev01", parent=DEV01)
        self.add(row)
        self.read()
        self.assertIsNone(self.sensor(3006).interface_id)

    def test_vm_interface(self):
        vm = self.vm("db-zabbix", "10.0.0.53")
        eth0 = VMInterface.objects.create(vm=vm, name="ens18")
        DeviceSnmp.objects.create(tenant=self.tenant, vm=vm, interfaces=[
            {"if_index": "2", "name": "ens18", "descr": "ens18"},
        ])
        self.add(traffic(3007, "(002) ens18 Traffic", parent=2082, device="db-zabbix"))
        self.read()
        s = self.sensor(3007)
        self.assertEqual((s.vm_interface_id, s.interface_id), (eth0.id, None))


class FilterTests(_Objects):
    def setUp(self):
        super().setUp()
        self.dev = self.device("db-dev01", "10.0.0.41")
        self.ip = IPAddress.objects.get(ip_address="10.0.0.41")
        self.gi1 = Interface.objects.create(device=self.dev, name="GigabitEthernet1/0/1")
        self.tls = self.service(self.dev, "HTTPS", 443)
        self.add(traffic(3001, "GigabitEthernet1/0/1 Traffic"))
        self.read()
        self.login()

    def _list(self, query):
        resp = self.client.get(f"/api/prtg/sensors/?page_size=500&{query}")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()["results"]

    def test_filters_and_summaries(self):
        self.assertEqual(
            {r["objid"] for r in self._list(f"ip_address={self.ip.id}")},
            {"2089", "2090", "2091", "2093", "2094", "3001"},
        )
        rows = self._list(f"interface={self.gi1.id}")
        self.assertEqual([r["objid"] for r in rows], ["3001"])
        self.assertEqual(rows[0]["interface"], {
            "id": str(self.gi1.id), "name": "GigabitEthernet1/0/1", "kind": "interface",
            "parent": str(self.dev.id),
        })
        self.assertEqual(rows[0]["ip_address"]["address"], "10.0.0.41")
        rows = self._list(f"service={self.tls.id}")
        self.assertEqual({r["objid"] for r in rows}, {"2090", "2091", "2094"})
        self.assertEqual(rows[0]["service"], {
            "id": str(self.tls.id), "name": "HTTPS", "ports": "tcp/443",
        })
        summary = self.client.get(f"/api/prtg/sensors/summary/?service={self.tls.id}").json()
        self.assertEqual(summary["total"], 3)

    def test_bad_id_is_400(self):
        resp = self.client.get("/api/prtg/sensors/?ip_address=nope")
        self.assertEqual(resp.status_code, 400)

    def test_another_tenant_sees_nothing(self):
        from django.contrib.auth import get_user_model

        from auth_api.models import UserProfile

        user = get_user_model().objects.create_user("o", password="x", is_superuser=True)
        UserProfile.objects.create(user=user).tenants.add(self.other)
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.other.id)
        sess.save()
        self.assertEqual(self._list(f"ip_address={self.ip.id}"), [])
