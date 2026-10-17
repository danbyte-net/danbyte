"""The device's hardware_count feeds the Components and Hardware tab badges."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Antenna, Device, DeviceType, InventoryItem, Manufacturer
from core.models import Organization, Tenant


class HardwareCountTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="AP", name="AP")
        self.dev = Device.objects.create(tenant=self.tenant, name="ap1", device_type=dt)
        self.client.force_login(User.objects.create_superuser("root", "r@a.c", "pw"))
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_antennas_count_as_hardware(self):
        Antenna.objects.create(device=self.dev, name="ant1", antenna_type="omni")
        Antenna.objects.create(device=self.dev, name="ant2", antenna_type="omni")
        InventoryItem.objects.create(device=self.dev, name="psu")
        r = self.client.get(f"/api/devices/{self.dev.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["hardware_count"], 3)

    def test_front_and_rear_ports_have_their_own_counts(self):
        """Front and rear ports are tabs of their own (#345): counted apart
        from the Hardware tab."""
        from api.models import FrontPort, RearPort

        InventoryItem.objects.create(device=self.dev, name="psu")
        rp = RearPort.objects.create(device=self.dev, name="R1", positions=2)
        RearPort.objects.create(device=self.dev, name="R2", positions=1)
        FrontPort.objects.create(device=self.dev, name="F1", rear_port=rp, rear_port_position=1)
        body = self.client.get(f"/api/devices/{self.dev.id}/").json()
        self.assertEqual(
            (body["hardware_count"], body["front_port_count"], body["rear_port_count"]),
            (1, 1, 2),
        )
        listed = self.client.get("/api/devices/").json()["results"][0]
        self.assertEqual((listed["front_port_count"], listed["rear_port_count"]), (0, 0))
