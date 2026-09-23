"""A MAC from a range the organisation owns is handed out once (#222)."""
from __future__ import annotations

import threading

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TransactionTestCase
from rest_framework.test import APIClient

from core.models import Organization, Tenant

from .models import Device, Interface, MACAddress, OuiPrefix, Site

User = get_user_model()


class MacAllocationTests(TransactionTestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="S")
        sw1 = Device.objects.create(tenant=self.tenant, name="switch-1", site=site)
        sw2 = Device.objects.create(tenant=self.tenant, name="switch-2", site=site)
        self.eth_a = Interface.objects.create(device=sw1, name="eth0")
        self.eth_b = Interface.objects.create(device=sw2, name="eth0")
        self.rng = OuiPrefix.objects.create(
            tenant=self.tenant, prefix="02aabb", vendor="Cluster", source="custom"
        )
        self.admin = User.objects.create_superuser("admin", "a@x.y", "x")

    def _client(self):
        c = APIClient()
        c.force_login(self.admin)
        s = c.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        return c

    def _create(self, client, mac, iface):
        return client.post("/api/mac-addresses/", {
            "mac_address": mac, "assigned_interface_id": str(iface.id),
        }, format="json")

    def test_two_operators_with_the_dialog_open_cannot_both_save_it(self):
        a, b = self._client(), self._client()
        mac_a = a.get(f"/api/oui-ranges/{self.rng.id}/next/").json()["mac"]
        mac_b = b.get(f"/api/oui-ranges/{self.rng.id}/next/").json()["mac"]
        self.assertEqual(mac_a, mac_b)  # the probe writes nothing - by design

        self.assertEqual(self._create(a, mac_a, self.eth_a).status_code, 201)
        r = self._create(b, mac_b, self.eth_b)

        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("02:aa:bb:00:00:01", str(r.json()["mac_address"]))
        self.assertEqual(MACAddress.objects.filter(mac_address=mac_a).count(), 1)

    def test_simultaneous_saves_are_decided_one_after_the_other(self):
        results = {}
        barrier = threading.Barrier(2)

        def save(name, iface):
            try:
                c = self._client()
                barrier.wait()
                results[name] = self._create(c, "02:aa:bb:00:00:07", iface).status_code
            finally:
                connection.close()

        threads = [threading.Thread(target=save, args=("a", self.eth_a)),
                   threading.Thread(target=save, args=("b", self.eth_b))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(sorted(results.values()), [201, 400])
        self.assertEqual(
            MACAddress.objects.filter(mac_address="02:aa:bb:00:00:07").count(), 1
        )

    def test_outside_an_owned_range_a_shared_mac_is_still_allowed(self):
        """A virtual MAC (VRRP, an anycast gateway) legitimately sits on
        several interfaces; the table has always allowed that."""
        c = self._client()
        vmac = "00:00:5e:00:01:01"
        self.assertEqual(self._create(c, vmac, self.eth_a).status_code, 201)
        self.assertEqual(self._create(c, vmac, self.eth_b).status_code, 201)

    def test_the_interface_that_already_carries_it_is_not_a_clash(self):
        self.eth_a.mac_address = "02:aa:bb:00:00:09"
        self.eth_a.save()
        c = self._client()
        self.assertEqual(
            self._create(c, "02:aa:bb:00:00:09", self.eth_a).status_code, 201
        )
        self.assertEqual(
            self._create(c, "02:aa:bb:00:00:09", self.eth_b).status_code, 400
        )
