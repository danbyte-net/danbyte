"""Prefix.allocate_from_ranges - the ranges inside a prefix as its
allocatable space (the follow-up to #143)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import IPAddress, IPRange, Prefix, Site
from api.test_utils import status_for
from api.views import _autospawn_gateway, _next_available_ips, _subnet_details
from auth_api.models import UserProfile
from core.models import Organization, Tenant


class AllocationTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="192.173.199.0/24",
            status=status_for(self.tenant), allocate_from_ranges=True,
        )
        self.range = IPRange.objects.create(
            tenant=self.tenant, prefix=self.prefix,
            start_address="192.173.199.61", end_address="192.173.199.67",
            status=status_for(self.tenant),
        )

    def _ip(self, addr):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=self.prefix, ip_address=addr
        )

    def test_next_available_walks_the_ranges(self):
        self._ip("192.173.199.61")
        self.assertEqual(
            _next_available_ips(self.prefix, count=3),
            ["192.173.199.62", "192.173.199.63", "192.173.199.64"],
        )

    def test_next_available_ignores_a_dhcp_exclusion(self):
        from integrations.models import DhcpExclusion, DhcpScope

        scope = DhcpScope.objects.create(
            tenant=self.tenant, scope_id="192.173.199.0", name="s",
            start_range="192.173.199.10", end_range="192.173.199.20",
        )
        excl = IPRange.objects.create(
            tenant=self.tenant, prefix=self.prefix,
            start_address="192.173.199.10", end_address="192.173.199.12",
            status=status_for(self.tenant),
        )
        DhcpExclusion.objects.create(
            scope=scope, ip_range=excl,
            start_address="192.173.199.10", end_address="192.173.199.12",
        )
        self.assertEqual(_next_available_ips(self.prefix, count=1), ["192.173.199.61"])

    def test_next_available_empty_without_ranges(self):
        self.range.delete()
        self.assertEqual(_next_available_ips(self.prefix), [])

    def test_next_available_works_in_a_prefix_too_big_to_enumerate(self):
        big = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8",
            status=status_for(self.tenant), allocate_from_ranges=True,
        )
        IPRange.objects.create(
            tenant=self.tenant, prefix=big,
            start_address="10.9.9.1", end_address="10.9.9.3",
            status=status_for(self.tenant),
        )
        self.assertEqual(_next_available_ips(big, count=5), ["10.9.9.1", "10.9.9.2", "10.9.9.3"])

    def test_utilisation_and_summary_count_the_ranges(self):
        self._ip("192.173.199.64")
        self._ip("192.173.199.1")  # outside every range - not part of the pool
        self.assertEqual(self.prefix.utilisation_pct, 14)
        summary = self.prefix.allocation_summary()
        self.assertEqual((summary["size"], summary["used"], summary["free"]), (7, 1, 6))
        self.assertEqual(summary["ranges"][0]["start_address"], "192.173.199.61")

    def test_utilisation_none_without_ranges(self):
        self.range.delete()
        self.assertIsNone(self.prefix.utilisation_pct)

    def test_off_means_whole_network(self):
        self.prefix.allocate_from_ranges = False
        self.prefix.save()
        self.assertIsNone(self.prefix.allocation_summary())
        self.assertEqual(_next_available_ips(self.prefix, count=1), ["192.173.199.1"])

    def test_subnet_details_gain_allocation_rows(self):
        self._ip("192.173.199.64")
        labels = {r["label"]: r["value"] for r in _subnet_details(self.prefix)}
        self.assertEqual(labels["Allocation"], "192.173.199.61–192.173.199.67")
        self.assertEqual(labels["Managed addresses"], "7")
        self.assertEqual(labels["Used"], "1")
        self.assertEqual(labels["Available"], "6")

    def test_serializer_exposes_flag_and_summary(self):
        r = self.client.get(f"/api/prefixes/{self.prefix.id}/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["allocate_from_ranges"])
        self.assertEqual(r.json()["allocation"]["size"], 7)
        r = self.client.patch(
            f"/api/prefixes/{self.prefix.id}/",
            {"allocate_from_ranges": False}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["allocation"])

    def test_new_ip_outside_the_ranges_is_refused(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "192.173.199.5", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("allocates only from its ranges", r.json()["ip_address"][0])
        self.assertIn("192.173.199.61–192.173.199.67", r.json()["ip_address"][0])

    def test_new_ip_inside_a_range_saves(self):
        r = self.client.post(
            "/api/ips/",
            {"ip_address": "192.173.199.64", "prefix_id": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_editing_a_legacy_ip_outside_the_ranges_still_saves(self):
        ip = self._ip("192.173.199.1")
        r = self.client.patch(
            f"/api/ips/{ip.id}/", {"description": "provider gateway"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_populate_is_cut_to_the_ranges(self):
        r = self.client.post(
            f"/api/prefixes/{self.prefix.id}/populate/",
            {"start": "192.173.199.60", "end": "192.173.199.70"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["created"], 7)
        self.assertEqual(
            IPAddress.objects.filter(prefix=self.prefix).count(), 7
        )
        r = self.client.post(
            f"/api/prefixes/{self.prefix.id}/populate/",
            {"start": "192.173.199.2", "end": "192.173.199.4"}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_gateway_autospawn_skips_the_providers_gateway(self):
        site = Site.objects.create(
            tenant=self.tenant, name="S", gateway_policy="first"
        )
        self.prefix.site = site
        self.prefix.save()
        self.assertIsNone(_autospawn_gateway(self.prefix))
        self.assertFalse(IPAddress.objects.filter(ip_address="192.173.199.1").exists())
