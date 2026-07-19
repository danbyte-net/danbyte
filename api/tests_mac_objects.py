"""MAC aggregation views with first-class MAC objects.

`/api/macs/` and `/api/macs/<mac>/` union three sources — interface hardware
addresses, IP↔MAC pairings, and :class:`~api.models.MACAddress` objects. These
tests pin that a standalone MAC object (no matching interface/IP string) still
shows up, and that object metadata (description / tags / assignment) rides along.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Interface, MACAddress, Manufacturer
from core.models import Organization, Tenant

User = get_user_model()


class MacAggregationTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt)
        # An interface carrying a hardware MAC + a matching first-class object.
        self.iface = Interface.objects.create(
            device=self.device, name="eth0", mac_address="aa:bb:cc:dd:ee:01"
        )
        self.obj = MACAddress.objects.create(
            tenant=self.tenant,
            mac_address="aa:bb:cc:dd:ee:01",
            assigned_interface=self.iface,
            description="primary nic",
        )
        # A standalone object — no interface or IP string references this MAC.
        self.standalone = MACAddress.objects.create(
            tenant=self.tenant, mac_address="de:ad:be:ef:00:99", description="spare"
        )
        admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_list_surfaces_objects(self):
        resp = self.client.get("/api/macs/")
        self.assertEqual(resp.status_code, 200)
        by_mac = {r["mac"]: r for r in resp.json()["results"]}
        # The interface MAC row carries both the interface and the object.
        row = by_mac["aa:bb:cc:dd:ee:01"]
        self.assertEqual(len(row["interfaces"]), 1)
        self.assertEqual(len(row["objects"]), 1)
        self.assertEqual(row["objects"][0]["description"], "primary nic")
        self.assertEqual(
            row["objects"][0]["assigned_interface"]["name"], "eth0"
        )

    def test_standalone_object_appears_in_list(self):
        # A MAC known only from an object (no interface/IP) is still a row.
        resp = self.client.get("/api/macs/")
        by_mac = {r["mac"]: r for r in resp.json()["results"]}
        self.assertIn("de:ad:be:ef:00:99", by_mac)
        row = by_mac["de:ad:be:ef:00:99"]
        self.assertEqual(row["interfaces"], [])
        self.assertEqual(row["ips"], [])
        self.assertEqual(row["objects"][0]["description"], "spare")

    def test_detail_includes_objects_with_custom_fields(self):
        resp = self.client.get("/api/macs/aa:bb:cc:dd:ee:01/")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["objects"]), 1)
        obj = data["objects"][0]
        self.assertEqual(obj["mac_address"], "aa:bb:cc:dd:ee:01")
        self.assertIn("custom_fields", obj)

    def test_detail_of_standalone_object(self):
        # Detail resolves for an object-only MAC (formerly 404'd).
        resp = self.client.get("/api/macs/de:ad:be:ef:00:99/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["objects"][0]["description"], "spare")

    def test_detail_unknown_mac_404(self):
        resp = self.client.get("/api/macs/00:00:00:00:00:00/")
        self.assertEqual(resp.status_code, 404)

    def test_other_tenant_object_not_listed(self):
        org2 = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=org2, name="T2", slug="t2")
        MACAddress.objects.create(
            tenant=other, mac_address="11:22:33:44:55:66", description="leak?"
        )
        resp = self.client.get("/api/macs/")
        macs = {r["mac"] for r in resp.json()["results"]}
        self.assertNotIn("11:22:33:44:55:66", macs)
