"""Topology graph v2: port-carrying stencil nodes, panel collapse (end-to-end
edges through patch panels with `via`), focus+depth, filters, saved views."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .models import (
    Cable, CableTermination, Device, DeviceRole, FrontPort, Interface,
    RearPort, Site,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _cable(self, a, b):
        from .models import ConsolePort, PowerOutlet, PowerPort

        cab = Cable.objects.create(tenant=self.tenant)
        for end, point in (("A", a), ("B", b)):
            kwargs = {"cable": cab, "end": end}
            if isinstance(point, Interface):
                kwargs["interface"] = point
            elif isinstance(point, FrontPort):
                kwargs["front_port"] = point
            elif isinstance(point, RearPort):
                kwargs["rear_port"] = point
            elif isinstance(point, ConsolePort):
                kwargs["console_port"] = point
            elif isinstance(point, PowerPort):
                kwargs["power_port"] = point
            elif isinstance(point, PowerOutlet):
                kwargs["power_outlet"] = point
            CableTermination.objects.create(**kwargs)
        return cab

    def _graph(self, qs=""):
        return self.client.get(f"/api/topology/?{qs}").json()


class DirectLinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = Device.objects.create(tenant=self.tenant, name="sw-a")
        self.b = Device.objects.create(tenant=self.tenant, name="sw-b")
        self.ia = Interface.objects.create(device=self.a, name="eth0")
        self.ib = Interface.objects.create(device=self.b, name="eth7")
        self._cable(self.ia, self.ib)

    def test_edge_carries_port_anchors(self):
        g = self._graph()
        self.assertEqual(len(g["edges"]), 1)
        pair = g["edges"][0]["data"]["pairs"][0]
        # a_port/b_port align with the edge's source/target devices.
        src = g["edges"][0]["source"][4:]
        a_dev = self.a if src == str(self.a.id) else self.b
        self.assertEqual(pair["a_port"], "eth0" if a_dev == self.a else "eth7")
        self.assertEqual(pair["b_port"], "eth7" if a_dev == self.a else "eth0")

    def test_nodes_carry_cabled_ports(self):
        g = self._graph()
        by_name = {n["data"]["name"]: n["data"] for n in g["nodes"]}
        self.assertEqual(
            by_name["sw-a"]["ports"], [{"name": "eth0", "kind": "interface"}]
        )
        self.assertFalse(by_name["sw-a"]["panel"])


class PanelCollapseTests(_Base):
    """server:eth0 —cable— panel-A.front1 (rear1) —trunk— panel-B (rear1)
    front1 —cable— switch:gi1. Collapsed: ONE edge server↔switch via both
    panels. Raw: three hops with the panels as nodes."""

    def setUp(self):
        super().setUp()
        self.server = Device.objects.create(tenant=self.tenant, name="server")
        self.switch = Device.objects.create(tenant=self.tenant, name="switch")
        self.pa = Device.objects.create(tenant=self.tenant, name="panel-a")
        self.pb = Device.objects.create(tenant=self.tenant, name="panel-b")
        self.s_eth = Interface.objects.create(device=self.server, name="eth0")
        self.w_gi = Interface.objects.create(device=self.switch, name="gi1")
        # panel-a: front1 → rear (pos 1); panel-b mirrored.
        self.ra = RearPort.objects.create(device=self.pa, name="rear", positions=12)
        self.fa = FrontPort.objects.create(
            device=self.pa, name="front1", rear_port=self.ra, rear_port_position=1
        )
        self.rb = RearPort.objects.create(device=self.pb, name="rear", positions=12)
        self.fb = FrontPort.objects.create(
            device=self.pb, name="front1", rear_port=self.rb, rear_port_position=1
        )
        self._cable(self.s_eth, self.fa)
        self._cable(self.ra, self.rb)  # trunk
        self._cable(self.fb, self.w_gi)

    def test_collapsed_end_to_end(self):
        g = self._graph("collapse_panels=1")
        # Fully-consumed panels drop off the collapsed map entirely — no
        # portless husks floating around.
        names = {n["data"]["name"] for n in g["nodes"]}
        self.assertEqual(names, {"server", "switch"})
        self.assertEqual(len(g["edges"]), 1)
        e = g["edges"][0]["data"]
        self.assertEqual(set(e["via"]), {"panel-a", "panel-b"})
        ports = {e["pairs"][0]["a_port"], e["pairs"][0]["b_port"]}
        self.assertEqual(ports, {"eth0", "gi1"})

    def test_focus_on_panel_shows_it_and_neighbours(self):
        # Regression: focusing the map ON a panel used to collapse it through
        # and return an empty graph even though it has cables. It must show the
        # panel plus the devices cabled to it (device page Map tab).
        from api.topology_views import device_trace_map

        g = device_trace_map(self.pa)
        names = {n["data"]["name"] for n in g["nodes"]}
        self.assertIn("panel-a", names)
        self.assertIn("server", names)  # front1 neighbour
        self.assertGreaterEqual(len(g["edges"]), 1)

    def test_raw_mode_pairs_front_and_rear_rows(self):
        # A cabled front port and its cabled strand rear port share a row.
        g = self._graph("collapse_panels=0")
        pa = next(n for n in g["nodes"] if n["data"]["name"] == "panel-a")
        merged = next(p for p in pa["data"]["ports"] if p["name"] == "front1")
        self.assertEqual(merged["pair"], "rear")
        # The rear port doesn't render its own solo row too.
        names = [p["name"] for p in pa["data"]["ports"]]
        self.assertNotIn("rear", names)

    def test_raw_mode_shows_panels(self):
        g = self._graph("collapse_panels=0")
        by_name = {n["data"]["name"]: n["data"] for n in g["nodes"]}
        self.assertEqual(len(g["edges"]), 3)
        self.assertTrue(by_name["panel-a"]["panel"])
        self.assertFalse(by_name["server"]["panel"])

    def test_device_paths_strip(self):
        data = self.client.get(f"/api/devices/{self.server.id}/paths/").json()
        self.assertEqual(len(data["runs"]), 1)
        run = data["runs"][0]
        self.assertEqual(run["origin"], {"name": "eth0", "kind": "interface"})
        self.assertTrue(run["complete"])
        chips = [st for st in run["steps"] if st["t"] == "chip"]
        segs = [st for st in run["steps"] if st["t"] == "seg"]
        # The run now opens with this device as an origin-flagged chip.
        self.assertEqual(
            [c["device"] for c in chips],
            ["server", "panel-a", "panel-b", "switch"],
        )
        self.assertTrue(chips[0]["origin"])
        self.assertEqual(chips[0]["device"], "server")
        self.assertNotIn("origin", chips[1])
        names = lambda c: [p["name"] for p in c["ports"]]
        self.assertEqual(names(chips[0]), ["eth0"])
        self.assertEqual(names(chips[1]), ["front1", "rear"])
        self.assertEqual(names(chips[2]), ["rear", "front1"])
        self.assertEqual(names(chips[3]), ["gi1"])
        # Interface ports carry their id (click target); panel ports don't.
        self.assertIsNotNone(chips[3]["ports"][0]["interface_id"])
        self.assertIsNone(chips[1]["ports"][0]["interface_id"])
        self.assertTrue(chips[1]["panel"] and not chips[3]["panel"])
        self.assertEqual(len(segs), 3)

    def test_device_paths_dangling_incomplete(self):
        # A run whose strand's far side is uncabled is flagged incomplete.
        s2 = Device.objects.create(tenant=self.tenant, name="server-2")
        i2 = Interface.objects.create(device=s2, name="eth0")
        fa2 = FrontPort.objects.create(
            device=self.pa, name="front2", rear_port=self.ra, rear_port_position=2
        )
        self._cable(i2, fa2)
        data = self.client.get(f"/api/devices/{s2.id}/paths/").json()
        run = data["runs"][0]
        self.assertFalse(run["complete"])
        # Path ends inside panel-b (front2 uncabled there? no front2 on b →
        # strand missing at panel-b, run stops at panel-b's rear).
        last_chip = [st for st in run["steps"] if st["t"] == "chip"][-1]
        self.assertIn(last_chip["device"], ("panel-a", "panel-b"))

    def test_dangling_panel_path_ends_at_panel(self):
        # A second server cabled into panel-a front2, whose strand's far side
        # is uncabled at panel-b → edge ends at panel-b, no crash.
        s2 = Device.objects.create(tenant=self.tenant, name="server-2")
        i2 = Interface.objects.create(device=s2, name="eth0")
        fa2 = FrontPort.objects.create(
            device=self.pa, name="front2", rear_port=self.ra, rear_port_position=2
        )
        FrontPort.objects.create(
            device=self.pb, name="front2", rear_port=self.rb, rear_port_position=2
        )
        self._cable(i2, fa2)
        g = self._graph("collapse_panels=1")
        # server-2's path ends at panel-b's uncabled front2.
        e2 = [
            e for e in g["edges"]
            if "server-2" in (e["data"]["pairs"][0]["a"] + e["data"]["pairs"][0]["b"])
        ]
        self.assertEqual(len(e2), 1)
        self.assertIn("panel-b", e2[0]["data"]["pairs"][0]["a"] + e2[0]["data"]["pairs"][0]["b"])


class FocusAndFilterTests(_Base):
    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="core", slug="core", color="#f00"
        )
        # chain: a — b — c — d
        self.devs = []
        prev_if = None
        for name in ("a", "b", "c", "d"):
            d = Device.objects.create(
                tenant=self.tenant, name=name, site=self.site,
                role=self.role if name == "a" else None,
            )
            self.devs.append(d)
            i_in = Interface.objects.create(device=d, name="in")
            i_out = Interface.objects.create(device=d, name="out")
            if prev_if is not None:
                self._cable(prev_if, i_in)
            prev_if = i_out

    def test_focus_depth(self):
        b = self.devs[1]
        g = self._graph(f"device={b.id}&depth=1")
        self.assertEqual(
            {n["data"]["name"] for n in g["nodes"]}, {"a", "b", "c"}
        )
        g = self._graph(f"device={b.id}&depth=2")
        self.assertEqual(
            {n["data"]["name"] for n in g["nodes"]}, {"a", "b", "c", "d"}
        )

    def test_role_filter(self):
        g = self._graph(f"role={self.role.id}")
        self.assertEqual({n["data"]["name"] for n in g["nodes"]}, {"a"})
        # Edges to out-of-scope devices are dropped with them.
        self.assertEqual(g["edges"], [])

    def test_device_map_action(self):
        b = self.devs[1]
        g = self.client.get(f"/api/devices/{b.id}/map/").json()
        self.assertEqual(
            {n["data"]["name"] for n in g["nodes"]}, {"a", "b", "c"}
        )
        # Node payload carries role color for the stencil.
        a = next(n for n in g["nodes"] if n["data"]["name"] == "a")
        self.assertEqual(a["data"]["role"]["color"], "#f00")


class SavedViewTests(_Base):
    def test_crud_and_tenant_scope(self):
        resp = self.client.post(
            "/api/topology-views/",
            {"name": "core row", "state": {
                "filters": {"site": "x", "collapse": True},
                "positions": {"dev:abc": [100, 200]},
            }},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        vid = resp.json()["id"]
        got = self.client.get(f"/api/topology-views/{vid}/").json()
        self.assertEqual(got["state"]["positions"]["dev:abc"], [100, 200])
        # Rename + reposition.
        resp = self.client.patch(
            f"/api/topology-views/{vid}/",
            {"state": {"filters": {}, "positions": {}}},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        # Bad state rejected.
        resp = self.client.post(
            "/api/topology-views/",
            {"name": "bad", "state": {"positions": "nope"}},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class PassThroughAndCrashTests(_Base):
    """Feature A: trace no longer crashes on console/power/aux terminations,
    and PDU outlet→inlet is a walkable pass-through (inlet→outlet is not)."""

    def test_cable_trace_to_console_port_is_200(self):
        # Previously threw AttributeError (NoneType.id) → 500.
        from .models import ConsolePort

        sw = Device.objects.create(tenant=self.tenant, name="sw")
        srv = Device.objects.create(tenant=self.tenant, name="srv")
        con = ConsolePort.objects.create(device=srv, name="console")
        ci = Interface.objects.create(device=sw, name="ge0")
        cab = self._cable(ci, con)
        r = self.client.get(f"/api/cables/{cab.id}/trace/")
        self.assertEqual(r.status_code, 200, r.content)
        names = {n["data"]["name"] for n in r.json()["nodes"]}
        self.assertTrue({"console", "ge0"} <= names)

    def test_device_paths_with_power_feed_termination_is_200(self):
        # Regression: a cable terminating on a PowerFeed (which lives on a
        # PowerPanel, not a device) 500'd /paths/ — the topology cable prefetch
        # asked for the non-existent power_feed.device. Must be 200 now.
        from .models import PowerFeed, PowerPanel, PowerPort, Site

        dev = Device.objects.create(tenant=self.tenant, name="host")
        pp = PowerPort.objects.create(device=dev, name="psu0")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        panel = PowerPanel.objects.create(tenant=self.tenant, site=site, name="PP-1")
        feed = PowerFeed.objects.create(
            tenant=self.tenant, power_panel=panel, name="FEED-A"
        )
        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", power_port=pp)
        CableTermination.objects.create(cable=cab, end="B", power_feed=feed)

        r = self.client.get(f"/api/devices/{dev.id}/paths/")
        self.assertEqual(r.status_code, 200, r.content)

    def test_interface_trace_to_power_is_200(self):
        from .models import PowerPort

        dev = Device.objects.create(tenant=self.tenant, name="host")
        pdu = Device.objects.create(tenant=self.tenant, name="pdu")
        pp = PowerPort.objects.create(device=pdu, name="inlet")
        eth = Interface.objects.create(device=dev, name="eth0")
        # An interface cabled to a power inlet is odd but must not 500.
        self._cable(eth, pp)
        r = self.client.get(f"/api/interfaces/{eth.id}/trace/")
        self.assertEqual(r.status_code, 200, r.content)

    def test_pdu_outlet_to_inlet_trace_walks_through(self):
        # server:psu0 —cable— pdu.outlet1 (inlet=inlet0) ; pdu.inlet0 —cable—
        # ups:out1. Tracing the server PSU cable must reach the UPS *through*
        # the PDU (outlet→inlet is a walkable pass-through). The map keeps the
        # PDU visible (see test_pdu_stays_visible_not_dropped) — only the
        # trace walks power.
        from .models import PowerPort, PowerOutlet

        server = Device.objects.create(tenant=self.tenant, name="server")
        pdu = Device.objects.create(tenant=self.tenant, name="pdu")
        ups = Device.objects.create(tenant=self.tenant, name="ups")
        s_psu = PowerPort.objects.create(device=server, name="psu0")
        inlet = PowerPort.objects.create(device=pdu, name="inlet0")
        outlet = PowerOutlet.objects.create(
            device=pdu, name="outlet1", power_port=inlet
        )
        ups_out = PowerOutlet.objects.create(device=ups, name="out1")
        cab = self._cable(s_psu, outlet)
        self._cable(inlet, ups_out)
        g = self.client.get(f"/api/cables/{cab.id}/trace/").json()
        names = {n["data"]["device_name"] for n in g["nodes"]
                 if "device_name" in n["data"]}
        # The trace reached all three devices via the outlet→inlet strand.
        self.assertTrue({"server", "pdu", "ups"} <= names, names)

    def test_pdu_stays_visible_not_dropped(self):
        # A device whose only cabled ends are power ports is a real node
        # (PDUs are only a partial pass-through), never collapsed away.
        from .models import PowerPort, PowerOutlet

        pdu = Device.objects.create(tenant=self.tenant, name="lonely-pdu")
        ups = Device.objects.create(tenant=self.tenant, name="ups2")
        inlet = PowerPort.objects.create(device=pdu, name="inlet0")
        ups_out = PowerOutlet.objects.create(device=ups, name="out1")
        self._cable(inlet, ups_out)
        g = self._graph("collapse_panels=1")
        self.assertIn("lonely-pdu", {n["data"]["name"] for n in g["nodes"]})


class TopologySplitterTests(_Base):
    """Splitters are real nodes in the topology map — never collapsed like a
    patch panel, with the feeder and every drop as direct edges."""

    def _splitter(self, name="spl", outputs=2):
        dev = Device.objects.create(tenant=self.tenant, name=name)
        rear = RearPort.objects.create(
            device=dev, name="in", positions=1, is_splitter=True
        )
        fronts = [
            FrontPort.objects.create(
                device=dev, name=f"out{i}", rear_port=rear,
                rear_port_position=1,
            )
            for i in range(1, outputs + 1)
        ]
        return dev, rear, fronts

    def _edge_pairs(self, g):
        names = {n["id"]: n["data"]["name"] for n in g["nodes"]}
        return {
            tuple(sorted((names[e["source"]], names[e["target"]])))
            for e in g["edges"]
        }

    def test_pon_tree_keeps_splitter_node(self):
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        spl, rear, fronts = self._splitter(outputs=2)
        self._cable(olt_if, rear)
        for i, f in enumerate(fronts, 1):
            ont = Device.objects.create(tenant=self.tenant, name=f"ont-{i}")
            self._cable(f, Interface.objects.create(device=ont, name="pon0"))
        g = self._graph("collapse_panels=1")
        names = {n["data"]["name"] for n in g["nodes"]}
        self.assertIn("spl", names)
        pairs = self._edge_pairs(g)
        self.assertIn(("olt", "spl"), pairs)
        self.assertIn(("ont-1", "spl"), pairs)
        self.assertIn(("ont-2", "spl"), pairs)

    def test_splitter_cascade_edge_survives_collapse(self):
        # SPL1 out1 —cable— SPL2 in: both ends are splitter-side ports; the
        # old panel-panel skip would have dropped this edge entirely.
        s1, r1, f1s = self._splitter("spl-1", outputs=1)
        s2, r2, _ = self._splitter("spl-2", outputs=1)
        self._cable(f1s[0], r2)
        g = self._graph("collapse_panels=1")
        self.assertIn(("spl-1", "spl-2"), self._edge_pairs(g))

    def test_splitter_behind_panel_stops_walk(self):
        # OLT — panel front1 (rear pos1) — cable — splitter in. Collapse
        # walks THROUGH the panel but must stop AT the splitter.
        olt = Device.objects.create(tenant=self.tenant, name="olt")
        olt_if = Interface.objects.create(device=olt, name="pon1")
        panel = Device.objects.create(tenant=self.tenant, name="panel")
        rear = RearPort.objects.create(device=panel, name="r", positions=12)
        front = FrontPort.objects.create(
            device=panel, name="f1", rear_port=rear, rear_port_position=1
        )
        spl, srear, fronts = self._splitter(outputs=1)
        self._cable(olt_if, front)
        self._cable(rear, srear)
        ont = Device.objects.create(tenant=self.tenant, name="ont-1")
        self._cable(
            fronts[0], Interface.objects.create(device=ont, name="pon0")
        )
        g = self._graph("collapse_panels=1")
        names = {n["data"]["name"] for n in g["nodes"]}
        pairs = self._edge_pairs(g)
        self.assertIn("spl", names)
        self.assertNotIn("panel", names)  # consumed pass-through
        self.assertIn(("olt", "spl"), pairs)
        self.assertIn(("ont-1", "spl"), pairs)
