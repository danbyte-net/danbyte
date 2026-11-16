"""What goes down if a device fails (#450): the device and multi-device
impact endpoints computed on every dependency but listing only what the
caller may view, ``limit``/``truncated``, ``impacts`` a maintenance create
takes, the dependency tree for the device tab with hidden nodes, and the
grant both need."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import DeviceDependency, Site

from .tests_device_dependencies import _Base


class ImpactTests(_Base):
    def setUp(self):
        super().setUp()
        # core → dist → acc; remote backs acc together with dist.
        self.dep(self.core, self.dist)
        self.dep(self.dist, self.acc, redundancy_group="up")
        self.dep(self.remote, self.acc, redundancy_group="up")

    def impact(self, device, query=""):
        return self.ok(self.client.get(f"/api/devices/{device.id}/impact/{query}"))

    def test_levels_depth_via_and_impacts(self):
        body = self.impact(self.core)
        self.assertEqual(body["root"], [{"id": str(self.core.id), "name": "core-1"}])
        rows = {d["name"]: d for d in body["devices"]}
        self.assertEqual(rows["dist-2"]["level"], "outage")
        self.assertEqual(rows["acc-7"]["level"], "reduced_redundancy")
        self.assertEqual(rows["acc-7"]["depth"], 2)
        self.assertEqual([v["name"] for v in rows["acc-7"]["via"]], ["dist-2"])
        self.assertEqual(body["counts"], {"outage": 1, "reduced_redundancy": 1})
        self.assertFalse(body["truncated"])
        self.assertEqual(body["impacts"][0], {"object_type": "device",
                                              "object_id": str(self.core.id),
                                              "level": "outage"})
        self.assertEqual(len(body["impacts"]), 3)

    def test_peers_are_ignored(self):
        self.dep(self.acc, self.foreign_peer(), kind="peer")
        names = [d["name"] for d in self.impact(self.acc)["devices"]]
        self.assertEqual(names, [])

    def foreign_peer(self):
        from api.models import Device

        return Device.objects.create(tenant=self.tenant, name="peer-9", site=self.site_a)

    def test_multi_root_takes_the_whole_group(self):
        body = self.ok(self.client.get(
            f"/api/device-dependencies/impact/?device={self.dist.id}&device={self.remote.id}"))
        self.assertEqual([d["name"] for d in body["devices"]], ["acc-7"])
        self.assertEqual(body["devices"][0]["level"], "outage")
        self.assertEqual(len(body["root"]), 2)
        self.assertEqual(
            self.client.get("/api/device-dependencies/impact/").status_code, 400)

    def test_limit_and_truncated(self):
        body = self.impact(self.core, "?limit=1")
        self.assertTrue(body["truncated"])
        self.assertEqual([d["name"] for d in body["devices"]], ["dist-2"])
        self.assertEqual(body["counts"], {"outage": 1, "reduced_redundancy": 1})

    def test_computed_on_every_row_listed_only_when_viewable(self):
        # A viewer of site A only: remote (site B) is invisible, yet with
        # dist down acc is still only reduced - remote still backs it.
        user = self.member((["devicedependency", "device"], ["view"]), sites=[self.site_a])
        self.login(user)
        body = self.impact(self.dist)
        self.assertEqual({d["name"]: d["level"] for d in body["devices"]},
                         {"acc-7": "reduced_redundancy"})
        self.assertEqual(self.client.get(f"/api/devices/{self.remote.id}/impact/").status_code,
                         404)
        body = self.ok(self.client.get(
            f"/api/device-dependencies/impact/?device={self.dist.id}&device={self.remote.id}"))
        self.assertEqual(len(body["root"]), 1)

    def test_needs_the_dependency_grant(self):
        user = self.member((["device"], ["view"]))
        self.login(user)
        self.assertEqual(self.client.get(f"/api/devices/{self.core.id}/impact/").status_code,
                         403)
        self.assertEqual(
            self.client.get(f"/api/devices/{self.core.id}/dependencies/").status_code, 403)

    def test_query_count_does_not_grow_with_the_graph(self):
        from api.models import Device

        self.impact(self.core)
        with CaptureQueriesContext(connection) as small:
            self.impact(self.core)
        prev = self.acc
        for i in range(30):
            d = Device.objects.create(tenant=self.tenant, name=f"leaf-{i}", site=self.site_a)
            DeviceDependency.objects.create(tenant=self.tenant, upstream=prev, downstream=d)
            prev = d
        self.impact(self.core)
        with CaptureQueriesContext(connection) as big:
            body = self.impact(self.core)
        self.assertEqual(len(body["devices"]), 2)  # acc is only reduced
        self.assertEqual(len(big.captured_queries), len(small.captured_queries))

    def test_impacts_are_accepted_by_a_maintenance_create(self):
        from api.status_registry import seed_builtin_statuses

        seed_builtin_statuses(self.tenant)
        from api.models import Status

        status = Status.objects.get(tenant=self.tenant, slug="tentative")
        impacts = self.impact(self.core)["impacts"]
        t0 = datetime(2026, 12, 1, 22, 0, tzinfo=UTC)
        r = self.client.post("/api/monitoring/maintenance-events/", {
            "kind": "maintenance", "status_id": str(status.id), "name": "Core swap",
            "starts_at": t0.isoformat(), "ends_at": (t0 + timedelta(hours=2)).isoformat(),
            "impacts": impacts,
        }, format="json")
        body = self.ok(r, 201)
        self.assertEqual(
            sorted((i["object_id"], i["level"]) for i in body["impacts"]),
            sorted((i["object_id"], i["level"]) for i in impacts),
        )


class TreeTests(_Base):
    def setUp(self):
        super().setUp()
        self.dep(self.core, self.dist, medium=self.fibre)
        self.dep(self.dist, self.acc)
        self.dep(self.remote, self.dist, kind="dependency", redundancy_group="")

    def tree(self, device, query=""):
        return self.ok(self.client.get(f"/api/devices/{device.id}/dependencies/{query}"))

    def test_up_and_down_with_media(self):
        body = self.tree(self.dist)
        self.assertEqual(body["root"]["name"], "dist-2")
        names = {n["name"] for n in body["nodes"]}
        self.assertEqual(names, {"core-1", "acc-7", "remote-1"})
        fibre = next(e for e in body["edges"] if e["upstream"] == str(self.core.id))
        self.assertEqual(fibre["medium"]["name"], "Fibre")
        self.assertEqual(len(body["edges"]), 3)
        self.assertEqual(body["truncated"], {"up": False, "down": False})

    def test_depth_and_direction(self):
        body = self.tree(self.core, "?direction=down&depth=1")
        self.assertEqual([n["name"] for n in body["nodes"]], ["dist-2"])
        self.assertTrue(body["truncated"]["down"])
        self.assertEqual(self.client.get(
            f"/api/devices/{self.core.id}/dependencies/?direction=sideways").status_code, 400)

    def test_peers_are_listed(self):
        low, high = sorted([self.acc, self.core], key=lambda d: str(d.pk))
        a = DeviceDependency.objects.create(tenant=self.tenant, kind="peer",
                                            upstream=low, downstream=high)
        body = self.tree(self.acc)
        self.assertIn(str(a.id), {e["id"] for e in body["edges"] if e["kind"] == "peer"})

    def test_a_device_the_caller_may_not_view_is_a_hidden_node(self):
        hidden_site = Site.objects.create(tenant=self.tenant, name="C")
        self.remote.site = hidden_site
        self.remote.save()
        user = self.member((["devicedependency"], ["view"]),
                           (["device"], ["view"], [self.site_a]))
        self.login(user)
        body = self.tree(self.dist)
        hidden = [n for n in body["nodes"] if n["hidden"]]
        self.assertEqual(len(hidden), 1)
        self.assertEqual(hidden[0]["name"], "Hidden")
        self.assertNotIn(str(self.remote.id), str(body))
