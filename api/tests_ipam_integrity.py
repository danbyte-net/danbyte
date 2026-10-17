"""IPAM integrity: ranges inside their prefix and clear of each other (#379),
containers that can't be shrunk around their children (#380), canonical
aggregates and their union utilisation (#381), and one host rule for
utilisation, next available and search (#382)."""
from __future__ import annotations

import ipaddress
from io import StringIO

from django.contrib.auth.models import User
from django.core.management import call_command
from rest_framework.test import APITestCase

from api.aggregate_normalise import plan
from api.models import (
    RIR,
    VLAN,
    VRF,
    Aggregate,
    IPAddress,
    IPRange,
    Prefix,
    VLANGroup,
    non_host_addresses,
    normalise_ip_term,
    usable_host_bounds,
    usable_host_count,
)
from api.test_utils import status_for
from api.views import _next_available_ips, _subnet_details
from auth_api.models import UserProfile
from core.models import Organization, Tenant


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        self.active = status_for(self.tenant)

    def prefix(self, cidr, **kw):
        return Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, status=self.active, **kw
        )

    def ip(self, prefix, addr):
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address=addr, status=self.active
        )

    def post_range(self, prefix, start, end, **extra):
        body = {"start_address": start, "end_address": end, **extra}
        if prefix is not None:
            body["prefix_id"] = str(prefix.id)
        return self.client.post("/api/ip-ranges/", body, format="json")


# ── #379 ─────────────────────────────────────────────────────────────────


class RangePlacementTests(_Base):
    def test_overlapping_range_in_the_same_vrf_is_refused(self):
        p = self.prefix("10.3.0.0/24")
        self.assertEqual(self.post_range(p, "10.3.0.10", "10.3.0.20").status_code, 201)
        r = self.post_range(p, "10.3.0.15", "10.3.0.25")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("overlaps", str(r.json()["start_address"]))
        self.assertIn("10.3.0.10", str(r.json()["start_address"]))
        self.assertEqual(IPRange.objects.count(), 1)

    def test_containing_and_contained_ranges_are_refused(self):
        p = self.prefix("10.3.0.0/24")
        self.post_range(p, "10.3.0.10", "10.3.0.20")
        self.assertEqual(self.post_range(p, "10.3.0.1", "10.3.0.100").status_code, 400)
        self.assertEqual(self.post_range(p, "10.3.0.12", "10.3.0.13").status_code, 400)
        self.assertEqual(self.post_range(p, "10.3.0.20", "10.3.0.30").status_code, 400)

    def test_adjacent_ranges_are_fine(self):
        p = self.prefix("10.3.0.0/24")
        self.post_range(p, "10.3.0.10", "10.3.0.20")
        self.assertEqual(self.post_range(p, "10.3.0.21", "10.3.0.30").status_code, 201)

    def test_the_same_span_in_another_vrf_is_fine(self):
        a = VRF.objects.create(tenant=self.tenant, name="A")
        b = VRF.objects.create(tenant=self.tenant, name="B")
        pa = self.prefix("10.3.0.0/24", vrf=a)
        pb = self.prefix("10.3.0.0/24", vrf=b)
        self.assertEqual(self.post_range(pa, "10.3.0.10", "10.3.0.20").status_code, 201)
        self.assertEqual(self.post_range(pb, "10.3.0.10", "10.3.0.20").status_code, 201)

    def test_global_vrf_ranges_without_a_prefix_overlap_too(self):
        """A NULL VRF is the Global table, a real bucket for the check."""
        self.assertEqual(self.post_range(None, "10.7.0.1", "10.7.0.9").status_code, 201)
        self.assertEqual(self.post_range(None, "10.7.0.5", "10.7.0.15").status_code, 400)
        vrf = VRF.objects.create(tenant=self.tenant, name="A")
        r = self.post_range(None, "10.7.0.5", "10.7.0.15", vrf_id=str(vrf.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_range_outside_its_prefix_is_refused(self):
        p = self.prefix("10.4.0.0/24")
        r = self.post_range(p, "10.9.9.1", "10.9.9.3")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("not inside the prefix 10.4.0.0/24", str(r.json()["start_address"]))

    def test_range_straddling_its_prefix_edge_is_refused(self):
        p = self.prefix("10.4.0.0/24")
        self.assertEqual(self.post_range(p, "10.4.0.250", "10.4.1.5").status_code, 400)

    def test_range_of_the_other_family_is_refused(self):
        p = self.prefix("10.4.0.0/24")
        self.assertEqual(self.post_range(p, "2001:db8::1", "2001:db8::5").status_code, 400)

    def test_patch_moving_a_range_onto_another_is_refused(self):
        p = self.prefix("10.3.0.0/24")
        self.post_range(p, "10.3.0.10", "10.3.0.20")
        other = self.post_range(p, "10.3.0.30", "10.3.0.40").json()["id"]
        r = self.client.patch(
            f"/api/ip-ranges/{other}/", {"start_address": "10.3.0.18"}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_patch_moving_a_range_out_of_its_prefix_is_refused(self):
        p = self.prefix("10.3.0.0/24")
        q = self.prefix("10.8.0.0/24")
        rid = self.post_range(p, "10.3.0.10", "10.3.0.20").json()["id"]
        r = self.client.patch(
            f"/api/ip-ranges/{rid}/", {"prefix_id": str(q.id)}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_range_stored_before_the_check_still_takes_a_description(self):
        p = self.prefix("10.3.0.0/24")
        IPRange.objects.create(tenant=self.tenant, prefix=p,
                               start_address="10.3.0.10", end_address="10.3.0.20")
        legacy = IPRange.objects.create(tenant=self.tenant, prefix=p,
                                        start_address="10.3.0.15", end_address="10.3.0.25")
        r = self.client.patch(
            f"/api/ip-ranges/{legacy.id}/", {"description": "x"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_pool_around_a_dhcp_exclusion_is_allowed(self):
        from integrations.models import DhcpExclusion, DhcpScope

        p = self.prefix("10.3.0.0/24")
        scope = DhcpScope.objects.create(
            tenant=self.tenant, scope_id="10.3.0.0", name="s",
            start_range="10.3.0.100", end_range="10.3.0.200",
        )
        excl = IPRange.objects.create(tenant=self.tenant, prefix=p,
                                      start_address="10.3.0.150", end_address="10.3.0.160")
        DhcpExclusion.objects.create(scope=scope, ip_range=excl,
                                     start_address="10.3.0.150", end_address="10.3.0.160")
        r = self.post_range(p, "10.3.0.100", "10.3.0.200")
        self.assertEqual(r.status_code, 201, r.content)

    def test_import_refuses_an_overlap_and_an_outside_range(self):
        p = self.prefix("10.3.0.0/24")
        self.post_range(p, "10.3.0.10", "10.3.0.20")
        content = (
            "start_address,end_address,prefix\n"
            "10.3.0.15,10.3.0.25,10.3.0.0/24\n"
            "10.9.9.1,10.9.9.3,10.3.0.0/24\n"
        )
        r = self.client.post("/api/io/iprange/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(IPRange.objects.count(), 1, r.json())

    def test_space_map_neither_lists_twice_nor_offers_outside(self):
        """Ranges saved before the check: merged and clipped to the prefix."""
        p = self.prefix("10.3.0.0/24", allocate_from_ranges=True)
        IPRange.objects.create(tenant=self.tenant, prefix=p,
                               start_address="10.3.0.10", end_address="10.3.0.20")
        IPRange.objects.create(tenant=self.tenant, prefix=p,
                               start_address="10.3.0.15", end_address="10.3.0.25")
        for n in range(10, 15):
            self.ip(p, f"10.3.0.{n}")
        r = self.client.get(f"/api/prefixes/{p.id}/space-map/?rows=0")
        nxt = r.json()["next_available"]
        self.assertEqual(len(nxt), len(set(nxt)))
        self.assertEqual(nxt[0], "10.3.0.15")
        summary = p.allocation_summary()
        self.assertEqual((summary["size"], summary["used"], summary["free"]), (16, 5, 11))

        q = self.prefix("10.4.0.0/24", allocate_from_ranges=True)
        IPRange.objects.create(tenant=self.tenant, prefix=q,
                               start_address="10.9.9.1", end_address="10.9.9.3")
        self.assertEqual(_next_available_ips(q), [])
        self.assertEqual(q.allocation_summary()["size"], 0)


# ── #380 ─────────────────────────────────────────────────────────────────


class PrefixShrinkTests(_Base):
    def test_narrowing_past_an_address_is_refused_and_names_it(self):
        p = self.prefix("10.5.0.0/24")
        self.ip(p, "10.5.0.200")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"cidr": "10.5.0.0/25"},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("10.5.0.200", str(r.json()["cidr"]))
        p.refresh_from_db()
        self.assertEqual(p.cidr, "10.5.0.0/24")

    def test_narrowing_that_keeps_every_address_is_fine(self):
        p = self.prefix("10.5.0.0/24")
        self.ip(p, "10.5.0.20")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"cidr": "10.5.0.0/25"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_widening_is_fine(self):
        p = self.prefix("10.5.0.0/24")
        self.ip(p, "10.5.0.200")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"cidr": "10.5.0.0/23"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_moving_past_a_range_is_refused(self):
        p = self.prefix("10.5.0.0/24")
        IPRange.objects.create(tenant=self.tenant, prefix=p,
                               start_address="10.5.0.130", end_address="10.5.0.140")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"cidr": "10.5.0.0/25"},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("10.5.0.130–10.5.0.140", str(r.json()["cidr"]))

    def test_the_message_counts_past_the_first_five(self):
        p = self.prefix("10.5.0.0/24")
        for n in range(200, 208):
            self.ip(p, f"10.5.0.{n}")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"cidr": "10.5.0.0/25"},
                              format="json")
        msg = str(r.json()["cidr"])
        self.assertIn("8 addresses", msg)
        self.assertIn("and 3 more", msg)

    def test_editing_another_field_never_checks(self):
        p = self.prefix("10.5.0.0/24")
        self.ip(p, "10.5.0.200")
        r = self.client.patch(f"/api/prefixes/{p.id}/", {"description": "x"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)


class VLANGroupShrinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.group = VLANGroup.objects.create(tenant=self.tenant, name="G", slug="g")
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="ten",
                                        group=self.group)

    def test_narrowing_past_a_vlan_is_refused_and_names_it(self):
        r = self.client.patch(f"/api/vlan-groups/{self.group.id}/", {"min_vid": 100},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("VLAN 10", str(r.json()["min_vid"]))
        self.group.refresh_from_db()
        self.assertEqual(self.group.min_vid, 1)

    def test_lowering_the_max_past_a_vlan_is_refused(self):
        VLAN.objects.create(tenant=self.tenant, vlan_id=900, name="n", group=self.group)
        r = self.client.patch(f"/api/vlan-groups/{self.group.id}/", {"max_vid": 500},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("900", str(r.json()["max_vid"]))

    def test_narrowing_that_keeps_every_vlan_is_fine(self):
        r = self.client.patch(f"/api/vlan-groups/{self.group.id}/",
                              {"min_vid": 5, "max_vid": 20}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_stranded_vlan_takes_other_edits(self):
        """A group narrowed before the check left VLAN 10 outside it."""
        VLANGroup.objects.filter(pk=self.group.pk).update(min_vid=100)
        r = self.client.patch(f"/api/vlans/{self.vlan.id}/", {"description": "x"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_stranded_vlan_still_cant_take_another_vid_outside(self):
        VLANGroup.objects.filter(pk=self.group.pk).update(min_vid=100)
        r = self.client.patch(f"/api/vlans/{self.vlan.id}/", {"vlan_id": 11},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(f"/api/vlans/{self.vlan.id}/", {"vlan_id": 150},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_new_vlan_outside_the_range_is_still_refused(self):
        VLANGroup.objects.filter(pk=self.group.pk).update(min_vid=100)
        r = self.client.post("/api/vlans/", {"vlan_id": 20, "name": "x",
                                             "group_id": str(self.group.id)},
                             format="json")
        self.assertEqual(r.status_code, 400, r.content)


# ── #381 ─────────────────────────────────────────────────────────────────


class AggregateTests(_Base):
    def setUp(self):
        super().setUp()
        self.rir = RIR.objects.create(tenant=self.tenant, name="R", slug="r")

    def post(self, prefix):
        return self.client.post("/api/aggregates/",
                                {"prefix": prefix, "rir_id": str(self.rir.id)},
                                format="json")

    def test_prefixes_are_stored_canonical(self):
        r = self.post("2001:DB8::/32")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["prefix"], "2001:db8::/32")
        r = self.post("10.1.2.3/8")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["prefix"], "10.0.0.0/8")

    def test_other_spellings_of_a_block_are_duplicates(self):
        self.assertEqual(self.post("2001:DB8::/32").status_code, 201)
        r = self.post("2001:db8::/32")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("already exists", str(r.json()["prefix"]))
        self.assertEqual(self.post("10.0.0.0/8").status_code, 201)
        self.assertEqual(self.post("10.1.2.3/8").status_code, 400)
        self.assertEqual(Aggregate.objects.count(), 2)

    def test_a_legacy_spelling_is_a_duplicate_too(self):
        Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="2001:DB8::/32")
        self.assertEqual(self.post("2001:db8::/32").status_code, 400)

    def test_a_legacy_duplicate_still_takes_a_description(self):
        a = Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="2001:DB8::/32")
        Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="2001:db8::/32")
        r = self.client.patch(f"/api/aggregates/{a.id}/", {"description": "x"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_patch_to_another_spelling_of_itself_is_fine(self):
        a = self.post("10.0.0.0/8").json()
        r = self.client.patch(f"/api/aggregates/{a['id']}/", {"prefix": "10.9.9.9/8"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["prefix"], "10.0.0.0/8")

    def test_import_normalises_and_refuses_duplicates(self):
        content = f"prefix,rir\n2001:DB8::/32,{self.rir.id}\n10.1.2.3/8,{self.rir.id}\n"
        r = self.client.post("/api/io/aggregate/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            sorted(Aggregate.objects.values_list("prefix", flat=True)),
            ["10.0.0.0/8", "2001:db8::/32"],
        )
        content = f"prefix,rir\n2001:0DB8::/32,{self.rir.id}\n"
        self.client.post("/api/io/aggregate/import/",
                         {"format": "csv", "content": content}, format="json")
        self.assertEqual(Aggregate.objects.count(), 2)

    def _vrf_pair(self):
        agg = Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="10.1.0.0/24")
        a = VRF.objects.create(tenant=self.tenant, name="A")
        b = VRF.objects.create(tenant=self.tenant, name="B")
        self.prefix("10.1.0.0/25", vrf=a)
        self.prefix("10.1.0.0/25", vrf=b)
        return agg

    def test_utilisation_counts_a_network_in_two_vrfs_once(self):
        agg = self._vrf_pair()
        self.assertEqual(agg.utilisation_pct, 50)
        r = self.client.get(f"/api/aggregates/{agg.id}/")
        self.assertEqual(r.json()["utilisation_pct"], 50)
        rows = self.client.get("/api/aggregates/").json()["results"]
        self.assertEqual(rows[0]["utilisation_pct"], 50)

    def test_utilisation_counts_nested_prefixes_once(self):
        agg = Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="10.1.0.0/24")
        self.prefix("10.1.0.0/25")
        self.prefix("10.1.0.0/26")
        self.prefix("10.1.0.192/26")
        self.assertEqual(agg.utilisation_pct, 75)
        rows = self.client.get("/api/aggregates/").json()["results"]
        self.assertEqual(rows[0]["utilisation_pct"], 75)

    def test_utilisation_of_a_full_aggregate(self):
        agg = Aggregate.objects.create(tenant=self.tenant, rir=self.rir, prefix="10.1.0.0/24")
        self.prefix("10.1.0.0/24")
        self.prefix("10.1.0.0/25")
        self.assertEqual(agg.utilisation_pct, 100)
        self.assertEqual(
            self.client.get(f"/api/aggregates/{agg.id}/").json()["utilisation_pct"], 100
        )


class AggregateMigrationPlanTests(_Base):
    def test_plan_rewrites_free_rows_and_reports_collisions(self):
        t, u = "t1", "t2"
        rows = [
            (1, t, "2001:DB8::/32"), (2, t, "2001:db8::/32"),  # collide
            (3, t, "10.1.2.3/8"),                               # free
            (4, u, "10.1.2.3/8"),                               # other tenant: free
            (5, t, "192.168.0.0/16"),                           # canonical already
            (6, t, "not a prefix"),                             # left alone
        ]
        updates, collisions = plan(rows)
        self.assertEqual(updates, {3: "10.0.0.0/8", 4: "10.0.0.0/8"})
        self.assertEqual(len(collisions), 1)
        self.assertEqual(collisions[0][1], "2001:db8::/32")

    def test_migration_function_never_deletes(self):
        from importlib import import_module

        from django.apps import apps

        rir = RIR.objects.create(tenant=self.tenant, name="R", slug="r")
        Aggregate.objects.create(tenant=self.tenant, rir=rir, prefix="2001:DB8::/32")
        Aggregate.objects.create(tenant=self.tenant, rir=rir, prefix="2001:db8::/32")
        Aggregate.objects.create(tenant=self.tenant, rir=rir, prefix="10.1.2.3/8")
        mod = import_module("api.migrations.0204_normalise_aggregate_prefixes")
        mod.forwards(apps, None)
        self.assertEqual(
            sorted(Aggregate.objects.values_list("prefix", flat=True)),
            ["10.0.0.0/8", "2001:DB8::/32", "2001:db8::/32"],
        )
        out = StringIO()
        call_command("check_aggregates", stdout=out)
        self.assertIn("2001:db8::/32 is stored as", out.getvalue())
        self.assertIn("1 duplicate block", out.getvalue())


# ── #382 ─────────────────────────────────────────────────────────────────


class HostRuleTests(_Base):
    def test_shared_rule_matches_hosts_everywhere(self):
        for cidr in ("10.0.0.0/24", "10.0.0.0/30", "10.0.0.0/31", "10.0.0.1/32",
                     "2001:db8::/120", "2001:db8::/126", "2001:db8::/127",
                     "2001:db8::1/128"):
            net = ipaddress.ip_network(cidr)
            hosts = list(net.hosts())
            self.assertEqual(usable_host_count(net), len(hosts), cidr)
            self.assertEqual(usable_host_bounds(net), (hosts[0], hosts[-1]), cidr)
            self.assertEqual(
                set(net) - set(hosts), non_host_addresses(net), cidr
            )

    def test_slash_126_utilisation_agrees_with_next_available(self):
        p = self.prefix("2001:db8:1::/126")
        self.ip(p, "2001:db8:1::1")
        self.ip(p, "2001:db8:1::2")
        r = self.client.get(f"/api/prefixes/{p.id}/").json()
        self.assertEqual(r["utilisation_pct"], 67)
        sm = self.client.get(f"/api/prefixes/{p.id}/space-map/?rows=0").json()
        self.assertEqual(sm["next_available"], ["2001:db8:1::3"])
        details = {row["label"]: row["value"] for row in sm["subnet_details"]}
        self.assertEqual(details["Usable hosts"], "3")
        self.assertEqual(details["First usable"], "2001:db8:1::1")
        self.assertEqual(details["Last usable"], "2001:db8:1::3")
        self.ip(p, "2001:db8:1::3")
        self.assertEqual(self.client.get(f"/api/prefixes/{p.id}/").json()["utilisation_pct"], 100)
        self.assertEqual(_next_available_ips(p), [])

    def test_slash_127_is_point_to_point(self):
        p = self.prefix("2001:db8:2::/127")
        self.ip(p, "2001:db8:2::")
        self.assertEqual(p.utilisation_pct, 50)
        self.assertEqual(_next_available_ips(p), ["2001:db8:2::1"])
        details = {row["label"]: row["value"] for row in _subnet_details(p)}
        self.assertEqual(details["Usable hosts"], "2")

    def test_ipv4_rules_are_unchanged(self):
        p = self.prefix("10.0.0.0/30")
        self.ip(p, "10.0.0.1")
        self.assertEqual(p.utilisation_pct, 50)
        self.assertEqual(_next_available_ips(p), ["10.0.0.2"])
        p31 = self.prefix("10.0.1.0/31")
        self.ip(p31, "10.0.1.0")
        self.assertEqual(p31.utilisation_pct, 50)
        self.assertEqual(_next_available_ips(p31), ["10.0.1.1"])
        details = {row["label"]: row["value"] for row in _subnet_details(p)}
        self.assertEqual(details["Usable hosts"], "2")
        self.assertEqual(details["Last usable"], "10.0.0.2")

    def test_populate_skips_the_subnet_router_anycast(self):
        p = self.prefix("2001:db8:3::/126")
        r = self.client.post(f"/api/prefixes/{p.id}/populate/",
                             {"start": "2001:db8:3::", "end": "2001:db8:3::3"},
                             format="json")
        self.assertIn(r.status_code, (200, 201), r.content)
        self.assertEqual(
            sorted(p.ip_addresses.values_list("ip_address", flat=True)),
            ["2001:db8:3::1", "2001:db8:3::2", "2001:db8:3::3"],
        )

    def test_range_allocated_ipv6_prefix_reports_utilisation(self):
        p = self.prefix("2001:db8:4::/64", allocate_from_ranges=True)
        IPRange.objects.create(tenant=self.tenant, prefix=p,
                               start_address="2001:db8:4::10", end_address="2001:db8:4::13")
        self.ip(p, "2001:db8:4::10")
        self.ip(p, "2001:db8:4::11")
        r = self.client.get(f"/api/prefixes/{p.id}/").json()
        self.assertEqual(r["allocation"]["size"], 4)
        self.assertEqual(r["utilisation_pct"], 50)
        rows = self.client.get("/api/prefixes/").json()["results"]
        self.assertEqual(rows[0]["utilisation_pct"], 50)

    def test_large_ipv6_prefix_without_ranges_stays_blank(self):
        p = self.prefix("2001:db8:5::/64")
        self.assertIsNone(p.utilisation_pct)


class IPSearchTests(_Base):
    def test_ipv6_search_in_any_spelling(self):
        p = self.prefix("2001:db8::/64")
        self.ip(p, "2001:db8::1")
        self.ip(p, "2001:db8::10")
        for term in ("2001:db8::1", "2001:0db8::1", "2001:DB8::1",
                     "2001:0db8:0000:0000:0000:0000:0000:0001"):
            r = self.client.get("/api/ips/", {"search": term})
            got = [row["ip_address"] for row in r.json()["results"]]
            self.assertEqual(got[0], "2001:db8::1", term)

    def test_partial_terms_are_untouched(self):
        self.assertEqual(normalise_ip_term("2001:0db8"), "2001:0db8")
        self.assertEqual(normalise_ip_term("10.0."), "10.0.")
        self.assertEqual(normalise_ip_term("host"), "host")
        self.assertEqual(normalise_ip_term(" 2001:0DB8::1 "), "2001:db8::1")
