"""Interface speed: free text, but a bare kbps number normalises to the
dropdown's form so scrapers and people end up with the same labels."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, Interface
from api.speed import normalize_speed, speed_mbps
from core.models import Organization, Tenant


class SpeedHelpersTests(APITestCase):
    def test_bare_kbps_reads_as_mbps(self):
        self.assertEqual(speed_mbps("1000000"), 1000)
        self.assertEqual(speed_mbps("25000000"), 25000)
        self.assertEqual(speed_mbps("10G"), 10000)
        self.assertIsNone(speed_mbps("fast"))

    def test_normalize(self):
        for raw, want in (
            ("1000000", "1G"), ("25000000", "25G"), ("2500000", "2.5G"),
            ("100000", "100M"), ("10000", "10M"), ("1234000", "1.234G"),
            ("10G", "10G"), ("1 Gbps", "1 Gbps"), ("", ""), ("0", "0"),
        ):
            self.assertEqual(normalize_speed(raw), want, raw)


class SpeedApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dev = Device.objects.create(tenant=self.tenant, name="sw1")
        self.client.force_login(
            get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        )
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_api_write_normalises(self):
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(self.dev.id), "name": "eth0", "speed": "25000000"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["speed"], "25G")
        r = self.client.patch(
            f"/api/interfaces/{r.json()['id']}/", {"speed": "100000"}, format="json"
        )
        self.assertEqual(r.json()["speed"], "100M")

    def test_bulk_update_normalises(self):
        eth = Interface.objects.create(device=self.dev, name="eth0")
        r = self.client.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(eth.id)], "fields": {"speed": "1000000"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        eth.refresh_from_db()
        self.assertEqual(eth.speed, "1G")
