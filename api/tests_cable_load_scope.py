"""The device paths and the site map load the cables they need, not every
cable of the tenant (#417).

``GET /api/devices/<id>/paths/``, ``/api/site-map/connections/`` and
``/api/site-map/cables/`` each built the whole tenant's cable hops per call,
even when the answer was empty. These tests count the cables handed to the
hop builder and check the answers did not change."""
from __future__ import annotations

from unittest import mock

from django.db import connection
from django.test.utils import CaptureQueriesContext

from api import topology_views
from api.models import Device, FrontPort, Interface, RearPort, Site
from api.tests_topology import _Base


class _Counted(_Base):
    def setUp(self):
        super().setUp()
        self.loaded: list[int] = []
        real = topology_views._links_from_cables

        def counted(cables):
            cables = list(cables)
            self.loaded.append(len(cables))
            return real(cables)

        patcher = mock.patch.object(topology_views, "_links_from_cables", counted)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _noise(self, n, site=None, tag="n"):
        """``n`` device-to-device cables nothing under test touches."""
        for i in range(n):
            a = Device.objects.create(tenant=self.tenant, name=f"{tag}{i}a", site=site)
            b = Device.objects.create(tenant=self.tenant, name=f"{tag}{i}b", site=site)
            self._cable(
                Interface.objects.create(device=a, name="eth0"),
                Interface.objects.create(device=b, name="eth0"),
            )


class DevicePathsLoadTests(_Counted):
    def setUp(self):
        super().setUp()
        # server.eth0 - panel-a.front1 ; panel-a.rear = panel-b.rear ;
        # panel-b.front1 - client.eth0 ; server.eth1 - peer.eth0
        self.server = Device.objects.create(tenant=self.tenant, name="server")
        self.client_dev = Device.objects.create(tenant=self.tenant, name="client")
        self.peer = Device.objects.create(tenant=self.tenant, name="peer")
        self.pa = Device.objects.create(tenant=self.tenant, name="panel-a")
        self.pb = Device.objects.create(tenant=self.tenant, name="panel-b")
        ra = RearPort.objects.create(device=self.pa, name="rear", positions=12)
        fa = FrontPort.objects.create(
            device=self.pa, name="front1", rear_port=ra, rear_port_position=1
        )
        rb = RearPort.objects.create(device=self.pb, name="rear", positions=12)
        fb = FrontPort.objects.create(
            device=self.pb, name="front1", rear_port=rb, rear_port_position=1
        )
        self._cable(Interface.objects.create(device=self.server, name="eth0"), fa)
        self._cable(ra, rb)
        self._cable(fb, Interface.objects.create(device=self.client_dev, name="eth0"))
        self._cable(
            Interface.objects.create(device=self.server, name="eth1"),
            Interface.objects.create(device=self.peer, name="eth0"),
        )
        self.lonely = Device.objects.create(tenant=self.tenant, name="lonely")
        Interface.objects.create(device=self.lonely, name="eth0")
        self._noise(20)

    def _runs(self, dev):
        r = self.client.get(f"/api/devices/{dev.id}/paths/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["runs"]

    def test_a_device_without_cables_loads_none(self):
        self.assertEqual(self._runs(self.lonely), [])
        self.assertEqual(self.loaded, [], "no cable may be built for an uncabled device")

    def test_only_the_cables_a_run_can_cross_are_loaded(self):
        runs = self._runs(self.server)
        # Its own two cables, the trunk behind panel-a, and the patch on
        # panel-b's far side - none of the 20 unrelated ones.
        self.assertEqual(self.loaded, [4])
        names = sorted(
            [s["device"] for s in r["steps"] if s["t"] == "chip"][-1] for r in runs
        )
        self.assertEqual(names, ["client", "peer"])
        self.assertTrue(all(r["complete"] for r in runs))

    def test_cost_does_not_grow_with_the_tenant(self):
        url = f"/api/devices/{self.server.id}/paths/"
        self.client.get(url)
        with CaptureQueriesContext(connection) as small:
            self.client.get(url)
        self._noise(30, tag="m")
        with CaptureQueriesContext(connection) as big:
            self.client.get(url)
        self.assertEqual(len(small.captured_queries), len(big.captured_queries))
        self.assertEqual(self.loaded[-1], 4)

    def test_answer_matches_the_whole_tenant_walk(self):
        """Every device's runs read the same as when built from every cable."""
        def whole(tenant, devices, through_panels=True):
            return topology_views._physical_links(tenant)

        for dev in (self.server, self.pa, self.pb, self.client_dev, self.peer):
            narrowed = self._runs(dev)
            with mock.patch.object(topology_views, "_links_around", whole):
                full = self._runs(dev)
            self.assertEqual(narrowed, full, dev.name)


class SiteMapLoadTests(_Counted):
    def setUp(self):
        super().setUp()
        self._noise(10)  # unplaced devices, no site

    def _get(self, path, key):
        r = self.client.get(f"/api/site-map/{path}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()[key]

    def test_nothing_placed_loads_no_cable(self):
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(self._get("connections", "connections"), [])
            self.assertEqual(self._get("cables", "cables"), [])
        self.assertEqual(self.loaded, [])
        self.assertFalse(
            [q for q in ctx.captured_queries if '"api_cable"' in q["sql"]],
            "no cable row may be read when nothing can be drawn",
        )

    def test_one_placed_site_draws_no_connection(self):
        Site.objects.create(tenant=self.tenant, name="A", latitude="55.0", longitude="12.0")
        self.assertEqual(self._get("connections", "connections"), [])
        self.assertEqual(self.loaded, [])

    def test_placed_cables_still_draw_and_only_they_load(self):
        s1 = Site.objects.create(
            tenant=self.tenant, name="A", latitude="55.0", longitude="12.0")
        s2 = Site.objects.create(
            tenant=self.tenant, name="B", latitude="56.0", longitude="10.0")
        a = Device.objects.create(tenant=self.tenant, name="a", site=s1)
        b = Device.objects.create(tenant=self.tenant, name="b", site=s2)
        cab = self._cable(
            Interface.objects.create(device=a, name="eth0"),
            Interface.objects.create(device=b, name="eth0"),
        )
        # A device with its own coordinates and no site still draws.
        free = Device.objects.create(
            tenant=self.tenant, name="free", latitude="55.5", longitude="11.0")
        cab2 = self._cable(
            Interface.objects.create(device=a, name="eth1"),
            Interface.objects.create(device=free, name="eth0"),
        )
        edges = self._get("connections", "connections")
        self.assertEqual([e["kind"] for e in edges], ["cable"])
        self.assertEqual(edges[0]["meta"]["cables"][0]["id"], str(cab.id))
        self.assertEqual(self.loaded, [2], "only cables with an end at a placed site")
        self.loaded.clear()
        lines = self._get("cables", "cables")
        self.assertEqual({row["id"] for row in lines}, {str(cab.id), str(cab2.id)})
        self.assertEqual(self.loaded, [2])

    def test_capacity_keeps_the_whole_tenant_walk(self):
        s1 = Site.objects.create(
            tenant=self.tenant, name="A", latitude="55.0", longitude="12.0")
        s2 = Site.objects.create(
            tenant=self.tenant, name="B", latitude="56.0", longitude="10.0")
        a = Device.objects.create(tenant=self.tenant, name="a", site=s1)
        b = Device.objects.create(tenant=self.tenant, name="b", site=s2)
        self._cable(
            Interface.objects.create(device=a, name="eth0"),
            Interface.objects.create(device=b, name="eth0"),
        )
        r = self.client.get("/api/site-map/connections/?include=capacity")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["connections"]), 1)
        self.assertEqual(self.loaded, [11])
