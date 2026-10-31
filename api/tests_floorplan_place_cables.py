"""Also place cables (floor-plan cables, phase 3).

After a device, rack or cabinet is placed, ``cable-plan`` previews its
cables to objects already on the floor (``objects``, against the unsaved
draft: ``new_tiles``, ``positions``, ``draft_trays``). Where no tray
connects the ends a run is suggested (``suggest_runs``): A* on the plan's
half-cell lattice in ``pathfinding.suggest_run`` - walls block except at
their doors, other tiles are in the way, existing trays are cheaper to
follow, an underfloor run stays on the raised floor - kept as a new tray
unless ``keep_runs`` is false. ``bulk/`` saves the kept runs
(``trays.create``) with the routes that use them.
"""
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase

from auth_api.models import ObjectPermission, UserProfile

from .cable_routing import PlanRouter, plan_batch, virtual_tile
from .models import (
    Cable,
    Device,
    FloorPlanCablePath,
    FloorPlanRaisedFloorArea,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    Rack,
)
from .pathfinding import lattice_steps, suggest_run
from .tests_floorplan_cable_paths import _Plan

User = get_user_model()


class SuggestRunTests(SimpleTestCase):
    """The A* on its own: no database."""

    WALL = ([[10, 0], [10, 20]], [{"seg": 0, "from": 14, "to": 15}])

    def test_open_floor_is_a_straight_run(self):
        pts = suggest_run((1.5, 2.5), (15.5, 2.5), width=20, height=20)
        self.assertEqual(pts, [(1.5, 2.5), (15.5, 2.5)])

    def test_goes_around_a_wall_through_its_door(self):
        pts = suggest_run((5.5, 2.5), (15.5, 2.5), width=20, height=20, walls=[self.WALL])
        self.assertIsNotNone(pts)
        # It crosses the wall once, inside the door (y 14-15).
        ys = [p[1] for p, q in zip(pts, pts[1:], strict=False)
              if min(p[0], q[0]) < 10 < max(p[0], q[0])]
        self.assertEqual(len(ys), 1)
        self.assertTrue(14 < ys[0] < 15, ys)

    def test_a_wall_without_a_door_blocks(self):
        wall = ([[10, 0], [10, 20]], [])
        self.assertIsNone(
            suggest_run((5.5, 2.5), (15.5, 2.5), width=20, height=20, walls=[wall])
        )

    def test_a_slanted_wall_blocks_too(self):
        wall = ([[8, 0], [12, 20]], [])
        self.assertIsNone(
            suggest_run((2.5, 2.5), (16.5, 2.5), width=20, height=20, walls=[wall])
        )

    def test_tiles_are_in_the_way(self):
        block = (8, 1, 2, 8)
        pts = suggest_run((5.5, 4.5), (15.5, 4.5), width=20, height=20, obstacles=[block])
        self.assertGreater(len(pts), 2)
        for p, q in zip(pts, pts[1:], strict=False):
            # No stretch of the run passes inside the block.
            if p[1] == q[1] and 1 < p[1] < 9:
                self.assertFalse(min(p[0], q[0]) < 10 and max(p[0], q[0]) > 8, pts)
            if p[0] == q[0] and 8 < p[0] < 10:
                self.assertFalse(min(p[1], q[1]) < 9 and max(p[1], q[1]) > 1, pts)

    def test_not_between_two_tiles_that_touch(self):
        # Two blocks meeting along y = 5: the seam is no way through.
        blocks = [(8, 1, 2, 4), (8, 5, 2, 4)]
        pts = suggest_run((5.5, 5), (15.5, 5), width=20, height=20, obstacles=blocks)
        self.assertGreater(len(pts), 2)
        self.assertTrue(any(p[1] <= 1 or p[1] >= 9 for p in pts), pts)

    def test_existing_trays_are_cheaper(self):
        # A tray a cell to the side: the run takes it rather than run
        # beside it.
        tray = [(0, 6), (20, 6)]
        pts = suggest_run((1, 5), (19, 5), width=20, height=12, trays=[tray])
        self.assertIn(6, [p[1] for p in pts])
        self.assertEqual(
            suggest_run((1, 5), (19, 5), width=20, height=12), [(1, 5), (19, 5)]
        )

    def test_runs_are_orthogonal(self):
        pts = suggest_run((1.5, 1.5), (17.5, 13.5), width=20, height=20)
        for p, q in zip(pts[1:-2], pts[2:-1], strict=False):
            self.assertTrue(p[0] == q[0] or p[1] == q[1], pts)
        self.assertLessEqual(len(pts), 4)

    def test_within_keeps_it_inside(self):
        raised = [(0, 0, 10, 10), (10, 6, 10, 4)]
        pts = suggest_run((2.5, 2.5), (18.5, 8.5), width=20, height=20, within=raised)
        self.assertIsNotNone(pts)
        for p in pts:
            self.assertTrue(any(
                x <= p[0] <= x + w and y <= p[1] <= y + h for x, y, w, h in raised
            ), p)
        self.assertIsNone(
            suggest_run((2.5, 2.5), (18.5, 2.5), width=20, height=20, within=raised)
        )

    def test_lattice_steps_both_ways(self):
        steps = lattice_steps([[(0, 0), (1, 0)]])
        self.assertIn((0, 0, 1, 0), steps)
        self.assertIn((1, 0, 0, 0), steps)
        self.assertEqual(len(steps), 4)


class _NoTray(_Plan):
    """The base plan without its tray: nothing connects the racks."""

    def setUp(self):
        super().setUp()
        self.tray.delete()
        self.url = f"/api/floor-plans/{self.plan.id}/cable-plan/"

    def preview(self, body, plan=None):
        url = f"/api/floor-plans/{(plan or self.plan).id}/cable-plan/"
        r = self.client.post(url, body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class SuggestServiceTests(_NoTray):
    def test_no_tray_path_suggests_a_run_kept_as_a_tray(self):
        router = PlanRouter(self.plan)
        routes, suggestions = plan_batch(router, [self.cable], suggest=True)
        route = routes[self.cable.pk]
        (s,) = suggestions
        self.assertEqual(route["via"], "suggest")
        self.assertEqual(route["kind"], "trays")
        self.assertEqual(route["tray_order"], [s["key"]])
        self.assertEqual(s["level"], "overhead")
        self.assertEqual(s["elevation_mm"], 2700)
        # The new tray runs between the tiles, not into them.
        self.assertEqual(s["run"], [[1.0, 2.5], [10.0, 2.5]])

    def test_without_keeping_it_is_the_cables_own_path_as_long(self):
        kept = plan_batch(PlanRouter(self.plan), [self.cable], suggest=True)[0]
        own = plan_batch(PlanRouter(self.plan), [self.cable], suggest=True,
                         keep_runs=False)[0]
        route = own[self.cable.pk]
        self.assertEqual(route["kind"], "manual")
        self.assertEqual(route["legs"][0]["elevation_mm"], 2700)
        self.assertEqual(route["length_mm"], kept[self.cable.pk]["length_mm"])
        # Up to the run's height and down again, not along the floor.
        self.assertGreater(route["drop_a_mm"], 0)

    def test_cables_between_one_pair_share_one_suggestion(self):
        second = self._cable("C-2", self.dev_a, self.dev_b)
        routes, suggestions = plan_batch(
            PlanRouter(self.plan), [self.cable, second], suggest=True
        )
        self.assertEqual(len(suggestions), 1)
        self.assertEqual(
            sorted(suggestions[0]["cable_ids"]), sorted([str(self.cable.id), str(second.id)])
        )

    def test_a_later_suggestion_follows_an_earlier_one(self):
        rack_c = Rack.objects.create(tenant=self.tenant, site=self.site, name="RC")
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=10, y=8, rack=rack_c, link_kind="rack",
        )
        dev_c = Device.objects.create(
            tenant=self.tenant, name="sw-c", site=self.site, rack=rack_c,
            device_type=self.dtype, position=1,
        )
        other = self._cable("C-3", self.dev_a, dev_c)
        _routes, suggestions = plan_batch(
            PlanRouter(self.plan), [self.cable, other], suggest=True
        )
        self.assertEqual(len(suggestions), 2)
        # The second new tray starts where it leaves the first.
        first, second = suggestions
        self.assertNotEqual(second["run"][0], [1.0, 2.5])

    def test_through_a_door(self):
        FloorPlanWall.objects.create(
            floor_plan=self.plan, points=[[5, 0], [5, 20]],
            openings=[{"seg": 0, "from": 9, "to": 10}],
        )
        _r, (s,) = plan_batch(PlanRouter(self.plan), [self.cable], suggest=True)
        crossing = [p for p, q in zip(s["points"], s["points"][1:], strict=False)
                    if min(p[0], q[0]) < 5 < max(p[0], q[0])]
        self.assertEqual(len(crossing), 1)
        self.assertTrue(9 < crossing[0][1] < 10, s["points"])

    def test_on_a_raised_floor_it_runs_underfloor_inside_it(self):
        FloorPlanRaisedFloorArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=12, height=6, plenum_mm=450,
        )
        _r, (s,) = plan_batch(PlanRouter(self.plan), [self.cable], suggest=True)
        self.assertEqual(s["level"], "underfloor")
        self.assertEqual(s["elevation_mm"], -450)
        for x, y in s["points"]:
            self.assertTrue(0 <= x <= 12 and 0 <= y <= 6)
        _r, (s,) = plan_batch(PlanRouter(self.plan), [self.cable], suggest=True,
                              level="overhead")
        self.assertEqual(s["level"], "overhead")

    def test_underfloor_follows_underfloor_trays_only(self):
        FloorPlanRaisedFloorArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=12, height=12,
        )
        # An overhead tray at y 6 is no help to an underfloor run.
        FloorPlanTray.objects.create(
            floor_plan=self.plan, name="OH", level="overhead",
            points=[[0, 6], [12, 6]],
        )
        _r, (s,) = plan_batch(
            PlanRouter(self.plan), [self.cable], level="underfloor",
            choices={str(self.cable.id): {"via": "suggest"}},
        )
        self.assertEqual(s["level"], "underfloor")
        self.assertNotIn(6.0, [p[1] for p in s["points"]])

    def test_direct_and_picked_trays(self):
        tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="T", points=[[0, 1], [11, 1]],
        )
        routes, _s = plan_batch(PlanRouter(self.plan), [self.cable], choices={
            str(self.cable.id): {"via": "direct"},
        })
        self.assertEqual(routes[self.cable.pk]["kind"], "direct")
        routes, _s = plan_batch(PlanRouter(self.plan), [self.cable], choices={
            str(self.cable.id): {"via": "trays", "tray_ids": [str(tray.id)]},
        })
        self.assertEqual(routes[self.cable.pk]["tray_order"], [str(tray.id)])

    def test_an_unsaved_tile_routes(self):
        dev = Device.objects.create(tenant=self.tenant, name="ap", site=self.site)
        cable = self._cable("C-ap", dev, self.dev_b)
        tile = virtual_tile("new-1", x=4, y=6, width=1, height=1, device_id=dev.pk)
        route = PlanRouter(self.plan, new_tiles=[tile]).route(cable)
        self.assertEqual(route["legs"][0]["from"]["tile"], "new-1")
        self.assertEqual(route["legs"][0]["points"][0], [4.5, 6.5])


class CablePlanAfterPlacingTests(_NoTray):
    def test_objects_list_the_cables_with_their_far_ends(self):
        ghost = Device.objects.create(tenant=self.tenant, name="ghost", site=self.site)
        off = self._cable("C-off", self.dev_a, ghost)
        inner = Device.objects.create(
            tenant=self.tenant, name="sw-a2", site=self.site, rack=self.rack_a,
            device_type=self.dtype, position=1,
        )
        self._cable("C-in", self.dev_a, inner)
        data = self.preview({"objects": [{"kind": "rack", "id": str(self.rack_a.id)}]})
        rows = {r["id"]: r for r in data["cables"]}
        self.assertEqual(set(rows), {str(self.cable.id), str(off.id)})
        row = rows[str(self.cable.id)]
        self.assertFalse(row["off_floor"])
        self.assertEqual(row["far"], [{"hidden": False, "device_name": "sw-b",
                                       "port": row["far"][0]["port"]}])
        self.assertEqual(row["via"], "direct")
        self.assertIn("cable_version", row)
        self.assertTrue(rows[str(off.id)]["off_floor"])
        self.assertIsNone(rows[str(off.id)]["route"])
        self.assertEqual(rows[str(off.id)]["reason"], "Leaves this floor.")

    def test_a_dropped_device_on_an_unsaved_tile(self):
        dev = Device.objects.create(tenant=self.tenant, name="ap", site=self.site)
        cable = self._cable("C-ap", dev, self.dev_b)
        data = self.preview({
            "objects": [{"kind": "device", "id": str(dev.id)}],
            "new_tiles": [{"id": "new-4", "x": 4, "y": 6, "width": 1, "height": 1,
                           "link_kind": "device", "link_id": str(dev.id)}],
            "suggest_runs": True,
        })
        (row,) = data["cables"]
        self.assertEqual(row["id"], str(cable.id))
        self.assertEqual(row["via"], "suggest")
        self.assertEqual(row["route"]["legs"][0]["from"]["tile"], "new-4")
        (s,) = data["suggestions"]
        self.assertEqual(row["route"]["tray_order"], [s["key"]])
        self.assertEqual(s["cable_ids"], [str(cable.id)])
        self.assertFalse(FloorPlanTray.objects.exists())

    def test_another_tenants_device_does_not_place(self):
        from core.models import Tenant

        other = Tenant.objects.create(org=self.org, name="X", slug="x")
        stranger = Device.objects.create(tenant=other, name="s", site=None)
        data = self.preview({
            "objects": [{"kind": "device", "id": str(stranger.id)}],
            "new_tiles": [{"id": "new-1", "x": 4, "y": 6, "width": 1, "height": 1,
                           "link_kind": "device", "link_id": str(stranger.id)}],
        })
        self.assertEqual(data["cables"], [])

    def test_draft_trays_route(self):
        data = self.preview({
            "cable_ids": [str(self.cable.id)],
            "draft_trays": [{"id": "new-9", "points": [[0, 1], [11, 1]],
                             "level": "overhead"}],
        })
        (row,) = data["cables"]
        self.assertEqual(row["via"], "trays")
        self.assertEqual(row["route"]["tray_order"], ["new-9"])

    def test_keep_runs_false_answers_manual_paths(self):
        data = self.preview({"cable_ids": [str(self.cable.id)], "suggest_runs": True,
                             "keep_runs": False})
        (row,) = data["cables"]
        self.assertEqual(row["route"]["kind"], "manual")
        self.assertEqual(row["suggestions"], ["run-1"])

    def test_bad_input_is_a_400(self):
        for body in (
            {"choices": []},
            {"run_level": "sideways"},
            {"objects": [{"kind": "vlan", "id": "x"}]},
            {"new_tiles": [{"id": "n", "x": 1}]},
            {"draft_trays": [{"id": "t", "points": [[0, 0]]}]},
        ):
            r = self.client.post(self.url, body, format="json")
            self.assertEqual(r.status_code, 400, (body, r.content))

    def test_hidden_far_end_reads_hidden(self):
        editor = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=editor).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "cable", "rack"],
            actions=["view"],
        )
        perm.users.add(editor)
        perm.tenants.add(self.tenant)
        self.login(editor)
        data = self.preview({"objects": [{"kind": "rack", "id": str(self.rack_a.id)}]})
        (row,) = data["cables"]
        self.assertEqual(row["far"], [{"hidden": True, "device_name": None, "port": None}])
        self.assertNotIn("sw-b", str(data))
        self.assertFalse(row["can_change"])

    def test_needs_the_plan(self):
        stranger = User.objects.create_user("s", password="x")
        UserProfile.objects.create(user=stranger).tenants.add(self.tenant)
        self.login(stranger)
        r = self.client.post(self.url, {"suggest_runs": True}, format="json")
        self.assertIn(r.status_code, (403, 404))


class BulkKeptRunTests(_NoTray):
    def setUp(self):
        super().setUp()
        self.editor = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=self.editor).tenants.add(self.tenant)

    def grant(self, types, actions):
        perm = ObjectPermission.objects.create(
            name="g-" + "-".join(types), object_types=types, actions=actions,
        )
        perm.users.add(self.editor)
        perm.tenants.add(self.tenant)

    def save_body(self, data):
        (row,) = data["cables"]
        (s,) = data["suggestions"]
        return {
            "trays": {"create": [{"key": s["key"], "points": s["run"], "level": s["level"]}]},
            "cable_paths": {"upsert": [{
                "cable": row["id"], "kind": row["route"]["kind"],
                "legs": [{"points": leg["points"]} for leg in row["route"]["legs"]],
                "tray_order": row["route"]["tray_order"], "write_length": True,
            }]},
        }

    def test_a_kept_run_is_a_new_tray_the_route_rides(self):
        data = self.preview({"cable_ids": [str(self.cable.id)], "suggest_runs": True})
        r = self.bulk(self.save_body(data))
        self.assertEqual(r.status_code, 200, r.content)
        tray = FloorPlanTray.objects.get(floor_plan=self.plan)
        self.assertEqual(tray.name, "Run 1")
        self.assertEqual(tray.points, [[1.0, 2.5], [10.0, 2.5]])
        self.assertEqual(r.json()["trays"], [{"key": "run-1", "id": str(tray.id)}])
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        self.assertEqual(path.tray_order, [str(tray.id)])
        self.assertEqual(list(self.cable.trays.all()), [tray])
        self.cable.refresh_from_db()
        self.assertEqual(self.cable.length_source, "computed")
        self.assertEqual(path.length_mm, data["cables"][0]["route"]["length_mm"])
        # The next one is Run 2.
        r = self.bulk({"trays": {"create": [{"key": "k", "points": [[0, 9], [5, 9]]}]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(FloorPlanTray.objects.filter(name="Run 2").exists())

    def test_a_run_left_as_a_path_keeps_its_height(self):
        data = self.preview({"cable_ids": [str(self.cable.id)], "suggest_runs": True,
                             "keep_runs": False})
        route = data["cables"][0]["route"]
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "kind": "manual",
            "legs": [{"points": leg["points"], "elevation_mm": leg["elevation_mm"]}
                     for leg in route["legs"]],
        }]}})
        self.assertEqual(r.status_code, 200, r.content)
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        self.assertEqual(path.length_mm, route["length_mm"])
        self.assertFalse(FloorPlanTray.objects.exists())

    def test_needs_the_tray_grant(self):
        data = self.preview({"cable_ids": [str(self.cable.id)], "suggest_runs": True})
        self.grant(["floorplan", "floorplantile", "floorplancablepath"],
                   ["view", "add", "change", "delete"])
        self.grant(["cable", "device"], ["view", "change"])
        self.login(self.editor)
        r = self.bulk(self.save_body(data))
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(FloorPlanTray.objects.exists())
        self.assertFalse(FloorPlanCablePath.objects.exists())
        self.grant(["floorplantray"], ["view", "add"])
        r = self.bulk(self.save_body(data))
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_conflict_writes_no_tray(self):
        from .cable_routing import save_path

        data = self.preview({"cable_ids": [str(self.cable.id)], "suggest_runs": True})
        path = save_path(self.plan, self.cable, PlanRouter(self.plan).direct(self.cable))
        stamp = path.updated_at.isoformat()
        save_path(self.plan, self.cable, PlanRouter(self.plan).direct(self.cable))
        body = self.save_body(data)
        body["cable_paths"]["upsert"][0]["version"] = stamp
        r = self.bulk(body)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertFalse(FloorPlanTray.objects.exists())

    def test_bad_trays_are_a_400_and_write_nothing(self):
        for trays in ({"create": [{"points": [[0, 1], [3, 1]]}]},
                      {"create": [{"key": "a", "points": [[0, 1]]}]},
                      {"create": [{"key": "a", "points": [[0, 1], [3, 1]]},
                                  {"key": "a", "points": [[0, 2], [3, 2]]}]}):
            r = self.bulk({"trays": trays})
            self.assertEqual(r.status_code, 400, (trays, r.content))
        self.assertFalse(FloorPlanTray.objects.exists())
        self.assertFalse(Cable.objects.filter(trays__isnull=False).exists())
