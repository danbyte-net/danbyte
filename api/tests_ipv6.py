"""IPv6 as a first-class citizen: enumerability, the v6 subnet map, next-
available, utilisation, and numeric address sorting."""
from __future__ import annotations

import ipaddress

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Aggregate, IPAddress, Prefix, RIR, is_enumerable
from api.views import _build_space_map, _next_available_ips
from auth_api.models import UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class IsEnumerableTests(APITestCase):
    def test_boundary(self):
        net = ipaddress.ip_network
        # 4096-address cap, both families.
        self.assertTrue(is_enumerable(net("2001:db8::/116")))   # 4096
        self.assertFalse(is_enumerable(net("2001:db8::/115")))  # 8192
        self.assertTrue(is_enumerable(net("10.0.0.0/20")))      # 4096
        self.assertFalse(is_enumerable(net("10.0.0.0/19")))     # 8192
        self.assertFalse(is_enumerable(net("2001:db8::/64")))
        self.assertFalse(is_enumerable(None))


class SpaceMapV6Tests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _mk(self, cidr, status="active"):
        return Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, status=status_for(self.tenant, status)
        )

    def _rows(self, prefix):
        return [
            (r["prefixlen"], r["count"])
            for r in _build_space_map(
                prefix.network, child_nets=[], tenant=self.tenant, vrf=None
            )
        ]

    def test_v6_64_is_nibble_capped(self):
        self.assertEqual(self._rows(self._mk("2001:db8::/64")),
                         [(68, 16), (72, 256)])

    def test_v6_small_steps_to_host_cells(self):
        self.assertEqual(self._rows(self._mk("2001:db8:0:1::/120")),
                         [(124, 16), (128, 256)])

    def test_v6_near_128_falls_back_to_bit_steps(self):
        self.assertEqual(self._rows(self._mk("2001:db8:0:2::/126")),
                         [(127, 2), (128, 4)])

    def test_v6_128_has_no_rows(self):
        self.assertEqual(self._rows(self._mk("2001:db8::1/128")), [])

    def test_v4_unchanged(self):
        # Regression: v4 still steps one bit at a time.
        self.assertEqual(self._rows(self._mk("10.0.0.0/28"))[:3],
                         [(29, 2), (30, 4), (31, 8)])

    def test_used_and_dirty_cells(self):
        parent = self._mk("2001:db8:0:3::/120")
        # A child /124 → its cells in the /124 row are "used".
        self._mk("2001:db8:0:3::/124")
        # A stray IP with no covering child → its cell is "dirty".
        IPAddress.objects.create(
            tenant=self.tenant, prefix=parent, ip_address="2001:db8:0:3::ff",
        )
        rows = _build_space_map(
            parent.network, child_nets=[ipaddress.ip_network("2001:db8:0:3::/124")],
            tenant=self.tenant, vrf=None,
        )
        row124 = next(r for r in rows if r["prefixlen"] == 124)
        self.assertTrue(any(c["used"] for c in row124["cells"]))
        self.assertTrue(any(c["dirty"] for c in row124["cells"]))

    def test_endpoint_supported_and_within(self):
        p = self._mk("2001:db8::/48")
        res = self.client.get(f"/api/prefixes/{p.id}/space-map/")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["supported"])
        self.assertEqual(res.json()["root"], "2001:db8::/48")
        # Descend into a child cell.
        res2 = self.client.get(
            f"/api/prefixes/{p.id}/space-map/?within=2001:db8:0:100::/56"
        )
        self.assertEqual(res2.status_code, 200)
        self.assertEqual(res2.json()["root"], "2001:db8:0:100::/56")
        # A cidr outside the prefix is rejected.
        bad = self.client.get(
            f"/api/prefixes/{p.id}/space-map/?within=2002::/56"
        )
        self.assertEqual(bad.status_code, 400)


class NextAvailableAndUtilTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _mk(self, cidr):
        return Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, status=status_for(self.tenant)
        )

    def test_next_available_small_v6(self):
        p = self._mk("2001:db8:0:1::/120")
        self.assertEqual(
            _next_available_ips(p, count=3),
            ["2001:db8:0:1::1", "2001:db8:0:1::2", "2001:db8:0:1::3"],
        )

    def test_next_available_huge_v6_empty(self):
        self.assertEqual(_next_available_ips(self._mk("2001:db8::/64")), [])

    def test_next_available_127_returns_both(self):
        p = self._mk("2001:db8:0:2::/127")
        self.assertEqual(
            _next_available_ips(p, count=5),
            ["2001:db8:0:2::", "2001:db8:0:2::1"],
        )

    def test_utilisation_small_v6_is_int(self):
        p = self._mk("2001:db8:0:3::/120")
        IPAddress.objects.create(
            tenant=self.tenant, prefix=p, ip_address="2001:db8:0:3::5"
        )
        self.assertIsInstance(p.utilisation_pct, int)

    def test_utilisation_huge_v6_is_none(self):
        self.assertIsNone(self._mk("2001:db8::/64").utilisation_pct)


class NumericSortTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_prefixes_sort_numeric_v4_before_v6(self):
        for c in ["10.0.0.10/32", "10.0.0.2/32", "2001:db8::/48"]:
            Prefix.objects.create(tenant=self.tenant, cidr=c, status=status_for(self.tenant))
        res = self.client.get("/api/prefixes/?page_size=50")
        order = [r["cidr"] for r in res.json()["results"]]
        self.assertEqual(
            order, ["10.0.0.2/32", "10.0.0.10/32", "2001:db8::/48"]
        )

    def test_aggregates_sort_numeric(self):
        rir = RIR.objects.create(tenant=self.tenant, name="RIPE", slug="ripe")
        for c in ["10.0.0.0/8", "2001:db8::/32", "10.0.0.0/12"]:
            Aggregate.objects.create(tenant=self.tenant, prefix=c, rir=rir)
        res = self.client.get("/api/aggregates/?page_size=50")
        order = [r["prefix"] for r in res.json()["results"]]
        # Same address sorts parent (/8) before child (/12); v4 before v6.
        self.assertEqual(order, ["10.0.0.0/8", "10.0.0.0/12", "2001:db8::/32"])


class SpaceMapMaxDepthTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _depths(self, cidr, **kw):
        net = Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, status=status_for(self.tenant)
        ).network
        return [
            r["prefixlen"]
            for r in _build_space_map(net, child_nets=[], tenant=self.tenant,
                                      vrf=None, **kw)
        ]

    def test_v4_cap_restricts(self):
        # /24 normally → /25../31 (capped at +8); max_v4=29 stops at /29.
        self.assertEqual(self._depths("10.0.0.0/24", max_v4=29),
                         [25, 26, 27, 28, 29])

    def test_v4_cap_below_first_row_ignored(self):
        # A cap shallower than the first child row can't hide everything.
        self.assertEqual(self._depths("10.0.0.0/24", max_v4=20), [25])

    def test_v6_cap_restricts(self):
        # /64 → /68·/72; cap /68 keeps only /68.
        self.assertEqual(self._depths("2001:db8::/64", max_v6=68), [68])

    def test_endpoint_honours_v4_max(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", status=status_for(self.tenant)
        )
        res = self.client.get(f"/api/prefixes/{p.id}/space-map/?v4_max=29")
        lens = [r["prefixlen"] for r in res.json()["rows"]]
        self.assertEqual(max(lens), 29)

    def test_endpoint_ignores_garbage(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.8.0.0/24", status=status_for(self.tenant)
        )
        res = self.client.get(f"/api/prefixes/{p.id}/space-map/?v4_max=abc")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(max(r["prefixlen"] for r in res.json()["rows"]), 31)
