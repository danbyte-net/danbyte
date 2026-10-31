"""Floor-plan walls: CRUD, isolation, exact points (trays keep the lattice),
opening validation, and the scene payload. v1 walls are documentation
geometry, linked to the area they were made from."""
from django.contrib.auth import get_user_model

from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import FloorPlan, FloorPlanArea, FloorPlanWall, Location, Site


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
        r = self._mk(points=[[0.24, 0], [9.76, 0.26049]])
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        # Any place in the grid, to 0.001 cell (an outline's exact corners).
        self.assertEqual(body["points"], [[0.24, 0], [9.76, 0.26]])
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
        # Decimal points save as sent in a bulk save too.
        short = next(w for w in body["walls"] if len(w["points"]) == 2)
        self.assertEqual(short["points"], [[6, 0], [6, 2.24]])
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


class WallPointTests(_Base):
    def test_points_outside_the_grid_or_not_numbers_are_refused(self):
        for pts in ([[0, 0], [600, 0]], [[0, 0], [True, 1]], [[0, 0]], [[0, "a"], [1, 1]]):
            r = self._mk(points=pts)
            self.assertEqual(r.status_code, 400, pts)

    def test_a_turned_outline_saves_exactly(self):
        pts = [[2.134, 1.5], [6.866, 4.232], [5.866, 5.964], [1.134, 3.232], [2.134, 1.5]]
        r = self._mk(points=pts)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["points"], pts)


class WallSourceAreaTests(_Base):
    """``source_area``: the area a wall was made from, while linked."""

    def setUp(self):
        super().setUp()
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.plan, x=1, y=1, width=4, height=3, label="Cage"
        )

    def bulk(self, body):
        return self.client.post(
            f"/api/floor-plans/{self.plan.id}/bulk/", body, format="json"
        )

    def test_link_and_unlink(self):
        r = self._mk(source_area_id=str(self.area.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["source_area"], str(self.area.id))
        wall = r.json()["id"]
        r = self.client.patch(
            f"/api/floor-plan-walls/{wall}/", {"source_area_id": None}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["source_area"])

    def test_area_of_another_plan_or_tenant_is_refused(self):
        other_plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Other",
        )
        theirs = FloorPlanArea.objects.create(floor_plan=other_plan, x=0, y=0)
        r = self._mk(source_area_id=str(theirs.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("source_area_id", r.json())
        other_site = Site.objects.create(tenant=self.other, name="S2")
        other_loc = Location.objects.create(tenant=self.other, site=other_site, name="D")
        foreign = FloorPlan.objects.create(tenant=self.other, location=other_loc, name="F")
        hidden = FloorPlanArea.objects.create(floor_plan=foreign, x=0, y=0)
        r = self._mk(source_area_id=str(hidden.id))
        self.assertEqual(r.status_code, 400)

    def test_deleting_the_area_keeps_the_wall_unlinked(self):
        w = FloorPlanWall.objects.create(
            floor_plan=self.plan, points=[[1, 1], [5, 1]], source_area=self.area
        )
        self.area.delete()
        w.refresh_from_db()
        self.assertIsNone(w.source_area_id)

    def test_bulk_links_a_wall_to_an_area_made_in_the_same_save(self):
        r = self.bulk({
            "areas": {"create": [{
                "key": "new-7", "shape": "rect", "x": 8, "y": 2,
                "width": 3, "height": 2, "label": "Room",
            }]},
            "walls": {"create": [{
                "label": "Room walls", "source_area_id": "new-7",
                "points": [[8, 2], [11, 2], [11, 4], [8, 4], [8, 2]],
            }]},
        })
        self.assertEqual(r.status_code, 200, r.content)
        area = FloorPlanArea.objects.get(floor_plan=self.plan, label="Room")
        wall = FloorPlanWall.objects.get(floor_plan=self.plan, label="Room walls")
        self.assertEqual(wall.source_area_id, area.id)
        self.assertEqual(
            next(w for w in r.json()["walls"] if w["id"] == str(wall.id))["source_area"],
            str(area.id),
        )

    def test_bulk_moves_an_area_and_its_walls_with_versions(self):
        w = FloorPlanWall.objects.create(
            floor_plan=self.plan, points=[[1, 1], [5, 1]], source_area=self.area
        )
        r = self.bulk({
            "areas": {"update": [{
                "id": str(self.area.id), "version": self.area.updated_at.isoformat(),
                "x": 2,
            }]},
            "walls": {"update": [{
                "id": str(w.id), "version": w.updated_at.isoformat(),
                "points": [[2, 1], [6, 1]], "source_area_id": str(self.area.id),
            }]},
        })
        self.assertEqual(r.status_code, 200, r.content)
        w.refresh_from_db()
        self.assertEqual(w.points, [[2, 1], [6, 1]])
        self.assertEqual(w.source_area_id, self.area.id)

    def test_bulk_unknown_area_key_is_refused(self):
        r = self.bulk({"walls": {"create": [{
            "source_area_id": "new-99", "points": [[0, 0], [1, 0]],
        }]}})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(FloorPlanWall.objects.filter(floor_plan=self.plan).exists())

    def test_clone_keeps_the_link_on_the_copy(self):
        FloorPlanWall.objects.create(
            floor_plan=self.plan, points=[[1, 1], [5, 1]], source_area=self.area
        )
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/clone/", {"name": "Copy"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        wall = copy.walls.get()
        self.assertEqual(wall.source_area.floor_plan_id, copy.id)


class OffLatticeWallRoutingTests(_Base):
    """A wall off the lattice lines (made from an outline) still blocks a
    suggested run, except through its door."""

    def test_blocks_and_lets_through_its_door(self):
        from .pathfinding import suggest_run

        wall = ([[10.3, 0], [10.3, 20]], [])
        self.assertIsNone(
            suggest_run((5.5, 2.5), (15.5, 2.5), width=20, height=20, walls=[wall])
        )
        door = ([[10.3, 0], [10.3, 20]], [{"seg": 0, "from": 2, "to": 3.2}])
        pts = suggest_run((5.5, 2.5), (15.5, 2.5), width=20, height=20, walls=[door])
        self.assertIsNotNone(pts)
