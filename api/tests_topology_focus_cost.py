"""The focused topology map (``?device=<id>&depth=N``, the device page's Map
tab) and the filtered map load only the cables around the devices they
return, never the whole tenant's cable table (#223) - and still produce
exactly the graph the whole-tenant build does."""
from __future__ import annotations

import json
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import topology_views as tv
from .models import (
    Cable,
    CableTermination,
    Circuit,
    CircuitTermination,
    ConsolePort,
    ConsoleServerPort,
    Device,
    DeviceRole,
    FrontPort,
    Interface,
    PowerFeed,
    PowerPanel,
    PowerPort,
    Provider,
    RearPort,
    Site,
)

User = get_user_model()

_POINT_KW = (
    (Interface, "interface"),
    (FrontPort, "front_port"),
    (RearPort, "rear_port"),
    (ConsolePort, "console_port"),
    (ConsoleServerPort, "console_server_port"),
    (PowerPort, "power_port"),
    (PowerFeed, "power_feed"),
    (CircuitTermination, "circuit_termination"),
)


class _FabricBase(APITestCase):
    """A small fabric exercising every path the builder resolves: direct
    links, a two-panel trunk carrying several strands, a dangling strand, a
    panel rear cabled straight to a device, a circuit, a console link, a
    splitter tree, a multi-termination cable, a LAG member, a power feed and
    a cross-site link."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self._n = 0
        self._build_fabric()

    # ── helpers ────────────────────────────────────────────────────────────
    def _dev(self, name, site=None, role=None):
        d = Device.objects.create(tenant=self.tenant, name=name, site=site, role=role)
        self.devs[name] = d
        return d

    def _if(self, dev, name, **kw):
        return Interface.objects.create(device=dev, name=name, **kw)

    def _cable(self, a, b):
        """``a``/``b`` are a point or a list of points (multi-termination)."""
        self._n += 1
        cab = Cable.objects.create(tenant=self.tenant, label=f"c{self._n:03d}")
        for end, points in (("A", a), ("B", b)):
            for point in points if isinstance(points, list) else [points]:
                kw = next(k for cls, k in _POINT_KW if isinstance(point, cls))
                CableTermination.objects.create(cable=cab, end=end, **{kw: point})
        return cab

    def _panel(self, name, positions=12, fronts=3, site=None, role=None):
        dev = self._dev(name, site=site, role=role)
        rear = RearPort.objects.create(device=dev, name="rear", positions=positions)
        fs = [
            FrontPort.objects.create(
                device=dev, name=f"f{i}", rear_port=rear, rear_port_position=i
            )
            for i in range(1, fronts + 1)
        ]
        return dev, rear, fs

    def _build_fabric(self):
        self.devs = {}
        t = self.tenant
        self.s1 = Site.objects.create(tenant=t, name="S1")
        self.s2 = Site.objects.create(tenant=t, name="S2")
        self.r_sw = DeviceRole.objects.create(tenant=t, name="switch", slug="switch")
        self.r_pp = DeviceRole.objects.create(
            tenant=t, name="panel", slug="panel", is_patch_panel=True
        )
        sw1 = self._dev("sw1", self.s1, self.r_sw)
        sw2 = self._dev("sw2", self.s1, self.r_sw)
        sw3 = self._dev("sw3", self.s1, self.r_sw)
        srv1 = self._dev("srv1", self.s1)
        srv2 = self._dev("srv2", self.s1)
        srv3 = self._dev("srv3", self.s1)
        cs1 = self._dev("cs1", self.s1)
        rtr = self._dev("rtr", self.s2, self.r_sw)
        olt = self._dev("olt", self.s2)
        ont1 = self._dev("ont1", self.s2)
        ont2 = self._dev("ont2", self.s2)
        p1, p1r, p1f = self._panel("p1", site=self.s1, role=self.r_pp)
        p2, p2r, p2f = self._panel("p2", site=self.s1)
        p3, p3r, p3f = self._panel("p3", fronts=1, site=self.s2)
        spl = self._dev("spl", self.s2)
        spl_in = RearPort.objects.create(
            device=spl, name="in", positions=1, is_splitter=True
        )
        spl_out = [
            FrontPort.objects.create(
                device=spl, name=f"out{i}", rear_port=spl_in, rear_port_position=1
            )
            for i in (1, 2)
        ]

        po1 = self._if(sw1, "po1")
        self._cable(self._if(sw1, "e1", lag=po1, speed="10G"), self._if(sw2, "e1"))
        self._cable(self._if(sw2, "e2"), self._if(sw3, "e1"))
        self._cable(self._if(sw1, "e2"), self._if(srv1, "eth0"))
        # Trunk p1.rear <-> p2.rear carrying three strands.
        self._cable(self._if(srv2, "eth0"), p1f[0])
        self._cable(p1r, p2r)
        self._cable(p2f[0], self._if(sw3, "e2"))
        self._cable(p1f[1], self._if(srv3, "eth0"))
        self._cable(p2f[1], self._if(sw1, "e3"))
        # p1.f3 is uncabled: the run from sw2 ends AT p1 (dangling).
        self._cable(p2f[2], self._if(sw2, "e3"))
        # Panel rear straight onto a device port.
        self._cable(self._if(srv1, "eth1"), p3f[0])
        self._cable(p3r, self._if(sw2, "e7"))
        # Circuit between sw3 and rtr.
        prov = Provider.objects.create(tenant=t, name="Telco", slug="telco")
        cir = Circuit.objects.create(tenant=t, cid="CIR-1", provider=prov)
        self.circuit = cir
        ta = CircuitTermination.objects.create(circuit=cir, term_side="A", site=self.s1)
        tz = CircuitTermination.objects.create(circuit=cir, term_side="Z", site=self.s2)
        self._cable(self._if(sw3, "e3"), ta)
        self._cable(tz, self._if(rtr, "e1"))
        # Console.
        self._cable(
            ConsolePort.objects.create(device=sw1, name="con0"),
            ConsoleServerPort.objects.create(device=cs1, name="csp1"),
        )
        # Splitter tree.
        self._cable(self._if(olt, "pon1"), spl_in)
        self._cable(spl_out[0], self._if(ont1, "pon0"))
        self._cable(spl_out[1], self._if(ont2, "pon0"))
        # Multi-termination cable.
        self._cable([self._if(sw2, "e5"), self._if(sw2, "e6")], self._if(rtr, "e2"))
        # Power feed (no device on the far end).
        panel = PowerPanel.objects.create(tenant=t, site=self.s1, name="PP-1")
        feed = PowerFeed.objects.create(tenant=t, power_panel=panel, name="FEED-A")
        self._cable(PowerPort.objects.create(device=sw3, name="psu0"), feed)
        # Cross-site.
        self._cable(self._if(rtr, "e3"), self._if(sw1, "e4"))

    def _unrelated_pairs(self, count, start=0):
        for i in range(start, start + count):
            a = self._dev(f"u{i:03d}a", self.s2)
            b = self._dev(f"u{i:03d}b", self.s2)
            self._cable(self._if(a, "eth0"), self._if(b, "eth0"))

    def _norm(self, payload):
        """JSON with every run-specific UUID swapped for a stable name, so the
        same fabric compares byte-for-byte across test runs."""
        s = json.dumps(payload, sort_keys=False)
        for name, d in self.devs.items():
            s = s.replace(str(d.id), f"<dev {name}>")
        for c in Cable.objects.filter(tenant=self.tenant):
            s = s.replace(str(c.id), f"<cable {c.label}>")
        for i in Interface.objects.filter(device__tenant=self.tenant):
            s = s.replace(str(i.id), f"<if {i.device.name}:{i.name}>")
        s = s.replace(str(self.circuit.id), "<circuit>")
        for label, obj in (("s1", self.s1), ("s2", self.s2), ("r_sw", self.r_sw),
                           ("r_pp", self.r_pp)):
            s = s.replace(str(obj.id), f"<{label}>")
        return s

    # Every request shape the builder serves, as (label, callable).
    def _shapes(self):
        from .topology_views import device_trace_map, trace_device_graph

        shapes = []
        get = self.client.get
        shapes.append(("full", lambda: get("/api/topology/").json()))
        shapes.append(("raw", lambda: get("/api/topology/?collapse_panels=0").json()))
        for qs in (f"site={self.s1.id}", f"site={self.s2.id}", f"role={self.r_sw.id}",
                   f"role={self.r_pp.id}", "group_by=site", "group_by=location"):
            for c in ("1", "0"):
                shapes.append((
                    f"{qs}&c={c}",
                    lambda qs=qs, c=c: get(f"/api/topology/?{qs}&collapse_panels={c}").json(),
                ))
        for c in ("1", "0"):
            shapes.append((
                f"summary c={c}",
                lambda c=c: get(f"/api/topology/summary/?collapse_panels={c}").json(),
            ))
            shapes.append((
                f"summary site c={c}",
                lambda c=c: get(
                    f"/api/topology/summary/?site={self.s1.id}&collapse_panels={c}"
                ).json(),
            ))
        some = ",".join(str(self.devs[n].id) for n in ("sw1", "p1", "srv2", "rtr"))
        shapes.append(("devices", lambda: get(f"/api/topology/?devices={some}").json()))
        shapes.append(("devices empty", lambda: get("/api/topology/?devices=").json()))
        for name in sorted(self.devs):
            did = self.devs[name].id
            for depth in (1, 2, 3, 6):
                for c in ("1", "0"):
                    shapes.append((
                        f"focus {name} d={depth} c={c}",
                        lambda did=did, depth=depth, c=c: get(
                            f"/api/topology/?device={did}&depth={depth}"
                            f"&collapse_panels={c}"
                        ).json(),
                    ))
            shapes.append((
                f"trace_map {name}",
                lambda d=self.devs[name]: device_trace_map(d),
            ))
            shapes.append((
                f"trace_map scoped {name}",
                lambda d=self.devs[name]: device_trace_map(d, scope_q=Q(site=self.s1)),
            ))
        # Scoped (RBAC row/site) builds, focused and not.
        for c in (True, False):
            shapes.append((
                f"scope c={c}",
                lambda c=c: tv._build_graph(self.tenant, collapse=c, scope_q=Q(site=self.s1)),
            ))
            shapes.append((
                f"scope+filter c={c}",
                lambda c=c: tv._build_graph(
                    self.tenant, device_filter_q=Q(role=self.r_sw), collapse=c,
                    scope_q=Q(site=self.s1),
                ),
            ))
            shapes.append((
                f"scope focus sw1 c={c}",
                lambda c=c: tv._build_graph(
                    self.tenant, focus_id=str(self.devs["sw1"].id), depth=2,
                    collapse=c, scope_q=Q(site=self.s1),
                ),
            ))
        shapes.append((
            "trace_device_graph",
            lambda: trace_device_graph(
                self.tenant,
                {"nodes": [{"type": "device", "data": {"device_id": str(self.devs[n].id)}}
                           for n in ("srv2", "p1", "p2", "sw3")],
                 "edges": []},
            ),
        ))
        return shapes


class FocusedMapMatchesWholeTenantBuild(_FabricBase):
    """The narrowed loader must yield exactly what building from every cable
    in the tenant yields, for every request shape."""

    def test_every_shape_matches_whole_tenant_build(self):
        self._unrelated_pairs(3)
        narrowed = {label: self._norm(fn()) for label, fn in self._shapes()}
        # Force the whole-tenant path: the reference the narrowed loader must
        # reproduce.
        with mock.patch.object(tv, "_narrowed_graph", side_effect=AssertionError):
            with mock.patch.object(tv, "_wants_narrowing", return_value=False):
                whole = {label: self._norm(fn()) for label, fn in self._shapes()}
        self.assertEqual(narrowed.keys(), whole.keys())
        for label in narrowed:
            self.assertEqual(narrowed[label], whole[label], label)

    def test_focused_map_hand_computed(self):
        # srv2's 1-hop neighbourhood: sw3 through both panels (collapsed).
        g = self.client.get(
            f"/api/topology/?device={self.devs['srv2'].id}&depth=1"
        ).json()
        names = {n["data"]["name"] for n in g["nodes"]}
        self.assertEqual(names, {"srv2", "sw3"})
        self.assertEqual(len(g["edges"]), 1)
        self.assertEqual(g["edges"][0]["data"]["via"], ["p2", "p1"])
        sw3 = next(n for n in g["nodes"] if n["data"]["name"] == "sw3")
        # sw3's node keeps every cabled port, including ones whose far end is
        # outside the returned neighbourhood.
        self.assertEqual(
            {p["name"] for p in sw3["data"]["ports"]}, {"e1", "e2", "e3"}
        )

    def test_focus_on_panel_raw_neighbourhood(self):
        g = self.client.get(f"/api/topology/?device={self.devs['p1'].id}").json()
        names = {n["data"]["name"] for n in g["nodes"]}
        self.assertEqual(names, {"p1", "p2", "srv2", "srv3"})


class FocusedMapCostTests(_FabricBase):
    """#223: the focused map's work scales with the neighbourhood, not with
    the tenant's cable table."""

    def _measure(self):
        seen = []
        real = tv._links_from_cables

        def spy(cables):
            cables = list(cables)
            seen.append(len(cables))
            return real(cables)

        url = f"/api/topology/?device={self.devs['srv2'].id}&depth=1"
        with mock.patch.object(tv, "_links_from_cables", side_effect=spy):
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
        self.assertEqual(r.status_code, 200)
        return len(ctx.captured_queries), sum(seen), r.json()

    def test_focused_cost_ignores_unrelated_cables(self):
        self._unrelated_pairs(5)
        q_before, cables_before, g_before = self._measure()
        self._unrelated_pairs(20, start=5)
        q_after, cables_after, g_after = self._measure()
        self.assertLessEqual(q_after, q_before)
        self.assertEqual(cables_after, cables_before)
        self.assertEqual(g_after, g_before)
        # And far fewer cables than the tenant holds.
        self.assertLess(cables_after, Cable.objects.filter(tenant=self.tenant).count() // 2)

    def test_foreign_tenant_cables_never_loaded(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        a = Device.objects.create(tenant=other, name="x")
        b = Device.objects.create(tenant=other, name="y")
        cab = Cable.objects.create(tenant=other)
        CableTermination.objects.create(
            cable=cab, end="A", interface=Interface.objects.create(device=a, name="e")
        )
        CableTermination.objects.create(
            cable=cab, end="B", interface=Interface.objects.create(device=b, name="e")
        )
        g = tv._build_graph(self.tenant, focus_id=str(a.id), depth=2)
        self.assertEqual(g, {"nodes": [], "edges": []})
