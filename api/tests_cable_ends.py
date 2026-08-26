"""What a single END of a cable may hold.

Several ports on one end is normal - a QSFP breakout fans out to four SFPs,
and those legs routinely land in four DIFFERENT servers, so the model
deliberately allows one side to span devices. Mixing port KINDS on one end is
not allowed: no cable is half network and half power.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Device, DeviceType, Interface, PowerPort

User = get_user_model()


class CableEndCompositionTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.sw = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt
        )
        self.srv_a = Device.objects.create(
            tenant=self.tenant, name="srv-a", device_type=dt
        )
        self.srv_b = Device.objects.create(
            tenant=self.tenant, name="srv-b", device_type=dt
        )
        self.qsfp = Interface.objects.create(device=self.sw, name="Et1/49")
        self.leg_a = Interface.objects.create(device=self.srv_a, name="eno1")
        self.leg_b = Interface.objects.create(device=self.srv_b, name="eno1")
        self.psu = PowerPort.objects.create(device=self.srv_a, name="PSU1")

    def _post(self, a, b):
        return self.client.post(
            "/api/cables/",
            {
                "type": "mmf-om4",
                "a": [{"kind": k, "id": str(o.id)} for k, o in a],
                "b": [{"kind": k, "id": str(o.id)} for k, o in b],
            },
            format="json",
        )

    def test_a_breakout_may_land_on_several_devices(self):
        r = self._post(
            [("interface", self.qsfp)],
            [("interface", self.leg_a), ("interface", self.leg_b)],
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()["b_terminations"]), 2)

    def test_one_end_cannot_mix_port_kinds(self):
        r = self._post(
            [("interface", self.qsfp)],
            [("interface", self.leg_a), ("power_port", self.psu)],
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("one kind of port", str(r.json()).lower())
