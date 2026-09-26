"""``include=link_ips`` on /api/topology/: each cable pair's addresses and the
subnets both ends share - the match rule (address/length, mask_length over
the prefix), the order an end's interfaces are searched in (port, LAG,
sub-interfaces), what is left out (host routes, VIPs), orientation, the
caller's ipaddress.view scope and the cost (flat in the cable count)."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api import topology_enrich as te
from api.models import (
    Cable,
    CableTermination,
    Device,
    FrontPort,
    Interface,
    IPAddress,
    IPRole,
    Prefix,
    RearPort,
    Site,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="dc-1")
        self._prefixes = {}

    def _device(self, name):
        return Device.objects.create(tenant=self.tenant, name=name, site=self.site)

    def _iface(self, device, name, **kw):
        return Interface.objects.create(device=device, name=name, **kw)

    def _cable(self, a, b):
        cab = Cable.objects.create(tenant=self.tenant)
        for end, port in (("A", a), ("B", b)):
            kind = "interface" if isinstance(port, Interface) else (
                "front_port" if isinstance(port, FrontPort) else "rear_port"
            )
            CableTermination.objects.create(cable=cab, end=end, **{kind: port})
        return cab

    def _prefix(self, cidr):
        if cidr not in self._prefixes:
            self._prefixes[cidr] = Prefix.objects.create(
                tenant=self.tenant, cidr=cidr, site=self.site
            )
        return self._prefixes[cidr]

    def _ip(self, iface, address, prefix, mask_length=None, role=None, site=None):
        prefix = self._prefix(prefix)
        return IPAddress.objects.create(
            tenant=self.tenant, prefix=prefix, ip_address=address,
            mask_length=mask_length, assigned_interface=iface, role=role,
            site=site or self.site,
        )

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _superuser(self):
        u = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        return u

    def _graph(self, **body):
        body.setdefault("include", ["link_ips"])
        r = self.client.post("/api/topology/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _link(self, g, a_dev, b_dev):
        """The edge between two devices and its pairs, re-oriented so ``a``
        is ``a_dev``'s end whichever device the edge starts at."""
        names = {n["id"]: n["data"]["name"] for n in g["nodes"]}
        edges = [
            e for e in g["edges"]
            if {names[e["source"]], names[e["target"]]} == {a_dev.name, b_dev.name}
        ]
        self.assertEqual(len(edges), 1, edges)
        e = edges[0]
        if names[e["source"]] == a_dev.name:
            return e, e["data"]["pairs"]
        flip = {"a": "b", "b": "a"}
        pairs = []
        for p in e["data"]["pairs"]:
            q = dict(p, a_ips=p["b_ips"], b_ips=p["a_ips"], subnets=[
                {**s, "a": s["b"], "b": s["a"], "a_via": s["b_via"], "b_via": s["a_via"]}
                for s in p["subnets"]
            ])
            q.update({f"{flip[k[0]]}{k[1:]}": p[k] for k in ("a_port", "b_port")})
            pairs.append(q)
        return e, pairs


class LinkIpTests(_Base):
    def setUp(self):
        super().setUp()
        self._login(self._superuser())
        self.r1 = self._device("r1")
        self.r2 = self._device("r2")

    def test_default_payload_has_no_ip_fields(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.1.0.0", "10.1.0.0/31")
        self._ip(b, "10.1.0.1", "10.1.0.0/31")
        self._cable(a, b)
        for g in (self.client.get("/api/topology/").json(),
                  self._graph(include=["card"])):
            e = g["edges"][0]["data"]
            self.assertNotIn("subnets", e)
            self.assertNotIn("a_ips", e["pairs"][0])

    def test_31(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth1")
        self._ip(a, "10.1.0.0", "10.1.0.0/31")
        self._ip(b, "10.1.0.1", "10.1.0.0/31")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_port"], "eth0")
        self.assertEqual(p["a_ips"], ["10.1.0.0/31"])
        self.assertEqual(p["b_ips"], ["10.1.0.1/31"])
        self.assertEqual(p["subnets"], [{
            "cidr": "10.1.0.0/31", "family": 4, "a": "10.1.0.0", "b": "10.1.0.1",
            "a_via": None, "b_via": None,
        }])
        self.assertFalse(p["subnets_truncated"])
        self.assertEqual(e["data"]["subnets"], ["10.1.0.0/31"])

    def test_30(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth1")
        self._ip(a, "10.1.0.1", "10.1.0.0/30")
        self._ip(b, "10.1.0.2", "10.1.0.0/30")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual([(s["cidr"], s["a"], s["b"]) for s in p["subnets"]],
                         [("10.1.0.0/30", "10.1.0.1", "10.1.0.2")])
        self.assertEqual(e["data"]["subnets"], ["10.1.0.0/30"])

    def test_aggregate_with_mask_length(self):
        # Both links' addresses sit in one /24 aggregate: each end's own
        # mask length decides, so only the real /31 matches.
        r3 = self._device("r3")
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        c = self._iface(self.r1, "eth1")
        d = self._iface(r3, "eth0")
        self._ip(a, "10.2.0.0", "10.2.0.0/24", mask_length=31)
        self._ip(b, "10.2.0.1", "10.2.0.0/24", mask_length=31)
        self._ip(c, "10.2.0.2", "10.2.0.0/24", mask_length=31)
        self._ip(d, "10.2.0.5", "10.2.0.0/24", mask_length=31)
        self._cable(a, b)
        self._cable(c, d)
        g = self._graph()
        _e, [p] = self._link(g, self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.2.0.0/31"])
        self.assertEqual([s["cidr"] for s in p["subnets"]], ["10.2.0.0/31"])
        e, [p] = self._link(g, self.r1, r3)
        self.assertEqual(p["a_ips"], ["10.2.0.2/31"])
        self.assertEqual(p["b_ips"], ["10.2.0.5/31"])
        self.assertEqual(p["subnets"], [])
        self.assertEqual(e["data"]["subnets"], [])

    def test_dual_stack_lists_ipv4_first(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "2001:db8:1::1", "2001:db8:1::/64")
        self._ip(b, "2001:db8:1::2", "2001:db8:1::/64")
        self._ip(a, "10.1.0.0", "10.1.0.0/31")
        self._ip(b, "10.1.0.1", "10.1.0.0/31")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.1.0.0/31", "2001:db8:1::1/64"])
        self.assertEqual(
            [(s["cidr"], s["family"], s["a"], s["b"]) for s in p["subnets"]],
            [("10.1.0.0/31", 4, "10.1.0.0", "10.1.0.1"),
             ("2001:db8:1::/64", 6, "2001:db8:1::1", "2001:db8:1::2")],
        )
        self.assertEqual(e["data"]["subnets"], ["10.1.0.0/31", "2001:db8:1::/64"])

    def test_lag_address(self):
        # The address sits on the port-channel; both members report it.
        ae1 = self._iface(self.r1, "ae1", type="lag")
        po1 = self._iface(self.r2, "Po1", type="lag")
        self._ip(ae1, "10.3.0.0", "10.3.0.0/31")
        self._ip(po1, "10.3.0.1", "10.3.0.0/31")
        for i in range(2):
            self._cable(
                self._iface(self.r1, f"xe-0/0/{i}", lag=ae1),
                self._iface(self.r2, f"Gi1/0/{i}", lag=po1),
            )
        g = self._graph()
        self.assertEqual(len(g["edges"]), 2)
        for e in g["edges"]:
            self.assertEqual(e["data"]["subnets"], ["10.3.0.0/31"])
        names = {n["id"]: n["data"]["name"] for n in g["nodes"]}
        for e in g["edges"]:
            [p] = e["data"]["pairs"]
            [s] = p["subnets"]
            vias = {names[e["source"]]: s["a_via"], names[e["target"]]: s["b_via"]}
            self.assertEqual(vias, {"r1": "ae1", "r2": "Po1"})

    def test_port_address_wins_over_its_lag(self):
        ae1 = self._iface(self.r1, "ae1", type="lag")
        a = self._iface(self.r1, "eth0", lag=ae1)
        b = self._iface(self.r2, "eth0")
        self._ip(ae1, "10.3.0.8", "10.3.0.0/24")
        self._ip(a, "10.3.0.1", "10.3.0.0/24")
        self._ip(b, "10.3.0.2", "10.3.0.0/24")
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.3.0.1/24", "10.3.0.8/24"])
        self.assertEqual(
            [(s["a"], s["a_via"]) for s in p["subnets"]], [("10.3.0.1", None)]
        )

    def test_sub_interfaces(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth1")
        for vlan, net in ((200, "10.4.1"), (100, "10.4.0")):
            self._ip(self._iface(self.r1, f"eth0.{vlan}", parent=a),
                     f"{net}.0", f"{net}.0/31")
            self._ip(self._iface(self.r2, f"eth1.{vlan}", parent=b),
                     f"{net}.1", f"{net}.0/31")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        # The sub-interfaces in name order.
        self.assertEqual(p["a_ips"], ["10.4.0.0/31", "10.4.1.0/31"])
        self.assertEqual(
            [(s["cidr"], s["a_via"], s["b_via"]) for s in p["subnets"]],
            [("10.4.0.0/31", "eth0.100", "eth1.100"),
             ("10.4.1.0/31", "eth0.200", "eth1.200")],
        )
        self.assertEqual(e["data"]["subnets"], ["10.4.0.0/31", "10.4.1.0/31"])

    def test_lag_sub_interface(self):
        # Router on a stick over a bundle: the address is on ae1.10.
        ae1 = self._iface(self.r1, "ae1", type="lag")
        self._ip(self._iface(self.r1, "ae1.10", parent=ae1), "10.5.0.0", "10.5.0.0/31")
        a = self._iface(self.r1, "xe-0/0/0", lag=ae1)
        b = self._iface(self.r2, "eth0")
        self._ip(b, "10.5.0.1", "10.5.0.0/31")
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(
            [(s["cidr"], s["a_via"], s["b_via"]) for s in p["subnets"]],
            [("10.5.0.0/31", "ae1.10", None)],
        )

    def test_mismatched_subnets_share_nothing(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.6.0.1", "10.6.0.0/24")
        self._ip(b, "10.7.0.1", "10.7.0.0/24")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.6.0.1/24"])
        self.assertEqual(p["b_ips"], ["10.7.0.1/24"])
        self.assertEqual(p["subnets"], [])
        self.assertEqual(e["data"]["subnets"], [])

    def test_host_routes_are_skipped(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.8.0.1", "10.8.0.0/24", mask_length=32)
        self._ip(b, "10.8.0.2", "10.8.0.0/24", mask_length=32)
        self._ip(a, "2001:db8:8::1", "2001:db8:8::/64", mask_length=128)
        self._ip(b, "2001:db8:8::2", "2001:db8:8::/64", mask_length=128)
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual((p["a_ips"], p["b_ips"], p["subnets"]), ([], [], []))
        self.assertEqual(e["data"]["subnets"], [])

    def test_virtual_addresses_are_skipped(self):
        vip, _ = IPRole.objects.get_or_create(
            tenant=self.tenant, slug="vip",
            defaults={"name": "VIP", "is_virtual": True},
        )
        vip.is_virtual = True
        vip.save()
        link, _ = IPRole.objects.get_or_create(
            tenant=self.tenant, slug="p2p", defaults={"name": "P2P"}
        )
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.9.0.1", "10.9.0.0/24", role=vip)
        self._ip(b, "10.9.0.2", "10.9.0.0/24", role=link)
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], [])
        # A role that isn't virtual keeps its address.
        self.assertEqual(p["b_ips"], ["10.9.0.2/24"])
        self.assertEqual(p["subnets"], [])

    def test_identical_addresses_share_nothing(self):
        # The same address on both ends (in two VRFs) is a clash, not a link.
        from api.models import VRF

        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.10.0.1", "10.10.0.0/24")
        red = VRF.objects.create(tenant=self.tenant, name="red")
        p_red = Prefix.objects.create(
            tenant=self.tenant, cidr="10.10.0.0/24", vrf=red, site=self.site
        )
        IPAddress.objects.create(
            tenant=self.tenant, prefix=p_red, ip_address="10.10.0.1",
            assigned_interface=b,
        )
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.10.0.1/24"])
        self.assertEqual(p["b_ips"], ["10.10.0.1/24"])
        self.assertEqual(p["subnets"], [])

    def test_vrfs_are_not_compared(self):
        # PE (in a VRF) to CE (global): one subnet all the same.
        from api.models import VRF

        red = VRF.objects.create(tenant=self.tenant, name="red")
        p_red = Prefix.objects.create(
            tenant=self.tenant, cidr="10.11.0.0/31", vrf=red, site=self.site
        )
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        IPAddress.objects.create(
            tenant=self.tenant, prefix=p_red, ip_address="10.11.0.0",
            assigned_interface=a,
        )
        self._ip(b, "10.11.0.1", "10.11.0.0/31")
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual([s["cidr"] for s in p["subnets"]], ["10.11.0.0/31"])

    def test_orientation_follows_the_pair(self):
        # The cable's A end is r2 here; the pair's `a` is the edge's source
        # (the lower device id), whichever end that is.
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth9")
        self._ip(a, "10.12.0.0", "10.12.0.0/31")
        self._ip(b, "10.12.0.1", "10.12.0.0/31")
        self._cable(b, a)
        g = self._graph()
        [e] = g["edges"]
        [p] = e["data"]["pairs"]
        src_is_r1 = e["source"] == f"dev:{self.r1.id}"
        mine = ("10.12.0.0", "10.12.0.1") if src_is_r1 else ("10.12.0.1", "10.12.0.0")
        self.assertEqual(p["a_port"], "eth0" if src_is_r1 else "eth9")
        self.assertEqual(p["a_ips"], [f"{mine[0]}/31"])
        self.assertEqual(p["b_ips"], [f"{mine[1]}/31"])
        self.assertEqual((p["subnets"][0]["a"], p["subnets"][0]["b"]), mine)

    def test_non_interface_ends_have_no_addresses(self):
        # Raw mode: a panel's front port is a pair end with nothing to show.
        panel = self._device("panel")
        rear = RearPort.objects.create(device=panel, name="rear", positions=1)
        front = FrontPort.objects.create(
            device=panel, name="front1", rear_port=rear, rear_port_position=1
        )
        a = self._iface(self.r1, "eth0")
        self._ip(a, "10.13.0.0", "10.13.0.0/31")
        self._cable(a, front)
        e, [p] = self._link(self._graph(collapse_panels=False), self.r1, panel)
        self.assertEqual(p["a_ips"], ["10.13.0.0/31"])
        self.assertEqual((p["b_ips"], p["subnets"]), ([], []))
        self.assertEqual(e["data"]["subnets"], [])

    def test_truncated(self):
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        for i in range(10):
            net = f"10.14.{i}"
            self._ip(self._iface(self.r1, f"eth0.{100 + i}", parent=a),
                     f"{net}.0", f"{net}.0/31")
            self._ip(self._iface(self.r2, f"eth0.{100 + i}", parent=b),
                     f"{net}.1", f"{net}.0/31")
        self._cable(a, b)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(len(p["a_ips"]), te.LINK_IPS_MAX)
        self.assertEqual(len(p["subnets"]), te.LINK_IPS_MAX)
        self.assertTrue(p["subnets_truncated"])
        self.assertEqual(p["subnets"][0]["cidr"], "10.14.0.0/31")
        # The edge's union is the full set.
        self.assertEqual(len(e["data"]["subnets"]), 10)

    def test_another_tenants_address_never_shows(self):
        # Bad data: another tenant's IP assigned to this tenant's interface.
        other = Tenant.objects.create(org=self.org, name="B", slug="b")
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.15.0.0", "10.15.0.0/31")
        p_other = Prefix.objects.create(tenant=other, cidr="10.15.0.0/31")
        IPAddress.objects.create(
            tenant=other, prefix=p_other, ip_address="10.15.0.1",
            assigned_interface=b,
        )
        self._cable(a, b)
        _e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual((p["b_ips"], p["subnets"]), ([], []))


class PanelCollapseTests(_Base):
    """r1:eth0 - panel-a front1 (rear) - trunk - (rear) front1 panel-b -
    r2:gi1. The collapsed edge's pair ends are the two routers' ports."""

    def setUp(self):
        super().setUp()
        self._login(self._superuser())
        self.r1 = self._device("r1")
        self.r2 = self._device("r2")
        pa = self._device("panel-a")
        pb = self._device("panel-b")
        ra = RearPort.objects.create(device=pa, name="rear", positions=12)
        fa = FrontPort.objects.create(
            device=pa, name="front1", rear_port=ra, rear_port_position=1
        )
        rb = RearPort.objects.create(device=pb, name="rear", positions=12)
        fb = FrontPort.objects.create(
            device=pb, name="front1", rear_port=rb, rear_port_position=1
        )
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "gi1")
        self._ip(a, "10.20.0.0", "10.20.0.0/31")
        self._ip(b, "10.20.0.1", "10.20.0.0/31")
        self._cable(a, fa)
        self._cable(ra, rb)
        self._cable(fb, b)

    def test_collapsed_run_labels_its_end_ports(self):
        g = self._graph()
        e, [p] = self._link(g, self.r1, self.r2)
        self.assertEqual(set(e["data"]["via"]), {"panel-a", "panel-b"})
        self.assertEqual((p["a_port"], p["b_port"]), ("eth0", "gi1"))
        self.assertEqual(p["a_ips"], ["10.20.0.0/31"])
        self.assertEqual(p["b_ips"], ["10.20.0.1/31"])
        self.assertEqual(e["data"]["subnets"], ["10.20.0.0/31"])


class ScopeTests(_Base):
    """Addresses pass the caller's ipaddress.view scope."""

    def setUp(self):
        super().setUp()
        self.site_b = Site.objects.create(tenant=self.tenant, name="dc-2")
        self.r1 = self._device("r1")
        self.r2 = self._device("r2")
        a = self._iface(self.r1, "eth0")
        b = self._iface(self.r2, "eth0")
        self._ip(a, "10.30.0.0", "10.30.0.0/31")
        self._ip(b, "10.30.0.1", "10.30.0.0/31", site=self.site_b)
        self._cable(a, b)
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )
        self._grant("device")
        self._login(self.user)

    def _grant(self, obj_type, site=None):
        perm = ObjectPermission.objects.create(
            name=f"{obj_type}-view", object_types=[obj_type], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        if site is not None:
            perm.sites.add(site)

    def test_no_ip_grant_adds_nothing_and_queries_nothing(self):
        counted = []
        real = te.enrich_link_ips

        def spy(ctx):
            with CaptureQueriesContext(connection) as q:
                real(ctx)
            counted.append(len(q.captured_queries))

        with mock.patch.object(te, "enrich_link_ips", side_effect=spy):
            g = self._graph()
        self.assertEqual(counted, [0])
        e = g["edges"][0]["data"]
        self.assertNotIn("subnets", e)
        self.assertNotIn("a_ips", e["pairs"][0])
        self.assertNotIn("subnets", e["pairs"][0])

    def test_one_end_hidden_shares_nothing(self):
        self._grant("ipaddress", site=self.site)
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["a_ips"], ["10.30.0.0/31"])
        self.assertEqual((p["b_ips"], p["subnets"]), ([], []))
        self.assertEqual(e["data"]["subnets"], [])

    def test_unscoped_ip_grant(self):
        self._grant("ipaddress")
        e, [p] = self._link(self._graph(), self.r1, self.r2)
        self.assertEqual(p["b_ips"], ["10.30.0.1/31"])
        self.assertEqual(e["data"]["subnets"], ["10.30.0.0/31"])


class CostTests(_Base):
    def setUp(self):
        super().setUp()
        self._login(self._superuser())
        self._n = 0

    def _add(self, count):
        """``count`` more links: each a LAG member on one side with its
        address on a sub-interface of the bundle, a plain port on the
        other."""
        for _ in range(count):
            i = self._n
            self._n += 1
            r1 = self._device(f"a{i}")
            r2 = self._device(f"b{i}")
            ae1 = self._iface(r1, "ae1", type="lag")
            sub = self._iface(r1, "ae1.10", parent=ae1)
            a = self._iface(r1, "xe-0/0/0", lag=ae1)
            b = self._iface(r2, "eth0")
            net = f"10.{40 + i // 100}.{i % 100}"
            self._ip(sub, f"{net}.0", f"{net}.0/31")
            self._ip(b, f"{net}.1", f"{net}.0/31")
            self._cable(a, b)

    def _measure(self):
        counted = []
        real = te.enrich_link_ips

        def spy(ctx):
            with CaptureQueriesContext(connection) as q:
                real(ctx)
            counted.append(len(q.captured_queries))

        with mock.patch.object(te, "enrich_link_ips", side_effect=spy):
            g = self._graph()
        self.assertEqual(len(counted), 1)
        return counted[0], g

    def test_cost_is_flat_in_the_cable_count(self):
        self._add(3)
        small, g = self._measure()
        self.assertEqual(len(g["edges"]), 3)
        self._add(27)
        large, g = self._measure()
        self.assertEqual(len(g["edges"]), 30)
        self.assertEqual(small, large)
        self.assertLessEqual(large, 2)
        self.assertTrue(all(e["data"]["subnets"] for e in g["edges"]))

    def test_no_interface_ends_query_nothing(self):
        panel = self._device("panel")
        rear = RearPort.objects.create(device=panel, name="rear", positions=1)
        front = FrontPort.objects.create(
            device=panel, name="front1", rear_port=rear, rear_port_position=1
        )
        other = self._device("panel-2")
        rear2 = RearPort.objects.create(device=other, name="rear", positions=1)
        self._cable(front, rear2)
        counted = []
        real = te.enrich_link_ips

        def spy(ctx):
            with CaptureQueriesContext(connection) as q:
                real(ctx)
            counted.append(len(q.captured_queries))

        with mock.patch.object(te, "enrich_link_ips", side_effect=spy):
            g = self._graph(collapse_panels=False)
        self.assertEqual(counted, [0])
        self.assertEqual(g["edges"][0]["data"]["subnets"], [])
