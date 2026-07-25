"""Raised-floor areas: CRUD, isolation, overlap rules, scene payload, and the
plenum-driven routing math that replaced the hardcoded −300."""
from django.contrib.auth import get_user_model

from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    FloorPlan,
    FloorPlanRaisedFloorArea,
    FloorPlanTray,
    Location,
    Site,
)
from .pathfinding import (
    DEFAULT_PLENUM_MM,
    rack_drop_mm,
    tray_elevation_mm,
    underfloor_plenum_mm,
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other_org = Organization.objects.create(name="OO", slug="oo")
        self.other = Tenant.objects.create(org=other_org, name="X", slug="x")
        U = get_user_model()
        self.user = U.objects.create_superuser("rf", "rf@x.io", "pw")
        self.client.force_authenticate(self.user)
        s = self.client.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="S1")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="DC"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall",
            grid_width=20, grid_height=12, cell_mm=600, ceiling_mm=3000,
        )

    def _mk(self, **over):
        body = {
            "floor_plan_id": str(self.plan.id),
            "x": 2, "y": 2, "width": 6, "height": 4,
            "plenum_mm": 400, "label": "Pad A",
        }
        body.update(over)
        return self.client.post(
            "/api/floor-plan-raised-floors/", body, format="json"
        )


class RaisedFloorCrudTests(_Base):
    def test_create_list_update_delete(self):
        r = self._mk()
        self.assertEqual(r.status_code, 201, r.content)
        area_id = r.json()["id"]

        listed = self.client.get(
            f"/api/floor-plan-raised-floors/?floor_plan={self.plan.id}"
        ).json()["results"]
        self.assertEqual([a["label"] for a in listed], ["Pad A"])

        patched = self.client.patch(
            f"/api/floor-plan-raised-floors/{area_id}/",
            {"plenum_mm": 600},
            format="json",
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["plenum_mm"], 600)

        gone = self.client.delete(f"/api/floor-plan-raised-floors/{area_id}/")
        self.assertEqual(gone.status_code, 204)

    def test_must_fit_the_grid(self):
        r = self._mk(x=18, width=6)  # 18+6 > 20
        self.assertEqual(r.status_code, 400)
        self.assertIn("fit inside", str(r.content))

    def test_overlap_rejected_but_touching_edges_allowed(self):
        self.assertEqual(self._mk().status_code, 201)
        # Overlapping by one cell → rejected.
        r = self.client.post(
            "/api/floor-plan-raised-floors/",
            {"floor_plan_id": str(self.plan.id),
             "x": 7, "y": 5, "width": 4, "height": 4},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Overlaps", str(r.content))
        # Sharing an edge (x = 8 starts where 2+6 ends) → fine: rectangles
        # compose L-shaped pads by abutting.
        ok = self.client.post(
            "/api/floor-plan-raised-floors/",
            {"floor_plan_id": str(self.plan.id),
             "x": 8, "y": 2, "width": 4, "height": 4},
            format="json",
        )
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_cross_tenant_plan_rejected(self):
        other_site = Site.objects.create(tenant=self.other, name="S2")
        other_loc = Location.objects.create(
            tenant=self.other, site=other_site, name="DC2"
        )
        hidden = FloorPlan.objects.create(
            tenant=self.other, location=other_loc, name="Hidden"
        )
        r = self._mk(floor_plan_id=str(hidden.id))
        self.assertEqual(r.status_code, 400)

    def test_other_tenants_areas_invisible(self):
        other_site = Site.objects.create(tenant=self.other, name="S2")
        other_loc = Location.objects.create(
            tenant=self.other, site=other_site, name="DC2"
        )
        hidden_plan = FloorPlan.objects.create(
            tenant=self.other, location=other_loc, name="Hidden"
        )
        FloorPlanRaisedFloorArea.objects.create(
            floor_plan=hidden_plan, x=0, y=0, width=2, height=2
        )
        listed = self.client.get("/api/floor-plan-raised-floors/").json()
        self.assertEqual(listed["count"], 0)

    def test_scene_includes_raised_floors(self):
        self._mk()
        body = self.client.get(
            f"/api/floor-plans/{self.plan.id}/scene/"
        ).json()
        self.assertEqual(len(body["raised_floors"]), 1)
        rf = body["raised_floors"][0]
        self.assertEqual(
            (rf["x"], rf["y"], rf["w"], rf["h"], rf["plenum_mm"]),
            (2, 2, 6, 4, 400),
        )


class PlenumMathTests(_Base):
    """The pure helpers that replaced −300 ×3 and the two drop_mm closures."""

    def test_tray_elevation_uses_the_plenum(self):
        self.assertEqual(tray_elevation_mm("underfloor", None, 3000), -300.0)
        self.assertEqual(
            tray_elevation_mm("underfloor", None, 3000, plenum_mm=600), -600.0
        )
        # Explicit elevation always wins; overhead/floor unaffected by plenum.
        self.assertEqual(
            tray_elevation_mm("underfloor", -450, 3000, plenum_mm=600), -450.0
        )
        self.assertEqual(
            tray_elevation_mm("overhead", None, 3000, plenum_mm=600), 2700.0
        )

    def test_underfloor_plenum_containment_max_and_fallback(self):
        areas = [(0, 0, 10, 10, 400), (10, 0, 10, 10, 700)]
        # Run entirely in the first area.
        self.assertEqual(underfloor_plenum_mm(areas, [[2, 2], [8, 2]]), 400.0)
        # Run crossing both → the deeper void wins.
        self.assertEqual(underfloor_plenum_mm(areas, [[8, 2], [12, 2]]), 700.0)
        # Run outside every area → historical default.
        self.assertEqual(
            underfloor_plenum_mm(areas, [[2, 11], [8, 11]]),
            float(DEFAULT_PLENUM_MM),
        )
        self.assertEqual(
            underfloor_plenum_mm([], [[1, 1]]), float(DEFAULT_PLENUM_MM)
        )

    def test_rack_drop_parity_with_the_old_inline_math(self):
        # Old closure: abs(elev - (u_height * 44.45 + 100)).
        self.assertAlmostEqual(
            rack_drop_mm(42, "overhead", None, 3000),
            abs((3000 - 300) - (42 * 44.45 + 100)),
        )
        # Underfloor with a deep plenum: the drop grows with the void.
        self.assertAlmostEqual(
            rack_drop_mm(42, "underfloor", None, 3000, plenum_mm=600),
            abs(-600 - (42 * 44.45 + 100)),
        )
        # No rack (a panel end): drop measured from the floor.
        self.assertAlmostEqual(
            rack_drop_mm(None, "underfloor", None, 3000), 300.0
        )

    def test_route_preview_drop_reflects_area_plenum(self):
        """End-to-end: the same plan routes with a longer estimate once its
        underfloor tray runs through a 600 mm plenum instead of the default."""
        from .models import FloorPlanTile, FloorTileType, Rack

        tt = FloorTileType.objects.create(
            tenant=self.tenant, name="Rack", slug="rack"
        )
        rack_a = Rack.objects.create(tenant=self.tenant, site=self.site, name="A")
        rack_b = Rack.objects.create(tenant=self.tenant, site=self.site, name="B")
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=1, y=5,
            rack=rack_a, link_kind="rack",
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=tt, x=15, y=5,
            rack=rack_b, link_kind="rack",
        )
        FloorPlanTray.objects.create(
            floor_plan=self.plan, name="UF-1", level="underfloor",
            points=[[1.5, 5.5], [15.5, 5.5]],
        )
        body = {"from": {"kind": "rack", "id": str(rack_a.id)},
                "to": {"kind": "rack", "id": str(rack_b.id)}}
        before = self.client.post(
            f"/api/floor-plans/{self.plan.id}/route/", body, format="json"
        ).json()
        self.assertTrue(before["reachable"])

        FloorPlanRaisedFloorArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=20, height=12,
            plenum_mm=600,
        )
        after = self.client.post(
            f"/api/floor-plans/{self.plan.id}/route/", body, format="json"
        ).json()
        # 300 mm deeper at both ends = 0.6 m more raw run; slack scales it.
        self.assertGreater(after["length_m"], before["length_m"])
