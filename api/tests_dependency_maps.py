"""Device dependencies on the maps (#450): the Topology layer and the site
map's ``?include=dependencies`` list only rows the caller may view between
devices they may view, in the active tenant."""
from __future__ import annotations

from api.models import DeviceDependency, Site
from api.tests_device_dependencies import _Base

LAYER = "/api/topology/dependencies/"
CONN = "/api/site-map/connections/"


class TopologyLayerTests(_Base):
    def setUp(self):
        super().setUp()
        self.d1 = self.dep(self.core, self.dist, medium=self.fibre, redundancy_group="up")
        self.d2 = self.dep(self.dist, self.acc)
        self.d3 = self.dep(self.core, self.remote)
        self.peer = DeviceDependency(tenant=self.tenant, upstream=self.acc,
                                     downstream=self.remote, kind="peer")
        self.peer.normalise()
        self.peer.save()

    def ids(self, body):
        return {e["id"] for e in body["edges"]}

    def test_edges_point_upstream_to_downstream(self):
        body = self.ok(self.client.get(LAYER))
        self.assertEqual(len(body["edges"]), 4)
        e = next(e for e in body["edges"] if e["id"] == f"dep:{self.d1.pk}")
        self.assertEqual(e["type"], "dependency")
        self.assertEqual(e["source"], f"dev:{self.core.pk}")
        self.assertEqual(e["target"], f"dev:{self.dist.pk}")
        self.assertEqual(e["data"]["medium"]["name"], "Fibre")
        self.assertEqual(e["data"]["medium"]["line_style"], "solid")
        self.assertEqual(e["data"]["redundancy_group"], "up")
        self.assertEqual((e["data"]["upstream"], e["data"]["downstream"]),
                         ("core-1", "dist-2"))
        kinds = {e["data"]["kind"] for e in body["edges"]}
        self.assertEqual(kinds, {"dependency", "peer"})

    def test_site_and_device_narrowing(self):
        body = self.ok(self.client.get(LAYER, {"site": str(self.site_b.pk)}))
        self.assertEqual(self.ids(body), {f"dep:{self.d3.pk}", f"dep:{self.peer.pk}"})
        body = self.ok(self.client.get(LAYER, {"device": [str(self.core.pk),
                                                           str(self.dist.pk)]}))
        self.assertEqual(self.ids(body), {f"dep:{self.d1.pk}"})
        # The POST body form, for long sets.
        body = self.ok(self.client.post(
            LAYER, {"device": [str(self.dist.pk), str(self.acc.pk)]}, format="json",
        ))
        self.assertEqual(self.ids(body), {f"dep:{self.d2.pk}"})
        r = self.client.get(LAYER, {"device": "nope"})
        self.assertEqual(r.status_code, 400)

    def test_rows_with_a_hidden_end_are_left_out(self):
        user = self.member((["devicedependency", "device"], ["view"]), sites=[self.site_a])
        self.login(user)
        body = self.ok(self.client.get(LAYER))
        # remote-1 is at site B: the rows to it are not drawn.
        self.assertEqual(self.ids(body), {f"dep:{self.d1.pk}", f"dep:{self.d2.pk}"})
        self.assertNotIn("remote-1", str(body))

    def test_device_view_alone_is_not_enough(self):
        user = self.member((["device"], ["view"]))
        self.login(user)
        self.assertEqual(self.client.get(LAYER).status_code, 403)

    def test_dependency_view_needs_device_view_for_its_ends(self):
        user = self.member((["devicedependency"], ["view"]))
        self.login(user)
        self.assertEqual(self.ok(self.client.get(LAYER))["edges"], [])

    def test_other_tenant_sees_none(self):
        self.login(self.admin, tenant=self.other)
        self.assertEqual(self.ok(self.client.get(LAYER))["edges"], [])


class SiteMapLayerTests(_Base):
    def setUp(self):
        super().setUp()
        for site, (lat, lng) in ((self.site_a, (55.0, 12.0)), (self.site_b, (56.0, 10.0))):
            site.latitude, site.longitude = lat, lng
            site.save()
        # Two placed devices of their own.
        for d, (lat, lng) in ((self.core, (55.1, 12.1)), (self.dist, (55.2, 12.2))):
            d.latitude, d.longitude = lat, lng
            d.save()
        self.on_map = self.dep(self.core, self.dist, medium=self.fibre)
        self.remote2 = self.remote.__class__.objects.create(
            tenant=self.tenant, name="remote-2", site=self.site_b)
        self.x1 = self.dep(self.acc, self.remote, medium=self.fibre)
        self.x2 = self.dep(self.acc, self.remote2, medium=self.fibre)
        self.x3 = self.dep(self.dist, self.remote2)

    def lines(self, **params):
        body = self.ok(self.client.get(CONN, {"include": "dependencies", **params}))
        return body["dependencies"]

    def test_only_when_asked(self):
        body = self.ok(self.client.get(CONN))
        self.assertNotIn("dependencies", body)
        body = self.ok(self.client.get(CONN, {"include": "capacity,dependencies"}))
        self.assertIn("dependencies", body)

    def test_device_lines_and_site_pairs_per_medium(self):
        lines = self.lines()
        dev = [ln for ln in lines if ln["kind"] == "devices"]
        self.assertEqual([ln["id"] for ln in dev], [f"dep:{self.on_map.pk}"])
        self.assertEqual(dev[0]["a"]["device_name"], "core-1")
        self.assertEqual(dev[0]["z"]["device_name"], "dist-2")
        pairs = [ln for ln in lines if ln["kind"] == "sites"]
        # Fibre: acc-7 → remote-1 and → remote-2 in one line; no medium:
        # dist-2 → remote-2 in another (dist-2 is placed, remote-2 is not).
        self.assertEqual(sorted(ln["count"] for ln in pairs), [1, 2])
        fibre = next(ln for ln in pairs if ln["medium"])
        self.assertEqual(fibre["site_a"]["name"], "A")
        self.assertEqual(fibre["site_z"]["name"], "B")
        self.assertEqual({p["downstream"]["name"] for p in fibre["pairs"]},
                         {"remote-1", "remote-2"})

    def test_hidden_ends_and_unplaced_sites(self):
        user = self.member((["devicedependency", "device", "site"], ["view"]),
                           sites=[self.site_a])
        self.login(user)
        lines = self.lines()
        self.assertEqual([ln["id"] for ln in lines], [f"dep:{self.on_map.pk}"])
        self.assertNotIn("remote", str(lines))
        # A site without coordinates draws no site-pair line.
        self.login(self.admin)
        Site.objects.filter(pk=self.site_b.pk).update(latitude=None, longitude=None)
        self.assertEqual([ln["kind"] for ln in self.lines()], ["devices"])

    def test_without_the_grant_no_lines(self):
        user = self.member((["device", "site"], ["view"]))
        self.login(user)
        self.assertEqual(self.lines(), [])
