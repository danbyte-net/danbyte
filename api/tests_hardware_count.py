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
