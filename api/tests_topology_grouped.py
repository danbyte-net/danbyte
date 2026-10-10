"""The grouped map (``group_by=site|location``) is computed from aggregate
queries instead of the whole device graph (#343) - and returns exactly what
grouping the device graph returned."""
from __future__ import annotations

from django.db import connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext

from auth_api import rbac

from . import topology_views as tv
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    Interface,
    Location,
    Site,
)
from .tests_topology_focus_cost import User, _FabricBase


def graph_grouped(tenant, group_by, device_filter_q=None, collapse=True,
                  scope_q=None):
    """The grouping as it was built before #343: the full device graph,
    then every device loaded again to find its group."""
    g = tv._build_graph(tenant, device_filter_q=device_filter_q,
                        collapse=collapse, scope_q=scope_q)
    base = tv._devices_qs(tenant)
    if device_filter_q is not None:
        base = base.filter(device_filter_q)
    if scope_q is not None:
        base = base.filter(scope_q)
    attr = "site" if group_by == "site" else "location"
    info = {}
    for d in base:
        obj = getattr(d, attr)
        info[str(d.id)] = (
            (str(obj.id), obj.name) if obj is not None else ("none", "Unassigned")
        )
    groups: dict = {}
    for n in g["nodes"]:
        gid, gname = info.get(n["data"]["device_id"], ("none", "Unassigned"))
        grp = groups.setdefault(gid, {"name": gname, "device_count": 0, "roles": {}})
        grp["device_count"] += 1
        role = n["data"].get("role")
        if role:
            r = grp["roles"].setdefault(
                role["name"], {"name": role["name"], "color": role["color"], "count": 0}
            )
            r["count"] += 1
    agg: dict = {}
    for e in g["edges"]:
        a = info.get(e["source"][4:], ("none", ""))[0]
        b = info.get(e["target"][4:], ("none", ""))[0]
        if a == b:
            continue
        ent = agg.setdefault(tuple(sorted((a, b))), {"cable_count": 0, "types": set()})
        ent["cable_count"] += 1
        if e["data"].get("cable_type"):
            ent["types"].add(e["data"]["cable_type"])
    nodes = [
        {
            "id": f"grp:{gid}", "type": "group",
            "data": {
                "group_id": gid if gid != "none" else None, "kind": group_by,
                "name": v["name"], "device_count": v["device_count"],
                "roles": sorted(v["roles"].values(), key=lambda r: (-r["count"], r["name"])),
            },
        }
        for gid, v in sorted(groups.items(), key=lambda kv: tv.natural_key(kv[1]["name"]))
    ]
    edges = [
        {
            "id": f"ge:{a}:{b}", "source": f"grp:{a}", "target": f"grp:{b}",
            "type": "group",
            "data": {"cable_count": v["cable_count"], "types": sorted(v["types"])},
        }
        for (a, b), v in agg.items()
    ]
    return {"nodes": nodes, "edges": edges}


def settled(graph):
    """``graph`` with same-named groups in one fixed order. The device-graph
    build listed them in whatever order the database returned its devices
    (its grouped device query has no ORDER BY), so only the order of groups
    sharing a name is not compared."""
    nodes = sorted(
        graph["nodes"],
        key=lambda n: (tv.natural_key(n["data"]["name"]), n["id"]),
    )
    return {**graph, "nodes": nodes}


class _GroupedFabric(_FabricBase):
    """The shared fabric plus what grouping cares about: a third site, two
    same-named locations, panels trunked across sites, a cable fanning out to
    three sites, a role named like another, typed cables and a device with
    no site."""

    def _build_fabric(self):
        super()._build_fabric()
        t = self.tenant
        self.s3 = Site.objects.create(tenant=t, name="S3")
        self.l1 = Location.objects.create(tenant=t, site=self.s1, name="Floor 1", slug="f1")
        self.l2 = Location.objects.create(tenant=t, site=self.s2, name="Floor 1", slug="f1")
        self.l3 = Location.objects.create(tenant=t, site=self.s3, name="Cage", slug="cage")
        Device.objects.filter(name__in=["sw1", "sw2", "p1"]).update(location=self.l1)
        Device.objects.filter(name__in=["rtr", "olt", "p3"]).update(location=self.l2)
        r_alt = DeviceRole.objects.create(
            tenant=t, name="switch", slug="switch-b", color="#ff0000"
        )
        r_srv = DeviceRole.objects.create(
            tenant=t, name="server", slug="server", color="#00ff00"
        )
        a1 = self._dev("a1", self.s3, r_alt)
        a2 = self._dev("a2", self.s3, r_srv)
        Device.objects.filter(pk__in=[a1.pk, a2.pk]).update(location=self.l3)
        loose = self._dev("loose", None, r_srv)
        # Panels trunked S1 <-> S3: a run from sw3 to a2 crosses both.
        q1, q1r, q1f = self._panel("q1", site=self.s1, role=self.r_pp)
        q2, q2r, q2f = self._panel("q2", site=self.s3)
        self._typed(self._cable(self._if(self.devs["sw3"], "x1"), q1f[0]), "smf-os2")
        self._typed(self._cable(q1r, q2r), "smf-os2")
        self._typed(self._cable(q2f[0], self._if(a2, "eth0")), "cat6")
        # A dangling strand ending at q2 (q2 keeps its node).
        self._cable(self._if(a1, "x9"), q1f[1])
        # One cable fanning out to three sites.
        self._typed(self._cable(
            self._if(self.devs["sw1"], "x2"),
            [self._if(a1, "e1"), self._if(self.devs["rtr"], "x2"), self._if(loose, "e1")],
        ), "cat6")
        # Several S1 <-> S3 plain cables, typed and untyped.
        for i in range(3):
            cab = self._cable(self._if(self.devs["sw2"], f"y{i}"), self._if(a1, f"y{i}"))
            if i:
                self._typed(cab, "dac-passive")
        self._cable(self._if(loose, "e2"), self._if(self.devs["srv1"], "e9"))

    def _typed(self, cab, kind):
        Cable.objects.filter(pk=cab.pk).update(type=kind)
        return cab


class GroupedMatchesDeviceGraph(_GroupedFabric):
    maxDiff = None

    def _cases(self):
        filters = (None, Q(site=self.s1), Q(site=self.s3), Q(role=self.r_sw),
                   Q(role=self.r_pp), Q(location=self.l1))
        scopes = (None, Q(site=self.s1), Q(site__in=[self.s1, self.s3]),
                  Q(site=self.s2) | Q(site__isnull=True))
        for group_by in ("site", "location"):
            for collapse in (True, False):
                for f in filters:
                    for s in scopes:
                        yield group_by, collapse, f, s

    def test_every_case_matches_the_device_graph(self):
        self._unrelated_pairs(3)
        for group_by, collapse, f, s in self._cases():
            kw = {"device_filter_q": f, "collapse": collapse, "scope_q": s}
            new = tv._grouped_graph(self.tenant, group_by, **kw)
            old = graph_grouped(self.tenant, group_by, **kw)
            self.assertEqual(settled(new), settled(old), (group_by, collapse, f, s))

    def test_fabric_exercises_the_cases(self):
        """Guards the parity test from passing on an empty fabric."""
        g = tv._grouped_graph(self.tenant, "site")
        by_name = {n["data"]["name"]: n["data"] for n in g["nodes"]}
        self.assertEqual(set(by_name), {"S1", "S2", "S3", "Unassigned"})
        self.assertGreaterEqual(len(g["edges"]), 3)
        # q1 is walked through and drops; q2 ends a dangling strand and stays.
        flat = tv._build_graph(self.tenant)
        names = {n["data"]["name"] for n in flat["nodes"]}
        self.assertNotIn("q1", names)
        self.assertIn("q2", names)
        self.assertEqual(
            by_name["S3"]["roles"],
            [{"name": "server", "color": "#00ff00", "count": 1},
             {"name": "switch", "color": "#ff0000", "count": 1}],
        )

    def test_api_matches_for_a_site_limited_user(self):
        from auth_api.models import ObjectPermission, UserProfile

        user = User.objects.create_user("scoped", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="s1-s3", object_types=["device"], actions=["view"],
            constraints=[{"site_id": str(self.s1.id)}, {"site_id": str(self.s3.id)}],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        scope = rbac.row_filter(user, self.tenant, "device", "view")
        self.assertNotIn(scope, (None, True))
        for group_by in ("site", "location"):
            for c in ("1", "0"):
                r = self.client.get(
                    f"/api/topology/?group_by={group_by}&collapse_panels={c}"
                )
                self.assertEqual(r.status_code, 200)
                old = graph_grouped(self.tenant, group_by, device_filter_q=Q(),
                                    collapse=c == "1", scope_q=scope)
                self.assertEqual(settled(r.json()), settled(old), (group_by, c))
            names = {n["data"]["name"] for n in r.json()["nodes"]}
            if group_by == "site":
                self.assertEqual(names, {"S1", "S3"})
            else:
                ids = {n["data"]["group_id"] for n in r.json()["nodes"]}
                self.assertIn(str(self.l1.id), ids)
                self.assertNotIn(str(self.l2.id), ids)  # S2's floor

    def test_provably_empty_scope_returns_an_empty_map(self):
        """An ``__in: []`` constraint makes the device scope provably empty,
        so Django refuses to compile it to SQL; the grouped map must answer
        with no groups rather than 500 (#368)."""
        from auth_api.models import ObjectPermission, UserProfile

        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="none", object_types=["device"], actions=["view"],
            constraints={"name__in": []},
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.assertEqual(self.client.get("/api/topology/").status_code, 200)
        for group_by in ("site", "location"):
            for c in ("1", "0"):
                r = self.client.get(
                    f"/api/topology/?group_by={group_by}&collapse_panels={c}"
                )
                self.assertEqual(r.status_code, 200, (group_by, c))
                self.assertEqual((r.json()["nodes"], r.json()["edges"]), ([], []))
        scope = rbac.row_filter(user, self.tenant, "device", "view")
        for group_by in ("site", "location"):
            g = tv._grouped_graph(self.tenant, group_by, scope_q=scope)
            self.assertEqual((g["nodes"], g["edges"]), ([], []))
        # A provably-empty filter, not only an RBAC scope.
        g = tv._grouped_graph(self.tenant, "site", device_filter_q=Q(pk__in=[]))
        self.assertEqual((g["nodes"], g["edges"]), ([], []))

    def test_other_tenants_cables_never_count(self):
        from core.models import Tenant

        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        before = tv._grouped_graph(self.tenant, "site")
        x = Device.objects.create(tenant=other, name="x", site=self.s1)
        y = Device.objects.create(tenant=other, name="y", site=self.s3)
        cab = Cable.objects.create(tenant=other)
        CableTermination.objects.create(
            cable=cab, end="A", interface=Interface.objects.create(device=x, name="e")
        )
        CableTermination.objects.create(
            cable=cab, end="B", interface=Interface.objects.create(device=y, name="e")
        )
        self.assertEqual(tv._grouped_graph(self.tenant, "site"), before)


class GroupedCostTests(_GroupedFabric):
    """#343: the grouped map's queries don't grow with the tenant."""

    def _queries(self, **kw):
        with CaptureQueriesContext(connection) as ctx:
            tv._grouped_graph(self.tenant, "site", **kw)
        return len(ctx.captured_queries)

    def _grow(self, n):
        """``n`` more devices per site, cabled across sites and through a
        fresh panel pair."""
        for i in range(n):
            a = self._dev(f"g{self._n}-{i}a", self.s1, self.r_sw)
            b = self._dev(f"g{self._n}-{i}b", self.s2)
            self._cable(self._if(a, "e0"), self._if(b, "e0"))
        _pa, ra, fa = self._panel(f"gp{self._n}a", site=self.s1)
        _pb, rb, fb = self._panel(f"gp{self._n}b", site=self.s2)
        self._cable(ra, rb)
        self._cable(self._if(a, "t0"), fa[0])
        self._cable(fb[0], self._if(b, "t0"))

    def test_query_count_does_not_grow(self):
        for kw in ({}, {"scope_q": Q(site=self.s1)}, {"collapse": False},
                   {"device_filter_q": Q(role=self.r_sw)}):
            before = self._queries(**kw)
            self._grow(15)
            after = self._queries(**kw)
            self.assertLessEqual(after, before, kw)
            self.assertLessEqual(after, 8, kw)

    def test_never_builds_the_device_graph(self):
        from unittest import mock

        with mock.patch.object(tv, "_build_graph", side_effect=AssertionError), \
                mock.patch.object(tv, "_cables_qs", side_effect=AssertionError):
            r = self.client.get("/api/topology/?group_by=site")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["nodes"])

    def test_walk_runs_without_per_panel_queries(self):
        """The full graph's walk queries each rear port it crosses; the
        grouped walk reads them from one preload."""
        with mock_rear_query() as calls:
            tv._grouped_graph(self.tenant, "site")
        self.assertEqual(calls, [])


class mock_rear_query:
    """Records calls to the shared strand lookup."""

    def __enter__(self):
        from unittest import mock

        self.calls = []
        real = tv._shared_strand_of

        def spy(*a, **kw):
            self.calls.append(a)
            return real(*a, **kw)

        self._p = mock.patch.object(tv, "_shared_strand_of", side_effect=spy)
        self._p.start()
        return self.calls

    def __exit__(self, *exc):
        self._p.stop()


class FullGraphWalkPreload(_GroupedFabric):
    """The collapse walk reads a rear port's front ports from one preload
    instead of a query per rear port crossed: every map shape the builder
    serves is unchanged, and the full map's queries stop growing with the
    panels in it."""

    def test_every_shape_unchanged(self):
        from unittest import mock

        preloaded = {label: fn() for label, fn in self._shapes()}
        with mock.patch.object(
            tv, "_preloaded_strand", side_effect=lambda links: tv._strand_of
        ):
            per_port = {label: fn() for label, fn in self._shapes()}
        self.assertEqual(preloaded.keys(), per_port.keys())
        for label in preloaded:
            self.assertEqual(preloaded[label], per_port[label], label)

    def test_full_map_queries_do_not_grow_with_panels(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                tv._build_graph(self.tenant)
            return len(ctx.captured_queries)

        before = count()
        for k in range(4):
            a = self._dev(f"m{k}a", self.s1)
            b = self._dev(f"m{k}b", self.s3)
            _pa, ra, fa = self._panel(f"mp{k}a", site=self.s1)
            _pb, rb, fb = self._panel(f"mp{k}b", site=self.s3)
            self._cable(ra, rb)
            self._cable(self._if(a, "e0"), fa[0])
            self._cable(fb[0], self._if(b, "e0"))
        self.assertLessEqual(count(), before)
