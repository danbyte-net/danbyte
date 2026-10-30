"""Floor plans P2: areas (rooms, locations, plain areas) and labels drawn on a
floor, free layout, snap-all, the editor's bulk save, and the registries the
new types join."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import SITE_PATHS, site_role_types
from core.models import Organization, Tenant

from .floor_stacks import add_floor
from .models import (
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanTile,
    FloorTileType,
    Location,
    Rack,
    Room,
    Site,
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building A", slug="building-a"
        )
        self.floor = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Floor 2", slug="floor-2",
            parent=self.bldg,
        )
        self.other_bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building B", slug="building-b"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.bldg, name="Ground",
            grid_width=20, grid_height=10,
        )
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.bldg, name="Room 1", slug="room-1",
            color="#22c55e",
        )
        self.child_room = Room.objects.create(
            tenant=self.tenant, location=self.floor, name="Room 210", slug="room-210"
        )
        self.far_room = Room.objects.create(
            tenant=self.tenant, location=self.other_bldg, name="Far", slug="far"
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        self.zone = FloorTileType.objects.create(
            tenant=self.tenant, name="Cold aisle", slug="cold", is_zone=True
        )
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.their_loc = Location.objects.create(
            tenant=self.tenant2, site=self.their_site, name="Theirs", slug="theirs"
        )
        self.their_room = Room.objects.create(
            tenant=self.tenant2, location=self.their_loc, name="Their room", slug="tr"
        )
        self.their_plan = FloorPlan.objects.create(
            tenant=self.tenant2, location=self.their_loc, name="Their floor"
        )
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, object_types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=object_types, actions=actions
        )
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _area(self, **body):
        body.setdefault("floor_plan_id", str(self.plan.id))
        body.setdefault("x", 1)
        body.setdefault("y", 1)
        body.setdefault("width", 4)
        body.setdefault("height", 3)
        return self.client.post("/api/floor-plan-areas/", body, format="json")

    def _label(self, **body):
        body.setdefault("floor_plan_id", str(self.plan.id))
        body.setdefault("text", "North side")
        body.setdefault("x", 2)
        body.setdefault("y", 2)
        return self.client.post("/api/floor-plan-labels/", body, format="json")


class AreaTests(_Base):
    def test_rect_area_linked_to_a_room(self):
        r = self._area(room_id=str(self.room.id), rotation=-30)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["shape"], "rect")
        self.assertEqual(body["rotation"], 330)
        self.assertEqual(body["points"], [])
        self.assertEqual(
            body["room"],
            {"id": str(self.room.id), "name": "Room 1", "code": "", "color": "#22c55e"},
        )
        self.assertIsNone(body["location"])
        self.assertEqual(body["fill_opacity"], 15)
        self.assertEqual(body["border"], "solid")
        self.assertTrue(body["show_name"])

    def test_room_of_a_child_location_is_accepted(self):
        r = self._area(room_id=str(self.child_room.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_room_of_another_location_is_refused(self):
        r = self._area(room_id=str(self.far_room.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("room_id", r.json())

    def test_room_of_another_tenant_is_refused(self):
        r = self._area(room_id=str(self.their_room.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("room_id", r.json())
        self.assertFalse(FloorPlanArea.objects.exists())

    def test_location_link_inside_and_outside(self):
        self.assertEqual(self._area(location_id=str(self.floor.id)).status_code, 201)
        r = self._area(location_id=str(self.other_bldg.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())

    def test_room_and_location_both_refused(self):
        r = self._area(room_id=str(self.room.id), location_id=str(self.bldg.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("room_id", r.json())

    def test_rect_must_fit_the_grid(self):
        self.assertEqual(self._area(x=18, width=4).status_code, 400)
        self.assertEqual(self._area(width=0).status_code, 400)
        self.assertEqual(self._area(x=16.5, width=3.5).status_code, 201)

    def test_polygon_bbox_and_self_intersection(self):
        r = self._area(shape="polygon", points=[[1, 1], [5, 1], [5, 4], [2, 6]],
                       rotation=40)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["x"], body["y"], body["width"], body["height"]),
                         (1, 1, 4, 5))
        self.assertEqual(body["rotation"], 0)
        bow = self._area(shape="polygon", points=[[1, 1], [5, 5], [5, 1], [1, 5]])
        self.assertEqual(bow.status_code, 400)
        self.assertEqual(bow.json()["points"], ["The outline crosses itself."])
        few = self._area(shape="polygon", points=[[1, 1], [5, 5]])
        self.assertEqual(few.status_code, 400)
        out = self._area(shape="polygon", points=[[1, 1], [25, 1], [5, 5]])
        self.assertEqual(out.status_code, 400)

    def test_other_tenants_plan_and_area(self):
        r = self._area(floor_plan_id=str(self.their_plan.id))
        self.assertEqual(r.status_code, 400)
        theirs = FloorPlanArea.objects.create(
            floor_plan=self.their_plan, x=0, y=0, width=1, height=1
        )
        self.assertEqual(
            self.client.get(f"/api/floor-plan-areas/{theirs.id}/").status_code, 404
        )
        listed = self.client.get(
            f"/api/floor-plan-areas/?floor_plan={self.their_plan.id}"
        ).json()["results"]
        self.assertEqual(listed, [])

    def test_patch_and_delete(self):
        aid = self._area().json()["id"]
        r = self.client.patch(f"/api/floor-plan-areas/{aid}/",
                              {"x": 2.5, "label": "Cage"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["x"], 2.5)
        self.assertEqual(
            self.client.delete(f"/api/floor-plan-areas/{aid}/").status_code, 204
        )

    def test_changes_are_logged(self):
        aid = self._area().json()["id"]
        self.client.patch(f"/api/floor-plan-areas/{aid}/", {"label": "Cage"}, format="json")
        actions = list(ChangeLogEntry.objects.filter(
            object_type="api.floorplanarea", object_id=aid
        ).order_by("timestamp").values_list("action", flat=True))
        self.assertEqual(actions, ["create", "update"])

    def test_deleting_the_room_unlinks_the_area(self):
        aid = self._area(room_id=str(self.room.id)).json()["id"]
        self.room.delete()
        self.assertIsNone(FloorPlanArea.objects.get(pk=aid).room_id)

    def test_site_scope_hides_areas_elsewhere(self):
        self._area()
        elsewhere = Site.objects.create(tenant=self.tenant, name="FRA")
        u = self._user("v", ["floorplan", "floorplanarea"], ["view"], [elsewhere])
        self._login(u)
        listed = self.client.get(
            f"/api/floor-plan-areas/?floor_plan={self.plan.id}"
        ).json()["results"]
        self.assertEqual(listed, [])

    def test_room_the_user_cannot_see_is_refused(self):
        u = self._user(
            "e", ["floorplan", "floorplanarea"], ["view", "add", "change", "delete"]
        )
        self._login(u)
        r = self._area(room_id=str(self.room.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("room_id", r.json())


class LabelTests(_Base):
    def test_defaults(self):
        r = self._label(text="  Loading dock \r\n east  ")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["text"], "Loading dock \n east")
        self.assertEqual(body["font_mm"], 300)
        self.assertEqual((body["weight"], body["align"], body["color"]),
                         ("normal", "left", ""))
        self.assertIsNone(body["width"])
        self.assertFalse(body["plate"])

    def test_validation(self):
        self.assertEqual(self._label(text="   ").status_code, 400)
        self.assertEqual(self._label(text="x" * 501).status_code, 400)
        self.assertEqual(self._label(font_mm=10).status_code, 400)
        self.assertEqual(self._label(font_mm=6000).status_code, 400)
        self.assertEqual(self._label(x=30).status_code, 400)
        self.assertEqual(self._label(color="#ff0000").status_code, 400)
        self.assertEqual(self._label(color="amber", font_mm=1200).status_code, 201)

    def test_logged(self):
        lid = self._label().json()["id"]
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.floorplanlabel", object_id=lid, action="create"
        ).exists())


class TileRuleTests(_Base):
    def _tile(self, **body):
        body.setdefault("floor_plan_id", str(self.plan.id))
        body.setdefault("x", 0)
        body.setdefault("y", 0)
        return self.client.post("/api/floor-plan-tiles/", body, format="json")

    def test_untyped_tile_needs_a_link(self):
        r = self._tile()
        self.assertEqual(r.status_code, 400)
        self.assertEqual(
            r.json()["tile_type_id"],
            ["Pick a tile type or role, or link the tile to an object."],
        )
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        r = self._tile(link_kind="rack", link_id=str(rack.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["tile_type"])
        # The plan's reads cope with an untyped tile.
        for path in ("contents", "state", "scene"):
            got = self.client.get(f"/api/floor-plans/{self.plan.id}/{path}/")
            self.assertEqual(got.status_code, 200, path)

    def test_grid_needs_whole_cells_free_does_not(self):
        r = self._tile(tile_type_id=str(self.tt.id), x=1.5)
        self.assertEqual(r.status_code, 400)
        self.assertIn("x", r.json())
        r = self._tile(tile_type_id=str(self.tt.id), orientation=45)
        self.assertEqual(r.status_code, 400)
        self.plan.layout_mode = "free"
        self.plan.save()
        r = self._tile(tile_type_id=str(self.tt.id), x=1.23456, width=1.5, orientation=45)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["x"], r.json()["width"], r.json()["orientation"]),
                         (1.235, 1.5, 45))
        self.assertEqual(self._tile(tile_type_id=str(self.tt.id), orientation=360)
                         .status_code, 400)


class LayoutModeTests(_Base):
    def _patch(self, mode):
        return self.client.patch(f"/api/floor-plans/{self.plan.id}/",
                                 {"layout_mode": mode}, format="json")

    def test_free_and_back(self):
        self.assertEqual(self._patch("free").json()["layout_mode"], "free")
        FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                     x=1.5, y=0, orientation=30)
        r = self._patch("grid")
        self.assertEqual(r.status_code, 400)
        self.assertIn("layout_mode", r.json())
        FloorPlanTile.objects.update(x=1, orientation=90)
        self.assertEqual(self._patch("grid").json()["layout_mode"], "grid")

    def test_snap_all(self):
        self._patch("free")
        a = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                         x=1.4, y=0.2, width=1.2, height=0.6,
                                         orientation=100)
        b = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                         x=0.8, y=0, width=1, height=1)
        z = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.zone,
                                         x=0, y=0, width=3, height=3)
        ok = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                          x=10, y=5, width=2, height=1)
        url = f"/api/floor-plans/{self.plan.id}/snap-all/"
        dry = self.client.post(url, {"dry_run": True}, format="json")
        self.assertEqual(dry.status_code, 200, dry.content)
        body = dry.json()
        self.assertEqual(body["layout_mode"], "free")
        self.assertEqual(body["moved"], 2)
        self.assertEqual({c["id"] for c in body["collisions"]}, {str(a.id), str(b.id)})
        a.refresh_from_db()
        self.assertEqual(a.x, 1.4)

        done = self.client.post(url, {}, format="json").json()
        self.assertEqual(done["layout_mode"], "grid")
        self.assertEqual(len(done["tiles"]), 4)
        a.refresh_from_db()
        self.assertEqual((a.x, a.y, a.width, a.height, a.orientation), (1, 0, 1, 1, 90))
        z.refresh_from_db()
        ok.refresh_from_db()
        self.assertEqual((ok.x, ok.width), (10, 2))
        self.plan.refresh_from_db()
        self.assertEqual(self.plan.layout_mode, "grid")
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.floorplantile", object_id=str(a.id), action="update"
        ).exists())

    def test_snap_all_needs_change(self):
        u = self._user("v", ["floorplan"], ["view"])
        self._login(u)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/snap-all/",
                             {"dry_run": True}, format="json")
        self.assertEqual(r.status_code, 403)


class BulkTests(_Base):
    def url(self):
        return f"/api/floor-plans/{self.plan.id}/bulk/"

    def test_every_kind_in_one_call(self):
        tile = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=0, y=0)
        gone = FloorPlanArea.objects.create(floor_plan=self.plan, x=0, y=0, width=1, height=1)
        label = FloorPlanLabel.objects.create(floor_plan=self.plan, text="A", x=1, y=1)
        r = self.client.post(self.url(), {
            "tiles": {
                "create": [{"tile_type_id": str(self.tt.id), "x": 3, "y": 3}],
                "update": [{"id": str(tile.id), "x": 1}],
            },
            "areas": {
                "create": [{"x": 0, "y": 0, "width": 5, "height": 5,
                            "room_id": str(self.room.id)}],
                "delete": [str(gone.id)],
            },
            "labels": {"update": [{"id": str(label.id), "text": "B"}]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(set(body), {"tiles", "areas", "labels"})
        self.assertEqual(len(body["tiles"]), 2)
        self.assertEqual([a["room"]["name"] for a in body["areas"]], ["Room 1"])
        self.assertEqual(body["labels"][0]["text"], "B")
        self.assertFalse(FloorPlanArea.objects.filter(pk=gone.pk).exists())

    def test_unknown_id_rolls_everything_back(self):
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.bldg, name="1")
        foreign = FloorPlanLabel.objects.create(floor_plan=other, text="X", x=0, y=0)
        r = self.client.post(self.url(), {
            "areas": {"create": [{"x": 0, "y": 0, "width": 1, "height": 1}]},
            "labels": {"update": [{"id": str(foreign.id), "text": "Y"}]},
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("labels", r.json())
        self.assertFalse(FloorPlanArea.objects.exists())
        foreign.refresh_from_db()
        self.assertEqual(foreign.text, "X")

    def test_cross_tenant_room_refused(self):
        r = self.client.post(self.url(), {
            "areas": {"create": [{"x": 0, "y": 0, "width": 1, "height": 1,
                                  "room_id": str(self.their_room.id)}]},
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(FloorPlanArea.objects.exists())

    def test_rows_stay_on_this_plan(self):
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.bldg, name="1")
        r = self.client.post(self.url(), {
            "labels": {"create": [{"text": "A", "x": 0, "y": 0,
                                   "floor_plan_id": str(other.id)}]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(FloorPlanLabel.objects.get().floor_plan_id, self.plan.id)

    def test_viewer_is_refused(self):
        u = self._user("v", ["floorplan", "floorplanarea", "floorplanlabel"], ["view"])
        self._login(u)
        r = self.client.post(self.url(), {"labels": {"create": [
            {"text": "A", "x": 0, "y": 0}]}}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_operation_cap(self):
        r = self.client.post(self.url(), {
            "labels": {"delete": ["x"] * 5001},
        }, format="json")
        self.assertEqual(r.status_code, 400)


class CopyTests(_Base):
    def test_clone_copies_areas_and_labels(self):
        FloorPlanArea.objects.create(floor_plan=self.plan, x=0, y=0, width=2, height=2,
                                     room=self.room)
        FloorPlanLabel.objects.create(floor_plan=self.plan, text="North", x=1, y=1)
        self.plan.layout_mode = "free"
        self.plan.save()
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/clone/")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertEqual(copy.layout_mode, "free")
        self.assertEqual(copy.areas.get().room_id, self.room.id)
        self.assertEqual(copy.labels.get().text, "North")
        self.assertEqual(self.plan.areas.count(), 1)

    def test_add_floor_copies_the_layout_mode(self):
        self.plan.layout_mode = "free"
        self.plan.save()
        FloorPlanLabel.objects.create(floor_plan=self.plan, text="North", x=1, y=1)
        new = add_floor(self.plan.stack, "First", copy_from=self.plan)
        self.assertEqual(new.layout_mode, "free")
        self.assertFalse(new.labels.exists())


class RegistryTests(APITestCase):
    def test_registered_and_site_scoped(self):
        for slug in ("floorplanarea", "floorplanlabel"):
            self.assertTrue(is_registered(slug))
            self.assertEqual(SITE_PATHS[slug], "floor_plan__site|floor_plan__location__site")
            self.assertIn(slug, site_role_types())
