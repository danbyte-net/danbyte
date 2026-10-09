"""Name ranges keep zero padding, take [n-n] as one name, and never store a
name with its brackets (#335)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Device, DeviceType, ModuleType, RearPort
from .name_range import expand_name_range, range_error

User = get_user_model()


class ExpandTests(SimpleTestCase):
    def test_padding_follows_the_start_bound(self):
        self.assertEqual(
            expand_name_range("Eth[01-04]"), ["Eth01", "Eth02", "Eth03", "Eth04"]
        )
        self.assertEqual(
            expand_name_range("p[08-11]"), ["p08", "p09", "p10", "p11"]
        )
        self.assertEqual(expand_name_range("Gi1/0/[001-002]"), ["Gi1/0/001", "Gi1/0/002"])

    def test_unpadded_ranges_are_unchanged(self):
        self.assertEqual(expand_name_range("Eth[1-3]"), ["Eth1", "Eth2", "Eth3"])
        self.assertEqual(expand_name_range("x[0-2]"), ["x0", "x1", "x2"])
        self.assertEqual(expand_name_range("Eth[9-10]"), ["Eth9", "Eth10"])

    def test_single_value_range_is_one_name(self):
        self.assertEqual(expand_name_range("Eth[5-5]"), ["Eth5"])
        self.assertIsNone(range_error("Eth[5-5]"))

    def test_unusable_ranges_are_reported(self):
        self.assertIn("count up", range_error("a[2-1]"))
        self.assertIn("count up", range_error("p[1-9999]"))
        self.assertIn("Only one", range_error("a[1-2]/[1-2]"))
        self.assertIsNone(range_error("eth0"))
        self.assertIsNone(range_error("Eth[01-04]"))


class RangeCreateTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )

    def _iface(self, name):
        return self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.device.id), "name": name, "type": "1000base-t"},
            format="json",
        )

    def _names(self, qs):
        return sorted(qs.values_list("name", flat=True))

    def test_padded_interface_range(self):
        r = self._iface("Eth[01-04]")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name"], "Eth01")
        self.assertEqual(
            self._names(self.device.interfaces),
            ["Eth01", "Eth02", "Eth03", "Eth04"],
        )

    def test_single_value_range_creates_the_name(self):
        r = self._iface("Eth[5-5]")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name"], "Eth5")
        self.assertEqual(self._names(self.device.interfaces), ["Eth5"])

    def test_single_value_range_clash_is_a_clean_400(self):
        self.assertEqual(self._iface("Eth5").status_code, 201)
        r = self._iface("Eth[5-5]")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Already exists", r.json()["name"])
        self.assertEqual(self._names(self.device.interfaces), ["Eth5"])

    def test_unexpandable_ranges_are_refused_not_stored(self):
        for name in ("Eth[5-1]", "Eth[1-9999]", "Eth[1-2]/[1-2]"):
            with self.subTest(name=name):
                r = self._iface(name)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("name", r.json())
        self.assertEqual(self.device.interfaces.count(), 0)

    def test_plain_names_are_untouched(self):
        for name in ("eth0", "Gi1/0/1", "port [a]"):
            self.assertEqual(self._iface(name).status_code, 201, name)
        self.assertEqual(
            self._names(self.device.interfaces), ["Gi1/0/1", "eth0", "port [a]"]
        )

    def test_ports_and_rear_ports_pad_too(self):
        r = self.client.post(
            "/api/console-ports/",
            {"device_id": str(self.device.id), "name": "con[01-02]"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._names(self.device.console_ports), ["con01", "con02"])
        r = self.client.post(
            "/api/rear-ports/",
            {"device_id": str(self.device.id), "name": "R[01-02]", "positions": 2},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self._names(RearPort.objects.filter(device=self.device)), ["R01", "R02"]
        )

    def test_templates_pad_and_refuse(self):
        r = self.client.post(
            "/api/interface-templates/",
            {"device_type_id": str(self.dt.id), "name": "Eth[01-03]"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self._names(self.dt.interface_templates), ["Eth01", "Eth02", "Eth03"]
        )
        r = self.client.post(
            "/api/interface-templates/",
            {"device_type_id": str(self.dt.id), "name": "Eth[9-9]"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name"], "Eth9")
        r = self.client.post(
            "/api/interface-templates/",
            {"device_type_id": str(self.dt.id), "name": "Eth[3-1]"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.dt.interface_templates.count(), 4)

    def test_module_templates_take_single_and_padded_ranges(self):
        mt = ModuleType.objects.create(tenant=self.tenant, name="NM")
        for name in ("Te1/{module}/[01-02]", "Te1/{module}/[7-7]"):
            r = self.client.post(
                "/api/module-interface-templates/",
                {"module_type_id": str(mt.id), "name": name, "type": "10gbase-x-sfpp"},
                format="json",
            )
            self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self._names(mt.interface_templates),
            ["Te1/{module}/01", "Te1/{module}/02", "Te1/{module}/7"],
        )
