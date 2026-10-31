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


class WallBulkTests(_Base):
    """Walls, raised floors and trays saved with the editor's ``bulk/``:
    one transaction, version checks, their own row permissions."""

    def bulk(self, body):
        return self.client.post(
            f"/api/floor-plans/{self.plan.id}/bulk/", body, format="json"
        )

    def test_creates_walls_in_one_save_and_answers_them(self):
        r = self.bulk({"walls": {"create": [
            {"points": [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]], "thickness_mm": 200},
            {"points": [[6, 0], [6, 2.24]]},
        ]}})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(len(body["walls"]), 2)
        self.assertEqual(FloorPlanWall.objects.filter(floor_plan=self.plan).count(), 2)
        loop = next(w for w in body["walls"] if len(w["points"]) == 5)
        self.assertEqual(loop["thickness_mm"], 200)
        # The lattice rule holds in a bulk save too.
        short = next(w for w in body["walls"] if len(w["points"]) == 2)
        self.assertEqual(short["points"], [[6, 0], [6, 2]])
        self.assertIn("raised_floors", body)
        self.assertIn("tray_rows", body)

    def test_one_bad_wall_writes_nothing(self):
        r = self.bulk({"walls": {"create": [
            {"points": [[0, 0], [4, 0]]},
            {"points": [[0, 0]]},
        ]}})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(FloorPlanWall.objects.exists())

    def test_update_and_delete_with_versions(self):
        a = FloorPlanWall.objects.create(floor_plan=self.plan, points=[[0, 0], [4, 0]])
        b = FloorPlanWall.objects.create(floor_plan=self.plan, points=[[0, 2], [4, 2]])
        r = self.bulk({"walls": {
            "update": [{"id": str(a.id), "version": a.updated_at.isoformat(),
                        "points": [[0, 0], [6, 0]]}],
            "delete": [{"id": str(b.id), "version": b.updated_at.isoformat()}],
        }})
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertEqual(a.points, [[0, 0], [6, 0]])
        self.assertFalse(FloorPlanWall.objects.filter(pk=b.pk).exists())

    def test_wall_changed_elsewhere_is_a_409(self):
        a = FloorPlanWall.objects.create(floor_plan=self.plan, points=[[0, 0], [4, 0]])
        old = a.updated_at.isoformat()
        a.label = "Theirs"
        a.save()
        r = self.bulk({"walls": {"update": [
            {"id": str(a.id), "version": old, "points": [[0, 0], [6, 0]]},
        ]}})
        self.assertEqual(r.status_code, 409, r.content)
        (c,) = r.json()["conflicts"]
        self.assertEqual((c["kind"], c["current"]["label"]), ("wall", "Theirs"))
        a.refresh_from_db()
        self.assertEqual(a.points, [[0, 0], [4, 0]])

    def test_raised_floor_and_tray_geometry_in_one_save(self):
        from .models import FloorPlanRaisedFloorArea, FloorPlanTray

        rf = FloorPlanRaisedFloorArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=2, height=2
        )
        tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="T1", points=[[0, 0], [4, 0]]
        )
        r = self.bulk({
            "raised_floors": {
                "update": [{"id": str(rf.id), "x": 3}],
                "create": [{"x": 8, "y": 0, "width": 2, "height": 2}],
            },
            "trays": {
                "update": [{"id": str(tray.id), "points": [[0, 1], [4, 1]]}],
                "create": [{"key": "new-1", "name": "T2", "points": [[0, 5], [3, 5]]}],
            },
        })
        self.assertEqual(r.status_code, 200, r.content)
        rf.refresh_from_db()
        tray.refresh_from_db()
        self.assertEqual(rf.x, 3)
        self.assertEqual(tray.points, [[0, 1], [4, 1]])
        body = r.json()
        self.assertEqual(len(body["raised_floors"]), 2)
        self.assertEqual({t["name"] for t in body["tray_rows"]}, {"T1", "T2"})
        self.assertEqual(body["trays"][0]["key"], "new-1")

    def test_overlapping_raised_floor_is_refused(self):
        from .models import FloorPlanRaisedFloorArea

        FloorPlanRaisedFloorArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=4, height=4
        )
        r = self.bulk({"raised_floors": {"create": [
            {"x": 2, "y": 2, "width": 3, "height": 3},
        ]}})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(FloorPlanRaisedFloorArea.objects.count(), 1)

    def test_wall_from_another_plan_is_unknown(self):
        other = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Other"
        )
        w = FloorPlanWall.objects.create(floor_plan=other, points=[[0, 0], [4, 0]])
        r = self.bulk({"walls": {"update": [{"id": str(w.id), "label": "x"}]}})
        self.assertEqual(r.status_code, 400)
        w.refresh_from_db()
        self.assertEqual(w.label, "")

    def test_walls_need_their_own_permission(self):
        from auth_api.models import ObjectPermission, UserProfile

        U = get_user_model()
        editor = U.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="plans", object_types=["floorplan"], actions=["view", "change"],
        )
        perm.users.add(editor)
        perm.tenants.add(self.tenant)
        self.client.force_authenticate(editor)
        s = self.client.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.bulk({"walls": {"create": [{"points": [[0, 0], [4, 0]]}]}})
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(FloorPlanWall.objects.exists())
        wall_perm = ObjectPermission.objects.create(
            name="walls", object_types=["floorplanwall"], actions=["view", "add"],
        )
        wall_perm.users.add(editor)
        wall_perm.tenants.add(self.tenant)
        r = self.bulk({"walls": {"create": [{"points": [[0, 0], [4, 0]]}]}})
        self.assertEqual(r.status_code, 200, r.content)


class DoorTests(_Base):
    def test_door_swing_and_bounds(self):
        ok = self._mk(thickness_mm=150, openings=[
            {"seg": 0, "from": 2, "to": 3.5, "height_mm": None,
             "hinge": "end", "side": "left"},
        ])
        self.assertEqual(ok.status_code, 201, ok.content)
        body = ok.json()
        self.assertEqual(body["openings"][0]["hinge"], "end")
        self.assertEqual(body["thickness_mm"], 150)
        bad = self._mk(label="w2", openings=[
            {"seg": 0, "from": 2, "to": 3, "hinge": "middle"},
        ])
        self.assertEqual(bad.status_code, 400)
        bad_side = self._mk(label="w3", openings=[
            {"seg": 0, "from": 2, "to": 3, "side": "up"},
        ])
        self.assertEqual(bad_side.status_code, 400)
        thin = self._mk(label="w4", thickness_mm=5)
        self.assertEqual(thin.status_code, 400)

    def test_moving_points_keeps_doors_inside_the_wall(self):
        w = self._mk(openings=[{"seg": 0, "from": 7, "to": 8.5}]).json()
        # The wall shortened under its door: refused, the door stays put.
        r = self.client.patch(
            f"/api/floor-plan-walls/{w['id']}/",
            {"points": [[0, 0], [6, 0]]}, format="json",
        )
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(
            f"/api/floor-plan-walls/{w['id']}/",
            {"points": [[0, 0], [6, 0]], "openings": [{"seg": 0, "from": 4.5, "to": 6}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_scene_carries_thickness(self):
        self._mk(thickness_mm=240)
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/").json()
        self.assertEqual(body["walls"][0]["thickness_mm"], 240)
