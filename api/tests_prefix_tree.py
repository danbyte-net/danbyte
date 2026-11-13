"""The prefix tree endpoint (api.prefix_tree) and the lists' ``within``.

A level at a time, paged, over the prefixes the reader may view: a prefix
under a hidden one hangs from the nearest visible prefix above it and the
hidden CIDR is never in an answer.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import VRF, IPAddress, Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

URL = "/api/prefixes/tree/"


class _Base(APITestCase):
    separation = False

    def setUp(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.separation
        dep.save(update_fields=["enhanced_site_separation", "updated_at"])
        org = Organization.objects.create(name="Acme", slug="acme")
        self.t = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.a = Site.objects.create(tenant=t, name="A")
        self.b = Site.objects.create(tenant=t, name="B")
        self.corp = VRF.objects.create(tenant=t, name="CORP")
        mk = self.mk
        self.p8 = mk("10.0.0.0/8", self.a)
        self.p16 = mk("10.1.0.0/16", self.a)
        self.p24 = mk("10.1.2.0/24", self.a)
        # A site-B /16 between a visible /8 and a visible /24.
        self.hidden = mk("10.9.0.0/16", self.b)
        self.under_hidden = mk("10.9.4.0/24", self.a)
        self.other_root = mk("192.168.0.0/16", self.a)
        self.in_vrf = mk("10.0.0.0/8", self.a, vrf=self.corp)
        self.root = User.objects.create_superuser("root", "r@a.c", "pw")
        self.u = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.u).tenants.add(t)
        perm = ObjectPermission.objects.create(
            name="a-prefixes", object_types=["prefix", "ipaddress"], actions=["view"])
        perm.users.add(self.u)
        perm.tenants.add(t)
        perm.sites.add(self.a)
        self.login(self.root)

    def mk(self, cidr, site=None, vrf=None, tenant=None):
        return Prefix.objects.create(tenant=tenant or self.t, cidr=cidr, site=site, vrf=vrf)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def get(self, **params):
        r = self.client.get(URL, params)
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def cidrs(self, r):
        return [(n["cidr"], n["child_count"]) for n in r.json()["results"]]


class _Visibility:
    def test_hidden_parent_is_skipped_and_never_named(self):
        self.login(self.u)
        r = self.get()
        self.assertEqual(self.cidrs(r), [("10.0.0.0/8", 2), ("192.168.0.0/16", 0)])
        r = self.get(parent=str(self.p8.id))
        # 10.9.4.0/24 sits directly under the /8: its /16 is site B's.
        self.assertEqual(self.cidrs(r), [("10.1.0.0/16", 1), ("10.9.4.0/24", 0)])
        self.assertNotIn(b"10.9.0.0", r.content)
        self.assertNotIn(str(self.hidden.id).encode(), r.content)

    def test_hidden_prefix_is_not_a_parent_search_hit_or_path(self):
        self.login(self.u)
        r = self.client.get(URL, {"parent": str(self.hidden.id)})
        self.assertEqual(r.status_code, 404)
        r = self.client.get(URL, {"reveal": str(self.hidden.id)})
        self.assertEqual(r.status_code, 404)
        r = self.get(q="10.9")
        self.assertNotIn(b"10.9.0.0", r.content)
        self.assertEqual(
            [(n["cidr"], n["match"]) for n in r.json()["results"]],
            [("10.0.0.0/8", False), ("10.9.4.0/24", True)],
        )
        r = self.get(reveal=str(self.under_hidden.id))
        self.assertEqual([n["cidr"] for n in r.json()["path"]],
                         ["10.0.0.0/8", "10.9.4.0/24"])
        self.assertEqual([n["index"] for n in r.json()["path"]], [0, 1])

    def test_rooted_tree_skips_a_hidden_intermediate(self):
        # A prefix page's tree: the root is visible, the /16 below it is
        # not; its /24 is a top node of the rooted tree, the /16 never named.
        self.login(self.u)
        root = str(self.p8.id)
        r = self.get(parent=root)
        self.assertEqual(self.cidrs(r), [("10.1.0.0/16", 1), ("10.9.4.0/24", 0)])
        self.assertEqual({n["parent"] for n in r.json()["results"]}, {root})
        r = self.get(parent=root, q="10.9")
        self.assertEqual(
            [(n["cidr"], n["match"], n["parent"]) for n in r.json()["results"]],
            [("10.9.4.0/24", True, root)],
        )
        self.assertNotIn(b"10.9.0.0", r.content)
        self.assertNotIn(str(self.hidden.id).encode(), r.content)
        r = self.client.get(URL, {"parent": str(self.hidden.id), "q": "10"})
        self.assertEqual(r.status_code, 404)

    def test_within_a_hidden_prefix_lists_nothing(self):
        self.login(self.u)
        r = self.client.get("/api/prefixes/", {"within": str(self.hidden.id)})
        self.assertEqual(r.json()["count"], 0)
        r = self.client.get("/api/ips/", {"within": str(self.hidden.id)})
        self.assertEqual(r.json()["count"], 0)

    def test_vrf_page_tree_and_lists(self):
        # A VRF page's tree: the VRF's roots, the site-B /16 skipped, its /24
        # hanging from the /8; the lists scoped by vrf= and within= together.
        lab = VRF.objects.create(tenant=self.t, name="LAB")
        top = self.mk("172.16.0.0/12", self.a, vrf=lab)
        hid = self.mk("172.16.0.0/16", self.b, vrf=lab)
        low = self.mk("172.16.1.0/24", self.a, vrf=lab)
        self.mk("172.16.1.0/24", self.a)  # the same CIDR, global
        mine = IPAddress.objects.create(tenant=self.t, ip_address="172.16.1.5", prefix=low)
        IPAddress.objects.create(tenant=self.t, ip_address="172.16.9.5", prefix=hid)
        self.login(self.u)
        vrf = str(lab.id)
        self.assertEqual(self.cidrs(self.get(vrf=vrf)), [("172.16.0.0/12", 1)])
        r = self.get(parent=str(top.id))
        self.assertEqual(self.cidrs(r), [("172.16.1.0/24", 0)])
        self.assertNotIn(str(hid.id).encode(), r.content)
        r = self.get(vrf=vrf, q="172.16.1")
        self.assertEqual([(n["cidr"], n["match"]) for n in r.json()["results"]],
                         [("172.16.0.0/12", False), ("172.16.1.0/24", True)])
        self.assertNotIn(str(hid.id).encode(), r.content)
        r = self.client.get("/api/prefixes/", {"vrf": vrf, "within": str(top.id)})
        self.assertEqual([p["id"] for p in r.json()["results"]], [str(top.id), str(low.id)])
        r = self.client.get("/api/ips/", {"vrf": vrf, "within": str(low.id)})
        self.assertEqual([x["id"] for x in r.json()["results"]], [str(mine.id)])
        # A node from another VRF scopes the VRF's lists to nothing.
        r = self.client.get("/api/prefixes/", {"vrf": vrf, "within": str(self.p8.id)})
        self.assertEqual(r.json()["count"], 0)

    def test_superuser_sees_the_hidden_level(self):
        r = self.get(parent=str(self.p8.id))
        self.assertEqual(self.cidrs(r), [("10.1.0.0/16", 1), ("10.9.0.0/16", 1)])


class SeparationOffTests(_Visibility, _Base):
    separation = False


class SeparationOnTests(_Visibility, _Base):
    separation = True


class TreeTests(_Base):
    def test_roots_per_vrf(self):
        self.assertEqual(self.cidrs(self.get()),
                         [("10.0.0.0/8", 2), ("192.168.0.0/16", 0)])
        self.assertEqual(self.cidrs(self.get(vrf="global")),
                         [("10.0.0.0/8", 2), ("192.168.0.0/16", 0)])
        self.assertEqual(self.cidrs(self.get(vrf=str(self.corp.id))),
                         [("10.0.0.0/8", 0)])
        self.assertEqual(self.get(vrf="not-a-uuid").json()["count"], 0)

    def test_another_tenants_prefix_is_not_found(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = self.mk("172.16.0.0/12", tenant=other)
        for key in ("parent", "reveal"):
            r = self.client.get(URL, {key: str(theirs.id)})
            self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get("/api/prefixes/", {"within": str(theirs.id)})
                         .json()["count"], 0)

    def test_large_sibling_list_pages(self):
        for i in range(250):
            self.mk(f"10.1.{3 + i // 32}.{(i % 32) * 8}/29")
        r = self.get(parent=str(self.p16.id))
        body = r.json()
        self.assertEqual(body["count"], 251)  # the /24 and 250 /29s
        self.assertEqual(len(body["results"]), 200)
        self.assertEqual(body["results"][0]["cidr"], "10.1.2.0/24")
        r = self.get(parent=str(self.p16.id), offset=200, limit=200)
        self.assertEqual(len(r.json()["results"]), 51)
        r = self.client.get(URL, {"parent": str(self.p16.id), "limit": "x"})
        self.assertEqual(r.status_code, 400)

    def test_query_count_does_not_grow_with_the_tree(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.get(parent=str(self.p16.id))
                self.get()
                self.get(reveal=str(self.p24.id))
                self.get(q="10.1")
            return len(ctx.captured_queries)

        before = count()
        for i in range(60):
            self.mk(f"10.1.{10 + i}.0/24")
            self.mk(f"10.1.{10 + i}.0/28")
        self.assertEqual(count(), before)

    def test_search_answers_outermost_matches_with_their_path(self):
        r = self.get(q="10.1")
        self.assertEqual(
            [(n["cidr"], n["match"], n["parent"]) for n in r.json()["results"]],
            [("10.0.0.0/8", False, None), ("10.1.0.0/16", True, str(self.p8.id))],
        )
        r = self.get(q="10.1.2.0/24")
        self.assertEqual([n["cidr"] for n in r.json()["results"] if n["match"]],
                         ["10.1.2.0/24"])
        # An address no prefix equals: the smallest prefix holding it.
        r = self.get(q="10.1.2.7")
        self.assertEqual([n["cidr"] for n in r.json()["results"] if n["match"]],
                         ["10.1.2.0/24"])
        self.assertEqual(self.get(q="172.").json()["results"], [])

    def test_rooted_search_stays_inside_the_parent(self):
        root = str(self.p16.id)
        r = self.get(parent=root, q="10.1")
        # The /16 itself and the /8 above it are not part of its tree.
        self.assertEqual(
            [(n["cidr"], n["match"], n["parent"]) for n in r.json()["results"]],
            [("10.1.2.0/24", True, root)],
        )
        r = self.get(parent=root, q="10.1.2.0/28")
        self.assertEqual([n["cidr"] for n in r.json()["results"]], ["10.1.2.0/24"])
        self.assertEqual(self.get(parent=root, q="192.").json()["results"], [])
        # The VRF's own 10.0.0.0/8 has nothing inside it.
        self.assertEqual(self.get(parent=str(self.in_vrf.id), q="10").json()["results"], [])

    def test_within_scopes_the_lists(self):
        ip = IPAddress.objects.create(tenant=self.t, ip_address="10.1.2.5", prefix=self.p24)
        IPAddress.objects.create(tenant=self.t, ip_address="192.168.0.5",
                                 prefix=self.other_root)
        r = self.client.get("/api/prefixes/", {"within": str(self.p16.id)})
        self.assertEqual([p["cidr"] for p in r.json()["results"]],
                         ["10.1.0.0/16", "10.1.2.0/24"])
        r = self.client.get("/api/ips/", {"within": str(self.p16.id)})
        self.assertEqual([x["id"] for x in r.json()["results"]], [str(ip.id)])
        r = self.client.get("/api/prefixes/", {"vrf": "global", "page_size": 50})
        self.assertNotIn(str(self.in_vrf.id), [p["id"] for p in r.json()["results"]])
        r = self.client.get("/api/prefixes/", {"within": "nope"})
        self.assertEqual(r.json()["count"], 0)

    def test_within_leaves_detail_reads_alone(self):
        # A detail action's own `within` (the space map's zoom window) is not
        # the list filter: the prefix is still found.
        ip = IPAddress.objects.create(tenant=self.t, ip_address="10.1.2.5", prefix=self.p24)
        r = self.client.get(f"/api/prefixes/{self.p8.id}/", {"within": str(self.p24.id)})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(f"/api/prefixes/{self.p8.id}/space-map/",
                            {"within": "10.1.0.0/16"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(f"/api/ips/{ip.id}/", {"within": str(self.other_root.id)})
        self.assertEqual(r.status_code, 200, r.content)

    def test_needs_prefix_view(self):
        nobody = User.objects.create_user("n", password="x")
        UserProfile.objects.create(user=nobody).tenants.add(self.t)
        self.login(nobody)
        self.assertIn(self.client.get(URL).status_code, (403, 404))
        self.client.logout()
        self.assertIn(self.client.get(URL).status_code, (401, 403))
