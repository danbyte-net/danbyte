"""Provider networks on the topology (#466): a circuit from a site to a
provider network draws a line from the device its site end is cabled to (or,
grouped, that device's card) to one node per network - hub and spoke."""
from __future__ import annotations

from django.db import connection
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .models import (
    Circuit,
    CircuitTermination,
    CircuitType,
    Device,
    FrontPort,
    Interface,
    Provider,
    ProviderNetwork,
    RearPort,
    Site,
)
from .tests_topology import User, _Base


class _ProviderBase(_Base):
    def setUp(self):
        super().setUp()
        self.provider = Provider.objects.create(
            tenant=self.tenant, name="Telco", slug="telco"
        )
        self.mpls = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="MPLS"
        )
        self.ctype = CircuitType.objects.create(
            tenant=self.tenant, name="MPLS", slug="mpls", color="aa00ff"
        )
        self.sites = {}
        self.switches = {}

    def _site(self, name):
        site = Site.objects.create(tenant=self.tenant, name=name)
        sw = Device.objects.create(tenant=self.tenant, name=f"sw-{name}", site=site)
        self.sites[name] = site
        self.switches[name] = sw
        return site, sw

    def _circuit(self, site, cid, network=None, cabled_to=None, rate=None):
        c = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid=cid,
            type=self.ctype, commit_rate_kbps=rate,
        )
        a = CircuitTermination.objects.create(circuit=c, term_side="A", site=site)
        CircuitTermination.objects.create(
            circuit=c, term_side="Z", provider_network=network or self.mpls
        )
        if cabled_to is not None:
            self._cable_term(cabled_to, a)
        return c, a

    def _cable_term(self, port, term):
        from .models import Cable, CableTermination

        cab = Cable.objects.create(tenant=self.tenant)
        kind = {Interface: "interface", FrontPort: "front_port",
                RearPort: "rear_port"}[type(port)]
        CableTermination.objects.create(cable=cab, end="A", **{kind: port})
        CableTermination.objects.create(cable=cab, end="B", circuit_termination=term)
        return cab

    def _uplink(self, name):
        return Interface.objects.create(device=self.switches[name], name="Gi0/48")

    def _pn(self, g):
        return [n for n in g["nodes"] if n["type"] == "provider_network"]

    def _circuit_edges(self, g):
        return [e for e in g["edges"] if e["type"] == "circuit"]


class DeviceMapTests(_ProviderBase):
    def setUp(self):
        super().setUp()
        for name in ("aarhus", "odense", "aalborg"):
            self._site(name)

    def test_one_hub_node_with_an_edge_per_site(self):
        for i, name in enumerate(("aarhus", "odense", "aalborg")):
            self._circuit(self.sites[name], f"C-{i}", cabled_to=self._uplink(name),
                          rate=100_000)
        g = self._graph()
        nodes = self._pn(g)
        self.assertEqual(len(nodes), 1)
        node = nodes[0]
        self.assertEqual(node["id"], f"pn:{self.mpls.id}")
        self.assertEqual(node["data"]["kind"], "provider_network")
        self.assertEqual(node["data"]["name"], "MPLS")
        self.assertEqual(node["data"]["provider"]["name"], "Telco")
        self.assertEqual(node["data"]["circuit_count"], 3)
        edges = self._circuit_edges(g)
        self.assertEqual(len(edges), 3)
        self.assertEqual({e["target"] for e in edges}, {node["id"]})
        self.assertEqual(
            {e["source"] for e in edges},
            {f"dev:{sw.id}" for sw in self.switches.values()},
        )
        e = next(x for x in edges if x["data"]["circuit"]["cid"] == "C-0")
        d = e["data"]
        self.assertEqual(d["circuit"]["commit_rate_kbps"], 100_000)
        self.assertEqual(d["circuit"]["provider"]["name"], "Telco")
        self.assertEqual(d["port"]["name"], "Gi0/48")
        self.assertEqual(d["port"]["kind"], "interface")
        self.assertEqual(d["color"], "aa00ff")
        self.assertEqual(d["pairs"][0]["b_port"], "C-0")
        # The cable to the demarc is no device-to-device cable edge.
        self.assertFalse([x for x in g["edges"] if x["type"] == "cable"])

    def test_two_networks_are_two_nodes(self):
        other = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="Internet"
        )
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        self._circuit(self.sites["odense"], "C-2", network=other,
                      cabled_to=self._uplink("odense"))
        names = sorted(n["data"]["name"] for n in self._pn(self._graph()))
        self.assertEqual(names, ["Internet", "MPLS"])

    def test_uncabled_end_draws_nothing_on_the_device_map(self):
        self._circuit(self.sites["aarhus"], "C-1")
        g = self._graph()
        self.assertEqual(self._pn(g), [])
        self.assertEqual(self._circuit_edges(g), [])

    def test_walks_through_patch_panels(self):
        panel = Device.objects.create(
            tenant=self.tenant, name="pp-1", site=self.sites["aarhus"]
        )
        rear = RearPort.objects.create(device=panel, name="R1", positions=1)
        front = FrontPort.objects.create(
            device=panel, name="F1", rear_port=rear, rear_port_position=1
        )
        self._cable(self._uplink("aarhus"), front)
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=rear)
        g = self._graph()
        (edge,) = self._circuit_edges(g)
        self.assertEqual(edge["source"], f"dev:{self.switches['aarhus'].id}")
        self.assertEqual(edge["data"]["via"], ["pp-1"])
        # Raw hops: the panel is the end.
        g = self._graph("collapse_panels=0")
        (edge,) = self._circuit_edges(g)
        self.assertEqual(edge["source"], f"dev:{panel.id}")

    def test_only_cards_on_the_map(self):
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        self._circuit(self.sites["odense"], "C-2", cabled_to=self._uplink("odense"))
        g = self._graph(f"site={self.sites['aarhus'].id}")
        (edge,) = self._circuit_edges(g)
        self.assertEqual(edge["data"]["circuit"]["cid"], "C-1")
        self.assertEqual(self._pn(g)[0]["data"]["circuit_count"], 1)

    def test_hand_picked_map(self):
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        self._circuit(self.sites["odense"], "C-2", cabled_to=self._uplink("odense"))
        r = self.client.post(
            "/api/topology/",
            {"devices": [str(self.switches["odense"].id)]}, format="json",
        )
        g = r.json()
        (edge,) = self._circuit_edges(g)
        self.assertEqual(edge["source"], f"dev:{self.switches['odense'].id}")
        self.assertEqual(len(self._pn(g)), 1)

    def test_focus(self):
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        g = self._graph(f"device={self.switches['aarhus'].id}")
        self.assertEqual(len(self._circuit_edges(g)), 1)

    def test_query_count_stays_flat(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get("/api/topology/").status_code, 200)
            return len(ctx.captured_queries)

        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        count()  # warm the per-process caches
        one = count()
        self._circuit(self.sites["odense"], "C-2", cabled_to=self._uplink("odense"))
        for i in range(5):
            site, _sw = self._site(f"extra-{i}")
            self._circuit(site, f"X-{i}", cabled_to=self._uplink(f"extra-{i}"))
        self.assertEqual(len(self._circuit_edges(self._graph())), 7)
        self.assertEqual(count(), one)


class GroupedMapTests(_ProviderBase):
    def setUp(self):
        super().setUp()
        for name in ("aarhus", "odense"):
            self._site(name)

    def test_lines_run_from_the_site_cards(self):
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        self._circuit(self.sites["odense"], "C-2", cabled_to=self._uplink("odense"))
        g = self._graph("group_by=site")
        (node,) = self._pn(g)
        edges = self._circuit_edges(g)
        self.assertEqual(
            {e["source"] for e in edges},
            {f"grp:{s.id}" for s in self.sites.values()},
        )
        self.assertEqual({e["target"] for e in edges}, {node["id"]})

    def test_uncabled_end_draws_from_its_site(self):
        self._circuit(self.sites["odense"], "C-2")
        (edge,) = self._circuit_edges(self._graph("group_by=site"))
        self.assertEqual(edge["source"], f"grp:{self.sites['odense'].id}")
        self.assertNotIn("port", edge["data"])
        # Grouped by location, an uncabled end has no card to start from.
        self.assertEqual(self._circuit_edges(self._graph("group_by=location")), [])

    def test_site_without_a_card_draws_nothing(self):
        lone = Site.objects.create(tenant=self.tenant, name="empty")
        self._circuit(lone, "C-9")
        g = self._graph("group_by=site")
        self.assertEqual(self._circuit_edges(g), [])
        self.assertEqual(self._pn(g), [])


class AccessTests(_ProviderBase):
    def setUp(self):
        super().setUp()
        for name in ("aarhus", "odense"):
            self._site(name)
        self._circuit(self.sites["aarhus"], "C-1", cabled_to=self._uplink("aarhus"))
        self._circuit(self.sites["odense"], "C-2", cabled_to=self._uplink("odense"))
        self.user = User.objects.create_user("reader", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )
        self.client.force_login(self.user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _grant(self, obj_type, site=None):
        perm = ObjectPermission.objects.create(
            name=f"{obj_type}-view", object_types=[obj_type], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        if site is not None:
            perm.sites.add(site)

    def test_needs_circuit_and_network_view(self):
        self._grant("device")
        self._grant("site")
        g = self._graph()
        self.assertEqual(self._pn(g), [])
        self._grant("circuit")
        self.assertEqual(self._pn(self._graph()), [])
        self._grant("providernetwork")
        g = self._graph()
        self.assertEqual(len(self._pn(g)), 1)
        self.assertEqual(len(self._circuit_edges(g)), 2)

    def test_site_scoped_reader_sees_only_their_sites_circuits(self):
        aarhus = self.sites["aarhus"]
        self._grant("device", site=aarhus)
        self._grant("site", site=aarhus)
        self._grant("circuit")
        self._grant("providernetwork")
        for qs in ("", "group_by=site"):
            g = self._graph(qs)
            (node,) = self._pn(g)
            self.assertEqual(
                [c["cid"] for c in node["data"]["circuits"]], ["C-1"], qs
            )
            self.assertEqual(len(self._circuit_edges(g)), 1, qs)

    def test_site_view_bounds_an_uncabled_end_on_the_grouped_map(self):
        aarhus, odense = self.sites["aarhus"], self.sites["odense"]
        # Devices at both sites, but the circuits only at the viewable one.
        self._grant("device")
        self._grant("site", site=aarhus)
        self._grant("circuit")
        self._grant("providernetwork")
        self._circuit(odense, "C-3")
        g = self._graph("group_by=site")
        cids = sorted(e["data"]["circuit"]["cid"] for e in self._circuit_edges(g))
        self.assertEqual(cids, ["C-1"])

    def test_other_tenant_never_shows(self):
        from core.models import Tenant

        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        prov = Provider.objects.create(tenant=other, name="T2", slug="t2")
        pn = ProviderNetwork.objects.create(tenant=other, provider=prov, name="X")
        site = Site.objects.create(tenant=other, name="far")
        c = Circuit.objects.create(tenant=other, provider=prov, cid="O-1")
        CircuitTermination.objects.create(circuit=c, term_side="A", site=site)
        CircuitTermination.objects.create(circuit=c, term_side="Z", provider_network=pn)
        for t in ("device", "site", "circuit", "providernetwork"):
            self._grant(t)
        names = {n["data"]["name"] for n in self._pn(self._graph())}
        self.assertEqual(names, {"MPLS"})
