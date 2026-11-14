"""Free space in the prefix list, Next available, allocate and the subnet
planner (api.prefix_space, api.prefix_space_views)."""
from __future__ import annotations

import ipaddress
import itertools
import threading
import time

from django.contrib.auth.models import User
from django.db import connection, transaction
from django.test import SimpleTestCase
from rest_framework.test import APIClient, APITestCase, APITransactionTestCase

from api import prefix_space as fs
from api.models import VRF, Prefix, Site
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

UNKNOWN = "X-Danbyte-Unknown-Params"


def _space(cidr, children=(), scope=None):
    """A Space without the database."""
    net = ipaddress.ip_network(cidr)
    p = Prefix(cidr=cidr)
    occ = sorted(
        (int(n.network_address), int(n.broadcast_address))
        for n in map(ipaddress.ip_network, children)
    )
    lo, hi, root = int(net.network_address), int(net.broadcast_address), net.prefixlen
    if scope:
        s = ipaddress.ip_network(scope)
        lo = max(lo, int(s.network_address))
        hi = min(hi, int(s.broadcast_address))
        root = max(root, s.prefixlen)
    return fs.Space(parent=p, version=net.version, lo=lo, hi=hi, root_len=root,
                    occupied=occ)


def _cidrs(space, blocks):
    return [fs.cidr_of(a, ln, space.version) for a, ln in blocks]


class ArithmeticTests(SimpleTestCase):
    def test_the_mock_up(self):
        s = _space("10.20.0.0/16", ["10.20.0.0/24", "10.20.1.0/24", "10.20.4.0/22"])
        self.assertEqual(_cidrs(s, s.blocks()), [
            "10.20.2.0/23", "10.20.8.0/21", "10.20.16.0/20", "10.20.32.0/19",
            "10.20.64.0/18", "10.20.128.0/17",
        ])

    def test_unaligned_gap_splits_into_aligned_blocks(self):
        s = _space("10.0.0.0/24", ["10.0.0.0/30", "10.0.0.192/26"])
        self.assertEqual(_cidrs(s, s.blocks()), [
            "10.0.0.4/30", "10.0.0.8/29", "10.0.0.16/28", "10.0.0.32/27",
            "10.0.0.64/26", "10.0.0.128/26",
        ])

    def test_edges(self):
        full = _space("10.0.0.0/30", ["10.0.0.0/31", "10.0.0.2/31"])
        self.assertEqual(full.blocks(), [])
        self.assertIsNone(full.largest())
        empty = _space("10.0.0.0/30")
        self.assertEqual(_cidrs(empty, empty.blocks()), ["10.0.0.0/30"])
        last = _space("255.255.255.0/24", ["255.255.255.0/25"])
        self.assertEqual(_cidrs(last, last.blocks()), ["255.255.255.128/25"])
        zero = _space("0.0.0.0/0", ["128.0.0.0/1"])
        self.assertEqual(_cidrs(zero, zero.blocks()), ["0.0.0.0/1"])
        # Nested children count once.
        nested = _space("10.0.0.0/24", ["10.0.0.0/25", "10.0.0.0/26", "10.0.0.64/27"])
        self.assertEqual(_cidrs(nested, nested.blocks()), ["10.0.0.128/25"])

    def test_sized_first_and_best(self):
        s = _space("10.0.0.0/24", ["10.0.0.0/28", "10.0.0.32/27", "10.0.0.128/25"])
        # Free: .16/28, .64/26.
        first = [fs.cidr_of(a, 29, 4) for a in s.candidates(29, "first")]
        self.assertEqual(first[:3], ["10.0.0.16/29", "10.0.0.24/29", "10.0.0.64/29"])
        self.assertEqual(s.count(29), 10)
        best = [fs.cidr_of(a, 28, 4) for a in s.candidates(28, "best")]
        # The /28 hole first, which keeps the /26 whole.
        self.assertEqual(best[0], "10.0.0.16/28")
        best26 = [fs.cidr_of(a, 26, 4) for a in s.candidates(26, "best")]
        self.assertEqual(best26, ["10.0.0.64/26"])
        self.assertEqual(list(s.candidates(25, "first")), [])
        self.assertEqual(s.largest(), 26)

    def test_scope(self):
        s = _space("10.0.0.0/15", ["10.0.0.0/24", "10.0.32.0/19"], scope="10.0.32.0/19")
        self.assertEqual(s.blocks(), [])
        s = _space("10.0.0.0/15", ["10.0.0.0/24"], scope="10.0.0.0/19")
        self.assertEqual(s.root, "10.0.0.0/19")
        blocks = _cidrs(s, s.blocks())
        self.assertEqual(blocks[0], "10.0.1.0/24")
        self.assertTrue(all(ipaddress.ip_network(b).subnet_of(
            ipaddress.ip_network("10.0.0.0/19")) for b in blocks))
        self.assertEqual(list(s.candidates(18, "first")), [])

    def test_ipv6_rounds_to_64(self):
        s = _space("2001:db8::/48", ["2001:db8:0:1::/127", "2001:db8:0:3::/64"])
        blocks = _cidrs(s, s.blocks())
        self.assertEqual(blocks[:3], ["2001:db8::/64", "2001:db8:0:2::/64", "2001:db8:0:4::/62"])
        self.assertTrue(all(int(b.split("/")[1]) <= 64 for b in blocks))
        # An explicit /127 packs into the partly used /64.
        first127 = [fs.cidr_of(a, 127, 6)
                    for a in itertools.islice(s.candidates(127, "first"), 2)]
        self.assertEqual(first127, ["2001:db8::/127", "2001:db8::2/127"])
        inner = _space("2001:db8::/48", ["2001:db8:0:1::/127"], scope="2001:db8:0:1::/64")
        self.assertEqual(inner.blocks(), [])  # a scope of a /64 still rounds
        self.assertEqual(
            fs.cidr_of(next(iter(inner.candidates(127, "first"))), 127, 6),
            "2001:db8:0:1::2/127")

    def test_ipv6_longer_parent_is_not_rounded(self):
        s = _space("2001:db8::/120", ["2001:db8::/126"])
        self.assertEqual(_cidrs(s, s.blocks())[0], "2001:db8::4/126")


class PlannerArithmeticTests(SimpleTestCase):
    def req(self, count, length, **kw):
        return {"count": count, "length": length, "fields": {}, "description": kw.get(
            "description", ""), "keep_together": kw.get("keep_together", False)}

    def test_largest_first_and_aligned(self):
        s = _space("10.0.0.0/23", ["10.0.0.0/26"])
        items, _ = fs.plan(s, [self.req(5, 29, description="p2p-{n}"), self.req(2, 24)])
        by = {(it.request, it.n): it for it in items}
        # The /24 can't go at .0 (a /26 is there); the second /24 doesn't fit.
        self.assertEqual(by[(1, 1)].cidr, "10.0.1.0/24")
        self.assertIsNone(by[(1, 2)].cidr)
        self.assertIn("largest free block is /25", by[(1, 2)].reason)
        self.assertEqual([by[(0, n)].cidr for n in range(1, 6)], [
            "10.0.0.64/29", "10.0.0.72/29", "10.0.0.80/29", "10.0.0.88/29", "10.0.0.96/29"])
        self.assertEqual(by[(0, 3)].fields["description"], "p2p-3")

    def test_best_fit_keeps_big_blocks(self):
        s = _space("10.0.0.0/24", ["10.0.0.0/28", "10.0.0.32/27", "10.0.0.128/25"])
        items, _ = fs.plan(s, [self.req(1, 28)], "best")
        self.assertEqual(items[0].cidr, "10.0.0.16/28")
        s = _space("10.0.0.0/24", ["10.0.0.0/28", "10.0.0.32/27", "10.0.0.128/25"])
        items, _ = fs.plan(s, [self.req(1, 28)], "first")
        self.assertEqual(items[0].cidr, "10.0.0.16/28")
        items, _ = fs.plan(_space("10.0.0.0/24", ["10.0.0.16/28", "10.0.0.128/25"]),
                           [self.req(1, 28)], "best")
        self.assertEqual(items[0].cidr, "10.0.0.0/28")

    def test_keep_together_and_growth(self):
        s = _space("10.0.0.0/24", ["10.0.0.8/29"])
        items, reserved = fs.plan(s, [self.req(3, 28, keep_together=True)],
                                  reserve_growth=True)
        self.assertEqual([it.cidr for it in items],
                         ["10.0.0.64/28", "10.0.0.80/28", "10.0.0.96/28"])
        self.assertEqual(_cidrs(s, reserved), ["10.0.0.128/26"])

    def test_too_big_for_parent(self):
        items, _ = fs.plan(_space("10.0.0.0/24"), [self.req(1, 23)])
        self.assertIn("larger than 10.0.0.0/24", items[0].reason)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.container = status_for(self.tenant, "container")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def p(self, cidr, **kw):
        return Prefix.objects.create(tenant=self.tenant, cidr=cidr, **kw)

    def free(self, **params):
        q = "&".join(f"{k}={v}" for k, v in {"free": 1, "page_size": 1000, **params}.items())
        r = self.client.get(f"/api/prefixes/?{q}")
        self.assertEqual(r.status_code, 200, r.content)
        return r


class FreeListTests(_Base):
    def setUp(self):
        super().setUp()
        self.root = self.p("10.20.0.0/16")
        self.p("10.20.0.0/24")
        self.p("10.20.1.0/24")
        self.p("10.20.4.0/22")

    def test_free_rows_for_parents_only(self):
        r = self.free()
        data = r.json()
        self.assertEqual(data["count"], 4)  # free rows are not counted
        self.assertEqual(len(data["results"]), 4)
        rows = data["free"]
        self.assertEqual({row["parent"] for row in rows}, {str(self.root.id)})
        self.assertEqual([row["cidr"] for row in rows][:2], ["10.20.2.0/23", "10.20.8.0/21"])
        self.assertTrue(all(row["kind"] == "free" for row in rows))
        self.assertEqual(data["free_totals"], {str(self.root.id): 6})
        self.assertNotIn(UNKNOWN, r)

    def test_without_free_nothing_changes(self):
        data = self.client.get("/api/prefixes/").json()
        self.assertNotIn("free", data)

    def test_empty_container_is_free(self):
        c = self.p("172.16.0.0/12", status=self.container)
        rows = [x for x in self.free().json()["free"] if x["parent"] == str(c.id)]
        self.assertEqual([x["cidr"] for x in rows], ["172.16.0.0/12"])

    def test_more_than_limit_collapses(self):
        for i in range(0, 40, 2):
            self.p(f"10.30.{i}.0/24")
        self.p("10.30.0.0/16")
        data = self.free().json()
        parent = Prefix.objects.get(cidr="10.30.0.0/16")
        rows = [x for x in data["free"] if x["parent"] == str(parent.id)]
        self.assertEqual(len(rows), fs.LIST_LIMIT)
        self.assertGreater(data["free_totals"][str(parent.id)], fs.LIST_LIMIT)

    def test_size_and_scope(self):
        data = self.free(length=29, scope="10.20.0.0/20").json()
        rows = data["free"]
        self.assertEqual(len(rows), fs.SIZE_LIMIT)
        self.assertEqual(rows[0]["cidr"], "10.20.2.0/29")
        # 10.20.2.0/23 + 10.20.8.0/21 = 64 + 256 /29s.
        self.assertEqual(data["free_totals"][str(self.root.id)], 320)
        self.assertTrue(all(ipaddress.ip_network(x["cidr"]).subnet_of(
            ipaddress.ip_network("10.20.0.0/20")) for x in rows))

    def test_bad_params(self):
        self.assertEqual(self.client.get("/api/prefixes/?free=1&length=x").status_code, 400)
        self.assertEqual(
            self.client.get("/api/prefixes/?free=1&scope=10.0.0.1/24").status_code, 400)
        self.assertEqual(
            self.client.get("/api/prefixes/?free=1&strategy=last").status_code, 400)

    def test_params_are_known(self):
        r = self.free(length=24, scope="10.20.0.0/16", strategy="best", limit=4)
        self.assertNotIn(UNKNOWN, r)
        # Without free=1 the free-space parameters do nothing - and say so.
        r = self.client.get("/api/prefixes/?length=24")
        self.assertIn("length", r[UNKNOWN])

    def test_ipv6(self):
        root = self.p("2001:db8::/48")
        self.p("2001:db8:0:1::/64")
        rows = [x for x in self.free().json()["free"] if x["parent"] == str(root.id)]
        self.assertEqual([x["cidr"] for x in rows][:2], ["2001:db8::/64", "2001:db8:0:2::/63"])


class AvailableTests(_Base):
    def setUp(self):
        super().setUp()
        self.vrf = VRF.objects.create(tenant=self.tenant, name="CUST")
        self.root = self.p("10.0.0.0/24")
        self.p("10.0.0.0/28")
        self.p("10.0.0.32/27")
        self.p("10.0.0.128/25")
        # Same space in another VRF holds nothing back here.
        self.other = self.p("10.0.0.0/24", vrf=self.vrf)
        self.p("10.0.0.16/28", vrf=self.vrf)

    def get(self, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        return self.client.get(f"/api/prefixes/available/?{q}")

    def test_within_id_and_cidr(self):
        r = self.get(within=self.root.id, length=28)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([x["cidr"] for x in r.json()], [
            "10.0.0.16/28", "10.0.0.64/28", "10.0.0.80/28", "10.0.0.96/28", "10.0.0.112/28"])
        self.assertEqual(r.json()[0]["parent"], {"id": str(self.root.id), "cidr": "10.0.0.0/24"})
        self.assertIsNone(r.json()[0]["vrf"])
        r = self.get(within="10.0.0.0/24", vrf=self.vrf.id, length=28, limit=1)
        self.assertEqual([x["cidr"] for x in r.json()], ["10.0.0.0/28"])
        self.assertEqual(r.json()[0]["vrf"]["name"], "CUST")

    def test_strategy_best(self):
        self.p("10.0.0.16/28")
        r = self.get(within=self.root.id, length=29, strategy="best", limit=1)
        self.assertEqual([x["cidr"] for x in r.json()], ["10.0.0.64/29"])
        Prefix.objects.filter(cidr="10.0.0.16/28", vrf__isnull=True).delete()
        self.p("10.0.0.24/29")
        r = self.get(within=self.root.id, length=29, strategy="best", limit=1)
        self.assertEqual([x["cidr"] for x in r.json()], ["10.0.0.16/29"])

    def test_scope_and_no_length(self):
        r = self.get(within=self.root.id, scope="10.0.0.64/26")
        self.assertEqual([x["cidr"] for x in r.json()], ["10.0.0.64/26"])
        r = self.get(within=self.root.id, scope="10.9.0.0/26")
        self.assertEqual(r.status_code, 400)
        r = self.get(within=self.root.id, length=23)
        self.assertEqual(r.status_code, 400)

    def test_across_parents(self):
        r = self.get(length=28, limit=2, vrf="global")
        self.assertEqual([x["cidr"] for x in r.json()], ["10.0.0.16/28", "10.0.0.64/28"])
        r = self.get(length=28, limit=50)
        self.assertEqual(len(r.json()), 5 + 15)

    def test_unknown_within(self):
        self.assertEqual(self.get(within="10.9.9.0/24").status_code, 400)
        self.assertEqual(self.get(within="nonsense").status_code, 400)


class AllocateTests(_Base):
    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.root = self.p("10.0.0.0/24", site=self.site)
        self.p("10.0.0.0/26")

    def post(self, prefix, **body):
        return self.client.post(f"/api/prefixes/{prefix.id}/allocate/", body, format="json")

    def test_allocates_next_with_fields(self):
        r = self.post(self.root, length=26, description="servers")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cidr"], "10.0.0.64/26")
        self.assertEqual(r.json()["description"], "servers")
        self.assertEqual(r.json()["site"]["id"], str(self.site.id))
        p = Prefix.objects.get(cidr="10.0.0.64/26")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(p.id), cause="Allocated in 10.0.0.0/24").exists())
        self.assertEqual(self.post(self.root, length=26).json()["cidr"], "10.0.0.128/26")
        self.assertEqual(self.post(self.root, length=26, scope="10.0.0.192/26").json()["cidr"],
                         "10.0.0.192/26")

    def test_full_is_409_with_reason(self):
        self.post(self.root, length=25)
        r = self.post(self.root, length=25)
        self.assertEqual(r.status_code, 409)
        self.assertIn("largest free block is /26", r.json()["length"][0])

    def test_refuses_cidr_and_vrf(self):
        self.assertEqual(self.post(self.root, length=26, cidr="10.0.0.64/26").status_code, 400)
        self.assertEqual(self.post(self.root, length=26, vrf_id=None).status_code, 400)
        self.assertEqual(self.post(self.root).status_code, 400)


class PlanTests(_Base):
    def setUp(self):
        super().setUp()
        self.root = self.p("10.0.0.0/22", status=self.container)
        self.p("10.0.0.0/25")

    def post(self, **body):
        return self.client.post(f"/api/prefixes/{self.root.id}/plan/", body, format="json")

    def test_dry_run_then_apply(self):
        reqs = [{"count": 2, "length": 24, "description": "servers-{n}"},
                {"count": 5, "length": 29, "description": "p2p-{n}"}]
        before = Prefix.objects.count()
        r = self.post(requests=reqs)
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertTrue(data["fits"])
        self.assertFalse(data["applied"])
        cidrs = [it["cidr"] for it in data["items"]]
        self.assertEqual(cidrs[:2], ["10.0.1.0/24", "10.0.2.0/24"])
        self.assertEqual(cidrs[2], "10.0.0.128/29")
        self.assertEqual(data["items"][0]["description"], "servers-1")
        self.assertEqual(data["strip"]["root"], "10.0.0.0/22")
        self.assertEqual(data["strip"]["used"], [[0.0, 0.125]])
        self.assertEqual(Prefix.objects.count(), before)
        r = self.post(requests=reqs, dry_run=False, cidrs=cidrs)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["created"]), 7)
        self.assertEqual(Prefix.objects.count(), before + 7)
        logged = ChangeLogEntry.objects.filter(cause="Planned in 10.0.0.0/22")
        self.assertEqual(logged.count(), 7)
        self.assertEqual(Prefix.objects.get(cidr="10.0.2.0/24").description, "servers-2")

    def test_all_or_nothing(self):
        before = Prefix.objects.count()
        reqs = [{"count": 4, "length": 24}]
        r = self.post(requests=reqs)
        self.assertFalse(r.json()["fits"])
        miss = [it for it in r.json()["items"] if not it["cidr"]]
        self.assertEqual(len(miss), 1)
        self.assertEqual(miss[0]["reason"],
                         "No free /24 left in 10.0.0.0/22; largest free block is /25.")
        r = self.post(requests=reqs, dry_run=False)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Prefix.objects.count(), before)
        # A field error on the last one rolls back the rest too.
        r = self.post(requests=[{"count": 2, "length": 24},
                                {"count": 1, "length": 29, "status_id": "nope"}],
                      dry_run=False)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Prefix.objects.count(), before)

    def test_space_changed_is_409(self):
        r = self.post(requests=[{"count": 1, "length": 24}])
        cidrs = [it["cidr"] for it in r.json()["items"]]
        self.p("10.0.1.0/24")
        r = self.post(requests=[{"count": 1, "length": 24}], dry_run=False, cidrs=cidrs)
        self.assertEqual(r.status_code, 409)

    def test_scope_and_bad_rows(self):
        r = self.post(requests=[{"count": 1, "length": 24}], scope="10.0.2.0/23")
        self.assertEqual(r.json()["items"][0]["cidr"], "10.0.2.0/24")
        self.assertEqual(self.post(requests=[]).status_code, 400)
        self.assertEqual(self.post(requests=[{"count": 0, "length": 24}]).status_code, 400)
        self.assertEqual(self.post(requests=[{"count": 1, "length": 40}]).status_code, 400)


class SiteSeparationTests(_Base):
    """A reader limited to site A: hidden prefixes stay hidden, their space is
    not offered, and nothing is created over them or outside site A."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        self.a = Site.objects.create(tenant=t, name="A")
        self.b = Site.objects.create(tenant=t, name="B")
        self.root = self.p("10.1.0.0/16", site=self.a)
        self.p("10.1.0.0/24", site=self.a)
        self.hidden = self.p("10.1.1.0/24", site=self.b, description="secret-b-net")
        self.foreign = self.p("10.2.0.0/16", site=self.b)
        self.shared = self.p("10.3.0.0/16")
        self.p("10.3.0.0/24", site=self.a)
        self.user = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(t)
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=["prefix", "ipaddress"],
            actions=["view", "add", "change"])
        perm.users.add(self.user)
        perm.tenants.add(t)
        perm.sites.add(self.a)
        self.login(self.user)

    def test_list_offers_only_real_free_space_and_names_nothing_hidden(self):
        r = self.free()
        text = r.content.decode()
        self.assertNotIn("10.1.1.0", text)
        self.assertNotIn("secret-b-net", text)
        self.assertNotIn(str(self.hidden.id), text)
        rows = [x["cidr"] for x in r.json()["free"] if x["parent"] == str(self.root.id)]
        self.assertEqual(rows[:2], ["10.1.2.0/23", "10.1.4.0/22"])
        self.assertNotIn(str(self.foreign.id), {x["parent"] for x in r.json()["free"]})
        # Totals count only what is offered.
        self.assertEqual(r.json()["free_totals"][str(self.root.id)], len(
            fs.load_spaces(self.tenant.id, [self.root])[self.root.pk].blocks()))

    def test_space_map_uses_the_same_rule(self):
        r = self.client.get(f"/api/prefixes/{self.root.id}/space-map/", {"details": 0})
        self.assertEqual(r.status_code, 200, r.content)
        text = r.content.decode()
        self.assertNotIn(str(self.hidden.id), text)
        self.assertNotIn("secret-b-net", text)
        row = next(x for x in r.json()["rows"] if x["prefixlen"] == 24)
        cells = {c["cidr"]: c for c in row["cells"]}
        taken = cells["10.1.1.0/24"]
        self.assertEqual(taken["state"], "full")
        self.assertEqual(taken["overlap_with"], [])
        self.assertIsNone(taken.get("prefix_id"))
        # Free cells are exactly the free /24s the list and allocate offer.
        space = fs.load_spaces(self.tenant.id, [self.root])[self.root.pk]
        self.assertEqual(row["free_count"], space.count(24))
        self.assertEqual(
            [c for c, v in cells.items() if v["state"] == "free"][:2],
            [fs.cidr_of(a, 24, 4) for a in itertools.islice(space.candidates(24), 2)])
        # A zoom into the hidden prefix is all taken, and has no context.
        r = self.client.get(f"/api/prefixes/{self.root.id}/space-map/",
                            {"details": 0, "within": "10.1.1.0/24", "deeper": 1})
        data = r.json()
        self.assertIsNone(data["context"])
        self.assertTrue(all(c["state"] == "full" for row in data["rows"]
                            for c in row["cells"]))
        self.assertTrue(all(run[2] == "full" and run[5] is None
                            for row in data["rows"] for run in row.get("runs", [])))
        self.assertNotIn(str(self.hidden.id), r.content.decode())

    def test_available_skips_hidden_space(self):
        r = self.client.get(f"/api/prefixes/available/?within={self.root.id}&length=24&limit=2")
        self.assertEqual([x["cidr"] for x in r.json()], ["10.1.2.0/24", "10.1.3.0/24"])
        r = self.client.get("/api/prefixes/available/?length=24&limit=500")
        parents = {x["parent"]["id"] for x in r.json()}
        self.assertNotIn(str(self.foreign.id), parents)
        self.assertNotIn("10.1.1.0", r.content.decode())
        r = self.client.get(f"/api/prefixes/available/?within={self.foreign.id}")
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/prefixes/available/?within=10.1.1.0/24")
        self.assertEqual(r.status_code, 400)

    def test_allocate_never_lands_on_hidden_space(self):
        r = self.client.post(f"/api/prefixes/{self.root.id}/allocate/", {"length": 24},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cidr"], "10.1.2.0/24")
        self.assertEqual(r.json()["site"]["id"], str(self.a.id))

    def test_allocate_in_a_prefix_it_cannot_see_is_404(self):
        for target in (self.foreign, self.hidden):
            r = self.client.post(f"/api/prefixes/{target.id}/allocate/", {"length": 28},
                                 format="json")
            self.assertEqual(r.status_code, 404, target.cidr)
            r = self.client.post(f"/api/prefixes/{target.id}/plan/",
                                 {"requests": [{"count": 1, "length": 28}]}, format="json")
            self.assertEqual(r.status_code, 404, target.cidr)

    def test_shared_space_is_refused(self):
        self.shared.site = None
        self.shared.save()
        # The shared /16 is visible only if the grant allows it; give view.
        perm = ObjectPermission.objects.create(
            name="view-all", object_types=["prefix"], actions=["view"])
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        before = Prefix.objects.count()
        r = self.client.post(f"/api/prefixes/{self.shared.id}/allocate/", {"length": 24},
                             format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.post(f"/api/prefixes/{self.shared.id}/plan/",
                             {"requests": [{"count": 1, "length": 24}]}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("10.1.1.0", r.content.decode())
        self.assertEqual(Prefix.objects.count(), before)

    def test_no_create_under_a_shared_parent(self):
        # View on everything, add only in site A: the shared /16 and what
        # sits in it are visible but take no children.
        perm = ObjectPermission.objects.create(
            name="view-all", object_types=["prefix"], actions=["view"])
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        in_shared = Prefix.objects.get(cidr="10.3.0.0/24")

        def add_child(p):
            r = self.client.get(f"/api/prefixes/{p.id}/")
            self.assertEqual(r.status_code, 200, r.content)
            return r.json()["permissions"]["add_child"]

        self.assertTrue(add_child(self.root))
        self.assertFalse(add_child(self.shared))
        self.assertFalse(add_child(in_shared))
        self.assertFalse(add_child(self.foreign))
        rows = {x["id"]: x["permissions"]["add_child"]
                for x in self.client.get("/api/prefixes/?page_size=100").json()["results"]}
        self.assertEqual(rows[str(self.root.id)], True)
        self.assertEqual(rows[str(self.shared.id)], False)
        self.assertEqual(rows[str(in_shared.id)], False)
        # The server refuses what the flag hides, and takes what it offers.
        before = Prefix.objects.count()
        for cidr in ("10.3.1.0/24", "10.3.0.128/25"):
            r = self.client.post("/api/prefixes/", {"cidr": cidr, "site_id": str(self.a.id)},
                                 format="json")
            self.assertEqual(r.status_code, 403, cidr)
        self.assertEqual(Prefix.objects.count(), before)
        r = self.client.post("/api/prefixes/", {"cidr": "10.1.9.0/24", "site_id": str(self.a.id)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        # Unrestricted creators may create anywhere.
        self.login(self.admin)
        self.assertTrue(add_child(self.shared))

    def test_plan_in_own_site(self):
        r = self.client.post(f"/api/prefixes/{self.root.id}/plan/",
                             {"requests": [{"count": 2, "length": 24}], "dry_run": False},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([c["cidr"] for c in r.json()["created"]],
                         ["10.1.2.0/24", "10.1.3.0/24"])
        self.assertNotIn("10.1.1.0", r.content.decode())

    def test_no_add_grant_is_403(self):
        viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="view", object_types=["prefix"], actions=["view"])
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.login(viewer)
        r = self.client.post(f"/api/prefixes/{self.root.id}/allocate/", {"length": 24},
                             format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.get(f"/api/prefixes/available/?within={self.root.id}&length=24")
        self.assertEqual(r.status_code, 200)


class TenantIsolationTests(_Base):
    def test_other_tenant(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = Prefix.objects.create(tenant=other, cidr="10.0.0.0/16")
        Prefix.objects.create(tenant=other, cidr="10.0.5.0/24", description="theirs")
        mine = self.p("10.0.0.0/16")
        self.p("10.0.0.0/24")
        rows = [x["cidr"] for x in self.free().json()["free"]]
        self.assertIn("10.0.4.0/22", rows)  # their /24 holds nothing of ours back
        r = self.client.post(f"/api/prefixes/{theirs.id}/allocate/", {"length": 24},
                             format="json")
        self.assertEqual(r.status_code, 404)
        r = self.client.get(f"/api/prefixes/available/?within={theirs.id}")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(
            f"/api/prefixes/available/?within={mine.id}&length=24&limit=5").json()[4]["cidr"],
            "10.0.5.0/24")


class PerformanceTests(_Base):
    def test_a_slash_8_with_thousands_of_children(self):
        root = self.p("10.0.0.0/8", status=self.container)
        Prefix.objects.bulk_create([
            Prefix(tenant=self.tenant, cidr=f"10.{i // 256}.{i % 256}.0/24")
            for i in range(0, 8000, 2)
        ])
        start = time.monotonic()
        data = self.free(page_size=100).json()
        listed = time.monotonic() - start
        self.assertEqual(data["free_totals"][str(root.id)] > 4000, True)
        start = time.monotonic()
        r = self.client.get(f"/api/prefixes/available/?within={root.id}&length=24&limit=256")
        took = time.monotonic() - start
        self.assertEqual(len(r.json()), 256)
        start = time.monotonic()
        r = self.client.post(f"/api/prefixes/{root.id}/plan/",
                             {"requests": [{"count": 20, "length": 24},
                                           {"count": 50, "length": 29}]}, format="json")
        planned = time.monotonic() - start
        self.assertTrue(r.json()["fits"])
        self.assertLess(listed, 3.0)
        self.assertLess(took, 2.0)
        self.assertLess(planned, 2.0)


class AllocateRaceTests(APITransactionTestCase):
    """Two allocations at once get different blocks: the first holds its
    transaction open while the second is sent."""

    @classmethod
    def tearDownClass(cls):
        # The final flush wipes the migration-seeded RBAC groups from a
        # --keepdb database; put them back for the next run.
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.root = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.inner = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/25")
        self.sessions = []
        for _ in range(2):
            login = APIClient()
            login.force_login(self.user)
            session = login.session
            session["current_tenant_id"] = str(self.tenant.id)
            session.save()
            self.sessions.append({k: m.value for k, m in login.cookies.items()})

    def _post(self, n, prefix):
        client = APIClient()
        client.cookies.load(self.sessions[n])
        return client.post(f"/api/prefixes/{prefix.id}/allocate/", {"length": 27},
                           format="json")

    def race(self, first_parent, second_parent):
        held, release, out = threading.Event(), threading.Event(), {}

        def hold():
            try:
                with transaction.atomic():
                    out["first"] = self._post(0, first_parent)
                    held.set()
                    release.wait(10)
            finally:
                held.set()
                connection.close()

        def run():
            try:
                out["second"] = self._post(1, second_parent)
            finally:
                connection.close()

        a = threading.Thread(target=hold)
        a.start()
        held.wait(10)
        b = threading.Thread(target=run)
        b.start()
        b.join(0.5)
        self.assertTrue(b.is_alive(), "the second allocation did not wait for the lock")
        release.set()
        a.join(10)
        b.join(10)
        return out["first"], out["second"]

    def test_same_parent(self):
        first, second = self.race(self.root, self.root)
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 201, second.content)
        self.assertEqual(first.json()["cidr"], "10.0.0.128/27")
        self.assertEqual(second.json()["cidr"], "10.0.0.160/27")

    def test_nested_parents(self):
        first, second = self.race(self.inner, self.root)
        self.assertEqual(first.json()["cidr"], "10.0.0.0/27")
        # The /25 is used space for the /24 either way; no overlap.
        self.assertEqual(second.json()["cidr"], "10.0.0.128/27")
        cidrs = list(Prefix.objects.values_list("cidr", flat=True))
        self.assertEqual(len(cidrs), len(set(cidrs)))
