"""POST /api/prefixes/<id>/renumber/ - move a prefix tree to a new parent."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api import renumber as rn
from api.models import (
    VRF,
    Device,
    FHRPGroup,
    Interface,
    IPAddress,
    IPRange,
    IPRole,
    NATRule,
    Prefix,
    Site,
)
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import DhcpExclusion, DhcpReservation, DhcpScope
from routing.models import PolicyRule, StaticRoute


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def post(self, prefix, new, dry_run=True, **extra):
        return self.client.post(
            f"/api/prefixes/{prefix.id}/renumber/",
            {"new_prefix": new, "dry_run": dry_run, **extra}, format="json",
        )


class IPv6RenumberTests(_Base):
    """A DHCPv6-PD /60 with a /64 per VLAN, an anycast gateway and an FHRP VIP."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        self.root = Prefix.objects.create(tenant=t, cidr="2001:db8:abc0::/60")
        self.v10 = Prefix.objects.create(
            tenant=t, cidr="2001:db8:abc0:1::/64", gateway="2001:db8:abc0:1::1")
        self.v20 = Prefix.objects.create(tenant=t, cidr="2001:db8:abc0:2::/64")
        self.dev = Device.objects.create(tenant=t, name="leaf1")
        self.svi = Interface.objects.create(device=self.dev, name="vlan10")
        anycast = IPRole.objects.create(tenant=t, name="Anycast", slug="anycast",
                                        is_virtual=True)
        vip = IPRole.objects.create(tenant=t, name="VIP", slug="vip", is_virtual=True)
        self.gw = IPAddress.objects.create(
            tenant=t, prefix=self.v10, ip_address="2001:db8:abc0:1::1", role=anycast,
            assigned_interface=self.svi, dns_name="gw.v10.example", mask_length=64)
        self.vip = IPAddress.objects.create(
            tenant=t, prefix=self.v10, ip_address="2001:db8:abc0:1::2", role=vip)
        # Recorded on the /60 itself though a /64 now holds it.
        self.host = IPAddress.objects.create(
            tenant=t, prefix=self.root, ip_address="2001:db8:abc0:2::10")
        self.fhrp = FHRPGroup.objects.create(
            tenant=t, protocol="vrrp3", group_id=10, virtual_ip=self.vip)
        self.rng = IPRange.objects.create(
            tenant=t, prefix=self.v10, start_address="2001:db8:abc0:1::100",
            end_address="2001:db8:abc0:1::1ff")
        self.route = StaticRoute.objects.create(
            tenant=t, device=self.dev, prefix="2001:db8:abc0:2::/64",
            next_hop="2001:db8:abc0:1::5")
        self.nat = NATRule.objects.create(tenant=t, name="web", internal_ip=self.host)
        # Outside the tree: never touched, never listed.
        self.other = Prefix.objects.create(tenant=t, cidr="2001:db8:ffff::/64")
        self.outside = IPAddress.objects.create(
            tenant=t, prefix=self.other, ip_address="2001:db8:ffff::1")

    def _snapshot(self):
        return (
            sorted(Prefix.objects.values_list("cidr", flat=True)),
            sorted(IPAddress.objects.values_list("ip_address", flat=True)),
            list(IPRange.objects.values_list("start_address", "end_address")),
            list(StaticRoute.objects.values_list("prefix", "next_hop")),
        )

    def test_preview_lists_every_change_and_writes_nothing(self):
        before = self._snapshot()
        r = self.post(self.root, "2001:db8:1230::/60")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["dry_run"])
        self.assertFalse(body["applied"])
        counts = {c["kind"]: c["count"] for c in body["counts"]}
        self.assertEqual(counts["prefix"], 3)
        self.assertEqual(counts["ipaddress"], 3)
        self.assertEqual(counts["iprange"], 1)
        self.assertEqual(counts["staticroute"], 1)
        pairs = {(c["kind"], c["field"], c["old"]): c["new"] for c in body["changes"]}
        self.assertEqual(pairs[("prefix", "cidr", "2001:db8:abc0:1::/64")],
                         "2001:db8:1230:1::/64")
        self.assertEqual(pairs[("prefix", "gateway", "2001:db8:abc0:1::1")],
                         "2001:db8:1230:1::1")
        self.assertEqual(pairs[("staticroute", "next_hop", "2001:db8:abc0:1::5")],
                         "2001:db8:1230:1::5")
        linked = {x["kind"]: x["count"] for x in body["linked"]}
        self.assertEqual(linked["fhrpgroup"], 1)
        self.assertEqual(linked["natrule"], 1)
        self.assertEqual(self._snapshot(), before)
        self.assertFalse(JournalEntry.objects.exists())

    def test_apply_moves_the_tree_and_keeps_everything_else(self):
        r = self.post(self.root, "2001:db8:1230::/60", dry_run=False)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["applied"])
        self.root.refresh_from_db()
        self.v10.refresh_from_db()
        self.assertEqual(self.root.cidr, "2001:db8:1230::/60")
        self.assertEqual(self.v10.cidr, "2001:db8:1230:1::/64")
        self.assertEqual(self.v10.gateway, "2001:db8:1230:1::1")
        self.gw.refresh_from_db()
        self.assertEqual(self.gw.ip_address, "2001:db8:1230:1::1")
        self.assertEqual(self.gw.mask_length, 64)
        self.assertEqual(self.gw.dns_name, "gw.v10.example")
        self.assertEqual(self.gw.assigned_interface_id, self.svi.id)
        self.assertEqual(self.gw.role.slug, "anycast")
        self.fhrp.refresh_from_db()
        self.assertEqual(self.fhrp.virtual_ip.ip_address, "2001:db8:1230:1::2")
        self.host.refresh_from_db()
        self.assertEqual(self.host.ip_address, "2001:db8:1230:2::10")
        self.rng.refresh_from_db()
        self.assertEqual((self.rng.start_address, self.rng.end_address),
                         ("2001:db8:1230:1::100", "2001:db8:1230:1::1ff"))
        self.route.refresh_from_db()
        self.assertEqual((self.route.prefix, self.route.next_hop),
                         ("2001:db8:1230:2::/64", "2001:db8:1230:1::5"))
        self.outside.refresh_from_db()
        self.assertEqual(self.outside.ip_address, "2001:db8:ffff::1")
        # One shared cause on every entry, and the journal on the root.
        cause = "Renumbered 2001:db8:abc0::/60 to 2001:db8:1230::/60"
        logged = set(ChangeLogEntry.objects.filter(cause=cause)
                     .values_list("object_type", "object_id"))
        for obj in (self.root, self.v10, self.v20, self.gw, self.vip, self.host,
                    self.rng, self.route):
            self.assertIn((obj._meta.label_lower, str(obj.pk)), logged)
        j = JournalEntry.objects.get(object_type="api.prefix", object_id=str(self.root.pk))
        self.assertIn("Renumbered from 2001:db8:abc0::/60 to 2001:db8:1230::/60",
                      j.comments)

    def test_apply_is_atomic(self):
        before = self._snapshot()
        with mock.patch.object(JournalEntry.objects, "create",
                               side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                rn.apply_plan(self.root, "2001:db8:1230::/60", self.admin, self.tenant)
        self.assertEqual(self._snapshot(), before)
        self.assertFalse(ChangeLogEntry.objects.filter(cause__startswith="Renumbered")
                         .exists())

    def test_overlap_with_an_existing_prefix_is_refused(self):
        Prefix.objects.create(tenant=self.tenant, cidr="2001:db8:1230:1::/64")
        r = self.post(self.root, "2001:db8:1230::/60")
        self.assertEqual(r.status_code, 400)
        self.assertIn("2001:db8:1230:1::/64", r.json()["new_prefix"][0])

    def test_overlap_with_an_existing_address_is_refused(self):
        p = Prefix.objects.create(tenant=self.tenant, cidr="2001:db8:1200::/48")
        IPAddress.objects.create(tenant=self.tenant, prefix=p, ip_address="2001:db8:1230:4::9")
        r = self.post(self.root, "2001:db8:1230::/60")
        self.assertEqual(r.status_code, 400)
        self.assertIn("2001:db8:1230:4::9", r.json()["new_prefix"][0])

    def test_a_containing_supernet_is_fine(self):
        Prefix.objects.create(tenant=self.tenant, cidr="2001:db8::/32")
        r = self.post(self.root, "2001:db8:1230::/60")
        self.assertEqual(r.status_code, 200, r.content)

    def test_length_and_family_must_match(self):
        for new, needle in (("2001:db8:1200::/56", "/60"), ("10.0.0.0/24", "IPv6"),
                            ("2001:db8:1230::", "length"), ("2001:db8:1230:1::/60", "valid")):
            r = self.post(self.root, new)
            self.assertEqual(r.status_code, 400, new)
            self.assertIn(needle, r.json()["new_prefix"][0], new)

    def test_vrf_move_is_refused(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="X")
        r = self.post(self.root, "2001:db8:1230::/60", vrf_id=str(vrf.id))
        self.assertEqual(r.status_code, 400)

    def test_missing_grant_on_one_kind_is_403_naming_it(self):
        user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="ipam", object_types=["prefix", "ipaddress", "iprange"],
            actions=["view", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        before = self._snapshot()
        r = self.post(self.root, "2001:db8:1230::/60", dry_run=False)
        self.assertEqual(r.status_code, 403)
        # A kind they can't view is counted, not named (#504).
        self.assertIn("1 object you can't view", r.json()["detail"])
        self.assertNotIn("static routes", r.json()["detail"])
        self.assertEqual(self._snapshot(), before)
        # Allowed to view routes, not change them: named.
        route_view = ObjectPermission.objects.create(
            name="routes", object_types=["staticroute"], actions=["view"])
        route_view.users.add(user)
        route_view.tenants.add(self.tenant)
        r = self.post(self.root, "2001:db8:1230::/60", dry_run=False)
        self.assertEqual(r.status_code, 403)
        self.assertIn("1 of 1 static routes", r.json()["detail"])
        # With the route grant too, it goes through.
        perm.object_types = [*perm.object_types, "staticroute"]
        perm.save()
        r = self.post(self.root, "2001:db8:1230::/60", dry_run=False)
        self.assertEqual(r.status_code, 200, r.content)


class SiteLimitTests(_Base):
    def test_child_in_another_site_blocks_a_site_editor(self):
        t = self.tenant
        a = Site.objects.create(tenant=t, name="A")
        b = Site.objects.create(tenant=t, name="B")
        root = Prefix.objects.create(tenant=t, cidr="10.1.0.0/16", site=a)
        Prefix.objects.create(tenant=t, cidr="10.1.1.0/24", site=a)
        Prefix.objects.create(tenant=t, cidr="10.1.2.0/24", site=b)
        user = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=user).tenants.add(t)
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=["prefix", "ipaddress"],
            actions=["view", "change"])
        perm.users.add(user)
        perm.tenants.add(t)
        perm.sites.add(a)
        self.login(user)
        r = self.post(root, "10.2.0.0/16")
        self.assertEqual(r.status_code, 403)
        # Site B's child is not theirs to view: counted, not named (#504).
        self.assertIn("1 object you can't view", r.json()["detail"])
        self.assertNotIn("10.1.2.0/24", r.json()["detail"])


class IPv4RenumberTests(_Base):
    """A /24 in a VRF with a local DHCP scope, a NAT rule and routes."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        self.vrf = VRF.objects.create(tenant=t, name="CUST")
        self.root = Prefix.objects.create(tenant=t, vrf=self.vrf, cidr="10.20.0.0/24",
                                          gateway="10.20.0.1")
        self.gw = IPAddress.objects.create(tenant=t, prefix=self.root,
                                           ip_address="10.20.0.1")
        self.srv = IPAddress.objects.create(tenant=t, prefix=self.root,
                                            ip_address="10.20.0.50")
        self.scope = DhcpScope.objects.create(
            tenant=t, scope_id="10.20.0.0", name="Office", prefix=self.root,
            start_range="10.20.0.100", end_range="10.20.0.200",
            subnet_mask="255.255.255.0",
            options=[{"option_id": 3, "name": "Router", "value": ["10.20.0.1"]},
                     {"option_id": 6, "name": "DNS", "value": ["192.0.2.53"]}])
        self.excl = DhcpExclusion.objects.create(
            scope=self.scope, start_address="10.20.0.150", end_address="10.20.0.160")
        self.res = DhcpReservation.objects.create(
            scope=self.scope, ip="10.20.0.120", mac="aa-bb-cc-dd-ee-ff")
        self.nat = NATRule.objects.create(tenant=t, name="ssh", internal_ip=self.srv)
        self.dev = Device.objects.create(tenant=t, name="fw1")
        self.route = StaticRoute.objects.create(
            tenant=t, device=self.dev, vrf=self.vrf, prefix="0.0.0.0/0",
            next_hop="10.20.0.1")
        # Same text in the global table: another table, not a reference.
        self.global_route = StaticRoute.objects.create(
            tenant=t, device=self.dev, prefix="10.20.0.0/25", next_hop="192.0.2.1")
        self.policy = PolicyRule.objects.create(
            tenant=t, device=self.dev, priority=100, from_prefix="10.20.0.0/25",
            table=100)

    def test_apply(self):
        r = self.post(self.root, "10.30.0.0/24")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        unchanged = {(u["kind"], u["id"]) for u in body["unchanged"]}
        self.assertIn(("policyrule", str(self.policy.id)), unchanged)
        self.assertNotIn(("staticroute", str(self.global_route.id)), unchanged)

        r = self.post(self.root, "10.30.0.0/24", dry_run=False)
        self.assertEqual(r.status_code, 200, r.content)
        self.root.refresh_from_db()
        self.assertEqual((self.root.cidr, self.root.gateway, self.root.vrf_id),
                         ("10.30.0.0/24", "10.30.0.1", self.vrf.id))
        self.srv.refresh_from_db()
        self.assertEqual(self.srv.ip_address, "10.30.0.50")
        self.assertEqual(self.srv.vrf_id, self.vrf.id)
        self.nat.refresh_from_db()
        self.assertEqual(self.nat.internal_ip.ip_address, "10.30.0.50")
        self.scope.refresh_from_db()
        self.assertEqual(
            (self.scope.scope_id, self.scope.start_range, self.scope.end_range),
            ("10.30.0.0", "10.30.0.100", "10.30.0.200"))
        self.assertEqual(self.scope.options[0]["value"], ["10.30.0.1"])
        self.assertEqual(self.scope.options[1]["value"], ["192.0.2.53"])
        self.excl.refresh_from_db()
        self.assertEqual((self.excl.start_address, self.excl.end_address),
                         ("10.30.0.150", "10.30.0.160"))
        self.res.refresh_from_db()
        self.assertEqual(self.res.ip, "10.30.0.120")
        self.route.refresh_from_db()
        self.assertEqual(self.route.next_hop, "10.30.0.1")
        self.global_route.refresh_from_db()
        self.assertEqual(self.global_route.prefix, "10.20.0.0/25")
        self.policy.refresh_from_db()
        self.assertEqual(self.policy.from_prefix, "10.20.0.0/25")
        cause = "Renumbered 10.20.0.0/24 to 10.30.0.0/24"
        logged = set(ChangeLogEntry.objects.filter(cause=cause)
                     .values_list("object_type", flat=True))
        self.assertTrue({"api.prefix", "api.ipaddress", "integrations.dhcpscope",
                         "integrations.dhcpreservation", "integrations.dhcpexclusion",
                         "routing.staticroute"} <= logged, logged)

    def test_global_table_rewrites_vrfless_text(self):
        t = self.tenant
        root = Prefix.objects.create(tenant=t, cidr="172.16.0.0/24")
        rule = PolicyRule.objects.create(
            tenant=t, device=self.dev, priority=200, from_prefix="172.16.0.0/25",
            table=100)
        r = self.post(root, "172.17.0.0/24", dry_run=False)
        self.assertEqual(r.status_code, 200, r.content)
        rule.refresh_from_db()
        self.assertEqual(rule.from_prefix, "172.17.0.0/25")

    def test_range_crossing_the_edge_is_refused(self):
        IPRange.objects.create(tenant=self.tenant, vrf=self.vrf,
                               start_address="10.20.0.250", end_address="10.20.1.5")
        r = self.post(self.root, "10.30.0.0/24")
        self.assertEqual(r.status_code, 400)
        self.assertIn("crosses the edge", r.json()["new_prefix"][0])

    def test_same_cidr_in_another_vrf_does_not_conflict(self):
        Prefix.objects.create(tenant=self.tenant, cidr="10.30.0.0/24")
        r = self.post(self.root, "10.30.0.0/24")
        self.assertEqual(r.status_code, 200, r.content)
