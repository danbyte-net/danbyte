"""Site-map connections - circuits / tunnels / cross-site cables as edges."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from api.models import (
    Cable, CableTermination, Circuit, CircuitTermination, Device, DeviceType,
    Interface, Provider, ProviderNetwork, Site, Tunnel, TunnelTermination,
)
from api.test_utils import status_for
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant


class ConnectionsBase(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="CO", slug="co")
        self.tenant = Tenant.objects.create(org=self.org, name="CT", slug="ct")
        seed_builtin_statuses(self.tenant)
        self.admin = User.objects.create_superuser("conn-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        self.s1 = Site.objects.create(
            tenant=self.tenant, name="A", latitude="55.0", longitude="12.0"
        )
        self.s2 = Site.objects.create(
            tenant=self.tenant, name="B", latitude="56.0", longitude="10.0"
        )
        self.unplaced = Site.objects.create(tenant=self.tenant, name="C")
        self.provider = Provider.objects.create(
            tenant=self.tenant, name="ISP", slug="isp"
        )

    def edges(self):
        r = self.client_api.get("/api/site-map/connections/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["connections"]

    def _device(self, name, site):
        dt, _ = DeviceType.objects.get_or_create(tenant=self.tenant, name="SW")
        return Device.objects.create(
            tenant=self.tenant, name=name, device_type=dt, site=site
        )


class CircuitEdgeTests(ConnectionsBase):
    def _circuit(self, a_site, z_site=None, z_pn=None, cid="C-1"):
        c = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid=cid,
            status=status_for(self.tenant, "active"),
        )
        CircuitTermination.objects.create(circuit=c, term_side="A", site=a_site)
        CircuitTermination.objects.create(
            circuit=c, term_side="Z", site=z_site, provider_network=z_pn
        )
        return c

    def test_a_z_circuit_becomes_an_edge(self):
        self._circuit(self.s1, self.s2)
        e = self.edges()
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["kind"], "circuit")
        self.assertEqual(e[0]["name"], "C-1")
        self.assertEqual(e[0]["site_a"]["name"], "A")
        self.assertEqual(e[0]["site_z"]["name"], "B")
        self.assertEqual(e[0]["meta"]["provider"], "ISP")

    def test_provider_network_end_is_no_site_to_site_edge(self):
        pn = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="cloud"
        )
        self._circuit(self.s1, z_pn=pn)
        # It draws to the network's own marker instead (#466).
        e = self.edges()
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["site_z"]["id"], f"pn:{pn.id}")
        self.assertEqual(e[0]["provider_network"]["id"], str(pn.id))

    def test_unplaced_site_drops_the_edge(self):
        self._circuit(self.s1, self.unplaced)
        self.assertEqual(self.edges(), [])


class TunnelEdgeTests(ConnectionsBase):
    def _term(self, tunnel, device, role="peer"):
        iface = Interface.objects.create(device=device, name=f"tun-{device.name}")
        return TunnelTermination.objects.create(
            tunnel=tunnel, interface=iface, role=role
        )

    def test_two_peer_sites_edge(self):
        t = Tunnel.objects.create(
            tenant=self.tenant, name="vpn1",
            status=status_for(self.tenant, "active"),
        )
        self._term(t, self._device("d1", self.s1))
        self._term(t, self._device("d2", self.s2))
        e = self.edges()
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["kind"], "tunnel")
        self.assertEqual(e[0]["name"], "vpn1")

    def test_hub_spoke_star(self):
        s3 = Site.objects.create(
            tenant=self.tenant, name="D", latitude="57.0", longitude="9.0"
        )
        t = Tunnel.objects.create(tenant=self.tenant, name="hub")
        self._term(t, self._device("hub1", self.s1), role="hub")
        self._term(t, self._device("sp1", self.s2), role="spoke")
        self._term(t, self._device("sp2", s3), role="spoke")
        e = [x for x in self.edges() if x["kind"] == "tunnel"]
        self.assertEqual(len(e), 2)
        self.assertTrue(all(x["site_a"]["name"] == "A" for x in e))

    def _vm_term(self, tunnel, name, *, site=None, cluster_site=None, role="peer"):
        from api.models import Cluster, ClusterType, VirtualMachine, VMInterface

        ctype, _ = ClusterType.objects.get_or_create(
            tenant=self.tenant, name="vm", defaults={"slug": "vm"}
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name=f"cl-{name}", type=ctype, site=cluster_site
        )
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=cluster, site=site
        )
        vmi = VMInterface.objects.create(vm=vm, name="eth0")
        return TunnelTermination.objects.create(
            tunnel=tunnel, vm_interface=vmi, role=role
        )

    def test_a_tunnel_to_a_virtual_machine_draws(self):
        # #144: only the device side was resolved, so a device-to-VM tunnel
        # never appeared and looked like a configuration mistake.
        t = Tunnel.objects.create(tenant=self.tenant, name="to-vm")
        self._term(t, self._device("d1", self.s1))
        self._vm_term(t, "vm1", site=self.s2)
        e = [x for x in self.edges() if x["kind"] == "tunnel"]
        self.assertEqual(len(e), 1)
        self.assertEqual(
            {e[0]["site_a"]["name"], e[0]["site_z"]["name"]}, {"A", "B"}
        )

    def test_a_virtual_machine_inherits_its_clusters_site(self):
        t = Tunnel.objects.create(tenant=self.tenant, name="to-vm-cluster")
        self._term(t, self._device("d2", self.s1))
        self._vm_term(t, "vm2", cluster_site=self.s2)
        self.assertEqual(len([x for x in self.edges() if x["kind"] == "tunnel"]), 1)

    def test_a_placeless_virtual_machine_draws_nothing(self):
        t = Tunnel.objects.create(tenant=self.tenant, name="nowhere")
        self._term(t, self._device("d3", self.s1))
        self._vm_term(t, "vm3")
        self.assertEqual([x for x in self.edges() if x["kind"] == "tunnel"], [])

    def test_multipoint_peer_mesh_skipped(self):
        s3 = Site.objects.create(
            tenant=self.tenant, name="D", latitude="57.0", longitude="9.0"
        )
        t = Tunnel.objects.create(tenant=self.tenant, name="mesh")
        self._term(t, self._device("m1", self.s1))
        self._term(t, self._device("m2", self.s2))
        self._term(t, self._device("m3", s3))
        self.assertEqual([x for x in self.edges() if x["kind"] == "tunnel"], [])


class CableEdgeTests(ConnectionsBase):
    def _link(self, dev_a, dev_b, label=""):
        cab = Cable.objects.create(
            tenant=self.tenant, status=status_for(self.tenant, "connected"),
            label=label,
        )
        ia = Interface.objects.create(device=dev_a, name=f"x-{label}-a")
        ib = Interface.objects.create(device=dev_b, name=f"x-{label}-b")
        CableTermination.objects.create(cable=cab, end="A", interface=ia)
        CableTermination.objects.create(cable=cab, end="B", interface=ib)
        return cab

    def test_cross_site_cables_aggregate_per_pair(self):
        d1, d2 = self._device("d1", self.s1), self._device("d2", self.s2)
        self._link(d1, d2, "f1")
        self._link(d1, d2, "f2")
        e = [x for x in self.edges() if x["kind"] == "cable"]
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["meta"]["count"], 2)

    def test_a_cable_to_a_circuit_end_does_not_break_the_map(self):
        # A circuit end is shimmed into the (device, port) shape and has no
        # site of its own; reading one crashed the whole endpoint, so every
        # line vanished the moment a handoff was cabled to a port.
        circuit = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid="C-CABLE",
            status=status_for(self.tenant, "active"),
        )
        CircuitTermination.objects.create(
            circuit=circuit, term_side="A", site=self.s1
        )
        term = CircuitTermination.objects.create(
            circuit=circuit, term_side="Z", site=self.s2
        )
        device = self._device("edge1", self.s1)
        iface = Interface.objects.create(device=device, name="Gi0/1")
        cab = Cable.objects.create(
            tenant=self.tenant, status=status_for(self.tenant, "connected")
        )
        CableTermination.objects.create(
            cable=cab, end="A", interface=iface
        )
        CableTermination.objects.create(
            cable=cab, end="B", circuit_termination=term
        )
        kinds = {e["kind"] for e in self.edges()}
        self.assertIn("circuit", kinds)

    def test_same_site_cable_excluded(self):
        d1, d2 = self._device("d1", self.s1), self._device("d2", self.s1)
        self._link(d1, d2, "in")
        self.assertEqual([x for x in self.edges() if x["kind"] == "cable"], [])


class ProviderNetworkTests(ConnectionsBase):
    """A circuit from a placed site to a provider network: one marker per
    network, a line from each site it serves (#466)."""

    def setUp(self):
        super().setUp()
        from api.models import CircuitType

        self.mpls = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="MPLS"
        )
        self.ctype = CircuitType.objects.create(
            tenant=self.tenant, name="MPLS", slug="mpls", color="aa00ff"
        )

    def _circuit(self, site, cid, network=None, **kw):
        c = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid=cid,
            status=status_for(self.tenant, "active"), **kw,
        )
        CircuitTermination.objects.create(circuit=c, term_side="A", site=site)
        CircuitTermination.objects.create(
            circuit=c, term_side="Z", provider_network=network or self.mpls
        )
        return c

    def payload(self, qs=""):
        r = self.client_api.get(f"/api/site-map/connections/{qs}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_hub_and_spokes(self):
        self._circuit(self.s1, "C-1", type=self.ctype, commit_rate_kbps=50_000)
        self._circuit(self.s2, "C-2")
        body = self.payload()
        (pn,) = body["provider_networks"]
        self.assertEqual(pn["name"], "MPLS")
        self.assertEqual(pn["provider"]["name"], "ISP")
        self.assertEqual(sorted(pn["site_ids"]), sorted([str(self.s1.id), str(self.s2.id)]))
        self.assertEqual([c["cid"] for c in pn["circuits"]], ["C-1", "C-2"])
        # At the centroid of the two sites.
        self.assertAlmostEqual(pn["latitude"], 55.5)
        self.assertAlmostEqual(pn["longitude"], 11.0)
        lines = body["connections"]
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertEqual(line["kind"], "circuit")
            self.assertEqual(line["site_z"]["id"], f"pn:{self.mpls.id}")
            self.assertEqual(line["site_z"]["latitude"], pn["latitude"])
        c1 = next(x for x in lines if x["name"] == "C-1")
        # Coloured by its type first, as the other circuit lines.
        self.assertEqual(c1["color"], "aa00ff")
        self.assertEqual(c1["meta"]["commit_rate_kbps"], 50_000)
        c2 = next(x for x in lines if x["name"] == "C-2")
        self.assertEqual(c2["color"], c2["status"]["color"])

    def test_one_site_is_enough_and_the_marker_sits_off_it(self):
        self.s2.latitude = self.s2.longitude = None
        self.s2.save()
        self._circuit(self.s1, "C-1")
        body = self.payload()
        (pn,) = body["provider_networks"]
        self.assertGreater(pn["latitude"], 55.0)
        self.assertEqual(len(body["connections"]), 1)

    def test_two_networks_on_the_same_sites_do_not_overlap(self):
        other = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="Internet"
        )
        self._circuit(self.s1, "C-1")
        self._circuit(self.s2, "C-2")
        self._circuit(self.s1, "C-3", network=other)
        self._circuit(self.s2, "C-4", network=other)
        a, b = self.payload()["provider_networks"]
        self.assertNotEqual(
            (a["latitude"], a["longitude"]), (b["latitude"], b["longitude"])
        )

    def test_unplaced_site_draws_nothing(self):
        self._circuit(self.unplaced, "C-1")
        body = self.payload()
        self.assertEqual(body["provider_networks"], [])
        self.assertEqual(body["connections"], [])

    def test_capacity(self):
        self._circuit(self.s1, "C-1", commit_rate_kbps=100_000)
        (line,) = self.payload("?include=capacity")["connections"]
        self.assertEqual(line["capacity"]["kbps"], 100_000)
        self.assertIsNone(line["links"][0]["z"]["site_id"])

    def test_query_count_stays_flat(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.payload()
            return len(ctx.captured_queries)

        self._circuit(self.s1, "C-1")
        count()  # warm the per-process caches (statuses, grants)
        one = count()
        for i in range(6):
            site = Site.objects.create(
                tenant=self.tenant, name=f"S{i}", latitude="57.0",
                longitude=str(8 + i),
            )
            self._circuit(site, f"X-{i}")
        self.assertEqual(len(self.payload()["connections"]), 7)
        self.assertEqual(count(), one)


class ProviderNetworkAccessTests(ProviderNetworkTests):
    """Grants: the circuit, the network and the site must all be viewable."""

    def setUp(self):
        super().setUp()
        from auth_api.models import ObjectPermission, UserProfile

        self._perm_model = ObjectPermission
        self.reader = User.objects.create_user("pn-reader", password="x")
        UserProfile.objects.create(user=self.reader, role="custom").tenants.add(
            self.tenant
        )
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.reader)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

    def _grant(self, obj_type, site=None):
        perm = self._perm_model.objects.create(
            name=f"{obj_type}-view", object_types=[obj_type], actions=["view"]
        )
        perm.users.add(self.reader)
        perm.tenants.add(self.tenant)
        if site is not None:
            perm.sites.add(site)

    # The inherited tests run as an unscoped reader.
    def _grant_all(self):
        for t in ("site", "circuit", "providernetwork", "cable", "device"):
            self._grant(t)

    def payload(self, qs=""):
        if not self._perm_model.objects.filter(users=self.reader).exists():
            self._grant_all()
        return super().payload(qs)

    def test_network_needs_its_own_grant(self):
        self._grant("site")
        self._grant("circuit")
        self._circuit(self.s1, "C-1")
        body = super().payload()
        self.assertEqual(body["provider_networks"], [])
        self.assertEqual(body["connections"], [])

    def test_circuit_needs_its_own_grant(self):
        self._grant("site")
        self._grant("providernetwork")
        self._circuit(self.s1, "C-1")
        self.assertEqual(super().payload()["provider_networks"], [])

    def test_site_scoped_reader_sees_only_their_sites(self):
        self._grant("site", site=self.s1)
        self._grant("circuit")
        self._grant("providernetwork")
        self._circuit(self.s1, "C-1")
        self._circuit(self.s2, "C-2")
        body = super().payload()
        (pn,) = body["provider_networks"]
        self.assertEqual([c["cid"] for c in pn["circuits"]], ["C-1"])
        self.assertEqual(pn["site_ids"], [str(self.s1.id)])
        self.assertEqual([e["name"] for e in body["connections"]], ["C-1"])
