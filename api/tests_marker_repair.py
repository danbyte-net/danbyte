"""api.0155 - photo markers a bulk template rename left on the old names."""
from __future__ import annotations

from django.apps import apps as global_apps
from django.test import TestCase

from api.models import Device, DeviceRole, DeviceType, Interface, InterfaceTemplate, Manufacturer
from core.models import Organization, Tenant


class PositionMarkerRepairTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")

    def _dt(self, **kw):
        return DeviceType.objects.create(
            tenant=self.tenant, manufacturer=self.mfr, **kw
        )

    def test_repairs_literal_marker_to_position_template(self):
        dt = self._dt(
            model="SW-40",
            image_ports={"front": [
                {"kind": "interface", "name": "Te1/0/1", "x": 1, "y": 1},
                {"kind": "interface", "name": "Gi0/0", "x": 2, "y": 1},
            ]},
            faceplate={"front": [
                {"slots": [{"t": "port", "kind": "interface", "name": "Te1/0/1"}]}
            ]},
        )
        InterfaceTemplate.objects.create(device_type=dt, name="Te{position}/0/1")
        InterfaceTemplate.objects.create(device_type=dt, name="Gi0/0")
        self.repair()
        dt.refresh_from_db()
        self.assertEqual(
            [m["name"] for m in dt.image_ports["front"]], ["Te{position}/0/1", "Gi0/0"]
        )
        self.assertEqual(
            dt.faceplate["front"][0]["slots"][0]["name"], "Te{position}/0/1"
        )

    def test_sync_diff_stops_expecting_the_literal_name(self):
        dt = self._dt(
            model="SW-2",
            image_ports={"front": [
                {"kind": "interface", "name": "Te1/0/1", "x": 1, "y": 1}
            ]},
        )
        InterfaceTemplate.objects.create(device_type=dt, name="Te{position}/0/1")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        dev = Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=dt, role=role, vc_position=2
        )
        Interface.objects.create(device=dev, name="Te2/0/1", marker_key="Te2/0/1")
        from api.models import diff_device_components

        self.assertEqual(
            diff_device_components(dev).get("interfaces", {}).get("add"), ["Te1/0/1"]
        )
        self.repair()
        dev.refresh_from_db()
        self.assertEqual(diff_device_components(dev), {})

    def test_leaves_a_marker_a_template_actually_defines(self):
        dt = self._dt(
            model="SW-3",
            image_ports={"front": [
                {"kind": "interface", "name": "Te1/0/1", "x": 1, "y": 1}
            ]},
        )
        InterfaceTemplate.objects.create(device_type=dt, name="Te1/0/1")
        InterfaceTemplate.objects.create(device_type=dt, name="Te{position}/0/1")
        self.repair()
        dt.refresh_from_db()
        self.assertEqual(dt.image_ports["front"][0]["name"], "Te1/0/1")

    def test_leaves_an_unmatched_marker_alone_and_is_idempotent(self):
        dt = self._dt(
            model="SW-4",
            image_ports={"front": [
                {"kind": "interface", "name": "Xe9/9/9", "x": 1, "y": 1}
            ]},
        )
        InterfaceTemplate.objects.create(device_type=dt, name="Te{position}/0/1")
        self.repair()
        self.repair()
        dt.refresh_from_db()
        self.assertEqual(dt.image_ports["front"][0]["name"], "Xe9/9/9")

    def repair(self):
        import importlib

        mod = importlib.import_module("api.migrations.0155_repair_position_markers")
        mod.repair(global_apps, None)
