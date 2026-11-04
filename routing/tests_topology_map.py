"""The Routing tab's payload (``/api/topology/routing/``): routers with their
router ID, ASNs and loopback, AS groups, eBGP and iBGP lines (a route
reflector's toward its client) with the sessions' panel rows, circuits and
cables as layers - per-layer grants, the tenant fence and a flat query
count."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import (
    ASN,
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Device,
    DeviceRole,
    Interface,
    IPAddress,
    Prefix,
    Provider,
    ProviderNetwork,
    Site,
    VirtualMachine,
)
from api.status_registry import seed_builtin_statuses
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    BFDProfile,
    BGPInstance,
    BGPNeighborAF,
    BGPPeerGroup,
    BGPSession,
    OSPFInstance,
    RoutingPolicy,
    RPKICache,
)

User = get_user_model()
URL = "/api/topology/routing/"


def _tenant(slug):
    org = Organization.objects.create(name=slug, slug=slug)
    t = Tenant.objects.create(org=org, name=slug, slug=slug)
    seed_builtin_statuses(t)
    return t


class _Base(APITestCase):
    def setUp(self):
        self.t = _tenant("acme")
        self.ams = Site.objects.create(tenant=self.t, name="AMS")
        self.lon = Site.objects.create(tenant=self.t, name="LON")
        self.role = DeviceRole.objects.create(
            tenant=self.t, name="Router", slug="router", color="0ea5e9"
        )
        self.as1 = ASN.objects.create(tenant=self.t, asn=65001, description="Core\nmore")
        self.as2 = ASN.objects.create(tenant=self.t, asn=65050)
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def _dev(self, name, site=None):
        return Device.objects.create(
            tenant=self.t, name=name, site=site or self.ams, role=self.role
        )

    def _bgp(self, dev, asn, router_id="", vrf=None, **kw):
        return BGPInstance.objects.create(
            tenant=self.t, device=dev, asn=asn, router_id=router_id, vrf=vrf, **kw
        )

    def _session(self, inst, peer, remote_asn, address, **kw):
        return BGPSession.objects.create(
            tenant=self.t, instance=inst, peer_device=peer, remote_asn=remote_asn,
            remote_address=address, **kw,
        )

    def _get(self, qs=""):
        r = self.client.get(f"{URL}?{qs}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    @staticmethod
    def _node(g, dev):
        return next(n for n in g["nodes"] if n["id"] == f"dev:{dev.id}")

    @staticmethod
    def _edges(g, kind):
        return [e for e in g["edges"] if e["type"] == kind]


class PayloadTests(_Base):
    def setUp(self):
        super().setUp()
        self.r1 = self._dev("r1")
        self.r2 = self._dev("r2")
        self.rr = self._dev("rr1")
        self.isp = self._dev("isp-edge", self.lon)
        self.i1 = self._bgp(self.r1, self.as1, "10.255.0.1")
        self.i2 = self._bgp(self.r2, self.as1, "10.255.0.2")
        self.irr = self._bgp(self.rr, self.as1, "10.255.0.9", cluster_id="1.1.1.1")
        self.policy_in = RoutingPolicy.objects.create(tenant=self.t, name="IN")
        self.policy_out = RoutingPolicy.objects.create(tenant=self.t, name="OUT")
        self.bfd = BFDProfile.objects.create(tenant=self.t, name="fast")
        self.rpki = RPKICache.objects.create(tenant=self.t, name="rpki1", address="10.0.0.65")
        self.i1.rpki_caches.add(self.rpki)
        self.group = BGPPeerGroup.objects.create(
            tenant=self.t, name="UPSTREAM", import_policy=self.policy_in,
            keepalive=10, hold_time=30,
        )
        # eBGP r1 -> isp, both sides; the isp end has no process of its own.
        self.e1 = self._session(
            self.i1, self.isp, 65050, "192.0.2.1", peer_group=self.group,
            export_policy=self.policy_out, maximum_prefix=1000, bfd=True,
            bfd_profile=self.bfd, address_families=["ipv4-unicast"],
        )
        BGPNeighborAF.objects.filter(session=self.e1).update(
            import_policy=self.policy_in
        )
        # iBGP: rr1 reflects to r1 and r2.
        self._session(self.irr, self.r1, 65001, "10.255.0.1",
                      route_reflector_client=True, address_families=["vpnv4-unicast"])
        self._session(self.i1, self.rr, 65001, "10.255.0.9")
        self._session(self.irr, self.r2, 65001, "10.255.0.2",
                      route_reflector_client=True)
        OSPFInstance.objects.create(tenant=self.t, device=self.r2, process_id="1")

    def test_routers_carry_router_id_asns_and_loopback(self):
        lo = Interface.objects.create(device=self.r1, name="Loopback0")
        prefix = Prefix.objects.create(tenant=self.t, cidr="10.255.0.0/24")
        IPAddress.objects.create(
            tenant=self.t, ip_address="10.255.0.1", prefix=prefix,
            assigned_device=self.r1, assigned_interface=lo,
        )
        g = self._get()
        n = self._node(g, self.r1)
        self.assertEqual(n["type"], "router")
        d = n["data"]
        self.assertTrue(d["router"])
        self.assertEqual(d["router_id"], "10.255.0.1")
        self.assertEqual(d["asns"], [{"asn": 65001, "vrf": None}])
        self.assertEqual(d["as_group"], 65001)
        self.assertEqual(d["loopback"], "10.255.0.1")
        self.assertEqual(d["role"]["color"], "0ea5e9")
        kinds = [p["kind"] for p in self._node(g, self.r2)["data"]["instances"]]
        self.assertEqual(kinds, ["bgp", "ospf"])

    def test_a_peer_with_no_process_sits_in_the_as_its_peers_name(self):
        g = self._get()
        d = self._node(g, self.isp)["data"]
        self.assertFalse(d["router"])
        self.assertEqual(d["as_group"], 65050)
        groups = {a["asn"]: a for a in g["as_groups"]}
        self.assertEqual(set(groups), {65001, 65050})
        self.assertEqual(groups[65001]["name"], "Core")
        self.assertEqual(groups[65001]["asn_id"], str(self.as1.id))
        self.assertEqual(
            set(groups[65001]["nodes"]),
            {f"dev:{x.id}" for x in (self.r1, self.r2, self.rr)},
        )

    def test_ebgp_line_with_its_session_panel(self):
        g = self._get()
        [e] = self._edges(g, "ebgp")
        self.assertEqual({e["source"], e["target"]}, {f"dev:{self.r1.id}", f"dev:{self.isp.id}"})
        d = e["data"]
        self.assertEqual(d["kind"], "ebgp")
        self.assertEqual(d["address_families"], ["ipv4-unicast"])
        self.assertEqual(sorted(d["pairs"][0].values()), ["AS65001", "AS65050"])
        self.assertTrue(d["one_sided"])
        [s] = d["sessions"]
        self.assertEqual(s["id"], str(self.e1.id))
        self.assertEqual(s["peer_group"]["name"], "UPSTREAM")
        self.assertEqual(s["import_policy"]["name"], "IN")  # from the group
        self.assertEqual(s["export_policy"]["name"], "OUT")
        self.assertEqual(s["maximum_prefix"], 1000)
        self.assertTrue(s["bfd"])
        self.assertEqual(s["bfd_profile"]["name"], "fast")
        self.assertEqual((s["keepalive"], s["hold_time"]), (10, 30))
        self.assertEqual(s["rpki_caches"], [{"id": str(self.rpki.id), "name": "rpki1"}])
        [af] = s["address_families"]
        self.assertEqual(af["afi_safi"], "ipv4-unicast")
        self.assertEqual(af["import_policy"]["name"], "IN")

    def test_ibgp_runs_from_the_route_reflector_to_its_client(self):
        g = self._get()
        lines = self._edges(g, "ibgp")
        self.assertEqual(len(lines), 2)
        rr = f"dev:{self.rr.id}"
        for e in lines:
            self.assertEqual(e["source"], rr)
            self.assertEqual(e["data"]["rr"]["reflector"], rr)
            self.assertEqual(e["data"]["rr"]["client"], e["target"])
            self.assertEqual(e["data"]["rr"]["cluster_id"], "1.1.1.1")
        to_r1 = next(e for e in lines if e["target"] == f"dev:{self.r1.id}")
        # Both directions of the session fold into one line.
        self.assertEqual(len(to_r1["data"]["sessions"]), 2)
        self.assertFalse(to_r1["data"]["one_sided"])

    def test_layers_and_site_filter(self):
        g = self._get("layers=ibgp")
        self.assertEqual({e["type"] for e in g["edges"]}, {"ibgp"})
        self.assertEqual(g["meta"]["requested"], ["ibgp"])
        self.assertEqual(self.client.get(f"{URL}?layers=bogus").status_code, 400)
        # The isp edge is in LON: filtered to AMS, its line goes with it.
        g = self._get(f"site={self.ams.id}")
        self.assertFalse(self._edges(g, "ebgp"))
        self.assertNotIn(f"dev:{self.isp.id}", {n["id"] for n in g["nodes"]})

    def test_focus_follows_bgp_hops(self):
        g = self._get(f"device={self.isp.id}")
        self.assertEqual(
            {n["id"] for n in g["nodes"]}, {f"dev:{self.isp.id}", f"dev:{self.r1.id}"}
        )
        g = self._get(f"device={self.isp.id}&depth=2")
        self.assertIn(f"dev:{self.rr.id}", {n["id"] for n in g["nodes"]})

    def test_hand_picked_set(self):
        g = self._get(f"devices={self.r1.id},{self.rr.id}")
        self.assertEqual(
            {n["id"] for n in g["nodes"]}, {f"dev:{self.r1.id}", f"dev:{self.rr.id}"}
        )
        self.assertEqual(len(self._edges(g, "ibgp")), 1)
        r = self.client.post(URL, {"devices": [str(self.r1.id)]}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([n["id"] for n in r.json()["nodes"]], [f"dev:{self.r1.id}"])

    def test_cables_layer_folds_a_pair(self):
        a = Interface.objects.create(device=self.r1, name="e1")
        b = Interface.objects.create(device=self.r2, name="e1")
        cab = Cable.objects.create(tenant=self.t)
        CableTermination.objects.create(cable=cab, end="A", interface=a)
        CableTermination.objects.create(cable=cab, end="B", interface=b)
        self.assertFalse(self._edges(self._get(), "cable"))
        [e] = self._edges(self._get("layers=cables"), "cable")
        self.assertEqual(e["data"]["cables"][0]["id"], str(cab.id))

    def test_circuits_layer_draws_the_provider_network(self):
        provider = Provider.objects.create(tenant=self.t, name="Telco", slug="telco")
        net = ProviderNetwork.objects.create(tenant=self.t, provider=provider, name="MPLS")
        c = Circuit.objects.create(tenant=self.t, provider=provider, cid="C-1")
        a = CircuitTermination.objects.create(circuit=c, term_side="A", site=self.ams)
        CircuitTermination.objects.create(circuit=c, term_side="Z", provider_network=net)
        up = Interface.objects.create(device=self.r1, name="wan0")
        cab = Cable.objects.create(tenant=self.t)
        CableTermination.objects.create(cable=cab, end="A", interface=up)
        CableTermination.objects.create(cable=cab, end="B", circuit_termination=a)
        g = self._get()
        self.assertIn(f"pn:{net.id}", {n["id"] for n in g["nodes"]})
        [e] = self._edges(g, "circuit")
        self.assertEqual(e["source"], f"dev:{self.r1.id}")
        self.assertFalse(self._edges(self._get("layers=ebgp"), "circuit"))

    def test_a_circuit_cabled_to_two_routers_is_a_line_between_them(self):
        # A circuit cabled at both ends used to 500 the payload: the circuit
        # layer's cards had no id for the site-to-site edge.
        provider = Provider.objects.create(tenant=self.t, name="Telco", slug="telco")
        cph = Site.objects.create(tenant=self.t, name="CPH")
        c = Circuit.objects.create(tenant=self.t, provider=provider, cid="PNI-1")
        a = CircuitTermination.objects.create(circuit=c, term_side="A", site=self.ams)
        z = CircuitTermination.objects.create(circuit=c, term_side="Z", site=cph)
        for dev, term in ((self.r1, a), (self.r2, z)):
            port = Interface.objects.create(device=dev, name="wan0")
            cab = Cable.objects.create(tenant=self.t)
            CableTermination.objects.create(cable=cab, end="A", interface=port)
            CableTermination.objects.create(cable=cab, end="B", circuit_termination=term)
        g = self._get()
        [e] = self._edges(g, "circuit")
        self.assertEqual(e["id"], f"cc:{c.id}")
        self.assertEqual({e["source"], e["target"]},
                         {f"dev:{self.r1.id}", f"dev:{self.r2.id}"})
        self.assertLessEqual({e["source"], e["target"]}, {n["id"] for n in g["nodes"]})

    def test_a_vm_router_is_a_card(self):
        from api.models import Cluster, ClusterType

        ct = ClusterType.objects.create(tenant=self.t, name="KVM", slug="kvm")
        cl = Cluster.objects.create(tenant=self.t, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.t, name="vrouter", cluster=cl,
                                           site=self.ams)
        BGPInstance.objects.create(tenant=self.t, virtual_machine=vm, asn=self.as1)
        g = self._get()
        n = next(n for n in g["nodes"] if n["id"] == f"vm:{vm.id}")
        self.assertEqual(n["data"]["kind"], "vm")
        self.assertEqual(n["data"]["as_group"], 65001)
        # A location filter leaves VMs out: they have none.
        self.assertNotIn(f"vm:{vm.id}", {n["id"] for n in self._get(
            f"devices={self.r1.id}")["nodes"]})


class QueryCountTests(_Base):
    def _ring(self, n, start):
        devs = [self._dev(f"q{start + i}") for i in range(n)]
        insts = [self._bgp(d, self.as1, f"10.0.0.{start + i}") for i, d in enumerate(devs)]
        for i, inst in enumerate(insts):
            peer = devs[(i + 1) % n]
            self._session(inst, peer, 65001, f"10.0.0.{start + (i + 1) % n}",
                          export_policy=RoutingPolicy.objects.get_or_create(
                              tenant=self.t, name="P")[0])
        return devs

    def _count(self, qs=""):
        with CaptureQueriesContext(connection) as ctx:
            self._get(qs)
        return len(ctx.captured_queries)

    def test_flat_whatever_the_size(self):
        self._ring(3, 1)
        small = self._count("layers=ebgp,ibgp,circuits,cables")
        self._ring(8, 20)
        big = self._count("layers=ebgp,ibgp,circuits,cables")
        self.assertEqual(small, big)
        self.assertLess(big, 40)


class AccessTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = self._dev("a1")
        self.b = self._dev("b1", self.lon)
        ia = self._bgp(self.a, self.as1, "1.1.1.1")
        ib = self._bgp(self.b, self.as2, "2.2.2.2")
        self._session(ia, self.b, 65050, "10.0.0.2")
        self._session(ib, self.a, 65001, "10.0.0.1")
        self.user = User.objects.create_user("viewer")
        UserProfile.objects.create(user=self.user).tenants.add(self.t)
        self._login(self.user)

    def _grant(self, types, site=None):
        perm = ObjectPermission.objects.create(
            name="-".join(types), object_types=types, actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.t)
        if site is not None:
            perm.sites.add(site)

    def test_no_device_view_is_a_403(self):
        self.assertEqual(self.client.get(URL).status_code, 403)

    def test_a_missing_bgpsession_grant_hides_the_layer_not_the_map(self):
        self._grant(["device", "bgpinstance"])
        g = self._get()
        self.assertEqual(len(g["nodes"]), 2)
        self.assertEqual(g["edges"], [])
        self.assertFalse(g["meta"]["layers"]["ebgp"])
        self.assertTrue(g["meta"]["layers"]["cables"])
        self.assertEqual(self._node(g, self.a)["data"]["router_id"], "1.1.1.1")

    def test_processes_need_their_own_grant(self):
        self._grant(["device"])
        g = self._get()
        # No process the caller may see: nothing on the map is a router.
        self.assertEqual(g["nodes"], [])

    def test_a_site_scoped_viewer_never_sees_the_far_end(self):
        self._grant(["device", "bgpinstance", "bgpsession"], site=self.ams)
        g = self._get()
        self.assertEqual([n["id"] for n in g["nodes"]], [f"dev:{self.a.id}"])
        self.assertEqual(g["edges"], [])

    def test_catalog_names_need_their_grant(self):
        self._grant(["device", "bgpinstance", "bgpsession"])
        policy = RoutingPolicy.objects.create(tenant=self.t, name="SECRET")
        BGPSession.objects.filter(instance__device=self.a).update(import_policy=policy)
        g = self._get()
        [e] = self._edges(g, "ebgp")
        row = next(s for s in e["data"]["sessions"] if s["node"] == f"dev:{self.a.id}")
        self.assertIsNone(row["import_policy"])
        self.assertNotIn("SECRET", str(g))


class TenantFenceTests(_Base):
    def test_another_tenants_routers_never_show(self):
        other = _tenant("other")
        asn = ASN.objects.create(tenant=other, asn=65001)
        dev = Device.objects.create(tenant=other, name="theirs")
        BGPInstance.objects.create(tenant=other, device=dev, asn=asn)
        mine = self._dev("mine")
        self._bgp(mine, self.as1)
        g = self._get()
        self.assertEqual([n["id"] for n in g["nodes"]], [f"dev:{mine.id}"])
        r = self.client.get(f"{URL}?devices={dev.id}")
        self.assertEqual(r.json()["nodes"], [])


class SavedViewKeysTests(_Base):
    def _save(self, state):
        return self.client.post("/api/topology-views/", {"name": "v", "state": state},
                                format="json")

    def test_routing_keys_are_validated(self):
        ok = self._save({
            "filters": {"viewStyle": "routing", "routing": {
                "mode": "detailed", "layers": {"ebgp": True, "cables": False},
                "fields": ["router_id", "asn", "loopback"],
            }},
            "positions_by_style": {"routing": {"dev:x": [1, 2]}},
            "zones_by_style": {"routing": [{
                "id": "z1", "label": "AS65001", "x": 0, "y": 0, "w": 400, "h": 300,
                "color": "#0EA5E9", "asn": 65001,
            }]},
        })
        self.assertEqual(ok.status_code, 201, ok.content)
        zone = ok.json()["state"]["zones_by_style"]["routing"][0]
        self.assertEqual(zone["color"], "#0ea5e9")
        for bad in (
            {"filters": {"routing": {"mode": "photo"}}},
            {"filters": {"routing": {"layers": {"ospf-ish": True}}}},
            {"filters": {"routing": {"layers": {"ebgp": "yes"}}}},
            {"filters": {"routing": {"fields": ["serial"]}}},
            {"filters": {"routing": []}},
            {"zones_by_style": {"routing": [{"id": "z", "kind": "band"}]}},
            {"zones_by_style": {"routing": [{"id": "z", "asn": 0}]}},
            {"zones_by_style": {"routing": [{"id": "z", "x": "far"}]}},
        ):
            with self.subTest(state=bad):
                r = self._save(bad)
                self.assertEqual(r.status_code, 400, r.content)
