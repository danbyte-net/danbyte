"""Site-map connections — circuits / tunnels / cross-site cables as edges."""
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

    def test_provider_network_end_is_excluded(self):
        pn = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="cloud"
        )
        self._circuit(self.s1, z_pn=pn)
        self.assertEqual(self.edges(), [])

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

    def test_same_site_cable_excluded(self):
        d1, d2 = self._device("d1", self.s1), self._device("d2", self.s1)
        self._link(d1, d2, "in")
        self.assertEqual([x for x in self.edges() if x["kind"] == "cable"], [])
