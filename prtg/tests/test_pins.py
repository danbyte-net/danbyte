"""Sensor channels pinned to a device's or VM's Overview.

CRUD and order, one parent per pin, the tenant boundary, the
``prtgsensorpin.change`` grant plus view on the parent, and site scope.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    Interface,
    IPAddress,
    Prefix,
    Service,
    Site,
    VirtualMachine,
    VMInterface,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from prtg.models import PrtgConnection, PrtgDeviceLink, PrtgSensor
from prtg.pins import PrtgSensorPin

URL = "/api/prtg/sensor-pins/"


class _Pins(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        for t in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(tenant=t, defaults={"prtg_enabled": True})
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev = Device.objects.create(tenant=self.tenant, name="d1", site=self.site)
        self.dev_b = Device.objects.create(tenant=self.tenant, name="d2", site=self.site_b)
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cluster, site=self.site,
        )
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="lab", url="https://prtg.example.com",
            credentials={"api_key": "k"},
        )
        self.ssl = self._sensor(self.dev, "2091", "SSL Certificate")
        self.ping = self._sensor(self.dev, "2089", "Ping v2")
        self.vm_ping = self._sensor(self.vm, "2093", "Ping v2")
        self.ping_b = self._sensor(self.dev_b, "2092", "Ping v2")
        # Another tenant's sensor.
        o_site = Site.objects.create(tenant=self.other, name="X")
        o_dev = Device.objects.create(tenant=self.other, name="x", site=o_site)
        o_conn = PrtgConnection.objects.create(
            tenant=self.other, name="o", url="https://p.example.com", credentials={"api_key": "k"},
        )
        o_link = PrtgDeviceLink.objects.create(
            tenant=self.other, connection=o_conn, device=o_dev, objid="9", name="x",
        )
        self.foreign = PrtgSensor.objects.create(
            tenant=self.other, connection=o_conn, link=o_link, device=o_dev, objid="99",
            name="Foreign",
        )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")

    def _sensor(self, parent, objid, name):
        is_vm = isinstance(parent, VirtualMachine)
        key = "virtual_machine" if is_vm else "device"
        link, _ = PrtgDeviceLink.objects.get_or_create(
            tenant=self.tenant, connection=self.conn, **{key: parent},
            defaults={"objid": f"l{objid}", "name": parent.name},
        )
        return PrtgSensor.objects.create(
            tenant=self.tenant, connection=self.conn, link=link, objid=objid, name=name,
            state="up", status_raw=3, **{key: parent},
        )

    def login(self, user=None, tenant=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str((tenant or self.tenant).id)
        sess.save()

    def pin(self, sensor, channel="0", **extra):
        return self.client.post(
            URL, {"sensor": str(sensor.id), "channel_id": channel, **extra}, format="json",
        )

    def _user(self, grants, sites=None):
        user = get_user_model().objects.create_user(f"u{ObjectPermission.objects.count()}")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"g{i}", object_types=types, actions=actions,
            )
            perm.tenants.set([self.tenant])
            if sites:
                perm.sites.set(sites)
            perm.users.set([user])
        return user


class PinCrudTests(_Pins):
    def test_pin_list_reorder_unpin(self):
        self.login()
        a = self.pin(self.ssl, "2", display="gauge")
        self.assertEqual(a.status_code, 201, a.content)
        self.assertEqual(a.json()["device"]["id"], str(self.dev.id))
        self.assertEqual(a.json()["sensor_info"]["name"], "SSL Certificate")
        b = self.pin(self.ping, "0")
        self.assertEqual(b.json()["position"], 1)
        listed = self.client.get(f"{URL}?device={self.dev.id}").json()["results"]
        self.assertEqual([p["id"] for p in listed], [a.json()["id"], b.json()["id"]])

        order = [b.json()["id"], a.json()["id"]]
        resp = self.client.post(f"{URL}reorder/", {"device": str(self.dev.id), "order": order},
                                format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        listed = self.client.get(f"{URL}?device={self.dev.id}").json()["results"]
        self.assertEqual([p["id"] for p in listed], order)

        self.assertEqual(self.client.delete(f"{URL}{a.json()['id']}/").status_code, 204)
        self.assertEqual(PrtgSensorPin.objects.count(), 1)

    def test_reorder_needs_every_pin_once(self):
        self.login()
        a = self.pin(self.ssl, "2").json()["id"]
        self.pin(self.ping, "0")
        resp = self.client.post(f"{URL}reorder/", {"device": str(self.dev.id), "order": [a]},
                                format="json")
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post(f"{URL}reorder/", {"order": [a]}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_a_channel_pins_once(self):
        self.login()
        self.assertEqual(self.pin(self.ssl, "2").status_code, 201)
        dup = self.pin(self.ssl, "2")
        self.assertEqual(dup.status_code, 400)
        self.assertIn("channel_id", dup.json())

    def test_channel_id_is_a_prtg_id(self):
        self.login()
        self.assertEqual(self.pin(self.ssl, "-4").status_code, 201)
        self.assertEqual(self.pin(self.ssl, "abc").status_code, 400)

    def test_display_defaults_and_choices(self):
        self.login()
        self.assertEqual(self.pin(self.ssl, "2").json()["display"], "auto")
        self.assertEqual(self.pin(self.ssl, "3", display="pie").status_code, 400)

    def test_vm_pins_take_the_vm(self):
        self.login()
        resp = self.pin(self.vm_ping)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["virtual_machine"]["id"], str(self.vm.id))
        self.assertIsNone(resp.json()["device"])
        listed = self.client.get(f"{URL}?virtual_machine={self.vm.id}").json()["results"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(self.client.get(f"{URL}?device={self.dev.id}").json()["results"], [])

    def test_the_parent_is_the_sensors(self):
        self.login()
        resp = self.pin(self.ssl, "2", device=str(self.dev_b.id))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("device", resp.json())

    def test_one_parent_constraint(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgSensorPin.objects.create(
                tenant=self.tenant, device=self.dev, virtual_machine=self.vm,
                sensor=self.ssl, channel_id="0",
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgSensorPin.objects.create(tenant=self.tenant, sensor=self.ssl, channel_id="0")

    def test_a_gone_sensor_takes_its_pins(self):
        self.login()
        self.pin(self.ssl, "2")
        self.ssl.delete()
        self.assertFalse(PrtgSensorPin.objects.exists())

    def test_off_integration_is_404(self):
        self.login()
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertEqual(self.client.get(URL).status_code, 404)


class WholeSensorPinTests(_Pins):
    def pin_sensor(self, sensor, **extra):
        return self.client.post(URL, {"sensor": str(sensor.id), **extra}, format="json")

    def test_pin_list_unpin_a_whole_sensor(self):
        self.login()
        self.ping.last_value = "12 msec"
        self.ping.save(update_fields=["last_value"])
        resp = self.pin_sensor(self.ping, display="gauge")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["channel_id"], "")
        # A sensor tile draws its primary value; the display is not a choice.
        self.assertEqual(body["display"], "auto")
        self.assertEqual(body["sensor_info"]["last_value"], "12 msec")
        self.assertIn("last_check_at", body["sensor_info"])
        listed = self.client.get(f"{URL}?device={self.dev.id}").json()["results"]
        self.assertEqual([(p["id"], p["channel_id"]) for p in listed], [(body["id"], "")])
        self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 204)
        self.assertFalse(PrtgSensorPin.objects.exists())

    def test_a_blank_channel_pins_the_sensor(self):
        self.login()
        resp = self.pin(self.ping, "")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertTrue(PrtgSensorPin.objects.get(id=resp.json()["id"]).whole_sensor)

    def test_a_sensor_pins_whole_once_beside_its_channels(self):
        self.login()
        self.assertEqual(self.pin(self.ping, "0").status_code, 201)
        self.assertEqual(self.pin_sensor(self.ping).status_code, 201)
        self.assertEqual(self.pin(self.ping, "1").status_code, 201)
        dup = self.pin_sensor(self.ping)
        self.assertEqual(dup.status_code, 400)
        self.assertEqual(dup.json()["channel_id"], ["This sensor is already pinned."])
        self.assertEqual(
            sorted(PrtgSensorPin.objects.values_list("channel_id", flat=True)), ["", "0", "1"],
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgSensorPin.objects.create(
                tenant=self.tenant, device=self.dev, sensor=self.ping, channel_id="",
            )

    def test_whole_sensor_pins_count_toward_the_cap(self):
        from prtg.pins import MAX_PINS

        self.login()
        for i in range(MAX_PINS - 1):
            self.assertEqual(self.pin(self.ssl, str(i)).status_code, 201)
        self.assertEqual(self.pin_sensor(self.ping).status_code, 201)
        over = self.pin_sensor(self.ssl)
        self.assertEqual(over.status_code, 400)
        self.assertIn("sensor", over.json())

    def test_vm_sensor_pins_whole(self):
        self.login()
        resp = self.pin_sensor(self.vm_ping)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["virtual_machine"]["id"], str(self.vm.id))

    def test_another_tenants_sensor_cannot_be_pinned_whole(self):
        self.login()
        self.assertEqual(self.pin_sensor(self.foreign).status_code, 400)


class PinScopeTests(_Pins):
    def test_another_tenants_sensor_cannot_be_pinned(self):
        self.login()
        resp = self.pin(self.foreign)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("sensor", resp.json())

    def test_another_tenants_pins_are_invisible(self):
        self.login()
        pid = self.pin(self.ssl, "2").json()["id"]
        other_admin = self._user([])
        UserProfile.objects.get(user=other_admin).tenants.add(self.other)
        other_admin.is_superuser = True
        other_admin.save()
        self.login(other_admin, tenant=self.other)
        self.assertEqual(self.client.get(URL).json()["results"], [])
        self.assertEqual(self.client.delete(f"{URL}{pid}/").status_code, 404)

    def test_writes_need_change_on_pins(self):
        viewer = self._user([(["prtgsensorpin", "prtgsensor", "device"], ["view"])])
        self.login(viewer)
        self.assertEqual(self.client.get(URL).status_code, 200)
        self.assertEqual(self.pin(self.ssl, "2").status_code, 403)
        # Add alone is not enough: a pin is gated on change.
        adder = self._user([(["prtgsensorpin", "device"], ["view", "add"])])
        self.login(adder)
        self.assertEqual(self.pin(self.ssl, "2").status_code, 403)
        editor = self._user([(["prtgsensorpin", "device"], ["view", "change"])])
        self.login(editor)
        pid = self.pin(self.ssl, "2").json()["id"]
        self.assertEqual(self.client.delete(f"{URL}{pid}/").status_code, 204)

    def test_pins_need_view_on_the_parent(self):
        self.login()
        self.pin(self.ssl, "2")
        user = self._user([(["prtgsensorpin"], ["view", "change"])])
        self.login(user)
        self.assertEqual(self.client.get(URL).json()["results"], [])
        resp = self.pin(self.ping, "0")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("sensor", resp.json())

    def test_site_scope_follows_the_parent(self):
        self.login()
        a = self.pin(self.ssl, "2").json()["id"]
        b = self.pin(self.ping_b, "0").json()["id"]
        user = self._user(
            [(["prtgsensorpin", "device", "prtgsensor"], ["view", "change"])],
            sites=[self.site_b],
        )
        self.login(user)
        listed = [p["id"] for p in self.client.get(URL).json()["results"]]
        self.assertEqual(listed, [b])
        self.assertEqual(self.client.delete(f"{URL}{a}/").status_code, 404)
        # A sensor at another site is not theirs to pin.
        self.assertEqual(self.pin(self.ping, "0").status_code, 400)
        self.assertEqual(self.pin(self.ping_b, "1").status_code, 201)


class ObjectPinTests(_Pins):
    """Pins on an address, interface (device or VM) or service: only for a
    sensor linked to that object, the cap per object, tenant and site scope."""

    def setUp(self):
        super().setUp()
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", site=self.site)
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.41/24", prefix=prefix,
        )
        self.gi1 = Interface.objects.create(device=self.dev, name="Gi1/0/1")
        self.eth0 = VMInterface.objects.create(vm=self.vm, name="ens18")
        self.https = Service.objects.create(
            tenant=self.tenant, name="HTTPS", protocol="tcp", ports=[443], device=self.dev,
        )
        self.ping.ip_address = self.ip
        self.ping.save(update_fields=["ip_address"])
        self.traffic = self._sensor(self.dev, "2094", "Traffic Gi1/0/1")
        self.traffic.interface = self.gi1
        self.traffic.save(update_fields=["interface"])
        self.vm_traffic = self._sensor(self.vm, "2095", "Traffic ens18")
        self.vm_traffic.vm_interface = self.eth0
        self.vm_traffic.save(update_fields=["vm_interface"])
        self.ssl.service = self.https
        self.ssl.save(update_fields=["service"])

    def cases(self):
        return [
            ("ip_address", self.ip, self.ping),
            ("interface", self.gi1, self.traffic),
            ("vm_interface", self.eth0, self.vm_traffic),
            ("service", self.https, self.ssl),
        ]

    def test_pin_list_unpin_on_each_kind(self):
        self.login()
        for field, obj, sensor in self.cases():
            with self.subTest(field=field):
                resp = self.pin(sensor, "0", **{field: str(obj.id)})
                self.assertEqual(resp.status_code, 201, resp.content)
                body = resp.json()
                self.assertEqual(body[field]["id"], str(obj.id))
                self.assertIsNone(body["device"])
                self.assertIsNone(body["virtual_machine"])
                listed = self.client.get(f"{URL}?{field}={obj.id}").json()["results"]
                self.assertEqual([p["id"] for p in listed], [body["id"]])
                # Not on the sensor's device or VM.
                owner = "device" if sensor.device_id else "virtual_machine"
                owner_id = sensor.device_id or sensor.virtual_machine_id
                self.assertEqual(
                    self.client.get(f"{URL}?{owner}={owner_id}").json()["results"], [],
                )
                self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 204)
        self.assertFalse(PrtgSensorPin.objects.exists())

    def test_the_parent_shape_and_whole_sensor(self):
        self.login()
        resp = self.client.post(URL, {
            "sensor": str(self.ping.id), "parent": {"kind": "ip_address", "id": str(self.ip.id)},
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["ip_address"]["id"], str(self.ip.id))
        self.assertEqual(resp.json()["channel_id"], "")
        bad = self.client.post(URL, {
            "sensor": str(self.ping.id), "parent": {"kind": "rack", "id": str(self.ip.id)},
        }, format="json")
        self.assertEqual(bad.status_code, 400)
        two = self.pin(self.ping, "1", ip_address=str(self.ip.id), device=str(self.dev.id))
        self.assertEqual(two.status_code, 400)
        self.assertEqual(self.pin(self.ping, "1", ip_address="nope").status_code, 400)

    def test_the_same_sensor_pins_on_the_device_and_the_address(self):
        self.login()
        self.assertEqual(self.pin(self.ping, "0").status_code, 201)
        self.assertEqual(self.pin(self.ping, "0", ip_address=str(self.ip.id)).status_code, 201)
        dup = self.pin(self.ping, "0", ip_address=str(self.ip.id))
        self.assertEqual(dup.status_code, 400)
        self.assertIn("channel_id", dup.json())

    def test_only_a_linked_sensor_pins_on_an_object(self):
        self.login()
        for field, obj, _sensor in self.cases():
            with self.subTest(field=field):
                resp = self.pin(self.ping_b, "0", **{field: str(obj.id)})
                self.assertEqual(resp.status_code, 400)
                self.assertIn("does not watch", resp.json()[field][0])
        resp = self.pin(self.traffic, "0", ip_address=str(self.ip.id))
        self.assertEqual(
            resp.json()["ip_address"],
            ["This sensor does not watch this address; pin it on the device or VM instead."],
        )

    def test_the_cap_is_per_object(self):
        from prtg.pins import MAX_PINS

        self.login()
        for i in range(MAX_PINS):
            self.assertEqual(
                self.pin(self.ping, str(i), ip_address=str(self.ip.id)).status_code, 201,
            )
        over = self.pin(self.ping, "99", ip_address=str(self.ip.id))
        self.assertEqual(over.status_code, 400)
        self.assertIn("sensor", over.json())
        # The device has room of its own.
        self.assertEqual(self.pin(self.ping, "99").status_code, 201)

    def test_reorder_per_object(self):
        self.login()
        a = self.pin(self.ssl, "0", service=str(self.https.id)).json()["id"]
        b = self.pin(self.ssl, "1", service=str(self.https.id)).json()["id"]
        self.pin(self.ssl, "0")
        resp = self.client.post(f"{URL}reorder/", {"service": str(self.https.id),
                                                   "order": [b, a]}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        listed = self.client.get(f"{URL}?service={self.https.id}").json()["results"]
        self.assertEqual([p["id"] for p in listed], [b, a])

    def test_one_parent_and_unique_per_object(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgSensorPin.objects.create(
                tenant=self.tenant, ip_address=self.ip, service=self.https,
                sensor=self.ping, channel_id="0",
            )
        PrtgSensorPin.objects.create(
            tenant=self.tenant, ip_address=self.ip, sensor=self.ping, channel_id="0",
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            PrtgSensorPin.objects.create(
                tenant=self.tenant, ip_address=self.ip, sensor=self.ping, channel_id="0",
            )

    def test_a_gone_object_takes_its_pins(self):
        self.login()
        self.pin(self.ping, "0", ip_address=str(self.ip.id))
        self.pin(self.traffic, "0", interface=str(self.gi1.id))
        self.ip.delete()
        self.gi1.delete()
        self.assertFalse(PrtgSensorPin.objects.exists())

    def test_another_tenants_object_is_refused(self):
        o_site = Site.objects.create(tenant=self.other, name="Y")
        o_prefix = Prefix.objects.create(tenant=self.other, cidr="10.9.0.0/24", site=o_site)
        o_ip = IPAddress.objects.create(
            tenant=self.other, ip_address="10.9.0.1/24", prefix=o_prefix,
        )
        self.login()
        resp = self.pin(self.ping, "0", ip_address=str(o_ip.id))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("ip_address", resp.json())
        pid = self.pin(self.ping, "0", ip_address=str(self.ip.id)).json()["id"]
        other_admin = self._user([])
        UserProfile.objects.get(user=other_admin).tenants.add(self.other)
        other_admin.is_superuser = True
        other_admin.save()
        self.login(other_admin, tenant=self.other)
        self.assertEqual(self.client.get(f"{URL}?ip_address={self.ip.id}").json()["results"], [])
        self.assertEqual(self.client.delete(f"{URL}{pid}/").status_code, 404)

    def test_writes_need_view_on_the_object(self):
        # Change on pins and view on the device, but nothing on addresses.
        user = self._user([(["prtgsensorpin", "device"], ["view", "change"])])
        self.login(user)
        resp = self.pin(self.ping, "0", ip_address=str(self.ip.id))
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["ip_address"], ["Not found."])
        user = self._user([(["prtgsensorpin", "device", "ipaddress"], ["view", "change"])])
        self.login(user)
        self.assertEqual(self.pin(self.ping, "0", ip_address=str(self.ip.id)).status_code, 201)
        viewer = self._user([(["prtgsensorpin", "device", "ipaddress"], ["view"])])
        self.login(viewer)
        listed = self.client.get(f"{URL}?ip_address={self.ip.id}").json()["results"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(self.pin(self.ping, "1", ip_address=str(self.ip.id)).status_code, 403)

    def test_site_scope_follows_the_object(self):
        prefix_b = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24", site=self.site_b)
        ip_b = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.5/24", prefix=prefix_b,
        )
        self.ping_b.ip_address = ip_b
        self.ping_b.save(update_fields=["ip_address"])
        self.login()
        a = self.pin(self.ping, "0", ip_address=str(self.ip.id)).json()["id"]
        b = self.pin(self.ping_b, "0", ip_address=str(ip_b.id)).json()["id"]
        user = self._user(
            [(["prtgsensorpin", "device", "ipaddress"], ["view", "change"])],
            sites=[self.site_b],
        )
        self.login(user)
        listed = [p["id"] for p in self.client.get(URL).json()["results"]]
        self.assertEqual(listed, [b])
        self.assertEqual(self.client.delete(f"{URL}{a}/").status_code, 404)
        self.assertEqual(self.pin(self.ping, "1", ip_address=str(self.ip.id)).status_code, 400)
        self.assertEqual(self.pin(self.ping_b, "1", ip_address=str(ip_b.id)).status_code, 201)
