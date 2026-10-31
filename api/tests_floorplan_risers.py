"""Cables between floors (floor-plan cables, phase 6).

A riser tile pairs with one riser tile on another floor of the site
(``riser_to`` on either side). A cable with an end on each floor is routed
to the riser on both floors (``PlanRouter.via_riser``) and stored as one
``FloorPlanCablePath`` per floor, each naming its riser; the length is the
two floors' runs, drops and level changes plus the vertical run, with the
length rules applied once.
"""
from django.contrib.auth import get_user_model

from auth_api.models import ObjectPermission, UserProfile

from .cable_routing import PlanRouter, length_total, riser_vertical_mm
from .models import (
    Device,
    FloorPlan,
    FloorPlanCablePath,
    FloorPlanTile,
    FloorPlanTray,
    Location,
    Rack,
    Site,
)
from .tests_floorplan_cable_paths import _Plan

User = get_user_model()


class _Floors(_Plan):
    """The base plan as floor 1, a second floor of the same floor plan with
    a rack, a riser on each floor and a cable from floor 1 to floor 2."""

    def setUp(self):
        super().setUp()
        self.plan2 = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, stack=self.plan.stack, name="Floor 2",
            floor_order=10, cell_mm=600, ceiling_mm=3000, grid_width=40, grid_height=20,
        )
        self.rack_c = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="RC", u_height=42
        )
        self.tile_c = FloorPlanTile.objects.create(
            floor_plan=self.plan2, tile_type=self.tt, x=2, y=2, rack=self.rack_c,
            link_kind="rack",
        )
        self.dev_c = Device.objects.create(
            tenant=self.tenant, name="sw-c", site=self.site, rack=self.rack_c,
            device_type=self.dtype, position=41,
        )
        self.r1 = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=12, y=2, riser=True, label="R1",
        )
        self.r2 = FloorPlanTile.objects.create(
            floor_plan=self.plan2, tile_type=self.tt, x=12, y=2, riser=True, label="R1 up",
        )
        self.tray2 = FloorPlanTray.objects.create(
            floor_plan=self.plan2, name="OH-2", level="overhead", points=[[2, 1], [13, 1]],
        )
        self.up = self._cable("C-up", self.dev_a, self.dev_c)

    def pair(self):
        self.r2.riser_to = self.r1
        self.r2.save()

    def preview(self, body, plan=None):
        r = self.client.post(
            f"/api/floor-plans/{(plan or self.plan).id}/cable-plan/", body, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"]: c for c in r.json()["cables"]}


class RiserPairingTests(_Floors):
    def tiles_bulk(self, plan, update):
        return self.bulk({"tiles": {"update": update}}, plan=plan)

    def tile(self, tile):
        r = self.client.get(f"/api/floor-plan-tiles/{tile.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_pair_through_the_editor_save_reads_on_both_sides(self):
        r = self.tiles_bulk(self.plan2, [{"id": str(self.r2.id), "riser_to_id": str(self.r1.id)}])
        self.assertEqual(r.status_code, 200, r.content)
        self.r2.refresh_from_db()
        self.assertEqual(self.r2.riser_to_id, self.r1.id)
        mine = self.tile(self.r1)["riser_pair"]
        self.assertEqual(mine["id"], str(self.r2.id))
        self.assertEqual(mine["floor_plan"]["name"], "Floor 2")
        self.assertEqual(self.tile(self.r2)["riser_pair"]["id"], str(self.r1.id))
        # Pairing back the other way keeps one pair.
        r = self.tiles_bulk(self.plan, [{"id": str(self.r1.id), "riser_to_id": str(self.r2.id)}])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.tile(self.r2)["riser_pair"]["id"], str(self.r1.id))

    def test_refused_pairs(self):
        other = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=14, y=2, riser=True,
        )
        plain = FloorPlanTile.objects.create(floor_plan=self.plan2, tile_type=self.tt, x=20, y=2)
        site2 = Site.objects.create(tenant=self.tenant, name="FRA")
        loc2 = Location.objects.create(tenant=self.tenant, site=site2, name="H", slug="h")
        far = FloorPlan.objects.create(tenant=self.tenant, location=loc2, name="Far")
        far_riser = FloorPlanTile.objects.create(
            floor_plan=far, tile_type=self.tt, x=1, y=1, riser=True,
        )
        cases = [
            (self.plan, self.r1, other, "another floor"),
            (self.plan, self.r1, plain, "not a riser"),
            (self.plan, self.r1, far_riser, "same site"),
            (self.plan, self.r1, self.r1, "another floor"),
        ]
        for plan, tile, target, words in cases:
            r = self.tiles_bulk(plan, [{"id": str(tile.id), "riser_to_id": str(target.id)}])
            self.assertEqual(r.status_code, 400, (words, r.content))
            self.assertIn(words, r.content.decode())
        # Already paired with a third riser.
        self.pair()
        third = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=16, y=2, riser=True,
        )
        r = self.tiles_bulk(self.plan, [{"id": str(third.id), "riser_to_id": str(self.r2.id)}])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("already pairs", r.content.decode())

    def test_unpairing_or_no_longer_a_riser_clears_both_sides(self):
        self.pair()
        r = self.tiles_bulk(self.plan, [{"id": str(self.r1.id), "riser_to_id": None}])
        self.assertEqual(r.status_code, 200, r.content)
        self.r2.refresh_from_db()
        self.assertIsNone(self.r2.riser_to_id)
        self.assertIsNone(self.tile(self.r1)["riser_pair"])
        self.pair()
        r = self.tiles_bulk(self.plan2, [{"id": str(self.r2.id), "riser": False}])
        self.assertEqual(r.status_code, 200, r.content)
        self.r2.refresh_from_db()
        self.assertIsNone(self.r2.riser_to_id)
        self.assertIsNone(self.tile(self.r1)["riser_pair"])

    def test_risers_lists_the_other_floors_risers(self):
        self.pair()
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/risers/")
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = r.json()["risers"]
        self.assertEqual(row["id"], str(self.r2.id))
        self.assertEqual(row["floor_plan"]["name"], "Floor 2")
        self.assertEqual(row["pair"], str(self.r1.id))

    def test_a_pair_on_a_floor_the_reader_may_not_view_reads_hidden(self):
        self.pair()
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan"], actions=["view"],
            constraints={"name": "Hall A"},
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm2 = ObjectPermission.objects.create(
            name="v2", object_types=["floorplantile"], actions=["view"],
        )
        perm2.users.add(user)
        perm2.tenants.add(self.tenant)
        self.login(user)
        pair = self.tile(self.r1)["riser_pair"]
        self.assertTrue(pair["hidden"])
        self.assertIsNone(pair["id"])
        self.assertNotIn("Floor 2", str(pair))
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/risers/")
        self.assertEqual(r.json()["risers"], [])

    def test_a_clone_keeps_its_risers_unpaired(self):
        self.pair()
        r = self.client.post(
            f"/api/floor-plans/{self.plan2.id}/clone/", {"name": "Floor 2 copy"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlanTile.objects.get(floor_plan_id=r.json()["id"], riser=True)
        self.assertIsNone(copy.riser_to_id)
        self.r2.refresh_from_db()
        self.assertEqual(self.r2.riser_to_id, self.r1.id)


class RiserVerticalTests(_Floors):
    def test_a_riser_height_wins(self):
        self.r1.riser_height_mm = 4200
        self.assertEqual(riser_vertical_mm(self.r1, self.r2), 4200)

    def test_floor_elevations(self):
        self.plan.elevation_mm = 0
        self.plan2.elevation_mm = 4500
        self.assertEqual(riser_vertical_mm(self.r1, self.r2), 4500)

    def test_ceiling_heights_of_the_floors_between(self):
        mid = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, stack=self.plan.stack, name="Mezz",
            floor_order=5, ceiling_mm=2500,
        )
        self.assertIsNotNone(mid)
        # Floor 1 (3000) and the mezzanine (2500) lie between.
        self.assertEqual(riser_vertical_mm(self.r1, self.r2), 5500)
        self.assertEqual(riser_vertical_mm(self.r2, self.r1), 5500)


class RiserRoutingTests(_Floors):
    def test_routes_each_floor_to_its_riser_and_sums_the_length(self):
        self.pair()
        res = PlanRouter(self.plan).via_riser(self.up)
        self.assertIsNotNone(res)
        near, far = res["near"], res["far"]
        self.assertEqual(res["far_plan"], self.plan2)
        self.assertEqual(near["legs"][0]["from"]["tile"], str(self.tile_a.id))
        self.assertEqual(near["legs"][0]["to"]["tile"], str(self.r1.id))
        self.assertTrue(near["legs"][0]["to"]["riser"])
        self.assertEqual(far["legs"][0]["from"]["tile"], str(self.tile_c.id))
        self.assertEqual(far["legs"][0]["to"]["tile"], str(self.r2.id))
        self.assertEqual(near["tray_order"], [str(self.tray.id)])
        self.assertEqual(far["tray_order"], [str(self.tray2.id)])
        self.assertEqual(near["riser"]["floor_plan"]["name"], "Floor 2")
        self.assertEqual(far["riser"]["floor_plan"]["name"], "Hall A")
        self.assertEqual(res["riser_mm"], 3000)
        # One length for the cable: both floors' parts and the riser, the
        # rules applied once.
        router = PlanRouter(self.plan)
        base = sum(
            part[k] for part in (near, far) for k in ("run_mm", "drop_a_mm", "drop_b_mm")
        ) + 3000
        _loops, _slack, total = length_total(base, router.rules)
        self.assertAlmostEqual(res["length_mm"], total, delta=10)
        self.assertEqual(near["length_mm"], far["length_mm"])
        # No drop at the riser: the cable climbs inside it.
        self.assertEqual(near["drop_b_mm"], 0)
        self.assertGreater(near["drop_a_mm"], 0)

    def test_no_pair_no_route(self):
        self.assertIsNone(PlanRouter(self.plan).via_riser(self.up))
        self.assertEqual(PlanRouter(self.plan).nearest_riser(self.up), self.r1)

    def test_a_cable_with_both_ends_here_is_not_a_riser_cable(self):
        self.pair()
        self.assertIsNone(PlanRouter(self.plan).via_riser(self.cable))

    def test_the_shortest_pair_wins(self):
        self.pair()
        r3 = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=3, y=4, riser=True, label="R2",
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan2, tile_type=self.tt, x=3, y=4, riser=True, riser_to=r3,
        )
        res = PlanRouter(self.plan).via_riser(self.up)
        self.assertEqual(res["near"]["riser"]["tile"], str(r3.id))

    def test_after_placing_routes_it_through_the_riser(self):
        self.pair()
        rows = self.preview({"objects": [{"kind": "rack", "id": str(self.rack_a.id)}]})
        row = rows[str(self.up.id)]
        self.assertFalse(row["off_floor"])
        self.assertEqual(row["via"], "riser")
        self.assertEqual(row["route"]["riser"]["tile"], str(self.r1.id))
        self.assertEqual(row["route"]["riser"]["floor_plan"]["name"], "Floor 2")
        self.assertEqual(row["route"]["riser"]["riser_mm"], 3000)
        self.assertTrue(row["write_length"])
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_unpaired_it_leaves_the_floor_via_the_riser(self):
        rows = self.preview({"objects": [{"kind": "rack", "id": str(self.rack_a.id)}]})
        row = rows[str(self.up.id)]
        self.assertTrue(row["off_floor"])
        self.assertIsNone(row["route"])
        self.assertEqual(row["via_riser"], "R1")
        self.assertEqual(row["reason"], "Leaves this floor via R1.")

    def test_a_far_floor_the_reader_may_not_view_is_not_used(self):
        self.pair()
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan"], actions=["view", "change"],
            constraints={"name": "Hall A"},
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm2 = ObjectPermission.objects.create(
            name="v2", object_types=["floorplantile", "floorplancablepath", "cable",
                                     "device", "rack"],
            actions=["view", "add", "change", "delete"],
        )
        perm2.users.add(user)
        perm2.tenants.add(self.tenant)
        self.login(user)
        rows = self.preview({"cable_ids": [str(self.up.id)]})
        row = rows[str(self.up.id)]
        self.assertIsNone(row["route"])
        self.assertNotIn("Floor 2", str(row))
        r = self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.up.id), "riser": str(self.r1.id)},
        ]}})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_save_stores_a_row_per_floor_and_the_length(self):
        self.pair()
        r = self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.up.id), "riser": str(self.r1.id), "write_length": True},
        ]}})
        self.assertEqual(r.status_code, 200, r.content)
        near = FloorPlanCablePath.objects.get(floor_plan=self.plan, cable=self.up)
        far = FloorPlanCablePath.objects.get(floor_plan=self.plan2, cable=self.up)
        self.assertEqual((near.riser_id, far.riser_id), (self.r1.id, self.r2.id))
        self.assertEqual((near.riser_mm, far.riser_mm), (3000, 3000))
        self.assertEqual(near.length_mm, far.length_mm)
        self.up.refresh_from_db()
        self.assertEqual(self.up.length_source, "computed")
        self.assertAlmostEqual(float(self.up.length) * 1000, near.length_mm, delta=10)
        self.assertEqual(
            set(self.up.trays.values_list("pk", flat=True)), {self.tray.id, self.tray2.id}
        )
        # Both floors draw their part, to the riser.
        row = self.cable_paths(plan=self.plan2)[str(self.up.id)]
        self.assertEqual(row["path"]["riser"]["tile"], str(self.r2.id))
        self.assertEqual(row["path"]["legs"][0]["to"]["tile"], str(self.r2.id))
        # Deleting the route takes both parts.
        r = self.bulk({"cable_paths": {"delete": [str(self.up.id)]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(FloorPlanCablePath.objects.filter(cable=self.up).exists())

    def test_a_riser_moved_makes_its_path_stale(self):
        self.pair()
        self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.up.id), "riser": str(self.r1.id)},
        ]}})
        self.r1.x = 14
        self.r1.save()
        self.assertTrue(FloorPlanCablePath.objects.get(floor_plan=self.plan, cable=self.up).stale)
