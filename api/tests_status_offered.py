"""A status goes only on the kinds of object its catalog entry offers it to
(``available_to``) - through the API's single edit and every bulk edit, as
the pickers already hold to. An object already wearing another keeps it
through an edit that leaves the status alone."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import VLAN, Device, Interface, IPAddress, Prefix, Status
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant


class StatusOfferedTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self.client.force_login(admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.active = status_for(self.tenant)
        self.ip_only = Status.objects.create(
            tenant=self.tenant, name="DHCP", slug="dhcp", available_to=["ipaddress"]
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")

    def test_a_device_refuses_a_status_offered_only_to_addresses(self):
        url = f"/api/devices/{self.device.id}/"
        r = self.client.patch(url, {"status_id": str(self.ip_only.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["status_id"], ["“DHCP” isn't a status for devices."])
        r = self.client.patch(url, {"status_id": str(self.active.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_object_keeps_a_status_it_already_wears(self):
        Device.objects.filter(pk=self.device.pk).update(status=self.ip_only)
        url = f"/api/devices/{self.device.id}/"
        r = self.client.patch(url, {"description": "x", "status_id": str(self.ip_only.id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_address_takes_its_own_and_refuses_a_device_status(self):
        dev_only = Status.objects.create(
            tenant=self.tenant, name="Racked", slug="racked", available_to=["device"]
        )
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=self.active)
        body = {"ip_address": "10.0.0.1/24", "prefix_id": str(pfx.id)}
        r = self.client.post("/api/ips/", {**body, "status_id": str(dev_only.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["status_id"], ["“Racked” isn't a status for IP addresses."])
        r = self.client.post("/api/ips/", {**body, "status_id": str(self.ip_only.id)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_bulk_edits_hold_to_the_catalog(self):
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24",
                                       status=self.active)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.1.0.5/24",
                                      prefix=prefix)
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v10")
        iface = Interface.objects.create(device=self.device, name="eth0")
        dev_only = Status.objects.create(
            tenant=self.tenant, name="Racked", slug="racked", available_to=["device"]
        )
        for url, ids in (("/api/prefixes/bulk-update/", [prefix.id]),
                         ("/api/ips/bulk-update/", [ip.id]),
                         ("/api/vlans/bulk-update/", [vlan.id]),
                         ("/api/interfaces/bulk-update/", [iface.id])):
            with self.subTest(url=url):
                r = self.client.post(url, {"ids": [str(i) for i in ids],
                                           "fields": {"status_id": str(dev_only.id)}},
                                     format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("status_id", r.json())
        r = self.client.post("/api/ips/bulk-update/", {
            "ids": [str(ip.id)], "fields": {"status_id": str(self.ip_only.id)},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
