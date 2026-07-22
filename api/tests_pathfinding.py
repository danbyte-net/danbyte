"""Auto-routing (Phase 3): the tray-graph router, length estimation, and the
route/auto-route endpoints."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .pathfinding import (
    estimate_length_m,
    route_through_trays,
    tray_elevation_mm,
)
from .models import (
    Cable, CableTermination, Device, FloorPlan, FloorPlanTile, FloorPlanTray,
    FloorTileType, Interface, Location, Rack, Site,
)

User = get_user_model()


class RouterTests(APITestCase):
    """Pure-geometry tests — no DB."""

    def test_no_trays_is_straight_and_unreachable(self):
        r = route_through_trays((0, 0), (10, 0), [])
        self.assertFalse(r.reachable)
        self.assertEqual(r.points, [(0, 0), (10, 0)])

    def test_single_tray_rides_it(self):
        # A at (0,2), B at (10,2), tray straight along y=1 from x=0..10.
        tray = [(0.0, 1.0), (10.0, 1.0)]
        r = route_through_trays((0, 2), (10, 2), [tray])
        self.assertTrue(r.reachable)
        self.assertEqual(r.tray_indexes, [0])
        # Entry hop (1) + 10 along + exit hop (1) = 12 cells.
        self.assertAlmostEqual(r.run_cells, 12.0, places=3)

    def test_t_split_branches(self):
        # Main run along y=0; branch drops from (5,0) to (5,5) near B.
        main = [(0.0, 0.0), (10.0, 0.0)]
        branch = [(5.0, 0.0), (5.0, 5.0)]
        r = route_through_trays((0, 1), (5, 6), [main, branch])
        self.assertTrue(r.reachable)
        self.assertEqual(r.tray_indexes, [0, 1])
        # 1 (entry) + 5 (main) + 5 (branch) + 1 (exit) = 12.
        self.assertAlmostEqual(r.run_cells, 12.0, places=2)

    def test_mid_segment_crossing_connects(self):
        # Two trays crossing at (5,5) with no shared vertex.
        h = [(0.0, 5.0), (10.0, 5.0)]
        v = [(5.0, 0.0), (5.0, 10.0)]
        r = route_through_trays((0, 4), (6, 10), [h, v])
        self.assertTrue(r.reachable)
        self.assertEqual(r.tray_indexes, [0, 1])

    def test_disconnected_trays_fall_back_straight(self):
        # Two parallel trays far apart — no junction, so B's side is only
        # reachable via its own entry… which IS connected through B's hop.
        # Truly unreachable needs the graph split: A hops onto tray 0, B onto
        # tray 1, and nothing links them.
        t0 = [(0.0, 0.0), (2.0, 0.0)]
        t1 = [(0.0, 10.0), (2.0, 10.0)]
        r = route_through_trays((0, 1), (2, 9), [t0, t1])
        self.assertFalse(r.reachable)
        self.assertEqual(r.points, [(0, 1), (2, 9)])

    def test_shorter_of_two_paths_wins(self):
        # A ring: top run is shorter than bottom.
        top = [(0.0, 0.0), (10.0, 0.0)]
        bottom = [(0.0, 0.0), (0.0, 6.0), (10.0, 6.0), (10.0, 0.0)]
        r = route_through_trays((0, 0), (10, 0), [top, bottom])
        self.assertEqual(r.tray_indexes, [0])
        self.assertAlmostEqual(r.run_cells, 10.0, places=2)

    def test_length_estimate(self):
        # 10 cells × 600mm = 6m run, 2m + 1m drops → 9m, +10% slack = 9.9.
        self.assertAlmostEqual(
            estimate_length_m(10, 600, 2000, 1000), 9.9, places=2
        )

    def test_tray_elevation_derivation(self):
        self.assertEqual(tray_elevation_mm("overhead", None, 3000), 2700)
        self.assertEqual(tray_elevation_mm("underfloor", None, 3000), -300)
        self.assertEqual(tray_elevation_mm("floor", None, 3000), 0)
        self.assertEqual(tray_elevation_mm("overhead", 2400, 3000), 2400)


class RouteApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", slug="hall"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A",
            cell_mm=600, ceiling_mm=3000,
        )
        self.tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        self.rack_a = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="RA", u_height=42
        )
        self.rack_b = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="RB", u_height=42
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=2,
            rack=self.rack_a, link_kind="rack",
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=10, y=2,
            rack=self.rack_b, link_kind="rack",
        )
        # One overhead tray connecting the two rack rows along y=1.
        self.tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="OH-1", level="overhead",
            points=[[0, 1], [11, 1]],
        )
        self.dev_a = Device.objects.create(
            tenant=self.tenant, name="sw-a", rack=self.rack_a
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant, name="sw-b", rack=self.rack_b
        )

    def test_route_preview(self):
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/route/",
            {"from": {"kind": "rack", "id": str(self.rack_a.id)},
             "to": {"kind": "rack", "id": str(self.rack_b.id)}},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertTrue(body["reachable"])
        self.assertEqual(body["tray_ids"], [str(self.tray.id)])
        self.assertGreater(body["length_m"], 0)
        # Drops: 42U rack top ≈ 1967mm, overhead tray at 2700 → ~733 each end.
        self.assertAlmostEqual(body["drops_mm"][0], 733, delta=2)

    def test_route_devices_resolve_via_rack(self):
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/route/",
            {"from": {"kind": "device", "id": str(self.dev_a.id)},
             "to": {"kind": "device", "id": str(self.dev_b.id)}},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["reachable"])

    def test_route_unplaced_endpoint_400(self):
        ghost = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="GHOST"
        )
        resp = self.client.post(
            f"/api/floor-plans/{self.plan.id}/route/",
            {"from": {"kind": "rack", "id": str(ghost.id)},
             "to": {"kind": "rack", "id": str(self.rack_b.id)}},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_route_tenant_isolation(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        o_site = Site.objects.create(tenant=other, name="LON")
        o_loc = Location.objects.create(
            tenant=other, site=o_site, name="X", slug="x"
        )
        hidden = FloorPlan.objects.create(
            tenant=other, location=o_loc, name="Hidden"
        )
        resp = self.client.post(
            f"/api/floor-plans/{hidden.id}/route/",
            {"from": {}, "to": {}}, format="json",
        )
        self.assertEqual(resp.status_code, 404)

    def _cable(self):
        cable = Cable.objects.create(tenant=self.tenant, label="C-1")
        ia = Interface.objects.create(device=self.dev_a, name="eth0")
        ib = Interface.objects.create(device=self.dev_b, name="eth0")
        CableTermination.objects.create(cable=cable, end="A", interface=ia)
        CableTermination.objects.create(cable=cable, end="B", interface=ib)
        return cable

    def test_auto_route_persists_trays_and_length(self):
        cable = self._cable()
        resp = self.client.post(
            f"/api/cables/{cable.id}/auto-route/",
            {"floor_plan": str(self.plan.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertTrue(body["reachable"])
        self.assertTrue(body["length_set"])
        cable.refresh_from_db()
        self.assertEqual(
            list(cable.trays.values_list("id", flat=True)), [self.tray.id]
        )
        self.assertIsNotNone(cable.length)
        self.assertEqual(cable.length_unit, "m")

    def test_auto_route_keeps_recorded_length_unless_overwrite(self):
        cable = self._cable()
        cable.length = 99
        cable.length_unit = "m"
        cable.save()
        self.client.post(
            f"/api/cables/{cable.id}/auto-route/",
            {"floor_plan": str(self.plan.id)}, format="json",
        )
        cable.refresh_from_db()
        self.assertEqual(float(cable.length), 99)
        self.client.post(
            f"/api/cables/{cable.id}/auto-route/",
            {"floor_plan": str(self.plan.id), "overwrite": True},
            format="json",
        )
        cable.refresh_from_db()
        self.assertNotEqual(float(cable.length), 99)

    def test_auto_route_no_path_reports_unreachable(self):
        self.tray.points = [[0, 1], [2, 1]]  # stops far from rack B
        self.tray.save()
        # Rack B far outside snap distance of the truncated tray.
        FloorPlanTile.objects.filter(rack=self.rack_b).update(x=40, y=30)
        cable = self._cable()
        resp = self.client.post(
            f"/api/cables/{cable.id}/auto-route/",
            {"floor_plan": str(self.plan.id)}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(resp.json()["reachable"])
        cable.refresh_from_db()
        self.assertEqual(cable.trays.count(), 0)