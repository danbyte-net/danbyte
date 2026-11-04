"""The Routing tab's OSPF, IS-IS and static layers, the VRF picker and the
Checks: adjacencies over a cable (through a patch panel) or a shared subnet,
static next hops resolved per table, the per-layer grants, the tenant fence
and a flat query count."""
from __future__ import annotations

from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import (
    VRF,
    Cable,
    CableTermination,
    Device,
    FrontPort,
    Interface,
    IPAddress,
    Prefix,
    RearPort,
)
from auth_api.models import ObjectPermission, UserProfile

from .models import (
    BFDProfile,
    BGPInstance,
    ISISInstance,
    ISISInterface,
    OSPFArea,
    OSPFInstance,
    OSPFInterface,
    RoutingKeychain,
    StaticRoute,
)
from .tests_topology_map import URL, User, _Base, _tenant


class _IGPBase(_Base):
    def setUp(self):
        super().setUp()
        self.area0 = OSPFArea.objects.create(tenant=self.t, name="backbone", area_id="0")
        self.area1 = OSPFArea.objects.create(tenant=self.t, name="edge", area_id="1")
        self._nets = {}

    def _port(self, dev, name, mtu=None):
        return Interface.objects.create(device=dev, name=name, mtu=mtu)

    def _cable(self, a, b):
        cab = Cable.objects.create(tenant=self.t)
        kind_a = "front_port" if isinstance(a, FrontPort) else (
            "rear_port" if isinstance(a, RearPort) else "interface")
        kind_b = "front_port" if isinstance(b, FrontPort) else (
            "rear_port" if isinstance(b, RearPort) else "interface")
        CableTermination.objects.create(cable=cab, end="A", **{kind_a: a})
        CableTermination.objects.create(cable=cab, end="B", **{kind_b: b})
        return cab

    def _ip(self, port, address, cidr, vrf=None):
        key = (cidr, vrf.id if vrf else None)
        if key not in self._nets:
            self._nets[key] = Prefix.objects.create(tenant=self.t, cidr=cidr, vrf=vrf)
        return IPAddress.objects.create(
            tenant=self.t, ip_address=address, prefix=self._nets[key],
            assigned_device=port.device, assigned_interface=port,
        )

    def _ospf(self, dev, vrf=None, version=2):
        return OSPFInstance.objects.create(tenant=self.t, device=dev, process_id="1",
                                           vrf=vrf, version=version)

    def _isis(self, dev, level="1-2"):
        return ISISInstance.objects.create(
            tenant=self.t, device=dev, process="core", level=level,
            net=f"49.0001.0000.0000.000{Device.objects.count() % 10}.00",
        )


class OSPFTests(_IGPBase):
    def setUp(self):
        super().setUp()
        self.r1, self.r2, self.r3 = (self._dev(n) for n in ("r1", "r2", "r3"))
        self.o1, self.o2, self.o3 = (self._ospf(d) for d in (self.r1, self.r2, self.r3))

    def _iface(self, inst, port, area=None, **kw):
        return OSPFInterface.objects.create(instance=inst, interface=port,
                                            area=area or self.area0, **kw)

    def test_cabled_adjacency_with_costs_each_way(self):
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        cab = self._cable(a, b)
        kc = RoutingKeychain.objects.create(tenant=self.t, name="OSPF-KEYS")
        bfd = BFDProfile.objects.create(tenant=self.t, name="fast")
        self._iface(self.o1, a, cost=10, bfd=True, bfd_profile=bfd,
                    authentication="md5", keychain=kc, passive=False)
        self._iface(self.o2, b, cost=20, network_type="point-to-point")
        [e] = self._edges(self._get(), "ospf")
        self.assertEqual({e["source"], e["target"]},
                         {f"dev:{self.r1.id}", f"dev:{self.r2.id}"})
        d = e["data"]
        self.assertEqual(d["area"], "0")
        self.assertEqual(d["version"], 2)
        r1_first = e["source"] == f"dev:{self.r1.id}"
        self.assertEqual(d["cost"], [10, 20] if r1_first else [20, 10])
        [link] = d["links"]
        self.assertEqual(link["via"], "cable")
        self.assertEqual(link["cable_id"], str(cab.id))
        end = link["a"] if r1_first else link["b"]
        self.assertEqual(end["interface"], "e1")
        self.assertTrue(end["bfd"])
        self.assertEqual(end["bfd_profile"]["name"], "fast")
        self.assertEqual(end["authentication"], "md5")
        self.assertEqual(end["keychain"], {"id": str(kc.id), "name": "OSPF-KEYS"})
        self.assertEqual(end["area_ref"]["name"], "backbone")
        self.assertEqual(d["problems"], [])

    def test_through_a_patch_panel(self):
        panel = Device.objects.create(tenant=self.t, name="pp1", site=self.ams)
        rear = RearPort.objects.create(device=panel, name="R1", positions=1)
        front = FrontPort.objects.create(device=panel, name="F1", rear_port=rear,
                                         rear_port_position=1)
        a, b = self._port(self.r1, "e2"), self._port(self.r2, "e2")
        self._cable(a, front)
        self._cable(rear, b)
        self._iface(self.o1, a)
        self._iface(self.o2, b)
        [e] = self._edges(self._get(), "ospf")
        self.assertEqual(e["data"]["links"][0]["via"], "cable")

    def test_falls_back_to_a_shared_subnet(self):
        a, c = self._port(self.r1, "e3"), self._port(self.r3, "e3")
        self._ip(a, "10.0.0.1", "10.0.0.0/30")
        self._ip(c, "10.0.0.2", "10.0.0.0/30")
        self._iface(self.o1, a)
        self._iface(self.o3, c)
        # A third router's port in another subnet stays out.
        b = self._port(self.r2, "e3")
        self._ip(b, "10.0.1.1", "10.0.1.0/30")
        self._iface(self.o2, b)
        [e] = self._edges(self._get(), "ospf")
        self.assertEqual({e["source"], e["target"]},
                         {f"dev:{self.r1.id}", f"dev:{self.r3.id}"})
        [link] = e["data"]["links"]
        self.assertEqual((link["via"], link["subnet"]), ("subnet", "10.0.0.0/30"))

    def test_a_cable_wins_over_the_subnet(self):
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        self._ip(a, "10.0.0.1", "10.0.0.0/30")
        self._ip(b, "10.0.0.2", "10.0.0.0/30")
        self._iface(self.o1, a)
        self._iface(self.o2, b)
        [e] = self._edges(self._get(), "ospf")
        self.assertEqual([x["via"] for x in e["data"]["links"]], ["cable"])

    def test_one_line_per_pair_and_area(self):
        for i, area in enumerate((self.area0, self.area0, self.area1)):
            a, b = self._port(self.r1, f"p{i}"), self._port(self.r2, f"p{i}")
            self._cable(a, b)
            self._iface(self.o1, a, area=area)
            self._iface(self.o2, b, area=area)
        lines = self._edges(self._get(), "ospf")
        self.assertEqual(sorted(e["data"]["area"] for e in lines), ["0", "1"])
        both = next(e for e in lines if e["data"]["area"] == "0")
        self.assertEqual(len(both["data"]["links"]), 2)

    def test_checks_area_timers_and_mtu(self):
        a, b = self._port(self.r1, "e1", mtu=1500), self._port(self.r2, "e1", mtu=9000)
        self._cable(a, b)
        self._iface(self.o1, a, area=self.area0, hello=10, dead=40)
        self._iface(self.o2, b, area=self.area1, hello=5, dead=40)
        g = self._get()
        [e] = self._edges(g, "ospf")
        self.assertIsNone(e["data"]["area"])
        self.assertEqual(sorted(e["data"]["areas"]), ["0", "1"])
        self.assertEqual(e["data"]["problems"], ["ospf_area", "ospf_timers", "ospf_mtu"])
        kinds = [c["kind"] for c in g["checks"]]
        self.assertEqual(kinds, ["ospf_area", "ospf_timers", "ospf_mtu"])
        self.assertTrue(all(c["edge"] == e["id"] for c in g["checks"]))
        # mtu-ignore on one end silences the MTU check.
        OSPFInterface.objects.filter(interface=a).update(mtu_ignore=True)
        self.assertNotIn("ospf_mtu", self._edges(self._get(), "ospf")[0]["data"]["problems"])

    def test_versions_and_tables_never_pair(self):
        red = VRF.objects.create(tenant=self.t, name="red")
        other = self._ospf(self.r2, vrf=red)
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        self._iface(self.o1, a)
        self._iface(other, b)
        self.assertFalse(self._edges(self._get("vrf=all"), "ospf"))

    def test_vrf_picker(self):
        red = VRF.objects.create(tenant=self.t, name="red")
        r1red, r2red = self._ospf(self.r1, vrf=red), self._ospf(self.r2, vrf=red)
        a, b = self._port(self.r1, "e5"), self._port(self.r2, "e5")
        self._cable(a, b)
        self._iface(r1red, a)
        self._iface(r2red, b)
        c, d = self._port(self.r1, "e6"), self._port(self.r2, "e6")
        self._cable(c, d)
        self._iface(self.o1, c)
        self._iface(self.o2, d)
        g = self._get()
        self.assertEqual(g["meta"]["vrf"], "global")
        self.assertEqual(g["meta"]["vrfs"],
                         [{"id": str(red.id), "name": "red", "color": None}])
        self.assertEqual([e["data"]["vrf"] for e in self._edges(g, "ospf")], [None])
        g = self._get(f"vrf={red.id}")
        self.assertEqual([e["data"]["vrf"] for e in self._edges(g, "ospf")], ["red"])
        self.assertEqual(len(self._edges(self._get("vrf=all"), "ospf")), 2)
        self.assertEqual(self.client.get(f"{URL}?vrf=nope").status_code, 400)
        r = self.client.post(URL, {"vrf": str(red.id)}, format="json")
        self.assertEqual([e["data"]["vrf"] for e in r.json()["edges"]
                          if e["type"] == "ospf"], ["red"])

    def test_focus_follows_igp_hops(self):
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        self._iface(self.o1, a)
        self._iface(self.o2, b)
        g = self._get(f"device={self.r1.id}")
        self.assertEqual({n["id"] for n in g["nodes"]},
                         {f"dev:{self.r1.id}", f"dev:{self.r2.id}"})


class ISISTests(_IGPBase):
    def setUp(self):
        super().setUp()
        self.r1, self.r2 = self._dev("r1"), self._dev("r2")
        self.i1, self.i2 = self._isis(self.r1), self._isis(self.r2, level="2")

    def test_level_and_metric(self):
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        ISISInterface.objects.create(instance=self.i1, interface=a, metric=10)
        ISISInterface.objects.create(instance=self.i2, interface=b, metric=10)
        g = self._get()
        [e] = self._edges(g, "isis")
        self.assertEqual(e["data"]["level"], "2")
        self.assertEqual(e["data"]["metric"], [10, 10])
        self.assertEqual(g["checks"], [])

    def test_level_mismatch_across_a_cable(self):
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        ISISInterface.objects.create(instance=self.i1, interface=a, level="1")
        ISISInterface.objects.create(instance=self.i2, interface=b)
        g = self._get()
        [e] = self._edges(g, "isis")
        self.assertIsNone(e["data"]["level"])
        self.assertEqual([c["kind"] for c in g["checks"]], ["isis_level"])

    def test_subnet_fallback(self):
        a, b = self._port(self.r1, "e2"), self._port(self.r2, "e2")
        self._ip(a, "2001:db8::1", "2001:db8::/64")
        self._ip(b, "2001:db8::2", "2001:db8::/64")
        ISISInterface.objects.create(instance=self.i1, interface=a)
        ISISInterface.objects.create(instance=self.i2, interface=b)
        [e] = self._edges(self._get(), "isis")
        self.assertEqual(e["data"]["links"][0]["subnet"], "2001:db8::/64")
        # A mismatch by subnet only is not a cable's: no check.
        ISISInterface.objects.filter(interface=a).update(level="1")
        self.assertEqual(self._get()["checks"], [])


class StaticTests(_IGPBase):
    def setUp(self):
        super().setUp()
        self.r1, self.r2 = self._dev("r1"), self._dev("r2")
        self.red = VRF.objects.create(tenant=self.t, name="red")
        p = self._port(self.r2, "e1")
        self._ip(p, "10.0.0.2", "10.0.0.0/30")
        q = self._port(self.r2, "e2")
        self._ip(q, "10.9.9.2", "10.9.9.0/30", vrf=self.red)

    def _route(self, prefix, hop, **kw):
        return StaticRoute.objects.create(tenant=self.t, device=self.r1, prefix=prefix,
                                          next_hop=hop, **kw)

    def test_routes_to_a_next_hop_router(self):
        for i in range(30):
            self._route(f"10.{100 + i}.0.0/16", "10.0.0.2")
        self._route("192.0.2.0/24", "203.0.113.1")  # off the map
        g = self._get()
        [e] = self._edges(g, "static")
        self.assertEqual((e["source"], e["target"]),
                         (f"dev:{self.r1.id}", f"dev:{self.r2.id}"))
        self.assertEqual(e["data"]["count"], 30)
        self.assertEqual(len(e["data"]["routes"]), 25)
        self.assertIsNone(e["data"]["vrf"])

    def test_next_hops_are_looked_up_per_table(self):
        # In red, 10.0.0.2 is nobody; 10.9.9.2 is r2.
        self._route("10.1.0.0/16", "10.0.0.2", vrf=self.red)
        self._route("10.2.0.0/16", "10.9.9.2", vrf=self.red)
        self.assertFalse(self._edges(self._get(), "static"))
        [e] = self._edges(self._get(f"vrf={self.red.id}"), "static")
        self.assertEqual([r["prefix"] for r in e["data"]["routes"]], ["10.2.0.0/16"])
        self.assertEqual(e["data"]["vrf"], "red")

    def test_route_leak_to_the_global_table(self):
        self._route("10.4.0.0/16", "10.9.9.2", next_hop_vrf=self.red)
        [e] = self._edges(self._get(), "static")
        self.assertEqual(e["data"]["count"], 1)


class BGPChecksAndVrfTests(_IGPBase):
    def test_one_sided_and_as_mismatch(self):
        a, b = self._dev("a"), self._dev("b")
        ia, ib = self._bgp(a, self.as1), self._bgp(b, self.as2)
        self._session(ia, b, 65099, "10.0.0.2")  # b is AS65050
        self._session(ib, a, 65001, "10.0.0.1")
        c = self._dev("c")
        self._bgp(c, self.as2)
        self._session(ia, c, 65050, "10.0.0.3")  # c never names a
        g = self._get()
        by = {c["edge"]: c["kind"] for c in g["checks"]}
        ab = next(e for e in self._edges(g, "ebgp")
                  if {e["source"], e["target"]} == {f"dev:{a.id}", f"dev:{b.id}"})
        ac = next(e for e in self._edges(g, "ebgp")
                  if {e["source"], e["target"]} == {f"dev:{a.id}", f"dev:{c.id}"})
        self.assertEqual(ab["data"]["problems"], ["bgp_as_mismatch"])
        self.assertEqual(by[ab["id"]], "bgp_as_mismatch")
        self.assertEqual(ac["data"]["problems"], ["bgp_one_sided"])
        text = next(x["text"] for x in g["checks"] if x["edge"] == ab["id"])
        self.assertEqual(text, "a expects AS65099, b is AS65050")

    def test_a_vrf_keeps_the_vpn_sessions_between_its_pes(self):
        red = VRF.objects.create(tenant=self.t, name="red")
        pe1, pe2, ce = self._dev("pe1"), self._dev("pe2"), self._dev("ce1")
        g1, g2 = self._bgp(pe1, self.as1), self._bgp(pe2, self.as1)
        self._session(g1, pe2, 65001, "10.255.0.2", address_families=["vpnv4-unicast"])
        v1 = self._bgp(pe1, self.as1, vrf=red)
        self._bgp(pe2, self.as1, vrf=red)
        self._session(v1, ce, 65050, "192.0.2.2")
        g = self._get(f"vrf={red.id}")
        self.assertEqual(sorted(e["type"] for e in g["edges"]), ["ebgp", "ibgp"])
        g = self._get()
        self.assertEqual([e["type"] for e in g["edges"]], ["ibgp"])


class LayerAccessTests(_IGPBase):
    def setUp(self):
        super().setUp()
        self.r1, self.r2 = self._dev("r1"), self._dev("r2", self.lon)
        a, b = self._port(self.r1, "e1"), self._port(self.r2, "e1")
        self._cable(a, b)
        for dev, port in ((self.r1, a), (self.r2, b)):
            o = self._ospf(dev)
            OSPFInterface.objects.create(instance=o, interface=port, area=self.area0)
            i = self._isis(dev)
            ISISInterface.objects.create(instance=i, interface=port)
        self._ip(b, "10.0.0.2", "10.0.0.0/30")
        StaticRoute.objects.create(tenant=self.t, device=self.r1, prefix="10.8.0.0/16",
                                   next_hop="10.0.0.2")
        self.user = User.objects.create_user("viewer")
        UserProfile.objects.create(user=self.user).tenants.add(self.t)
        self._login(self.user)

    def _grant(self, types, site=None):
        perm = ObjectPermission.objects.create(name="-".join(types), object_types=types,
                                               actions=["view"])
        perm.users.add(self.user)
        perm.tenants.add(self.t)
        if site is not None:
            perm.sites.add(site)

    def test_each_layer_needs_its_grants(self):
        base = ["device", "ospfinstance", "isisinstance"]
        self._grant(base)
        g = self._get()
        self.assertEqual(len(g["nodes"]), 2)
        self.assertEqual(g["edges"], [])
        self.assertFalse(g["meta"]["layers"]["ospf"])
        self.assertFalse(g["meta"]["layers"]["isis"])
        self.assertFalse(g["meta"]["layers"]["static"])
        self._grant(["ospfinterface"])
        g = self._get()
        self.assertEqual({e["type"] for e in g["edges"]}, {"ospf"})
        self._grant(["isisinterface", "staticroute"])
        g = self._get()
        self.assertEqual({e["type"] for e in g["edges"]}, {"ospf", "isis", "static"})

    def test_names_need_their_grant(self):
        kc = RoutingKeychain.objects.create(tenant=self.t, name="SECRET-KC")
        OSPFInterface.objects.update(keychain=kc, authentication="md5")
        self._grant(["device", "ospfinstance", "ospfinterface"])
        [e] = self._edges(self._get(), "ospf")
        self.assertIsNone(e["data"]["links"][0]["a"]["keychain"])
        self.assertIsNone(e["data"]["links"][0]["a"]["area_ref"])
        self.assertEqual(e["data"]["links"][0]["a"]["area"], "0")
        self.assertNotIn("SECRET-KC", str(self._get()))

    def test_a_site_scoped_viewer_never_sees_the_far_end(self):
        self._grant(["device", "ospfinstance", "ospfinterface", "staticroute"],
                    site=self.ams)
        g = self._get()
        self.assertEqual([n["id"] for n in g["nodes"]], [f"dev:{self.r1.id}"])
        self.assertEqual(g["edges"], [])


class TenantTests(_IGPBase):
    def test_another_tenants_port_in_the_same_subnet_never_pairs(self):
        mine = self._dev("mine")
        o = self._ospf(mine)
        p = self._port(mine, "e1")
        self._ip(p, "10.0.0.1", "10.0.0.0/30")
        OSPFInterface.objects.create(instance=o, interface=p, area=self.area0)
        StaticRoute.objects.create(tenant=self.t, device=mine, prefix="10.8.0.0/16",
                                   next_hop="10.0.0.2")
        other = _tenant("other")
        dev = Device.objects.create(tenant=other, name="theirs")
        area = OSPFArea.objects.create(tenant=other, name="bb", area_id="0")
        oo = OSPFInstance.objects.create(tenant=other, device=dev, process_id="1")
        q = Interface.objects.create(device=dev, name="e1")
        net = Prefix.objects.create(tenant=other, cidr="10.0.0.0/30")
        IPAddress.objects.create(tenant=other, ip_address="10.0.0.2", prefix=net,
                                 assigned_device=dev, assigned_interface=q)
        OSPFInterface.objects.create(instance=oo, interface=q, area=area)
        g = self._get()
        self.assertEqual([n["id"] for n in g["nodes"]], [f"dev:{mine.id}"])
        self.assertEqual(g["edges"], [])


class QueryCountTests(_IGPBase):
    def _block(self, n, start):
        devs = [self._dev(f"q{start + i}") for i in range(n)]
        ospf = [self._ospf(d) for d in devs]
        isis = [self._isis(d) for d in devs]
        for i, dev in enumerate(devs):
            BGPInstance.objects.create(tenant=self.t, device=dev, asn=self.as1)
            j = (i + 1) % n
            a, b = self._port(dev, f"o{start + i}"), self._port(devs[j], f"i{start + i}")
            self._cable(a, b)
            self._ip(b, f"10.{start}.{i}.2", f"10.{start}.{i}.0/30")
            OSPFInterface.objects.create(instance=ospf[i], interface=a, area=self.area0)
            ISISInterface.objects.create(instance=isis[i], interface=a)
            OSPFInterface.objects.create(instance=ospf[j], interface=b, area=self.area0)
            StaticRoute.objects.create(tenant=self.t, device=dev,
                                       prefix=f"10.{200 + start}.{i}.0/24",
                                       next_hop=f"10.{start}.{i}.2")

    def _count(self, qs):
        with CaptureQueriesContext(connection) as ctx:
            self._get(qs)
        return len(ctx.captured_queries)

    def test_flat_whatever_the_size(self):
        layers = "layers=ebgp,ibgp,ospf,isis,static,circuits,cables"
        self._block(3, 1)
        small = self._count(layers)
        self._block(8, 20)
        big = self._count(layers)
        g = self._get(layers)
        self.assertEqual(len(self._edges(g, "ospf")), 11)
        self.assertEqual(len(self._edges(g, "static")), 11)
        self.assertEqual(small, big)
        self.assertLess(big, 50)


class SavedViewTests(_Base):
    saved = 0

    def _save(self, state):
        self.saved += 1
        return self.client.post("/api/topology-views/",
                                {"name": f"v{self.saved}", "state": state}, format="json")

    def test_vrf_and_checks_keys(self):
        red = VRF.objects.create(tenant=self.t, name="red")
        for vrf in ("global", "all", str(red.id)):
            r = self._save({"filters": {"routing": {
                "vrf": vrf, "checks": True,
                "layers": {"ospf": False, "isis": True, "static": False},
            }}})
            self.assertEqual(r.status_code, 201, r.content)
        for bad in ({"vrf": "red"}, {"vrf": 3}, {"checks": "yes"},
                    {"layers": {"rip": True}}):
            with self.subTest(bad=bad):
                r = self._save({"filters": {"routing": bad}})
                self.assertEqual(r.status_code, 400, r.content)
