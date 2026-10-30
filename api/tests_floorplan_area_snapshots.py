"""Snapshots of a room, location or area drawn on a floor, and the Floor plan
tab of a room's and a location's page (docs/features/floor-plans.md,
"Snapshots"; docs/dcim/rooms.md, "Floor plan").

A snapshot may be taken of an area in place of a dragged rectangle: the crop
is the area's bounding box in whole cells plus a margin. A live view taken so
follows the area - moving or resizing it moves the view - and reads the
area's outline as its ``mask``. ``GET /api/rooms/<id>/plan/`` and
``/api/locations/<id>/plan/`` answer the room's part of its floor, live,
under the plan's permissions."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import floor_plan_snapshots as snaps
from .models import (
    Device,
    FloorPlan,
    FloorPlanArea,
    FloorPlanTile,
    FloorTileType,
    Location,
    Room,
    Site,
)

User = get_user_model()


def _area(**kw):
    return FloorPlanArea(**{"x": 0, "y": 0, "width": 1, "height": 1, "rotation": 0,
                            "shape": "rect", "points": [], **kw})


class AreaCropTests(SimpleTestCase):
    def test_an_upright_rectangle_takes_the_cells_it_touches(self):
        a = _area(x=2.5, y=1, width=3, height=2)
        self.assertEqual(snaps.area_crop(a, 0, 20, 10), snaps.Crop(2, 1, 4, 2))

    def test_a_margin_widens_it_inside_the_grid(self):
        a = _area(x=2.5, y=1, width=3, height=2)
        self.assertEqual(snaps.area_crop(a, 2, 20, 10), snaps.Crop(0, 0, 8, 5))
        self.assertEqual(snaps.area_crop(a, 20, 20, 10), snaps.Crop(0, 0, 20, 10))

    def test_a_turned_rectangle_crops_to_its_bounding_box(self):
        # A 4 x 2 rectangle centred on (10, 5), a quarter turn: 2 wide, 4 high.
        a = _area(x=8, y=4, width=4, height=2, rotation=90)
        self.assertEqual(snaps.area_crop(a, 0, 20, 10), snaps.Crop(9, 3, 2, 4))
        # 45°: the box grows to the diagonal's reach.
        b = _area(x=8, y=4, width=2, height=2, rotation=45)
        self.assertEqual(snaps.area_crop(b, 0, 20, 10), snaps.Crop(7, 3, 4, 4))

    def test_a_polygon_crops_to_its_points_box(self):
        a = _area(shape="polygon", points=[[1.5, 1], [6, 1.2], [3, 4.5]])
        self.assertEqual(snaps.area_crop(a, 1, 20, 10), snaps.Crop(0, 0, 7, 6))

    def test_the_outline_of_a_turned_rectangle(self):
        a = _area(x=8, y=4, width=4, height=2, rotation=90)
        pts = sorted(snaps.area_outline(a))
        self.assertEqual(pts, [(9.0, 3.0), (9.0, 7.0), (11.0, 3.0), (11.0, 7.0)])

    def test_a_margin_must_be_whole_cells_in_range(self):
        self.assertEqual(snaps.parse_margin(None), 0)
        self.assertEqual(snaps.parse_margin("3"), 3)
        for bad in (-1, 1.5, 51, "x", True):
            with self.assertRaises(ValueError):
                snaps.parse_margin(bad)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall A", slug="hall-a"
        )
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.loc, name="R210", slug="r210"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Ground",
            grid_width=20, grid_height=10, cell_mm=600,
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.plan, x=4.5, y=2, width=4, height=3, room=self.room,
        )
        self.inside = self.tile(5, 3, label="inside")
        self.outside = self.tile(15, 3, label="outside")
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, name, *grants, sites=()):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            p = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=list(types), actions=list(actions),
            )
            p.users.add(u)
            if sites:
                p.sites.set(sites)
        return u

    def tile(self, x, y, w=1, h=1, plan=None, **kw):
        return FloorPlanTile.objects.create(
            floor_plan=plan or self.plan, tile_type=self.tt, x=x, y=y, width=w, height=h, **kw
        )

    def snapshot(self, mode, area=None, margin=None, name="Room 210", plan=None):
        body = {"name": name, "mode": mode, "target": "plan",
                "area_id": str((area or self.area).pk)}
        if margin is not None:
            body["margin"] = margin
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(
                f"/api/floor-plans/{(plan or self.plan).id}/snapshot/", body, format="json"
            )


class AreaSnapshotTests(_Base):
    def test_a_copy_of_an_area_is_its_box_in_whole_cells(self):
        r = self.snapshot("copy", margin=1)
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.data["id"])
        self.assertEqual(copy.crop, {"x": 3, "y": 1, "w": 7, "h": 5})
        self.assertEqual((copy.grid_width, copy.grid_height), (7, 5))
        self.assertIsNone(copy.source_area_id)
        self.assertEqual(sorted(copy.tiles.values_list("label", flat=True)), ["inside"])
        a = copy.areas.get()
        self.assertEqual((a.x, a.y, a.room_id), (1.5, 1, self.room.pk))

    def test_a_view_of_an_area_remembers_it_and_reads_its_outline(self):
        r = self.snapshot("view")
        self.assertEqual(r.status_code, 201, r.content)
        v = FloorPlan.objects.get(pk=r.data["id"])
        self.assertEqual(v.source_area_id, self.area.pk)
        s = r.data["snapshot"]
        self.assertEqual(s["crop"], {"x": 4, "y": 2, "w": 5, "h": 3})
        self.assertEqual(s["area"], {"id": str(self.area.pk), "name": "R210"})
        self.assertEqual(s["margin"], 0)
        self.assertEqual(sorted(map(tuple, s["mask"])),
                         [(0.5, 0), (0.5, 3), (4.5, 0), (4.5, 3)])

    def test_a_live_view_follows_its_area(self):
        v = FloorPlan.objects.get(pk=self.snapshot("view", margin=1).data["id"])
        r = self.client.patch(f"/api/floor-plan-areas/{self.area.pk}/",
                              {"x": 12, "y": 4, "width": 6, "height": 4}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        got = self.client.get(f"/api/floor-plans/{v.id}/").data
        self.assertEqual(got["snapshot"]["crop"], {"x": 11, "y": 3, "w": 8, "h": 6})
        self.assertEqual((got["grid_width"], got["grid_height"]), (8, 6))
        tiles = self.client.get(f"/api/floor-plans/{v.id}/contents/").data["tiles"]
        self.assertEqual([(t["label"], t["x"], t["y"]) for t in tiles], [("outside", 4, 0)])

    def test_a_turned_area_follows_with_its_turn_and_mask(self):
        v = FloorPlan.objects.get(pk=self.snapshot("view").data["id"])
        self.area.x, self.area.y, self.area.width, self.area.height = 8, 4, 4, 2
        self.area.rotation = 90
        self.area.save()
        s = self.client.get(f"/api/floor-plans/{v.id}/").data["snapshot"]
        self.assertEqual(s["crop"], {"x": 9, "y": 3, "w": 2, "h": 4})
        self.assertEqual(sorted(map(tuple, s["mask"])),
                         [(0, 0), (0, 4), (2, 0), (2, 4)])

    def test_a_polygon_area_crops_to_its_box_and_masks_its_outline(self):
        poly = FloorPlanArea.objects.create(
            floor_plan=self.plan, shape="polygon", points=[[10, 1], [14, 1], [10, 5]],
            x=10, y=1, width=4, height=4,
        )
        r = self.snapshot("view", area=poly)
        self.assertEqual(r.data["snapshot"]["crop"], {"x": 10, "y": 1, "w": 4, "h": 4})
        self.assertEqual(r.data["snapshot"]["mask"], [[0, 0], [4, 0], [0, 4]])

    def test_deleting_the_area_freezes_the_view_where_it_was(self):
        v = FloorPlan.objects.get(pk=self.snapshot("view").data["id"])
        self.area.x = 10
        self.area.save()
        r = self.client.delete(f"/api/floor-plan-areas/{self.area.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        v.refresh_from_db()
        self.assertIsNone(v.source_area_id)
        self.assertEqual(v.crop, {"x": 10, "y": 2, "w": 4, "h": 3})
        s = self.client.get(f"/api/floor-plans/{v.id}/").data["snapshot"]
        self.assertEqual((s["crop"], s["area"], s["mask"]),
                         ({"x": 10, "y": 2, "w": 4, "h": 3}, None, None))

    def test_unlinking_a_following_view_forgets_the_area(self):
        v = FloorPlan.objects.get(pk=self.snapshot("view").data["id"])
        r = self.client.post(f"/api/floor-plans/{v.id}/unlink/")
        self.assertEqual(r.status_code, 200, r.content)
        v.refresh_from_db()
        self.assertEqual((v.kind, v.source_area_id), ("plan", None))

    def test_a_bad_area_or_margin_is_refused(self):
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.loc, name="Other")
        theirs = FloorPlanArea.objects.create(floor_plan=other, x=0, y=0, width=1, height=1)
        r = self.snapshot("view", area=theirs)
        self.assertEqual(r.status_code, 400)
        self.assertIn("area_id", r.data)
        r = self.snapshot("view", margin=99)
        self.assertEqual(r.status_code, 400)
        self.assertIn("margin", r.data)

    def test_through_a_view_the_area_is_cut_to_it(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/snapshot/", {
            "name": "Left", "mode": "view", "crop": {"x": 0, "y": 0, "w": 6, "h": 10},
        }, format="json")
        view = FloorPlan.objects.get(pk=r.data["id"])
        r = self.snapshot("copy", plan=view, name="Cut")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data["snapshot"]["crop"], {"x": 4, "y": 2, "w": 2, "h": 3})
        far = FloorPlanArea.objects.create(floor_plan=self.plan, x=15, y=0, width=2, height=2)
        r = self.snapshot("copy", plan=view, area=far, name="Far")
        self.assertEqual(r.status_code, 400)


class RoomPlanTests(_Base):
    def plan_of(self, url, status=200):
        r = self.client.get(url)
        self.assertEqual(r.status_code, status, r.content)
        return r.data

    def test_a_room_reads_its_part_of_the_floor(self):
        d = self.plan_of(f"/api/rooms/{self.room.id}/plan/?margin=1")
        self.assertEqual([a["id"] for a in d["areas"]], [str(self.area.pk)])
        self.assertEqual(d["areas"][0]["floor_plan"]["id"], str(self.plan.pk))
        self.assertEqual(d["area"], str(self.area.pk))
        self.assertEqual(d["crop"], {"x": 3, "y": 1, "w": 7, "h": 5})
        self.assertEqual(d["floor_plan"]["id"], str(self.plan.pk))
        self.assertEqual([(t["label"], t["x"], t["y"]) for t in d["contents"]["tiles"]],
                         [("inside", 2, 2)])
        self.assertEqual(sorted(map(tuple, d["outline"])),
                         [(1.5, 1), (1.5, 4), (5.5, 1), (5.5, 4)])
        # Live: a move of the area moves the part read.
        self.area.x = 16
        self.area.save()
        d = self.plan_of(f"/api/rooms/{self.room.id}/plan/")
        self.assertEqual(d["crop"]["x"], 16)
        self.assertEqual(d["contents"]["tiles"], [])

    def test_several_floors_are_listed_and_one_picked(self):
        upper = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Upper", stack=self.plan.stack,
            floor_order=1, grid_width=10, grid_height=10,
        )
        a2 = FloorPlanArea.objects.create(floor_plan=upper, x=1, y=1, width=2, height=2,
                                          room=self.room)
        d = self.plan_of(f"/api/rooms/{self.room.id}/plan/?area={a2.pk}")
        self.assertEqual([a["floor_plan"]["name"] for a in d["areas"]], ["Ground", "Upper"])
        self.assertEqual((d["area"], d["floor_plan"]["id"]), (str(a2.pk), str(upper.pk)))
        self.plan_of(f"/api/rooms/{self.room.id}/plan/?area={self.outside.pk}", 404)

    def test_a_room_without_an_area_reads_none(self):
        bare = Room.objects.create(
            tenant=self.tenant, location=self.loc, name="Store", slug="store"
        )
        d = self.plan_of(f"/api/rooms/{bare.id}/plan/")
        self.assertEqual(d["areas"], [])
        self.assertIsNone(d["contents"])

    def test_a_location_reads_its_area(self):
        la = FloorPlanArea.objects.create(floor_plan=self.plan, x=0, y=6, width=20, height=4,
                                          location=self.loc)
        d = self.plan_of(f"/api/locations/{self.loc.id}/plan/")
        self.assertEqual([a["id"] for a in d["areas"]], [str(la.pk)])
        self.assertEqual(d["crop"], {"x": 0, "y": 6, "w": 20, "h": 4})

    def test_the_plans_permissions_apply(self):
        # The room, but not the floor plan: no areas.
        u = self.member("rooms-only", (["room"], ["view"]))
        self.login(u)
        self.assertEqual(self.plan_of(f"/api/rooms/{self.room.id}/plan/")["areas"], [])
        # The plan but not its areas: none either.
        u = self.member("no-areas", (["room", "floorplan", "floorplantile"], ["view"]))
        self.login(u)
        self.assertEqual(self.plan_of(f"/api/rooms/{self.room.id}/plan/")["areas"], [])

    def test_a_site_viewer_sees_hidden_tiles_hidden(self):
        far_site = Site.objects.create(tenant=self.tenant, name="FRA")
        far = Device.objects.create(tenant=self.tenant, name="far-b", site=far_site)
        FloorPlanTile.objects.create(floor_plan=self.plan, x=6, y=3, device=far,
                                     link_kind="device")
        u = self.member(
            "local",
            (["room", "floorplan", "floorplantile", "floorplanarea", "device"], ["view"]),
            sites=[self.site],
        )
        self.login(u)
        r = self.client.get(f"/api/rooms/{self.room.id}/plan/")
        self.assertEqual(r.status_code, 200, r.content)
        linked = [t["linked"] for t in r.data["contents"]["tiles"] if t["linked"]]
        self.assertEqual(linked[0]["name"], "Hidden")
        self.assertNotIn("far-b", r.content.decode())
        # A room at a site they may not view is not found.
        floc = Location.objects.create(tenant=self.tenant, site=far_site, name="F", slug="f")
        froom = Room.objects.create(tenant=self.tenant, location=floc, name="Far room")
        self.plan_of(f"/api/rooms/{froom.id}/plan/", 404)

    def test_another_tenants_room_is_not_found(self):
        osite = Site.objects.create(tenant=self.other, name="LON")
        oloc = Location.objects.create(tenant=self.other, site=osite, name="B", slug="b")
        oroom = Room.objects.create(tenant=self.other, location=oloc, name="Theirs")
        self.plan_of(f"/api/rooms/{oroom.id}/plan/", 404)
        self.plan_of(f"/api/locations/{oloc.id}/plan/", 404)
