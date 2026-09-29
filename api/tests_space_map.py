"""Prefix space map: free / partly used / full cells and zooming.

A block holding a smaller child prefix is *partly* used - it must not read as
taken, or deep-link to the child, when its free space is one zoom away.
"""

from __future__ import annotations

import ipaddress

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import VRF, IPAddress, IPRange, Prefix
from api.test_utils import status_for
from api.views import SPACE_MAP_MAX_SPANS, _build_space_map, _space_map_spans
from auth_api.models import UserProfile
from core.models import Organization, Tenant

net = ipaddress.ip_network


def _cells(rows, prefixlen):
    row = next(r for r in rows if r["prefixlen"] == prefixlen)
    return {c["cidr"]: c for c in row["cells"]}


class SpaceMapCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _mk(self, cidr):
        return Prefix.objects.create(tenant=self.tenant, cidr=cidr, status=status_for(self.tenant))

    def _map(self, root, children, **kw):
        return _build_space_map(
            net(root),
            child_nets=[net(c) for c in children],
            tenant=self.tenant,
            vrf=None,
            **kw,
        )

    def _get(self, prefix, **params):
        res = self.client.get(f"/api/prefixes/{prefix.id}/space-map/", params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


class CellClassificationTests(SpaceMapCase):
    def test_small_child_makes_its_blocks_partial_not_full(self):
        # The reported case: a /28 inside a /18, seen at /26.
        rows = self._map("10.196.192.0/18", ["10.196.238.128/28"])
        c = _cells(rows, 26)["10.196.238.128/26"]
        self.assertEqual(c["state"], "partial")
        self.assertTrue(c["used"])
        self.assertFalse(c["exact"])
        self.assertEqual(c["overlap_with"], ["10.196.238.128/28"])
        self.assertEqual(c["used_fraction"], 0.25)
        self.assertEqual(c["used_spans"], [[0.0, 0.25, 1.0]])
        self.assertFalse(c["dirty"])
        # Every ancestor block up to /19 is partial too - none is "taken".
        for plen in range(19, 27):
            states = {x["state"] for x in _cells(rows, plen).values()}
            self.assertNotIn("full", states, plen)
        row26 = next(r for r in rows if r["prefixlen"] == 26)
        self.assertEqual((row26["free_count"], row26["partial_count"]), (255, 1))

    def test_span_sits_where_the_child_is(self):
        rows = self._map("10.196.192.0/18", ["10.196.238.128/28"])
        c = _cells(rows, 19)["10.196.224.0/19"]
        # (238.128 - 224.0) / 8192 addresses = 0.453125; a /28 is 16 of them.
        self.assertEqual(c["used_spans"], [[0.453125, 0.455078125, 1.0]])

    def test_block_equal_to_a_child_is_full_and_exact(self):
        rows = self._map("10.0.0.0/22", ["10.0.1.0/24"])
        c = _cells(rows, 24)["10.0.1.0/24"]
        self.assertEqual((c["state"], c["exact"]), ("full", True))
        self.assertEqual(c["used_fraction"], 1.0)

    def test_block_inside_a_child_is_full_not_exact(self):
        rows = self._map("10.0.0.0/22", ["10.0.1.0/24"])
        c = _cells(rows, 26)["10.0.1.64/26"]
        self.assertEqual((c["state"], c["exact"]), ("full", False))
        self.assertEqual(c["overlap_with"], ["10.0.1.0/24"])

    def test_covering_prefixes_most_specific_first(self):
        rows = self._map("10.0.0.0/22", ["10.0.1.0/24", "10.0.1.64/26"])
        c = _cells(rows, 26)["10.0.1.64/26"]
        self.assertTrue(c["exact"])
        self.assertEqual(c["overlap_with"], ["10.0.1.64/26", "10.0.1.0/24"])

    def test_grandchildren_do_not_count_twice(self):
        # A /23 holding a /24 which holds a /26: the /23 is half used, by
        # the /24 alone.
        rows = self._map("10.0.0.0/22", ["10.0.1.0/24", "10.0.1.64/26"])
        c = _cells(rows, 23)["10.0.0.0/23"]
        self.assertEqual(c["state"], "partial")
        self.assertEqual(c["overlap_with"], ["10.0.1.0/24"])
        self.assertEqual(c["overlap_count"], 1)
        self.assertEqual(c["used_fraction"], 0.5)

    def test_adjacent_children_merge_into_one_span(self):
        rows = self._map("10.0.0.0/24", ["10.0.0.0/27", "10.0.0.32/27"])
        c = _cells(rows, 25)["10.0.0.0/25"]
        self.assertEqual(c["used_spans"], [[0.0, 0.5, 1.0]])
        self.assertEqual(c["overlap_count"], 2)

    def test_free_cell_with_ips_is_dirty_partial_is_not(self):
        parent = self._mk("10.7.0.0/24")
        self._mk("10.7.0.0/28")
        for a in ("10.7.0.5", "10.7.0.200"):
            IPAddress.objects.create(tenant=self.tenant, prefix=parent, ip_address=a)
        rows = self._map("10.7.0.0/24", ["10.7.0.0/28"])
        cells = _cells(rows, 25)
        self.assertEqual(cells["10.7.0.0/25"]["state"], "partial")
        self.assertFalse(cells["10.7.0.0/25"]["dirty"])
        self.assertEqual(cells["10.7.0.128/25"]["state"], "free")
        self.assertTrue(cells["10.7.0.128/25"]["dirty"])

    def test_child_equal_to_the_map_root_is_context_not_a_child(self):
        # Zooming into an existing prefix maps its own space: the prefix
        # itself must not paint every cell as used.
        rows = self._map("10.0.1.0/24", ["10.0.1.0/24", "10.0.1.64/26"])
        cells = _cells(rows, 26)
        self.assertEqual(cells["10.0.1.0/26"]["state"], "free")
        self.assertEqual(cells["10.0.1.64/26"]["state"], "full")

    def test_ipv6_partial(self):
        rows = self._map("2001:db8::/48", ["2001:db8:0:140::/64"])
        c = _cells(rows, 56)["2001:db8:0:100::/56"]
        self.assertEqual(c["state"], "partial")
        self.assertEqual(c["used_fraction"], 1 / 256)
        self.assertEqual(c["used_spans"], [[0.25, 0.25 + 1 / 256, 1.0]])
        self.assertEqual(_cells(rows, 52)["2001:db8::/52"]["state"], "partial")

    def test_ipv6_tiny_child_keeps_a_nonzero_span(self):
        rows = self._map("2001:db8::/48", ["2001:db8::1/128"])
        c = _cells(rows, 56)["2001:db8::/56"]
        self.assertEqual(c["state"], "partial")
        # ::1 is 1 / 2**72 of the /56 - far below a pixel, but not zero.
        start, end, _share = c["used_spans"][0]
        self.assertGreater(start, 0.0)
        self.assertGreater(end, start)


class SpanCapTests(SpaceMapCase):
    def assertSpansHonest(self, c, size):
        """No span paints a gap as used: the drawn share adds up to the used
        fraction, and solid spans exceed it by at most the sub-pixel slack."""
        spans = c["used_spans"]
        self.assertLessEqual(len(spans), SPACE_MAP_MAX_SPANS)
        weighted = sum((e - s) * share for s, e, share in spans)
        self.assertAlmostEqual(weighted, c["used_fraction"], places=9)
        solid = sum(e - s for s, e, share in spans if share >= 0.99)
        self.assertLessEqual(solid, c["used_fraction"] + len(spans) / 256)

    def test_bins_spans_past_the_cap(self):
        # 40 scattered /32s in a /24: one solid sliver per sixteenth that
        # holds any, as wide as what it holds, inside that sixteenth.
        kids = [f"10.9.0.{i * 6}/32" for i in range(40)]
        rows = self._map("10.9.0.0/23", kids)
        c = _cells(rows, 24)["10.9.0.0/24"]
        self.assertEqual(c["overlap_count"], 40)
        self.assertEqual(c["used_fraction"], 40 / 256)
        self.assertEqual(len(c["used_spans"]), 15)
        for start, end, share in c["used_spans"]:
            self.assertEqual(share, 1.0)
            self.assertEqual(int(start * 16), int(end * 16 - 1e-9))
        # The first sixteenth holds .0, .6 and .12: three addresses around .6.
        self.assertEqual(c["used_spans"][0], [5 / 256, 8 / 256, 1.0])
        self.assertSpansHonest(c, 256)

    def test_many_small_children_never_paint_free_space_as_used(self):
        # 45 /24s and /30s spread over a /9: well under 1% used. Closing the
        # gaps between them used to paint about half of each /9 cell rose.
        kids = []
        for i in range(23):
            kids.append(f"11.{i * 5}.0.0/24")
        for i in range(22):
            kids.append(f"11.{i * 5 + 2}.9.0/30")
        rows = self._map("11.0.0.0/8", kids)
        for plen in (9, 10):
            for c in _cells(rows, plen).values():
                if c["state"] == "partial":
                    self.assertLess(c["used_fraction"], 0.01)
                    self.assertSpansHonest(c, 2 ** (32 - plen))
        c9 = _cells(rows, 9)["11.0.0.0/9"]
        self.assertEqual(c9["overlap_count"], 45)
        drawn = sum(e - s for s, e, _ in c9["used_spans"])
        self.assertAlmostEqual(drawn, c9["used_fraction"], places=9)

    def test_helper_merges_touching_blocks(self):
        self.assertEqual(
            _space_map_spans([(0, 3), (4, 7), (12, 15)], 0, 16),
            [[0.0, 0.5, 1.0], [0.75, 1.0, 1.0]],
        )

    def test_helper_merges_only_pixel_wide_gaps(self):
        # In a 16384-address cell a 16-address gap is 1/1024 of it: one span,
        # with the gap counted out of its share. A wider gap stays a gap.
        spans = _space_map_spans([(0, 15), (32, 47), (1024, 1039)], 0, 16384)
        self.assertEqual(len(spans), 2)
        self.assertEqual(spans[0][:2], [0.0, 48 / 16384])
        self.assertAlmostEqual(spans[0][2], 32 / 48)
        self.assertEqual(spans[1], [1024 / 16384, 1040 / 16384, 1.0])


class RangeTests(SpaceMapCase):
    def _range(self, start, end, vrf=None):
        return IPRange.objects.create(
            tenant=self.tenant, vrf=vrf, start_address=start, end_address=end
        )

    def test_range_only_block_stays_free_but_is_flagged(self):
        self._range("10.196.196.10", "10.196.196.50")
        rows = self._map("10.196.192.0/18", [])
        row = next(r for r in rows if r["prefixlen"] == 26)
        c = _cells(rows, 26)["10.196.196.0/26"]
        self.assertEqual(c["state"], "free")
        self.assertEqual(c["range_count"], 1)
        self.assertEqual(c["ranges"], ["10.196.196.10–50"])
        self.assertEqual(c["range_spans"], [[10 / 64, 51 / 64, 1.0]])
        self.assertEqual(row["ranged_count"], 1)
        self.assertEqual(row["free_count"], 256)
        self.assertEqual(_cells(rows, 26)["10.196.196.64/26"]["range_count"], 0)

    def test_range_straddling_two_cells_marks_both(self):
        self._range("10.0.0.120", "10.0.0.135")
        rows = self._map("10.0.0.0/24", [])
        cells = _cells(rows, 25)
        left, right = cells["10.0.0.0/25"], cells["10.0.0.128/25"]
        self.assertEqual((left["range_count"], right["range_count"]), (1, 1))
        self.assertEqual(left["range_spans"], [[120 / 128, 1.0, 1.0]])
        self.assertEqual(right["range_spans"], [[0.0, 8 / 128, 1.0]])
        self.assertEqual(left["ranges"], ["10.0.0.120–135"])
        self.assertEqual(next(r for r in rows if r["prefixlen"] == 25)["ranged_count"], 2)

    def test_range_inside_a_child_prefix_belongs_to_it(self):
        self._range("10.0.0.20", "10.0.0.30")
        rows = self._map("10.0.0.0/24", ["10.0.0.0/27"])
        self.assertEqual(_cells(rows, 25)["10.0.0.0/25"]["range_count"], 0)
        self.assertEqual(_cells(rows, 27)["10.0.0.0/27"]["range_count"], 0)

    def test_range_in_a_partial_blocks_free_part(self):
        self._range("10.0.0.40", "10.0.0.47")
        rows = self._map("10.0.0.0/24", ["10.0.0.0/28"])
        c = _cells(rows, 26)["10.0.0.0/26"]
        self.assertEqual((c["state"], c["range_count"]), ("partial", 1))

    def test_other_vrf_and_family_ranges_are_ignored(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="red")
        self._range("10.0.0.10", "10.0.0.20", vrf=vrf)
        self._range("2001:db8::10", "2001:db8::20")
        rows = self._map("10.0.0.0/24", [])
        self.assertEqual(next(r for r in rows if r["prefixlen"] == 25)["ranged_count"], 0)

    def test_ipv6_range_label(self):
        self._range("2001:db8::10", "2001:db8::20")
        rows = self._map("2001:db8::/120", [])
        c = _cells(rows, 124)["2001:db8::10/124"]
        self.assertEqual(c["ranges"], ["2001:db8::10–2001:db8::20"])


class ZoomEndpointTests(SpaceMapCase):
    def setUp(self):
        super().setUp()
        self.p18 = self._mk("10.196.192.0/18")
        self.p28 = self._mk("10.196.238.128/28")
        self.p24 = self._mk("10.196.200.0/24")
        self.p27 = self._mk("10.196.200.64/27")

    def test_overview_stops_at_the_row_cap_and_marks_partial(self):
        data = self._get(self.p18)
        self.assertEqual([r["prefixlen"] for r in data["rows"]], list(range(19, 27)))
        c = _cells(data["rows"], 26)["10.196.238.128/26"]
        self.assertEqual(c["state"], "partial")
        self.assertEqual(c["prefix_id"], str(self.p28.id))
        exact = _cells(data["rows"], 24)["10.196.200.0/24"]
        self.assertEqual((exact["state"], exact["exact"]), ("full", True))
        self.assertEqual(exact["prefix_id"], str(self.p24.id))

    def test_zoom_into_a_partial_block_shows_the_child_and_free_siblings(self):
        data = self._get(self.p18, within="10.196.238.128/26")
        self.assertEqual(data["root"], "10.196.238.128/26")
        # /26 + 8 bits is past the IPv4 floor; rows run to /31.
        self.assertEqual([r["prefixlen"] for r in data["rows"]], [27, 28, 29, 30, 31])
        row28 = _cells(data["rows"], 28)
        self.assertEqual(row28["10.196.238.128/28"]["state"], "full")
        self.assertTrue(row28["10.196.238.128/28"]["exact"])
        self.assertEqual(row28["10.196.238.128/28"]["prefix_id"], str(self.p28.id))
        for free in ("10.196.238.144/28", "10.196.238.160/28", "10.196.238.176/28"):
            self.assertEqual(row28[free]["state"], "free")
        row27 = _cells(data["rows"], 27)
        self.assertEqual(row27["10.196.238.128/27"]["state"], "partial")
        self.assertEqual(row27["10.196.238.160/27"]["state"], "free")

    def test_zoom_respects_the_depth_preference(self):
        data = self._get(self.p18, within="10.196.238.128/26", v4_max=29)
        self.assertEqual([r["prefixlen"] for r in data["rows"]], [27, 28, 29])

    def test_zoom_into_an_existing_child_maps_its_own_space(self):
        data = self._get(self.p18, within="10.196.200.0/24")
        row27 = _cells(data["rows"], 27)
        self.assertEqual(row27["10.196.200.0/27"]["state"], "free")
        self.assertEqual(row27["10.196.200.64/27"]["state"], "full")
        self.assertEqual(row27["10.196.200.64/27"]["prefix_id"], str(self.p27.id))
        self.assertEqual(_cells(data["rows"], 25)["10.196.200.0/25"]["state"], "partial")

    def test_zoom_below_a_child_is_drawn_inside_it(self):
        # A block inside the /24 (not a prefix itself): the /24 is context.
        data = self._get(self.p18, within="10.196.200.0/26")
        row27 = _cells(data["rows"], 27)
        self.assertEqual(row27["10.196.200.0/27"]["state"], "free")
        self.assertEqual(row27["10.196.200.32/27"]["state"], "free")

    def test_ipv6_zoom_into_partial_block(self):
        p48 = self._mk("2001:db8::/48")
        p64 = self._mk("2001:db8:0:140::/64")
        top = self._get(p48)
        self.assertEqual(_cells(top["rows"], 56)["2001:db8:0:100::/56"]["state"], "partial")
        data = self._get(p48, within="2001:db8:0:100::/56")
        row64 = _cells(data["rows"], 64)
        self.assertEqual(row64["2001:db8:0:140::/64"]["state"], "full")
        self.assertEqual(row64["2001:db8:0:140::/64"]["prefix_id"], str(p64.id))
        self.assertEqual(row64["2001:db8:0:141::/64"]["state"], "free")


class ZoomContextTests(SpaceMapCase):
    """The endpoint names the prefix a zoomed view sits in, rejects a zoom
    into the other family, and serves the details and the map apart."""

    def setUp(self):
        super().setUp()
        self.p18 = self._mk("10.196.192.0/18")
        self.p28 = self._mk("10.196.238.128/28")
        self.p24 = self._mk("10.196.200.0/24")

    def test_context_is_the_most_specific_prefix_holding_the_view(self):
        self.assertIsNone(self._get(self.p18)["context"])
        self.assertIsNone(self._get(self.p18, within="10.196.238.128/26")["context"])
        self.assertEqual(
            self._get(self.p18, within="10.196.200.0/26")["context"],
            {"id": str(self.p24.id), "cidr": "10.196.200.0/24"},
        )
        self.assertEqual(
            self._get(self.p18, within="10.196.238.128/28")["context"],
            {"id": str(self.p28.id), "cidr": "10.196.238.128/28"},
        )

    def test_within_of_the_other_family_is_a_400(self):
        p6 = self._mk("2001:db8:5e::/48")
        for prefix, within in ((p6, "10.0.0.0/24"), (self.p18, "2001:db8::/64")):
            res = self.client.get(
                f"/api/prefixes/{prefix.id}/space-map/", {"within": within}
            )
            self.assertEqual(res.status_code, 400, within)

    def test_zoom_past_a_shallow_depth_preference_draws_the_full_window(self):
        top = self._get(self.p18, v4_max=24)
        self.assertEqual([r["prefixlen"] for r in top["rows"]], list(range(19, 25)))
        data = self._get(self.p18, within="10.196.238.0/24", v4_max=24)
        self.assertEqual([r["prefixlen"] for r in data["rows"]], list(range(25, 32)))
        # Above the cap it still trims.
        mid = self._get(self.p18, within="10.196.224.0/20", v4_max=24)
        self.assertEqual([r["prefixlen"] for r in mid["rows"]], [21, 22, 23, 24])

    def test_ipv6_zoom_past_the_preference_keeps_nibble_steps(self):
        p48 = self._mk("2001:db8::/48")
        top = self._get(p48, v6_max=64)
        self.assertEqual([r["prefixlen"] for r in top["rows"]], [52, 56])
        data = self._get(p48, within="2001:db8:0:1::/64", v6_max=64)
        self.assertEqual([r["prefixlen"] for r in data["rows"]], [68, 72])

    def test_details_and_rows_are_served_apart(self):
        details = self._get(self.p18, rows="0")
        self.assertEqual(details["rows"], [])
        self.assertTrue(details["subnet_details"])
        rows = self._get(self.p18, details="0")
        self.assertIsNone(rows["subnet_details"])
        self.assertEqual(rows["next_available"], [])
        self.assertEqual(len(rows["rows"]), 8)

    def test_ips_outside_the_view_are_not_counted(self):
        IPAddress.objects.create(
            tenant=self.tenant, prefix=self.p18, ip_address="10.196.238.150"
        )
        IPAddress.objects.create(
            tenant=self.tenant, prefix=self.p18, ip_address="10.196.238.200"
        )
        data = self._get(self.p18, within="10.196.238.128/26")
        row = next(r for r in data["rows"] if r["prefixlen"] == 27)
        self.assertEqual(sum(c["ip_count"] for c in row["cells"]), 1)
