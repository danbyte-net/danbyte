"""Link capacity on the site map (#246): the first known figure wins and
names its source; links between a site pair add up; unknown stays unknown."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .link_capacity import (
    Capacity,
    bundle,
    cable_capacity,
    circuit_capacity,
    short,
    tunnel_capacity,
)


class LinkCapacityTests(SimpleTestCase):
    def test_a_circuit_takes_its_commit_rate_first(self):
        self.assertEqual(circuit_capacity(100_000, [(1_000_000, 1_000_000)], 10_000_000),
                         Capacity(100_000, None, "commit"))

    def test_then_its_slowest_termination_per_direction(self):
        cap = circuit_capacity(None, [(1_000_000, 200_000), (500_000, 100_000)])
        self.assertEqual(cap, Capacity(500_000, 100_000, "port"))
        self.assertEqual(cap.as_dict()["label"], "500/100M")
        # Symmetric: no second figure.
        self.assertEqual(circuit_capacity(None, [(1_000_000, 1_000_000)]),
                         Capacity(1_000_000, None, "port"))

    def test_then_a_cabled_interface_and_else_nothing(self):
        self.assertEqual(circuit_capacity(None, [(None, None)], 10_000_000),
                         Capacity(10_000_000, None, "interface"))
        self.assertIsNone(circuit_capacity(None, [], None))

    def test_tunnels_and_cables(self):
        self.assertEqual(tunnel_capacity(50_000), Capacity(50_000, None, "override"))
        self.assertIsNone(tunnel_capacity(None))
        self.assertEqual(cable_capacity(10_000_000, 1_000_000), Capacity(1_000_000, None, "cable"))
        self.assertEqual(cable_capacity(None, 1_000_000), Capacity(1_000_000, None, "cable"))
        self.assertIsNone(cable_capacity(None, None))

    def test_a_site_pair_adds_its_links_up(self):
        ten = Capacity(10_000_000, None, "cable")
        self.assertEqual(bundle([ten, ten, None]),
                         {"kbps": 20_000_000, "count": 2, "unknown": 1, "label": "2×10G"})
        self.assertEqual(bundle([ten, Capacity(1_000_000, None, "cable")])["label"], "11G")
        self.assertEqual(bundle([None]), {"kbps": None, "count": 0, "unknown": 1, "label": ""})

    def test_short_labels(self):
        self.assertEqual([short(v) for v in (10_000_000, 2_500_000, 500_000, 64)],
                         ["10G", "2.5G", "500M", "64k"])
        self.assertEqual(short(1_000_000, 512), "1G/512k")
        self.assertEqual(short(None), "")


class TunnelCapacityTests(APITestCase):
    """A tunnel's own capacity figure (#246), written and read through the API."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = get_user_model().objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_capacity_round_trips_and_clears(self):
        r = self.client.post("/api/tunnels/", {"name": "hq-branch", "encapsulation": "ipsec-tunnel",
                                               "capacity_kbps": 100_000}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["capacity_kbps"], 100_000)
        url = f"/api/tunnels/{r.json()['id']}/"
        r = self.client.patch(url, {"capacity_kbps": None}, format="json")
        self.assertIsNone(r.json()["capacity_kbps"])
        r = self.client.patch(url, {"capacity_kbps": -5}, format="json")
        self.assertEqual(r.status_code, 400)
