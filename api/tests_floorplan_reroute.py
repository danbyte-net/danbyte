"""Re-routing after a move (floor-plan cables, phase 4).

A tile with stored routes moved in the editor's draft, or a tray those
routes ride reshaped or deleted there, previews the routes again through
``cable-plan`` with the draft: ``positions`` for the tiles, ``draft_trays``
naming a saved tray for its new shape and ``removed_trays`` for the trays
gone. The stored path reads ``stale`` against the draft; nothing is
written until ``bulk/`` saves the move with the new routes.
"""
from django.contrib.auth import get_user_model

from auth_api.models import ObjectPermission, UserProfile

from .cable_routing import PlanRouter
from .models import FloorPlanCablePath, FloorPlanTray
from .tests_floorplan_cable_paths import _Plan

User = get_user_model()


class RerouteTests(_Plan):
    def setUp(self):
        super().setUp()
        self.path = self.store()
        self.url = f"/api/floor-plans/{self.plan.id}/cable-plan/"

    def preview(self, body):
        r = self.client.post(self.url, {"cable_ids": [str(self.cable.id)], **body},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = r.json()["cables"]
        return row

    def test_a_moved_tile_reads_stale_and_routes_against_the_draft(self):
        row = self.preview({"positions": {str(self.tile_b.id): {"x": 14, "y": 2}}})
        self.assertTrue(row["path"]["stale"])
        self.assertEqual(row["route"]["legs"][0]["to"]["at"], [14.5, 2.5])
        self.assertEqual(row["route"]["tray_order"], [str(self.tray.id)])
        # Nothing moved on the server.
        self.tile_b.refresh_from_db()
        self.assertEqual(self.tile_b.x, 10)
        self.assertFalse(FloorPlanCablePath.objects.get(pk=self.path.pk).stale)

    def test_unmoved_reads_up_to_date(self):
        row = self.preview({})
        self.assertFalse(row["path"]["stale"])

    def test_a_reshaped_saved_tray_routes_as_drawn(self):
        row = self.preview({"draft_trays": [{
            "id": str(self.tray.id), "points": [[0, 5], [11, 5]], "level": "overhead",
        }]})
        self.assertTrue(row["path"]["stale"])
        self.assertEqual(row["route"]["tray_order"], [str(self.tray.id)])
        self.assertIn([10.5, 5.0], row["route"]["legs"][0]["points"])
        # The tray itself is untouched.
        self.assertEqual(FloorPlanTray.objects.get(pk=self.tray.pk).points, [[0, 1], [11, 1]])

    def test_a_deleted_tray_leaves_a_direct_route(self):
        row = self.preview({"removed_trays": [str(self.tray.id)]})
        self.assertTrue(row["path"]["stale"])
        self.assertEqual(row["route"]["kind"], "direct")
        self.assertEqual(row["route"]["tray_order"], [])

    def test_router_keeps_other_trays(self):
        other = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="OH-2", points=[[0, 8], [11, 8]],
        )
        router = PlanRouter(self.plan, removed_trays=[str(self.tray.id)])
        self.assertEqual(set(router.tray_by_id), {str(other.pk)})
        self.assertEqual(router.changed_trays, {str(self.tray.id)})

    def test_bad_removed_trays_is_a_400(self):
        r = self.client.post(self.url, {"removed_trays": "x"}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_saving_the_move_with_the_new_route_is_up_to_date(self):
        row = self.preview({"positions": {str(self.tile_b.id): {"x": 14, "y": 2}}})
        route = row["route"]
        r = self.bulk({
            "tiles": {"update": [{"id": str(self.tile_b.id), "x": 14}]},
            "cable_paths": {"upsert": [{
                "cable": str(self.cable.id), "kind": route["kind"],
                "legs": [{"points": leg["points"]} for leg in route["legs"]],
                "tray_order": route["tray_order"],
                "version": row["path"]["version"],
            }]},
        })
        self.assertEqual(r.status_code, 200, r.content)
        path = FloorPlanCablePath.objects.get(pk=self.path.pk)
        self.assertFalse(path.stale)
        self.assertEqual(path.legs[0]["to"]["at"], [14.5, 2.5])

    def test_needs_the_plan(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        r = self.client.post(self.url, {"cable_ids": [str(self.cable.id)]}, format="json")
        self.assertIn(r.status_code, (403, 404))

    def test_a_route_changed_elsewhere_still_conflicts(self):
        row = self.preview({"positions": {str(self.tile_b.id): {"x": 14, "y": 2}}})
        self.store()  # someone else stores the route again
        route = row["route"]
        r = self.bulk({
            "tiles": {"update": [{"id": str(self.tile_b.id), "x": 14}]},
            "cable_paths": {"upsert": [{
                "cable": str(self.cable.id), "kind": route["kind"],
                "legs": [{"points": leg["points"]} for leg in route["legs"]],
                "tray_order": route["tray_order"],
                "version": row["path"]["version"],
            }]},
        })
        self.assertEqual(r.status_code, 409, r.content)
        self.tile_b.refresh_from_db()
        self.assertEqual(self.tile_b.x, 10)


# Unused import guard: ObjectPermission is kept for grants added later.
del ObjectPermission
