"""A colour on providers and provider networks (#540): a network wears its
own colour, else its provider's, on the topology, the Routing tab and the
site map; blank on both is the neutral card."""
from __future__ import annotations

from . import tests_site_map_connections as _site_map
from .models import Provider, ProviderNetwork
from .tests_topology_provider import _ProviderBase


class ProviderColorApiTests(_ProviderBase):
    def test_provider_colour_is_saved_lower_case(self):
        r = self.client.patch(
            f"/api/providers/{self.provider.id}/", {"color": "#AA00FF"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["color"], "#aa00ff")
        self.provider.refresh_from_db()
        self.assertEqual(self.provider.color, "#aa00ff")

    def test_provider_colour_must_be_a_hex(self):
        r = self.client.patch(
            f"/api/providers/{self.provider.id}/", {"color": "red"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("color", r.json())

    def test_blank_by_default(self):
        r = self.client.post(
            "/api/providers/", {"name": "Fibre Co"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["color"], "")
        r = self.client.get(f"/api/provider-networks/{self.mpls.id}/")
        self.assertEqual(r.json()["color"], "")
        self.assertEqual(r.json()["effective_color"], "")

    def test_network_inherits_then_overrides(self):
        self.provider.color = "#112233"
        self.provider.save()
        r = self.client.get(f"/api/provider-networks/{self.mpls.id}/")
        body = r.json()
        self.assertEqual(body["color"], "")
        self.assertEqual(body["effective_color"], "#112233")
        self.assertEqual(body["provider"]["color"], "#112233")
        r = self.client.patch(
            f"/api/provider-networks/{self.mpls.id}/", {"color": "#00FF00"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["color"], "#00ff00")
        self.assertEqual(r.json()["effective_color"], "#00ff00")

    def test_network_colour_must_be_a_hex(self):
        r = self.client.patch(
            f"/api/provider-networks/{self.mpls.id}/", {"color": "#12"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("color", r.json())

    def test_picker_carries_the_colour(self):
        self.provider.color = "#112233"
        self.provider.save()
        rows = self.client.get("/api/providers/?picker=1").json()["results"]
        self.assertEqual(rows[0]["color"], "#112233")


class ProviderColorTopologyTests(_ProviderBase):
    def setUp(self):
        super().setUp()
        self._site("aarhus")
        self._circuit(self.sites["aarhus"], "C-1",
                      cabled_to=self._uplink("aarhus"))

    def _node(self, qs=""):
        (node,) = self._pn(self._graph(qs))
        return node["data"]

    def test_uncoloured_network_is_neutral(self):
        d = self._node()
        self.assertEqual(d["color"], "")
        self.assertEqual(d["provider"]["color"], "")

    def test_network_takes_its_providers_colour(self):
        self.provider.color = "#112233"
        self.provider.save()
        d = self._node()
        self.assertEqual(d["color"], "#112233")
        self.assertEqual(d["provider"]["color"], "#112233")

    def test_own_colour_wins(self):
        self.provider.color = "#112233"
        self.provider.save()
        self.mpls.color = "#ff8800"
        self.mpls.save()
        d = self._node()
        self.assertEqual(d["color"], "#ff8800")
        self.assertEqual(d["provider"]["color"], "#112233")

    def test_grouped_map_and_circuit_line_carry_it(self):
        self.mpls.color = "#ff8800"
        self.mpls.save()
        d = self._node("group_by=site")
        self.assertEqual(d["color"], "#ff8800")
        (edge,) = self._circuit_edges(self._graph())
        self.assertEqual(edge["data"]["provider_network"]["color"], "#ff8800")
        # The line itself keeps the circuit's colour.
        self.assertEqual(edge["data"]["color"], "aa00ff")


class ProviderColorSiteMapTests(_site_map.ConnectionsBase):
    def setUp(self):
        super().setUp()
        self.mpls = ProviderNetwork.objects.create(
            tenant=self.tenant, provider=self.provider, name="MPLS"
        )

    _circuit = _site_map.ProviderNetworkTests._circuit
    payload = _site_map.ProviderNetworkTests.payload

    def test_marker_carries_the_colour(self):
        self.provider.color = "#112233"
        self.provider.save()
        self._circuit(self.s1, "C-1")
        (pn,) = self.payload()["provider_networks"]
        self.assertEqual(pn["color"], "#112233")
        self.assertEqual(pn["provider"]["color"], "#112233")
        ProviderNetwork.objects.filter(pk=self.mpls.pk).update(color="#ff8800")
        (pn,) = self.payload()["provider_networks"]
        self.assertEqual(pn["color"], "#ff8800")

    def test_uncoloured_marker_is_neutral(self):
        self._circuit(self.s1, "C-1")
        (pn,) = self.payload()["provider_networks"]
        self.assertEqual(pn["color"], "")


class ProviderColorModelTests(_ProviderBase):
    def test_effective_colour(self):
        self.assertEqual(self.mpls.effective_color, "")
        Provider.objects.filter(pk=self.provider.pk).update(color="#123456")
        pn = ProviderNetwork.objects.select_related("provider").get(pk=self.mpls.pk)
        self.assertEqual(pn.effective_color, "#123456")
        pn.color = "#abcdef"
        self.assertEqual(pn.effective_color, "#abcdef")
