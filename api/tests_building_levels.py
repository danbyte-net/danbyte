"""Building levels: a floor plan's floors aligned into one building - the
Same footprint add (walls and background copied), basements, computed
elevations, and the tenancy and permission rules of the copy."""

from __future__ import annotations

from audit.models import ChangeLogEntry

from .cable_routing import riser_vertical_mm
from .floor_stacks import outer_walls, stack_elevations
from .models import FloorPlan, FloorPlanStack, FloorPlanTile, FloorPlanWall, FloorTileType
from .tests_floorplan_stacks import StackTestCase

RING = [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]


class ElevationTests(StackTestCase):
    def _floors(self, *rows):
        stack = FloorPlanStack.objects.create(
            tenant=self.tenant, location=self.bldg, name="Tower", aligned=True)
        out = []
        for i, (name, order, ceiling, slab, elev) in enumerate(rows):
            out.append(FloorPlan.objects.create(
                tenant=self.tenant, location=self.bldg, stack=stack, name=name,
                floor_order=order if order is not None else i * 10,
                ceiling_mm=ceiling, slab_mm=slab, elevation_mm=elev))
        return stack, out

    def test_ground_is_zero_and_storeys_are_ceiling_plus_slab(self):
        _, (b1, g, one, two) = self._floors(
            ("B1", -10, 2500, 400, None), ("G", 0, 3000, 300, None),
            ("1", 10, 2800, 300, None), ("2", 20, 3000, 250, None))
        elev = stack_elevations([b1, g, one, two])
        self.assertEqual(elev[g.pk], 0)
        self.assertEqual(elev[one.pk], 3300)
        self.assertEqual(elev[two.pk], 3300 + 2800 + 250)
        # A basement: the ground's slab and its own ceiling below the ground.
        self.assertEqual(elev[b1.pk], -300 - 2500)

    def test_a_set_elevation_anchors_the_others(self):
        _, (g, one, two) = self._floors(
            ("G", 0, 3000, 300, None), ("1", 10, 3000, 300, 5000),
            ("2", 20, 3000, 300, None))
        elev = stack_elevations([g, one, two])
        self.assertEqual((elev[g.pk], elev[one.pk], elev[two.pk]), (1700, 5000, 8300))

    def test_the_stack_lists_elevations_only_when_aligned(self):
        stack, _ = self._floors(("G", 0, 3000, 300, None), ("1", 10, 3000, 300, None))
        r = self.client.get(f"/api/floor-plan-stacks/{stack.id}/")
        self.assertTrue(r.json()["aligned"])
        self.assertEqual([f["elevation"] for f in r.json()["floors"]], [0, 3300])
        FloorPlanStack.objects.filter(pk=stack.pk).update(aligned=False)
        r = self.client.get(f"/api/floor-plan-stacks/{stack.id}/")
        self.assertEqual([f["elevation"] for f in r.json()["floors"]], [None, None])

    def test_a_riser_on_an_aligned_stack_climbs_the_computed_storeys(self):
        _, (g, one, two) = self._floors(
            ("G", 0, 3000, 300, None), ("1", 10, 2700, 300, None),
            ("2", 20, 3000, 300, None))
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Riser", slug="riser")
        a = FloorPlanTile.objects.create(floor_plan=g, x=1, y=1, tile_type=tt, riser=True)
        b = FloorPlanTile.objects.create(floor_plan=two, x=1, y=1, tile_type=tt,
                                         riser=True, riser_to=a)
        self.assertEqual(riser_vertical_mm(a, b), 3300 + 3000)


class OuterWallTests(StackTestCase):
    def _wall(self, plan, points, **kw):
        return FloorPlanWall.objects.create(floor_plan=plan, points=points, **kw)

    def test_the_outline_without_partitions(self):
        plan = self._stack(floors=("G",)).floors.get()
        ring = self._wall(plan, RING, label="Ring")
        part = self._wall(plan, [[10, 0], [10, 10]], label="Partition")
        stub = self._wall(plan, [[0, 5], [6, 5]], label="Stub")
        self.assertEqual(outer_walls([ring, part, stub]), [ring])
        # Walls drawn per side are each on the outline.
        sides = [self._wall(plan, [a, b]) for a, b in zip(RING, RING[1:], strict=False)]
        self.assertEqual(outer_walls(sides + [part]), sides)

    def test_marked_walls_win(self):
        plan = self._stack(floors=("G",)).floors.get()
        ring = self._wall(plan, RING)
        part = self._wall(plan, [[10, 0], [10, 10]], exterior=True)
        self.assertEqual(outer_walls([ring, part]), [part])


class SameFootprintTests(StackTestCase):
    def setUp(self):
        super().setUp()
        self.stack = self._stack(floors=("Ground",))
        self.ground = FloorPlan.objects.get(stack=self.stack)
        FloorPlan.objects.filter(pk=self.ground.pk).update(
            grid_width=40, grid_height=30, cell_mm=500, ceiling_mm=3200, align_dx=1.5)
        self.ground.refresh_from_db()
        FloorPlanWall.objects.create(
            floor_plan=self.ground, points=RING, label="Shell", thickness_mm=300,
            openings=[{"seg": 0, "from": 2, "to": 3}])
        FloorPlanWall.objects.create(floor_plan=self.ground, points=[[10, 0], [10, 10]],
                                     label="Partition")

    def _add(self, **body):
        body.setdefault("copy_from", str(self.ground.id))
        return self.client.post(f"/api/floor-plan-stacks/{self.stack.id}/floors/", body,
                                format="json")

    def test_a_level_above_shares_the_footprint_and_takes_the_outer_walls(self):
        r = self._add(name="1", same_footprint=True, copy_walls=True, copy_background=True)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["grid_width"], body["grid_height"], body["cell_mm"]),
                         (40, 30, 500))
        self.assertEqual(body["align_dx"], 1.5)
        self.assertIsNone(body["elevation_mm"])
        self.assertEqual(body["elevation"], 3200 + 300)
        self.assertTrue(body["stack"]["aligned"])
        self.stack.refresh_from_db()
        self.assertTrue(self.stack.aligned)
        walls = list(FloorPlanWall.objects.filter(floor_plan_id=body["id"]))
        self.assertEqual([(w.label, w.openings, w.exterior, w.thickness_mm) for w in walls],
                         [("Shell", [], True, 300)])
        # Logged as any wall is.
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.floorplanwall", object_id=str(walls[0].pk),
            action="create").exists())

    def test_a_basement_goes_below_with_a_negative_order_and_elevation(self):
        r = self._add(name="B1", below=True, same_footprint=True, copy_walls=False)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertLess(r.json()["floor_order"], 0)
        self.assertFalse(FloorPlanWall.objects.filter(floor_plan_id=r.json()["id"]).exists())
        r = self._add(name="B2", below=True, same_footprint=True)
        self.assertEqual(self._names(self.stack), ["B2", "B1", "Ground"])
        floors = self.client.get(f"/api/floor-plan-stacks/{self.stack.id}/").json()["floors"]
        self.assertEqual([f["elevation"] for f in floors],
                         [-300 - 3200 - 300 - 3200, -300 - 3200, 0])
        # A floor put in by position keeps the ground at 0.
        r = self._add(name="Mezz", position=3, same_footprint=True)
        self.assertEqual(r.status_code, 201, r.content)
        orders = dict(FloorPlan.objects.filter(stack=self.stack)
                      .values_list("name", "floor_order"))
        self.assertEqual(orders, {"B2": -20, "B1": -10, "Ground": 0, "Mezz": 10})

    def test_without_the_tick_nothing_is_aligned_or_copied(self):
        r = self._add(name="1", copy_walls=True)
        self.assertEqual(r.status_code, 201, r.content)
        self.stack.refresh_from_db()
        self.assertFalse(self.stack.aligned)
        self.assertFalse(FloorPlanWall.objects.filter(floor_plan_id=r.json()["id"]).exists())

    def test_same_footprint_needs_a_floor_of_this_stack(self):
        r = self._add(name="1", same_footprint=True, copy_from=None)
        self.assertEqual(r.status_code, 400)
        other = self._stack(name="Other", floors=("X",))
        x = FloorPlan.objects.get(stack=other)
        r = self._add(name="1", same_footprint=True, copy_from=str(x.id))
        self.assertEqual(r.status_code, 400)
        their = FloorPlan.objects.create(tenant=self.tenant2, location=self.their_loc,
                                         stack=self.their_stack, name="T")
        r = self._add(name="1", same_footprint=True, copy_walls=True,
                      copy_from=str(their.id))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self._names(self.stack), ["Ground"])

    def test_copying_walls_needs_wall_add_and_rolls_back(self):
        u = self._limited_user("floors-only", ["view", "add", "change"])
        self._login(u)
        r = self._add(name="1", same_footprint=True, copy_walls=True)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(self._names(self.stack), ["Ground"])
        self.stack.refresh_from_db()
        self.assertFalse(self.stack.aligned)
        # Without the walls the same user may add the level.
        r = self._add(name="1", same_footprint=True)
        self.assertEqual(r.status_code, 201, r.content)

    def test_align_fields_are_editable(self):
        r = self.client.patch(f"/api/floor-plans/{self.ground.id}/",
                              {"align_dx": 2.25, "align_rot": 90, "slab_mm": 250},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["align_dx"], r.json()["align_rot"], r.json()["slab_mm"]),
                         (2.25, 90.0, 250))
        r = self.client.patch(f"/api/floor-plans/{self.ground.id}/", {"align_rot": 720},
                              format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/floor-plan-stacks/{self.stack.id}/", {"aligned": True},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["aligned"])

    def test_walls_read_and_write_exterior(self):
        r = self.client.post("/api/floor-plan-walls/", {
            "floor_plan_id": str(self.ground.id), "points": [[0, 0], [5, 0]],
            "exterior": True}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["exterior"])


class RiserShaftTests(StackTestCase):
    """Risers at one place of an aligned floor plan pair on their own, and
    Through to places or removes them on the other levels."""

    def setUp(self):
        super().setUp()
        self.stack = FloorPlanStack.objects.create(
            tenant=self.tenant, location=self.bldg, name="Tower", aligned=True)
        self.floors = [
            FloorPlan.objects.create(tenant=self.tenant, location=self.bldg,
                                     stack=self.stack, name=n, floor_order=i * 10)
            for i, n in enumerate(("G", "1", "2"))
        ]
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Shaft",
                                               slug="shaft")
        self.r0 = FloorPlanTile.objects.create(floor_plan=self.floors[0], x=4, y=3,
                                               tile_type=self.tt, riser=True, label="S1")

    def _through(self, floors, tile=None):
        return self.client.post(f"/api/floor-plan-tiles/{(tile or self.r0).id}/through/",
                                {"floors": [str(f.id) for f in floors]}, format="json")

    def test_through_places_risers_that_pair_at_the_same_place(self):
        from .cable_routing import riser_links, riser_pairs

        r = self._through(self.floors[1:])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(all(lv["tile"] for lv in r.json()["levels"]))
        up = FloorPlanTile.objects.get(floor_plan=self.floors[2])
        self.assertEqual((up.x, up.y, up.label, up.riser), (4, 3, "S1", True))
        links = riser_links(self.floors[0], [self.r0])[self.r0.pk]
        self.assertEqual([t.floor_plan_id for t in links],
                         [self.floors[1].pk, self.floors[2].pk])
        self.assertEqual(riser_pairs(self.floors[0], [self.r0])[self.r0.pk].floor_plan_id,
                         self.floors[1].pk)
        # The scene names them for the 3D building.
        scene = self.client.get(f"/api/floor-plans/{self.floors[0].id}/scene/").json()
        tile = next(t for t in scene["tiles"] if t["id"] == str(self.r0.id))
        self.assertEqual([x["floor_plan"] for x in tile["riser_to"]],
                         [str(self.floors[1].id), str(self.floors[2].id)])
        self.assertEqual(scene["plan"]["elevation_mm"], 0)
        # Untick a level: its riser goes.
        r = self._through(self.floors[1:2])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(FloorPlanTile.objects.filter(floor_plan=self.floors[2]).exists())

    def test_an_offset_level_gets_the_riser_at_its_own_cells(self):
        FloorPlan.objects.filter(pk=self.floors[1].pk).update(align_dx=2, align_dy=-1)
        r = self._through(self.floors[1:2])
        self.assertEqual(r.status_code, 200, r.content)
        t = FloorPlanTile.objects.get(floor_plan=self.floors[1])
        self.assertEqual((t.x, t.y), (2, 4))

    def test_not_aligned_or_not_a_riser_is_refused(self):
        r = self._through([], tile=FloorPlanTile.objects.create(
            floor_plan=self.floors[0], x=0, y=0, tile_type=self.tt))
        self.assertEqual(r.status_code, 400)
        FloorPlanStack.objects.filter(pk=self.stack.pk).update(aligned=False)
        r = self._through(self.floors[1:])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(
            f"/api/floor-plan-tiles/{self.r0.id}/through/").json()["levels"], [])

    def test_a_level_of_another_stack_is_refused(self):
        other = self._stack(name="Other", floors=("X",)).floors.get()
        r = self._through([other])
        self.assertEqual(r.status_code, 400)

    def test_another_tenants_user_finds_nothing(self):
        their_user = self._limited_user("them", ["view", "change", "add"],
                                        types=("floorplan", "floorplantile"))
        their_user.profile.tenants.set([self.tenant2])
        self.client.force_login(their_user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant2.id)
        sess.save()
        r = self._through(self.floors[1:])
        self.assertEqual(r.status_code, 404)
        self.assertEqual(FloorPlanTile.objects.count(), 1)

    def test_tile_add_is_needed(self):
        u = self._limited_user("chg", ["view", "change"],
                               types=("floorplan", "floorplantile"))
        self._login(u)
        r = self._through(self.floors[1:])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(FloorPlanTile.objects.count(), 1)
