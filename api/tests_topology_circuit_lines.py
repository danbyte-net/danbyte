"""Site-to-site circuits on the topology: a circuit whose two ends are both
on sites and both cabled to device ports is one ``circuit`` line between the
two devices (or, grouped, between their groups' cards)."""
from __future__ import annotations

from django.db import connection
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .models import (
    Circuit,
    CircuitTermination,
    Device,
    FrontPort,
    Interface,
    Location,
    Provider,
    RearPort,
    Site,
)
from .tests_topology import User
from .tests_topology_provider import _ProviderBase


class _SiteCircuitBase(_ProviderBase):
    def setUp(self):
        super().setUp()
        self.pe1 = self._router("nsp1", "NSP1-PE2")
        self.pe2 = self._router("nsp2", "NSP2-PE2")

    def _router(self, site_name, name):
        site = Site.objects.create(tenant=self.tenant, name=site_name)
        dev = Device.objects.create(tenant=self.tenant, name=name, site=site)
        self.sites[site_name] = site
        self.switches[site_name] = dev
        return dev

    def _p2p(self, cid, a_port=None, z_port=None, a_site=None, z_site=None):
        c = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid=cid,
            type=self.ctype, commit_rate_kbps=1_000_000,
        )
        a = CircuitTermination.objects.create(
            circuit=c, term_side="A", site=a_site or self.sites["nsp1"]
        )
        z = CircuitTermination.objects.create(
            circuit=c, term_side="Z", site=z_site or self.sites["nsp2"]
        )
        if a_port is not None:
            self._cable_term(a_port, a)
        if z_port is not None:
            self._cable_term(z_port, z)
        return c, a, z

    def _port(self, dev, name="xe-0/0/0"):
        return Interface.objects.create(device=dev, name=name)

    def _both(self, cid="MPLS-1"):
        return self._p2p(cid, self._port(self.pe1), self._port(self.pe2))


class DeviceMapTests(_SiteCircuitBase):
    def test_both_ends_cabled_draw_one_line(self):
        c, a, z = self._both()
        g = self._graph()
        (edge,) = self._circuit_edges(g)
        self.assertEqual(edge["id"], f"cc:{c.id}")
        self.assertEqual(edge["source"], f"dev:{self.pe1.id}")
        self.assertEqual(edge["target"], f"dev:{self.pe2.id}")
        d = edge["data"]
        self.assertEqual(d["circuit"]["cid"], "MPLS-1")
        self.assertEqual(d["circuit"]["provider"]["name"], "Telco")
        self.assertEqual(d["circuit"]["type"]["name"], "MPLS")
        self.assertEqual(d["circuit"]["commit_rate_kbps"], 1_000_000)
        self.assertEqual(d["color"], "aa00ff")
        self.assertNotIn("provider_network", d)
        ea, ez = d["ends"]
        self.assertEqual(ea["side"], "A")
        self.assertEqual(ea["termination"]["id"], str(a.id))
        self.assertEqual(ea["site"]["name"], "nsp1")
        self.assertEqual(ea["device"]["name"], "NSP1-PE2")
        self.assertEqual(ea["port"], {
            "id": ea["port"]["id"], "name": "xe-0/0/0", "kind": "interface",
        })
        self.assertEqual(ez["termination"]["id"], str(z.id))
        self.assertEqual(ez["device"]["name"], "NSP2-PE2")
        (pair,) = d["pairs"]
        self.assertEqual(pair["a"], "NSP1-PE2:xe-0/0/0")
        self.assertEqual(pair["b"], "NSP2-PE2:xe-0/0/0")
        # No hub, no cable edge: the two cables end at the circuit.
        self.assertEqual(self._pn(g), [])
        self.assertFalse([e for e in g["edges"] if e["type"] == "cable"])
        # Both cards carry the row the line anchors to.
        for n in g["nodes"]:
            self.assertIn("xe-0/0/0", [p["name"] for p in n["data"]["ports"]])

    def test_one_end_uncabled_draws_nothing(self):
        self._p2p("MPLS-1", a_port=self._port(self.pe1))
        self.assertEqual(self._circuit_edges(self._graph()), [])
        self.assertEqual(self._circuit_edges(self._graph("group_by=site")), [])

    def test_walks_through_a_patch_panel(self):
        panel = Device.objects.create(
            tenant=self.tenant, name="pp-1", site=self.sites["nsp2"]
        )
        rear = RearPort.objects.create(device=panel, name="R1", positions=1)
        front = FrontPort.objects.create(
            device=panel, name="F1", rear_port=rear, rear_port_position=1
        )
        self._cable(self._port(self.pe2), front)
        self._p2p("MPLS-1", a_port=self._port(self.pe1), z_port=rear)
        (edge,) = self._circuit_edges(self._graph())
        self.assertEqual(edge["target"], f"dev:{self.pe2.id}")
        self.assertEqual(edge["data"]["ends"][1]["via"], ["pp-1"])
        self.assertEqual(edge["data"]["via"], ["pp-1"])
        # Raw hops: the panel is the end.
        (edge,) = self._circuit_edges(self._graph("collapse_panels=0"))
        self.assertEqual(edge["target"], f"dev:{panel.id}")

    def test_hand_picked_map_and_focus(self):
        self._both()
        r = self.client.post(
            "/api/topology/",
            {"devices": [str(self.pe1.id), str(self.pe2.id)]}, format="json",
        )
        self.assertEqual(len(self._circuit_edges(r.json())), 1)
        # Only one end on the map: nothing.
        r = self.client.post(
            "/api/topology/", {"devices": [str(self.pe1.id)]}, format="json",
        )
        self.assertEqual(self._circuit_edges(r.json()), [])
        g = self._graph(f"device={self.pe1.id}")
        self.assertEqual(self._circuit_edges(g), [])
        g = self._graph(f"site={self.sites['nsp1'].id}")
        self.assertEqual(self._circuit_edges(g), [])

    def test_a_lag_never_takes_it(self):
        c, _a, _z = self._both()
        lag = Interface.objects.create(device=self.pe1, name="ae0", type="lag")
        Interface.objects.filter(device=self.pe1, name="xe-0/0/0").update(lag=lag)
        (edge,) = self._circuit_edges(self._graph())
        self.assertNotIn("lag", edge["data"])

    def test_query_count_stays_flat(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get("/api/topology/").status_code, 200)
            return len(ctx.captured_queries)

        self._both("MPLS-0")
        count()  # warm the per-process caches
        one = count()
        for i in range(6):
            self._p2p(
                f"MPLS-{i + 1}", self._port(self.pe1, f"xe-0/0/{i + 1}"),
                self._port(self.pe2, f"xe-0/0/{i + 1}"),
            )
        self.assertEqual(len(self._circuit_edges(self._graph())), 7)
        self.assertEqual(count(), one)


class GroupedMapTests(_SiteCircuitBase):
    def test_a_line_between_two_sites(self):
        c, _a, _z = self._both()
        (edge,) = self._circuit_edges(self._graph("group_by=site"))
        self.assertEqual(edge["id"], f"cc:{c.id}")
        self.assertEqual(edge["source"], f"grp:{self.sites['nsp1'].id}")
        self.assertEqual(edge["target"], f"grp:{self.sites['nsp2'].id}")
        self.assertEqual(edge["data"]["circuit"]["cid"], "MPLS-1")
        self.assertNotIn("pairs", edge["data"])

    def test_dropped_inside_one_group(self):
        site = self.sites["nsp1"]
        Device.objects.filter(id=self.pe2.id).update(site=site)
        self._both()
        self.assertEqual(self._circuit_edges(self._graph("group_by=site")), [])

    def test_by_location(self):
        la = Location.objects.create(
            tenant=self.tenant, site=self.sites["nsp1"], name="hall-a"
        )
        lb = Location.objects.create(
            tenant=self.tenant, site=self.sites["nsp2"], name="hall-b"
        )
        Device.objects.filter(id=self.pe1.id).update(location=la)
        Device.objects.filter(id=self.pe2.id).update(location=lb)
        self._both()
        (edge,) = self._circuit_edges(self._graph("group_by=location"))
        self.assertEqual(
            {edge["source"], edge["target"]}, {f"grp:{la.id}", f"grp:{lb.id}"}
        )


class AccessTests(_SiteCircuitBase):
    def setUp(self):
        super().setUp()
        self._both()
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

    def test_needs_circuit_view(self):
        self._grant("device")
        for qs in ("", "group_by=site"):
            self.assertEqual(self._circuit_edges(self._graph(qs)), [], qs)
        self._grant("circuit")
        for qs in ("", "group_by=site"):
            self.assertEqual(len(self._circuit_edges(self._graph(qs))), 1, qs)

    def test_far_device_not_viewable_drops_the_line(self):
        self._grant("device", site=self.sites["nsp1"])
        self._grant("circuit")
        for qs in ("", "group_by=site"):
            g = self._graph(qs)
            self.assertEqual(self._circuit_edges(g), [], qs)
            self.assertNotIn("NSP2-PE2", str(g), qs)

    def test_other_tenant_never_shows(self):
        from core.models import Tenant

        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        prov = Provider.objects.create(tenant=other, name="T2", slug="t2")
        s1 = Site.objects.create(tenant=other, name="o1")
        s2 = Site.objects.create(tenant=other, name="o2")
        d1 = Device.objects.create(tenant=other, name="o-r1", site=s1)
        d2 = Device.objects.create(tenant=other, name="o-r2", site=s2)
        c = Circuit.objects.create(tenant=other, provider=prov, cid="O-1")
        a = CircuitTermination.objects.create(circuit=c, term_side="A", site=s1)
        z = CircuitTermination.objects.create(circuit=c, term_side="Z", site=s2)
        from .models import Cable, CableTermination

        for dev, term in ((d1, a), (d2, z)):
            cab = Cable.objects.create(tenant=other)
            CableTermination.objects.create(
                cable=cab, end="A",
                interface=Interface.objects.create(device=dev, name="e0"),
            )
            CableTermination.objects.create(
                cable=cab, end="B", circuit_termination=term
            )
        self._grant("device")
        self._grant("circuit")
        for qs in ("", "group_by=site"):
            cids = [
                e["data"]["circuit"]["cid"]
                for e in self._circuit_edges(self._graph(qs))
            ]
            self.assertEqual(cids, ["MPLS-1"], qs)
