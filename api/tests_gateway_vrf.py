"""Gateway autospawn stays inside the new prefix's VRF (#331)."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import VRF, IPAddress, IPRole, Prefix, Site
from api.vrf_placement import ANY_VRF, row_in_vrf
from core.models import Organization, Tenant


class GatewayAutospawnVrfTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(
            tenant=self.tenant, name="S1", gateway_policy="first"
        )
        self.gw_role = IPRole.objects.create(
            tenant=self.tenant, name="Gateway", slug="gateway", is_gateway=True
        )
        self.vrf_a = VRF.objects.create(tenant=self.tenant, name="A")
        self.vrf_b = VRF.objects.create(tenant=self.tenant, name="B")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _create(self, cidr, vrf=None):
        body = {"cidr": cidr, "site_id": str(self.site.id)}
        if vrf is not None:
            body["vrf_id"] = str(vrf.id)
        r = self.client.post("/api/prefixes/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return Prefix.objects.get(pk=r.json()["id"])

    def _ip(self, prefix, addr):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address=addr
        )

    def test_another_vrfs_address_is_left_alone(self):
        prefix_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", vrf=self.vrf_a
        )
        ip_a = self._ip(prefix_a, "10.0.0.1")
        prefix_b = self._create("10.0.0.0/24", self.vrf_b)

        ip_a.refresh_from_db()
        self.assertEqual(ip_a.vrf_id, self.vrf_a.id)
        self.assertEqual(ip_a.prefix_id, prefix_a.id)
        self.assertIsNone(ip_a.role_id)
        self.assertEqual(prefix_a.ip_addresses.count(), 1)

        gw = IPAddress.objects.get(tenant=self.tenant, vrf=self.vrf_b, ip_address="10.0.0.1")
        self.assertNotEqual(gw.pk, ip_a.pk)
        self.assertEqual(gw.prefix_id, prefix_b.id)
        self.assertEqual(gw.role_id, self.gw_role.id)
        self.assertEqual(prefix_b.gateway, "10.0.0.1")

    def test_address_in_two_other_vrfs_still_spawns(self):
        # Two existing rows used to raise MultipleObjectsReturned, swallowed.
        for vrf in (self.vrf_a, None):
            p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", vrf=vrf)
            self._ip(p, "10.0.0.1")
        prefix_b = self._create("10.0.0.0/24", self.vrf_b)
        self.assertTrue(
            IPAddress.objects.filter(
                prefix=prefix_b, ip_address="10.0.0.1", role=self.gw_role
            ).exists()
        )
        self.assertEqual(prefix_b.gateway, "10.0.0.1")

    def test_global_and_vrf_do_not_cross(self):
        prefix_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", vrf=self.vrf_a
        )
        ip_a = self._ip(prefix_a, "10.0.0.1")
        prefix_g = self._create("10.0.0.0/24")
        ip_a.refresh_from_db()
        self.assertEqual(ip_a.prefix_id, prefix_a.id)
        gw = IPAddress.objects.get(tenant=self.tenant, vrf=None, ip_address="10.0.0.1")
        self.assertEqual(gw.prefix_id, prefix_g.id)

    def test_same_vrf_parent_address_moves_in(self):
        parent = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/16", vrf=self.vrf_a
        )
        ip = self._ip(parent, "10.0.0.1")
        child = self._create("10.0.0.0/24", self.vrf_a)
        ip.refresh_from_db()
        self.assertEqual(ip.prefix_id, child.id)
        self.assertEqual(ip.role_id, self.gw_role.id)
        self.assertEqual(
            IPAddress.objects.filter(tenant=self.tenant, ip_address="10.0.0.1").count(), 1
        )

    def test_same_vrf_more_specific_owner_keeps_it(self):
        link = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/30", vrf=self.vrf_a
        )
        ip = self._ip(link, "10.0.0.1")
        new = self._create("10.0.0.0/24", self.vrf_a)
        ip.refresh_from_db()
        self.assertEqual(ip.prefix_id, link.id)
        self.assertIsNone(ip.role_id)
        self.assertEqual(new.gateway, "10.0.0.1")

    def test_a_failing_autospawn_is_logged_not_swallowed(self):
        with mock.patch("api.views._autospawn_gateway", side_effect=RuntimeError("boom")):
            with self.assertLogs("danbyte.api", level="ERROR") as logs:
                prefix = self._create("10.9.0.0/24")
        self.assertIn("gateway autospawn failed", logs.output[0])
        self.assertTrue(Prefix.objects.filter(pk=prefix.pk).exists())


class RowInVrfTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.vrf_a = VRF.objects.create(tenant=self.tenant, name="A")

    def test_named_vrf_is_a_hard_scope(self):
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", vrf=self.vrf_a)
        IPAddress.objects.create(tenant=self.tenant, prefix=p, ip_address="10.0.0.5")
        self.assertIsNone(row_in_vrf(self.tenant, "10.0.0.5", None))
        self.assertIsNotNone(row_in_vrf(self.tenant, "10.0.0.5", self.vrf_a))
        self.assertIsNotNone(row_in_vrf(self.tenant, "10.0.0.5", ANY_VRF))

    def test_any_vrf_with_several_rows_takes_the_placed_one(self):
        wide = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/16")
        narrow = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", vrf=self.vrf_a
        )
        IPAddress.objects.create(tenant=self.tenant, prefix=wide, ip_address="10.0.0.5")
        a = IPAddress.objects.create(tenant=self.tenant, prefix=narrow, ip_address="10.0.0.5")
        self.assertEqual(row_in_vrf(self.tenant, "10.0.0.5"), a)
