"""Floor-plan walls: CRUD, isolation, lattice snapping shared with trays,
opening validation, and the scene payload. v1 walls are documentation
geometry - nothing here touches routing, by design."""
from django.contrib.auth import get_user_model

from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import FloorPlan, FloorPlanWall, Location, Site


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other_org = Organization.objects.create(name="OO", slug="oo")
        self.other = Tenant.objects.create(org=other_org, name="X", slug="x")
        U = get_user_model()
        self.user = U.objects.create_superuser("wall", "w@x.io", "pw")
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
            "label": "North wall",
            "points": [[0, 0], [10, 0]],
        }
        body.update(over)
        return self.client.post("/api/floor-plan-walls/", body, format="json")


class WallCrudTests(_Base):
    def test_create_snap_update_delete(self):
        r = self._mk(points=[[0.24, 0], [9.76, 0.26]])
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        # Half-cell snap - the same lattice rule trays use.
        self.assertEqual(body["points"], [[0, 0], [10, 0.5]])
        wall_id = body["id"]

        patched = self.client.patch(
            f"/api/floor-plan-walls/{wall_id}/",
            {"height_mm": 2400, "label": "North"},
            format="json",
        )
        self.assertEqual(patched.status_code, 200, patched.content)
        self.assertEqual(patched.json()["height_mm"], 2400)

        gone = self.client.delete(f"/api/floor-plan-walls/{wall_id}/")
        self.assertEqual(gone.status_code, 204)

    def test_tray_points_still_snap_via_the_shared_helper(self):
        # Regression: extracting validate_lattice_points must not change tray
        # behaviour by a hair.
        r = self.client.post(
            "/api/floor-plan-trays/",
            {"floor_plan_id": str(self.plan.id), "name": "T1",
             "points": [[0.24, 0], [3.76, 0]]},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["points"], [[0, 0], [4, 0]])

    def test_openings_validated_against_segments(self):
        # Segment 0 runs (0,0)→(10,0): length 10 cells.
        ok = self._mk(openings=[
            {"seg": 0, "from": 2, "to": 3.5, "height_mm": 2100},
            {"seg": 0, "from": 6, "to": 7, "height_mm": None},
        ])
        self.assertEqual(ok.status_code, 201, ok.content)

        bad_seg = self._mk(label="w2", openings=[{"seg": 3, "from": 0, "to": 1}])
        self.assertEqual(bad_seg.status_code, 400)

        past_end = self._mk(label="w3", openings=[{"seg": 0, "from": 9, "to": 11}])
        self.assertEqual(past_end.status_code, 400)

        overlap = self._mk(label="w4", openings=[
            {"seg": 0, "from": 2, "to": 4},
            {"seg": 0, "from": 3, "to": 5},
        ])
        self.assertEqual(overlap.status_code, 400)
        self.assertIn("overlap", str(overlap.content))

        taller_than_wall = self._mk(
            label="w5", height_mm=2000,
            openings=[{"seg": 0, "from": 1, "to": 2, "height_mm": 2400}],
        )
        self.assertEqual(taller_than_wall.status_code, 400)

    def test_cross_tenant_plan_rejected_and_invisible(self):
        other_site = Site.objects.create(tenant=self.other, name="S2")
        other_loc = Location.objects.create(
            tenant=self.other, site=other_site, name="DC2"
        )
        hidden_plan = FloorPlan.objects.create(
            tenant=self.other, location=other_loc, name="Hidden"
        )
        r = self._mk(floor_plan_id=str(hidden_plan.id))
        self.assertEqual(r.status_code, 400)

        FloorPlanWall.objects.create(
            floor_plan=hidden_plan, points=[[0, 0], [2, 0]]
        )
        listed = self.client.get("/api/floor-plan-walls/").json()
        self.assertEqual(listed["count"], 0)

    def test_scene_includes_walls(self):
        self._mk(openings=[{"seg": 0, "from": 4, "to": 5, "height_mm": None}])
        body = self.client.get(
            f"/api/floor-plans/{self.plan.id}/scene/"
        ).json()
        self.assertEqual(len(body["walls"]), 1)
        w = body["walls"][0]
        self.assertEqual(w["points"], [[0, 0], [10, 0]])
        self.assertIsNone(w["height_mm"])
        self.assertEqual(w["openings"][0]["from"], 4)
