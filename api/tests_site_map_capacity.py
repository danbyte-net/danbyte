"""Link speed on the site map (#246): ``?include=capacity`` on the connection
and cable endpoints - the figure and where it came from, the links behind it
and their ends, under the caller's grants, in a fixed number of queries."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    FrontPort,
    Interface,
    Provider,
    RearPort,
    Site,
    Tunnel,
    TunnelTermination,
    VirtualMachine,
    VMInterface,
)

User = get_user_model()

TEN_G, ONE_G = 10_000_000, 1_000_000


class _MapBase(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self._login(self.admin)
        self.ams = Site.objects.create(
            tenant=self.tenant, name="AMS", latitude="52.37", longitude="4.89"
        )
        self.lon = Site.objects.create(
            tenant=self.tenant, name="LON", latitude="51.50", longitude="-0.12"
        )
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="Box")
        self.panel_role = DeviceRole.objects.create(
            tenant=self.tenant, name="Panel", slug="panel", is_patch_panel=True
        )
        self.provider = Provider.objects.create(tenant=self.tenant, name="ISP", slug="isp")

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _viewer(self, *grants):
        """A tenant member holding ``(types, sites)`` view grants - ``sites``
        narrows a grant to those sites."""
        user = User.objects.create_user(f"viewer{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for types, sites in grants:
            perm = ObjectPermission.objects.create(
                name=f"view {' '.join(types)}", object_types=list(types), actions=["view"]
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            for site in sites or ():
                perm.sites.add(site)
        self._login(user)
        return user

    def _dev(self, name, site, role=None):
        return Device.objects.create(
            tenant=self.tenant, name=name, site=site, device_type=self.dt, role=role
        )

    def _iface(self, device, name, speed=""):
        return Interface.objects.create(device=device, name=name, speed=speed)

    def _cable(self, a, b, label=""):
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)
        return cable

    def _panel(self, name, site, positions=4, duplex=False):
        """A patch panel: one rear port of ``positions`` strands and the front
        ports mapped onto it - simplex, or duplex connectors of two strands."""
        device = self._dev(name, site, role=self.panel_role)
        rear = RearPort.objects.create(device=device, name="R1", positions=positions)
        width = 2 if duplex else 1
        fronts = [
            FrontPort.objects.create(
                device=device, name=f"F{i + 1}", rear_port=rear,
                rear_port_position=1 + i * width, positions=width,
            )
            for i in range(positions // width)
        ]
        return rear, fronts

    def _get(self, url):
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp

    def connections(self, include=True):
        url = "/api/site-map/connections/" + ("?include=capacity" if include else "")
        return self._get(url).json()["connections"]

    def cables(self, include=True):
        url = "/api/site-map/cables/" + ("?include=capacity" if include else "")
        return self._get(url).json()["cables"]

    def edge(self, kind):
        edges = [e for e in self.connections() if e["kind"] == kind]
        self.assertEqual(len(edges), 1, edges)
        return edges[0]


class OptInTests(_MapBase):
    def test_without_include_nothing_changes(self):
        # The dashboard and site-page mini maps share these endpoints and must
        # not pay for, nor receive, the figures.
        self._cable(
            {"interface": self._iface(self._dev("a", self.ams), "e0", "10G")},
            {"interface": self._iface(self._dev("b", self.lon), "e0", "10G")},
        )
        Tunnel.objects.create(tenant=self.tenant, name="t", capacity_kbps=5)
        for row in self.connections(include=False) + self.cables(include=False):
            for key in ("capacity", "links", "link_count"):
                self.assertNotIn(key, row)
        self.assertEqual(self.cables()[0]["capacity"]["label"], "10G")


class CircuitTests(_MapBase):
    def _circuit(self, commit=None, a=(None, None), z=(None, None)):
        circuit = Circuit.objects.create(
            tenant=self.tenant, provider=self.provider, cid="C-1", commit_rate_kbps=commit
        )
        ta = CircuitTermination.objects.create(
            circuit=circuit, term_side="A", site=self.ams,
            port_speed_kbps=a[0], upstream_speed_kbps=a[1],
        )
        tz = CircuitTermination.objects.create(
            circuit=circuit, term_side="Z", site=self.lon,
            port_speed_kbps=z[0], upstream_speed_kbps=z[1],
        )
        return ta, tz

    def _cable_ends(self, ta, tz):
        """A side straight to a 10G router port; Z side into a patch panel,
        out over a trunk to a second panel and on to a 1G router port."""
        rtr_a = self._dev("rtr-ams", self.ams)
        self._cable({"circuit_termination": ta},
                    {"interface": self._iface(rtr_a, "xe-0/0/0", "10G")})
        rear1, fronts1 = self._panel("mmr-lon", self.lon)
        rear2, fronts2 = self._panel("pp-lon", self.lon)
        self._cable({"circuit_termination": tz}, {"front_port": fronts1[0]})
        self._cable({"rear_port": rear1}, {"rear_port": rear2})
        rtr_z = self._dev("rtr-lon", self.lon)
        self._cable({"front_port": fronts2[0]},
                    {"interface": self._iface(rtr_z, "ge-0/0/1", "1 Gbps")})

    def test_the_commit_rate_wins(self):
        self._circuit(commit=100_000, a=(ONE_G, ONE_G), z=(ONE_G, ONE_G))
        self.assertEqual(self.edge("circuit")["capacity"], {
            "kbps": 100_000, "up_kbps": None, "source": "commit", "label": "100M",
            "count": 1, "unknown": 0,
        })

    def test_then_the_slower_termination_each_way(self):
        self._circuit(a=(ONE_G, ONE_G), z=(500_000, 100_000))
        edge = self.edge("circuit")
        cap = edge["capacity"]
        self.assertEqual(
            (cap["kbps"], cap["up_kbps"], cap["source"], cap["label"]),
            (500_000, 100_000, "port", "500/100M"),
        )
        self.assertEqual(edge["link_count"], 1)
        link = edge["links"][0]
        self.assertEqual(link["capacity"]["label"], "500/100M")
        self.assertEqual(link["a"]["site_id"], str(self.ams.id))
        self.assertEqual(link["z"]["termination"], {
            "id": link["z"]["termination"]["id"], "side": "Z",
            "port_speed_kbps": 500_000, "upstream_speed_kbps": 100_000,
        })
        # Not cabled: nothing at the end, and nothing hidden either.
        self.assertEqual((link["a"]["device"], link["a"]["restricted"]), (None, False))

    def test_then_the_interfaces_it_is_cabled_to_through_the_panels(self):
        ta, tz = self._circuit()
        self._cable_ends(ta, tz)
        edge = self.edge("circuit")
        self.assertEqual(
            (edge["capacity"]["kbps"], edge["capacity"]["source"]), (ONE_G, "interface")
        )
        link = edge["links"][0]
        self.assertEqual(link["a"]["device"]["name"], "rtr-ams")
        self.assertEqual(link["a"]["port"], {
            "id": link["a"]["port"]["id"], "name": "xe-0/0/0", "kind": "interface",
            "speed_kbps": TEN_G,
        })
        # The panels are crossed: the end is the router, not the demarc panel.
        self.assertEqual(link["z"]["device"]["name"], "rtr-lon")
        self.assertEqual(link["z"]["port"]["speed_kbps"], ONE_G)

    def test_nothing_known_is_null(self):
        self._circuit()
        edge = self.edge("circuit")
        self.assertIsNone(edge["capacity"])
        self.assertIsNone(edge["links"][0]["capacity"])

    def test_without_cable_view_no_ends_and_no_interface_speed(self):
        ta, tz = self._circuit(z=(None, None))
        self._cable_ends(ta, tz)
        self._viewer((["site", "circuit", "device", "interface"], None))
        edge = self.edge("circuit")
        self.assertIsNone(edge["capacity"])
        for end in (edge["links"][0]["a"], edge["links"][0]["z"]):
            self.assertEqual((end["device"], end["port"], end["restricted"]), (None, None, True))

    def test_interface_speeds_need_both_ends_viewable(self):
        ta, tz = self._circuit()
        self._cable_ends(ta, tz)
        self._viewer((["site", "circuit", "cable"], None), (["device"], [self.ams]))
        resp = self._get("/api/site-map/connections/?include=capacity")
        edge = next(e for e in resp.json()["connections"] if e["kind"] == "circuit")
        self.assertIsNone(edge["capacity"])
        self.assertEqual(edge["links"][0]["a"]["device"]["name"], "rtr-ams")
        self.assertTrue(edge["links"][0]["z"]["restricted"])
        self.assertNotIn(b"rtr-lon", resp.content)
        self.assertNotIn(b"ge-0/0/1", resp.content)
        self.assertNotIn(b"pp-lon", resp.content)


class TunnelTests(_MapBase):
    def _term(self, tunnel, device, role="peer", speed=""):
        iface = self._iface(device, f"tun-{device.name}", speed)
        return TunnelTermination.objects.create(tunnel=tunnel, interface=iface, role=role)

    def test_a_tunnel_carries_its_own_figure(self):
        tunnel = Tunnel.objects.create(tenant=self.tenant, name="vpn", capacity_kbps=50_000)
        self._term(tunnel, self._dev("fw-ams", self.ams), speed="1G")
        self._term(tunnel, self._dev("fw-lon", self.lon))
        edge = self.edge("tunnel")
        self.assertEqual(edge["capacity"], {
            "kbps": 50_000, "up_kbps": None, "source": "override", "label": "50M",
            "count": 1, "unknown": 0,
        })
        link = edge["links"][0]
        self.assertEqual(link["a"]["device"]["name"], "fw-ams")
        self.assertEqual(link["a"]["port"]["speed_kbps"], ONE_G)
        self.assertEqual(link["z"]["port"]["name"], "tun-fw-lon")
        # Interfaces never make a tunnel's figure.
        tunnel.capacity_kbps = None
        tunnel.save()
        self.assertIsNone(self.edge("tunnel")["capacity"])

    def test_every_spoke_shows_the_hubs_figure(self):
        par = Site.objects.create(tenant=self.tenant, name="PAR", latitude="48.8", longitude="2.3")
        tunnel = Tunnel.objects.create(tenant=self.tenant, name="dmvpn", capacity_kbps=TEN_G)
        self._term(tunnel, self._dev("hub", self.ams), role="hub")
        self._term(tunnel, self._dev("spoke-1", self.lon), role="spoke")
        self._term(tunnel, self._dev("spoke-2", par), role="spoke")
        edges = [e for e in self.connections() if e["kind"] == "tunnel"]
        self.assertEqual(len(edges), 2)
        for edge in edges:
            self.assertEqual(edge["capacity"]["label"], "10G")
            self.assertEqual(edge["links"][0]["a"]["device"]["name"], "hub")

    def test_a_virtual_machine_end_is_named_only_with_vm_view(self):
        tunnel = Tunnel.objects.create(tenant=self.tenant, name="to-vm")
        self._term(tunnel, self._dev("fw-ams", self.ams))
        ctype = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c", type=ctype)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vpn-vm", cluster=cluster, site=self.lon
        )
        TunnelTermination.objects.create(
            tunnel=tunnel, vm_interface=VMInterface.objects.create(vm=vm, name="eth0")
        )
        z = self.edge("tunnel")["links"][0]["z"]
        self.assertEqual(z["virtual_machine"], {"id": str(vm.id), "name": "vpn-vm"})
        self.assertEqual(z["port"]["kind"], "vm_interface")
        self._viewer((["site", "tunnel", "device"], None))
        resp = self._get("/api/site-map/connections/?include=capacity")
        z = resp.json()["connections"][0]["links"][0]["z"]
        self.assertTrue(z["restricted"])
        self.assertNotIn(b"vpn-vm", resp.content)


class CableTests(_MapBase):
    def setUp(self):
        super().setUp()
        self.sw_ams = self._dev("sw-ams", self.ams)
        self.sw_lon = self._dev("sw-lon", self.lon)
        self.n = 0

    def _ports(self, speed_a="10G", speed_b="10G"):
        self.n += 1
        return (self._iface(self.sw_ams, f"Te1/0/{self.n}", speed_a),
                self._iface(self.sw_lon, f"Te1/0/{self.n}", speed_b))

    def _direct(self, speed_a="10G", speed_b="10G"):
        a, b = self._ports(speed_a, speed_b)
        return self._cable({"interface": a}, {"interface": b})

    def _trunk(self, positions=4, duplex=False, patched=(1, 2), half=(3,)):
        """Two panels joined by a rear-to-rear trunk; strands in ``patched``
        are patched to 10G switch ports at both ends, ``half`` at AMS only.
        Returns the trunk and the AMS patch cords by front port index."""
        rear_a, fronts_a = self._panel("pp-ams", self.ams, positions, duplex)
        rear_b, fronts_b = self._panel("pp-lon", self.lon, positions, duplex)
        trunk = self._cable({"rear_port": rear_a}, {"rear_port": rear_b}, label="trunk")
        cords = {}
        for i in (*patched, *half):
            a, b = self._ports()
            cords[i] = self._cable({"interface": a}, {"front_port": fronts_a[i - 1]})
            if i in patched:
                self._cable({"front_port": fronts_b[i - 1]}, {"interface": b})
        return trunk, cords

    def test_two_cables_between_a_pair_read_two_by_ten(self):
        self._direct()
        self._direct()
        edge = self.edge("cable")
        self.assertEqual(edge["capacity"], {
            "kbps": 2 * TEN_G, "up_kbps": None, "source": "cable", "label": "2×10G",
            "count": 2, "unknown": 0,
        })
        self.assertEqual(edge["link_count"], 2)
        link = edge["links"][0]
        self.assertEqual(link["a"]["device"]["name"], "sw-ams")
        self.assertEqual(link["z"]["device"]["name"], "sw-lon")
        self.assertEqual(link["capacity"]["source"], "cable")
        self.assertEqual(link["a"]["site_id"], str(self.ams.id))

    def test_the_slower_end_wins_and_unknown_links_count_apart(self):
        self._direct("10G", "1G")
        self._direct("", "")
        cap = self.edge("cable")["capacity"]
        self.assertEqual(
            (cap["kbps"], cap["label"], cap["count"], cap["unknown"]), (ONE_G, "1G", 1, 1)
        )

    def test_the_links_follow_the_line_not_the_cable_ends(self):
        # Cables drawn either way round all list their ends in the line's
        # site_a → site_z order.
        a, b = self._ports("10G", "1G")
        self._direct()
        self._cable({"interface": b}, {"interface": a})
        edge = self.edge("cable")
        for link in edge["links"]:
            self.assertEqual(link["a"]["site_id"], edge["site_a"]["id"])
            self.assertEqual(link["z"]["site_id"], edge["site_z"]["id"])
        self.assertEqual(edge["capacity"]["label"], "11G")

    def test_a_trunk_walks_through_the_panels_and_adds_its_links_up(self):
        trunk, cords = self._trunk()
        edge = self.edge("cable")
        self.assertEqual(edge["meta"]["count"], 1)
        self.assertEqual(
            (edge["capacity"]["label"], edge["capacity"]["count"], edge["capacity"]["unknown"]),
            ("2×10G", 2, 0),
        )
        names = {(lk["a"]["device"]["name"], lk["z"]["device"]["name"]) for lk in edge["links"]}
        self.assertEqual(names, {("sw-ams", "sw-lon")})
        self.assertEqual({lk["cable_id"] for lk in edge["links"]}, {str(trunk.id)})

        rows = {row["id"]: row for row in self.cables()}
        self.assertEqual(rows[str(trunk.id)]["capacity"]["label"], "2×10G")
        cord = rows[str(cords[1].id)]
        self.assertEqual(cord["capacity"]["label"], "10G")
        self.assertEqual(cord["links"][0]["z"]["device"]["name"], "sw-lon")
        # Patched at AMS only: the strand stops dark in the LON panel.
        dark = rows[str(cords[3].id)]
        self.assertEqual((dark["capacity"], dark["links"], dark["link_count"]), (None, [], 0))

    def test_a_duplex_connector_is_one_link(self):
        self._trunk(positions=4, duplex=True, patched=(1, 2), half=())
        cap = self.edge("cable")["capacity"]
        self.assertEqual((cap["label"], cap["count"]), ("2×10G", 2))

    def _multi(self, a_ports, b_ports, label="bundle"):
        """One cable with every port of ``a_ports`` on its A end and of
        ``b_ports`` on its B end, in that order."""
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        for end, ports in (("A", a_ports), ("B", b_ports)):
            for port in ports:
                CableTermination.objects.create(cable=cable, end=end, interface=port)
        return cable

    def test_a_multi_port_cable_is_one_link_per_position(self):
        # 2+2 ports are two links, not the four A×B pairs (#312).
        (a1, b1), (a2, b2) = self._ports(), self._ports()
        cable = self._multi([a1, a2], [b1, b2])
        edge = self.edge("cable")
        self.assertEqual(edge["link_count"], 2)
        self.assertEqual(
            (edge["capacity"]["kbps"], edge["capacity"]["label"]), (2 * TEN_G, "2×10G")
        )
        pairs = {(lk["a"]["port"]["id"], lk["z"]["port"]["id"]) for lk in edge["links"]}
        self.assertEqual(pairs, {(str(a1.id), str(b1.id)), (str(a2.id), str(b2.id))})
        row = next(r for r in self.cables() if r["id"] == str(cable.id))
        self.assertEqual((row["link_count"], row["capacity"]["label"]), (2, "2×10G"))

    def test_uneven_multi_port_ends_pair_up_to_the_shorter_end(self):
        (a1, b1), (a2, b2), (_a3, b3) = self._ports(), self._ports(), self._ports()
        self._multi([a1, a2], [b1, b2, b3])
        edge = self.edge("cable")
        self.assertEqual((edge["link_count"], edge["capacity"]["label"]), (2, "2×10G"))

    def test_a_breakout_fans_out_from_its_single_port(self):
        # One 40G port broken out to four 10G ports carries four links.
        qsfp = self._iface(self.sw_ams, "Fo1/1", "40G")
        lanes = [self._iface(self.sw_lon, f"Te2/{i}", "10G") for i in range(4)]
        self._multi([qsfp], lanes)
        edge = self.edge("cable")
        self.assertEqual((edge["link_count"], edge["capacity"]["label"]), (4, "4×10G"))

    def test_a_multi_port_cable_behind_a_panel_follows_its_own_position(self):
        # A rear-to-rear trunk patched at LON with a two-port cord: each
        # strand comes out on the cord's port in its position only.
        rear_a, fronts_a = self._panel("pp-ams", self.ams, positions=2)
        rear_b, fronts_b = self._panel("pp-lon", self.lon, positions=2)
        self._cable({"rear_port": rear_a}, {"rear_port": rear_b}, label="trunk")
        (a1, b1), (a2, b2) = self._ports(), self._ports()
        for i, a in enumerate((a1, a2)):
            self._cable({"interface": a}, {"front_port": fronts_a[i]})
        cord = Cable.objects.create(tenant=self.tenant, label="cord")
        for front in fronts_b:
            CableTermination.objects.create(cable=cord, end="A", front_port=front)
        for port in (b1, b2):
            CableTermination.objects.create(cable=cord, end="B", interface=port)
        edge = self.edge("cable")
        pairs = {(lk["a"]["port"]["id"], lk["z"]["port"]["id"]) for lk in edge["links"]}
        self.assertEqual(pairs, {(str(a1.id), str(b1.id)), (str(a2.id), str(b2.id))})

    def test_a_cable_that_leads_nowhere_counts_as_unknown(self):
        self._direct()
        rear, fronts = self._panel("pp-lon", self.lon)
        a, _ = self._ports()
        self._cable({"interface": a}, {"front_port": fronts[0]})
        cap = self.edge("cable")["capacity"]
        self.assertEqual((cap["label"], cap["count"], cap["unknown"]), ("10G", 1, 1))

    def test_a_site_limited_viewer_sees_no_far_names_or_speeds(self):
        self._direct()
        self._trunk(patched=(1,), half=())
        self._viewer((["site", "cable"], None), (["device"], [self.ams]))
        resp = self._get("/api/site-map/connections/?include=capacity")
        edge = next(e for e in resp.json()["connections"] if e["kind"] == "cable")
        self.assertIsNone(edge["capacity"])
        self.assertEqual(edge["link_count"], 2)
        for link in edge["links"]:
            self.assertEqual(link["a"]["device"]["name"], "sw-ams")
            self.assertEqual(link["z"], {
                "site_id": None, "device": None, "port": None, "restricted": True,
            })
            self.assertIsNone(link["capacity"])
        for name in (b"sw-lon", b"pp-lon"):
            self.assertNotIn(name, resp.content)
        # The cable list draws only cables whose both devices they may view.
        resp = self._get("/api/site-map/cables/?include=capacity")
        self.assertNotIn(b"sw-lon", resp.content)

    def test_another_tenant_never_shows(self):
        self._direct()
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="LON", latitude="51.5", longitude="0")
        theirs = Device.objects.create(tenant=other, name="their-sw", site=site)
        # A hand-made cross-tenant termination (the API refuses one) still
        # names nothing of the other tenant and makes no figure.
        mine = self._iface(self.sw_ams, "Te9/9", "100G")
        self._cable({"interface": mine},
                    {"interface": Interface.objects.create(device=theirs, name="x", speed="100G")})
        resp = self._get("/api/site-map/cables/?include=capacity")
        self.assertNotIn(b"their-sw", resp.content)
        resp = self._get("/api/site-map/connections/?include=capacity")
        self.assertNotIn(b"their-sw", resp.content)
        edge = next(e for e in resp.json()["connections"] if e["kind"] == "cable")
        self.assertEqual(edge["capacity"]["label"], "10G")


class QueryCountTests(_MapBase):
    """However many links the map draws, the same number of queries."""

    def _world(self, n):
        for i in range(n):
            tag = f"{len(Site.objects.all())}-{i}"
            a = Site.objects.create(tenant=self.tenant, name=f"A{tag}", latitude="1", longitude="1")
            b = Site.objects.create(tenant=self.tenant, name=f"B{tag}", latitude="2", longitude="2")
            sw_a, sw_b = self._dev(f"sw-a{tag}", a), self._dev(f"sw-b{tag}", b)
            # A circuit cabled at both ends, a tunnel, a direct cable and a
            # trunk with two patched strands.
            circuit = Circuit.objects.create(tenant=self.tenant, provider=self.provider, cid=tag)
            for side, site, sw in (("A", a, sw_a), ("Z", b, sw_b)):
                term = CircuitTermination.objects.create(circuit=circuit, term_side=side, site=site)
                self._cable({"circuit_termination": term},
                            {"interface": self._iface(sw, f"wan{side}", "1G")})
            tunnel = Tunnel.objects.create(tenant=self.tenant, name=f"t{tag}", capacity_kbps=5)
            for sw in (sw_a, sw_b):
                TunnelTermination.objects.create(
                    tunnel=tunnel, interface=self._iface(sw, "tun0")
                )
            self._cable({"interface": self._iface(sw_a, "d0", "10G")},
                        {"interface": self._iface(sw_b, "d0", "10G")})
            rear_a, fronts_a = self._panel(f"pp-a{tag}", a)
            rear_b, fronts_b = self._panel(f"pp-b{tag}", b)
            self._cable({"rear_port": rear_a}, {"rear_port": rear_b})
            for k in (0, 1):
                self._cable({"interface": self._iface(sw_a, f"p{k}", "10G")},
                            {"front_port": fronts_a[k]})
                self._cable({"front_port": fronts_b[k]},
                            {"interface": self._iface(sw_b, f"p{k}", "10G")})

    def _count(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200, resp.content)
        return len(ctx.captured_queries), resp.json()

    def _counts(self):
        urls = ("/api/site-map/connections/?include=capacity",
                "/api/site-map/cables/?include=capacity")
        return [self._count(url) for url in urls]

    def test_flat_in_the_number_of_links(self):
        self._world(1)
        small = self._counts()
        self._world(5)
        big = self._counts()
        self.assertEqual([c for c, _ in small], [c for c, _ in big])
        edges = big[0][1]["connections"]
        self.assertEqual(len([e for e in edges if e["kind"] == "circuit"]), 6)
        trunk_pairs = [e for e in edges if e["kind"] == "cable"]
        self.assertTrue(all(e["capacity"]["label"] == "3×10G" for e in trunk_pairs))

        # The same for a viewer whose grants are narrowed to sites.
        sites = list(Site.objects.filter(name__startswith="A"))
        self._viewer((["site", "circuit", "tunnel", "cable"], None), (["device"], sites))
        narrowed = self._counts()
        self._world(2)
        self.assertEqual([c for c, _ in narrowed], [c for c, _ in self._counts()])
