"""Floor plans P3: the Place picker's candidates, rooms from areas (never
automatic), photos as tile icons, the tile ``display``/``z`` fields and the
save conflict check (409)."""

from __future__ import annotations

import shutil
import tempfile

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanTile,
    FloorTileType,
    ImageAttachment,
    Location,
    Rack,
    Room,
    Site,
)


def _png(w=40, h=10) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 200, 30)).save(buf, "PNG")
    return buf.getvalue()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.other_site = Site.objects.create(tenant=self.tenant, name="Branch")
        self.bldg = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Building A", slug="building-a"
        )
        self.floor = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Floor 2", slug="floor-2",
            parent=self.bldg,
        )
        self.annex = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Annex", slug="annex"
        )
        self.branch_loc = Location.objects.create(
            tenant=self.tenant, site=self.other_site, name="Branch", slug="branch"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.bldg, name="Ground",
            grid_width=20, grid_height=10,
        )
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.floor, name="Room 210", slug="room-210",
            color="#22c55e",
        )
        self.room2 = Room.objects.create(
            tenant=self.tenant, location=self.bldg, name="Lab", slug="lab"
        )
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.their_dev = Device.objects.create(
            tenant=self.tenant2, name="their-sw", site=their_site
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

    def _grant(self, user, object_types, actions):
        perm = ObjectPermission.objects.create(
            name=f"{user.username}-{'-'.join(object_types)}",
            object_types=object_types, actions=actions,
        )
        perm.tenants.add(self.tenant)
        perm.users.add(user)


class PlaceableTests(_Base):
    def setUp(self):
        super().setUp()
        self.in_room = Device.objects.create(
            tenant=self.tenant, name="sw-room", site=self.site,
            location=self.floor, room=self.room,
        )
        self.in_floor = Device.objects.create(
            tenant=self.tenant, name="sw-floor", site=self.site, location=self.bldg
        )
        self.elsewhere = Device.objects.create(
            tenant=self.tenant, name="sw-annex", site=self.site, location=self.annex
        )
        self.branch = Device.objects.create(
            tenant=self.tenant, name="sw-branch", site=self.other_site,
            location=self.branch_loc,
        )
        self.rack = Rack.objects.create(
            tenant=self.tenant, name="R1", site=self.site, location=self.floor,
            room=self.room,
        )
        self.racked = Device.objects.create(
            tenant=self.tenant, name="sw-racked", site=self.site, location=self.floor,
            rack=self.rack,
        )

    def url(self, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        return f"/api/floor-plans/{self.plan.id}/placeable/?{q}"

    def rows(self, **params):
        r = self.client.get(self.url(**params))
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]

    def test_ranked_by_the_room_near_then_the_floor_then_the_site(self):
        rows = self.rows(near_room=self.room.id)
        ranked = [(r["kind"], r["name"], r["rank"]) for r in rows]
        self.assertEqual(ranked, [
            ("rack", "R1", 0),
            ("device", "sw-room", 0),
            ("device", "sw-floor", 1),
            ("device", "sw-annex", 2),
        ])
        first = rows[1]
        self.assertEqual(first["room"]["name"], "Room 210")
        self.assertEqual(first["room"]["color"], "#22c55e")
        self.assertEqual(first["placed_count"], 0)

    def test_without_a_room_the_floor_comes_first(self):
        rows = self.rows(kind="device")
        self.assertEqual([r["name"] for r in rows], ["sw-floor", "sw-room", "sw-annex"])
        self.assertEqual({r["kind"] for r in rows}, {"device"})

    def test_a_near_location_ranks_its_objects_first(self):
        rows = self.rows(near_location=self.annex.id, kind="device")
        self.assertEqual(rows[0]["name"], "sw-annex")
        self.assertEqual(rows[0]["rank"], 0)

    def test_other_sites_tenants_and_racked_devices_stay_out(self):
        names = {r["name"] for r in self.rows()}
        self.assertNotIn("sw-branch", names)
        self.assertNotIn("their-sw", names)
        self.assertNotIn("sw-racked", names)

    def test_another_tenants_room_does_not_rank(self):
        their_loc = Location.objects.create(
            tenant=self.tenant2, site=self.their_dev.site, name="L", slug="l"
        )
        their_room = Room.objects.create(
            tenant=self.tenant2, location=their_loc, name="X", slug="x"
        )
        rows = self.rows(near_room=their_room.id, kind="device")
        self.assertEqual(rows[0]["name"], "sw-floor")

    def test_where_it_is_placed(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.in_room, link_kind="device"
        )
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.bldg, name="1")
        FloorPlanTile.objects.create(
            floor_plan=other, x=0, y=0, device=self.in_floor, link_kind="device"
        )
        rows = {r["name"]: r for r in self.rows(kind="device")}
        self.assertTrue(rows["sw-room"]["placed_on"][0]["this_floor"])
        self.assertFalse(rows["sw-floor"]["placed_on"][0]["this_floor"])
        self.assertEqual(rows["sw-floor"]["placed_on"][0]["floor_plan"]["name"], "1")

    def test_unplaced_keeps_the_floors_objects_placed_nowhere(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.in_room, link_kind="device"
        )
        names = [r["name"] for r in self.rows(unplaced=1)]
        self.assertEqual(names, ["R1", "sw-floor"])

    def test_search(self):
        self.assertEqual([r["name"] for r in self.rows(q="annex")], ["sw-annex"])

    def test_each_kind_by_its_own_view_grant(self):
        u = self._user("racks-only", ["floorplan", "rack"], ["view"])
        self._login(u)
        self.assertEqual([r["kind"] for r in self.rows()], ["rack"])

    def test_site_scoped_grant(self):
        u = self._user("annex", ["floorplan", "device"], ["view"], sites=[self.site])
        self._login(u)
        self.assertEqual(len(self.rows(kind="device")), 3)
        v = self._user("branch", ["floorplan", "device"], ["view"], sites=[self.other_site])
        self._login(v)
        r = self.client.get(self.url())
        self.assertEqual(r.status_code, 404)

    def test_no_plan_permission(self):
        self._login(self._user("nobody", ["device"], ["view"]))
        self.assertEqual(self.client.get(self.url()).status_code, 403)


class AssignRoomTests(_Base):
    def setUp(self):
        super().setUp()
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=6, height=6, room=self.room
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, location=self.bldg,
            room=self.room2,
        )
        self.ok = Device.objects.create(
            tenant=self.tenant, name="sw2", site=self.site, location=self.floor,
            room=self.room,
        )
        self.outside = Device.objects.create(
            tenant=self.tenant, name="sw3", site=self.site, location=self.bldg
        )

    def url(self):
        return f"/api/floor-plans/{self.plan.id}/assign-rooms/"

    def _place(self, dev, x, y):
        return self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {
            "tiles": {"create": [
                {"x": x, "y": y, "link_kind": "device", "link_id": str(dev.id)},
            ]},
        }, format="json")

    def test_placing_never_sets_the_room(self):
        r = self._place(self.dev, 1, 1)
        self.assertEqual(r.status_code, 200, r.content)
        tile = r.json()["tiles"][0]
        self.assertIsNone(tile["tile_type"])
        self.assertEqual(tile["linked"]["room"]["name"], "Lab")
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.room_id, self.room2.id)

    def test_dry_run_lists_objects_in_another_rooms_area(self):
        self._place(self.dev, 1, 1)
        self._place(self.ok, 2, 2)
        self._place(self.outside, 10, 8)
        r = self.client.post(self.url(), {"dry_run": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["objects"]
        self.assertEqual([x["name"] for x in rows], ["sw1"])
        self.assertEqual(rows[0]["room"]["name"], "Lab")
        self.assertEqual(rows[0]["area_room"]["name"], "Room 210")
        self.assertTrue(rows[0]["can_change"])
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.room_id, self.room2.id)

    def test_a_turned_area_and_a_polygon(self):
        self.area.delete()
        FloorPlanArea.objects.create(
            floor_plan=self.plan, shape="polygon", x=10, y=0, width=4, height=4,
            points=[[10, 0], [14, 0], [10, 4]], room=self.room,
        )
        FloorPlanArea.objects.create(
            floor_plan=self.plan, x=0, y=4, width=8, height=2, rotation=90,
            room=self.room,
        )
        self._place(self.dev, 10, 0)  # centre (10.5, 0.5): inside the triangle
        self._place(self.outside, 3, 1)  # centre (3.5, 1.5): in the turned rect
        r = self.client.post(self.url(), {"dry_run": True}, format="json")
        self.assertEqual(sorted(x["name"] for x in r.json()["objects"]), ["sw1", "sw3"])

    def test_apply_sets_the_room_and_logs_it(self):
        self._place(self.dev, 1, 1)
        r = self.client.post(self.url(), {
            "apply": [{"kind": "device", "id": str(self.dev.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual([a["id"] for a in body["applied"]], [str(self.dev.id)])
        self.assertEqual(body["objects"], [])
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.room_id, self.room.id)
        # The room's location comes with it.
        self.assertEqual(self.dev.location_id, self.floor.id)
        entry = ChangeLogEntry.objects.filter(
            object_type="api.device", object_id=str(self.dev.id), action="update"
        ).latest("timestamp")
        self.assertIn("room", entry.changes)

    def test_only_listed_rows_are_applied(self):
        self._place(self.dev, 1, 1)
        r = self.client.post(self.url(), {
            "apply": [{"kind": "device", "id": str(self.outside.id)},
                      {"kind": "device", "id": str(self.their_dev.id)}],
        }, format="json")
        self.assertEqual(r.json()["applied"], [])
        self.assertEqual(len(r.json()["skipped"]), 2)
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.room_id, self.room2.id)

    def test_without_change_on_the_device_it_is_skipped(self):
        self._place(self.dev, 1, 1)
        u = self._user("viewer", ["floorplan", "floorplanarea", "device", "room"], ["view"])
        self._login(u)
        r = self.client.post(self.url(), {"dry_run": True}, format="json")
        self.assertFalse(r.json()["objects"][0]["can_change"])
        r = self.client.post(self.url(), {
            "apply": [{"kind": "device", "id": str(self.dev.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["skipped"][0]["reason"], "You may not change it.")
        self.dev.refresh_from_db()
        self.assertEqual(self.dev.room_id, self.room2.id)

    def test_the_one_click_prompt_is_a_permission_checked_device_write(self):
        u = self._user("viewer2", ["device", "room"], ["view"])
        self._login(u)
        r = self.client.patch(f"/api/devices/{self.dev.id}/",
                              {"room_id": str(self.room.id)}, format="json")
        self.assertEqual(r.status_code, 403)
        self._grant(u, ["device"], ["change"])
        r = self.client.patch(f"/api/devices/{self.dev.id}/",
                              {"room_id": str(self.room.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.device", object_id=str(self.dev.id), action="update",
            user=u,
        ).exists())


class RoleLookTests(_Base):
    """A device placed straight from the picker needs no tile type: its tile
    reads the device's role as it is now."""

    def setUp(self):
        super().setUp()
        from .models import DeviceRole

        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access", color="#0ea5e9",
            icon="router",
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, role=self.role
        )

    def _tiles(self):
        return self.client.get(f"/api/floor-plans/{self.plan.id}/contents/").json()["tiles"]

    def test_an_untyped_tile_reads_the_devices_role_and_follows_it(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": {"create": [
            {"x": 1, "y": 1, "link_kind": "device", "link_id": str(self.dev.id)},
        ]}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tile = r.json()["tiles"][0]
        self.assertIsNone(tile["tile_type"])
        self.assertIsNone(tile["role_type"])
        self.assertEqual(
            (tile["linked"]["role"]["color"], tile["linked"]["role"]["icon"]),
            ("#0ea5e9", "router"),
        )
        self.role.color = "#f97316"
        self.role.save()
        self.assertEqual(self._tiles()[0]["linked"]["role"]["color"], "#f97316")

    def test_a_typed_tile_linked_afterwards_keeps_its_type(self):
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Box", slug="box")
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": {"create": [
            {"x": 1, "y": 1, "tile_type_id": str(tt.id)},
        ]}}, format="json")
        tile = r.json()["tiles"][0]
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": {"update": [
            {"id": tile["id"], "link_kind": "device", "link_id": str(self.dev.id)},
        ]}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tile = r.json()["tiles"][0]
        self.assertEqual(tile["tile_type"]["id"], str(tt.id))
        self.assertEqual(tile["linked"]["role"]["name"], "Access")

    def test_the_3d_room_paints_it_in_the_role_colour(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device"
        )
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["tiles"][0]["color"], "#0ea5e9")

    def test_a_rack_reads_its_rack_role(self):
        from .models import RackRole

        role = RackRole.objects.create(
            tenant=self.tenant, name="Core", slug="core", color="#a855f7"
        )
        rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site, role=role)
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, rack=rack, link_kind="rack"
        )
        self.assertEqual(self._tiles()[0]["linked"]["role"]["color"], "#a855f7")


class TileDisplayTests(_Base):
    def setUp(self):
        super().setUp()
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, True)
        settings = override_settings(MEDIA_ROOT=media)
        settings.enable()
        self.addCleanup(settings.disable)
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="Switch", width_mm=440
        )
        self.dt.front_image = SimpleUploadedFile("front.png", _png(40, 10), "image/png")
        self.dt.save()
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, device_type=self.dt
        )

    def _contents(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["tiles"]

    def test_display_and_z_round_trip(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": {"create": [
            {"x": 1, "y": 1, "link_kind": "device", "link_id": str(self.dev.id),
             "display": "photo", "z": 3},
        ]}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tile = r.json()["tiles"][0]
        self.assertEqual((tile["display"], tile["z"]), ("photo", 3))
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {"tiles": {"update": [
            {"id": tile["id"], "display": "banner"},
        ]}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_defaults(self):
        t = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device"
        )
        t.refresh_from_db()
        self.assertEqual((t.display, t.z), ("icon", 0))

    def test_the_type_front_image_is_the_photo(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device"
        )
        photo = self._contents()[0]["photo"]
        self.assertEqual(photo["source"], "type")
        self.assertAlmostEqual(photo["aspect"], 0.25)
        self.assertEqual(photo["width_mm"], 440.0)
        self.assertTrue(photo["url"].endswith(".png"))

    def test_the_devices_own_image_wins(self):
        from django.contrib.contenttypes.models import ContentType

        ImageAttachment.objects.create(
            tenant=self.tenant, content_type=ContentType.objects.get_for_model(Device),
            object_id=self.dev.id,
            image=SimpleUploadedFile("mine.png", _png(20, 20), "image/png"),
        )
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device"
        )
        photo = self._contents()[0]["photo"]
        self.assertEqual(photo["source"], "device")
        self.assertAlmostEqual(photo["aspect"], 1.0)

    def test_the_picker_row_carries_the_photo(self):
        rows = self.client.get(
            f"/api/floor-plans/{self.plan.id}/placeable/?kind=device"
        ).json()["results"]
        self.assertEqual(rows[0]["photo"]["source"], "type")

    def test_no_photo_without_view_on_the_device(self):
        FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, device=self.dev, link_kind="device"
        )
        self._login(self._user("planner", ["floorplan", "floorplantile"], ["view"]))
        self.assertIsNone(self._contents()[0]["photo"])

    def test_an_unlinked_tile_has_none(self):
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Wall", slug="wall")
        FloorPlanTile.objects.create(floor_plan=self.plan, x=0, y=0, tile_type=tt)
        self.assertIsNone(self._contents()[0]["photo"])


class ConflictTests(_Base):
    def setUp(self):
        super().setUp()
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        self.tile = FloorPlanTile.objects.create(
            floor_plan=self.plan, x=0, y=0, tile_type=self.tt
        )
        self.label = FloorPlanLabel.objects.create(floor_plan=self.plan, text="A", x=1, y=1)
        self.read = {
            t["id"]: t["updated_at"]
            for t in self.client.get(
                f"/api/floor-plans/{self.plan.id}/contents/"
            ).json()["tiles"]
        }
        self.label_version = self.client.get(
            f"/api/floor-plan-labels/{self.label.id}/"
        ).json()["updated_at"]

    def bulk(self, body):
        return self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", body, format="json")

    def test_a_current_version_saves(self):
        r = self.bulk({"tiles": {"update": [
            {"id": str(self.tile.id), "x": 2, "version": self.read[str(self.tile.id)]},
        ]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.tile.refresh_from_db()
        self.assertEqual(self.tile.x, 2)

    def test_a_stale_version_is_a_409_and_nothing_is_written(self):
        # Someone else moves the tile meanwhile.
        self.tile.x = 5
        self.tile.save()
        r = self.bulk({
            "tiles": {"update": [
                {"id": str(self.tile.id), "x": 2, "version": self.read[str(self.tile.id)]},
            ]},
            "labels": {"create": [{"text": "B", "x": 0, "y": 0}]},
        })
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual(len(body["conflicts"]), 1)
        conflict = body["conflicts"][0]
        self.assertEqual((conflict["kind"], conflict["id"]), ("tile", str(self.tile.id)))
        self.assertEqual(conflict["current"]["x"], 5)
        self.tile.refresh_from_db()
        self.assertEqual(self.tile.x, 5)
        self.assertEqual(FloorPlanLabel.objects.count(), 1)

    def test_a_row_deleted_elsewhere(self):
        tile_id = str(self.tile.id)
        version = self.read[tile_id]
        self.tile.delete()
        r = self.bulk({"tiles": {"update": [
            {"id": tile_id, "x": 2, "version": version},
        ]}})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIsNone(r.json()["conflicts"][0]["current"])

    def test_a_stale_delete(self):
        self.label.text = "Changed"
        self.label.save()
        r = self.bulk({"labels": {"delete": [
            {"id": str(self.label.id), "version": self.label_version},
        ]}})
        self.assertEqual(r.status_code, 409)
        self.assertTrue(FloorPlanLabel.objects.filter(pk=self.label.pk).exists())
        r = self.bulk({"labels": {"delete": [{"id": str(self.label.id)}]}})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(FloorPlanLabel.objects.filter(pk=self.label.pk).exists())

    def test_without_a_version_the_last_save_wins(self):
        self.tile.x = 5
        self.tile.save()
        r = self.bulk({"tiles": {"update": [{"id": str(self.tile.id), "x": 2}]}})
        self.assertEqual(r.status_code, 200)

    def test_a_malformed_version(self):
        r = self.bulk({"tiles": {"update": [
            {"id": str(self.tile.id), "x": 2, "version": "yesterday"},
        ]}})
        self.assertEqual(r.status_code, 400)

    def test_single_writes(self):
        self.label.text = "Changed"
        self.label.save()
        url = f"/api/floor-plan-labels/{self.label.id}/"
        r = self.client.patch(url, {"text": "Mine", "version": self.label_version},
                              format="json")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["conflicts"][0]["current"]["text"], "Changed")
        r = self.client.delete(f"{url}?version={self.label_version}")
        self.assertEqual(r.status_code, 409)
        fresh = self.client.get(url).json()["updated_at"]
        r = self.client.patch(url, {"text": "Mine", "version": fresh}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tile_url = f"/api/floor-plan-tiles/{self.tile.id}/"
        r = self.client.patch(tile_url, {"x": 3, "version": "2001-01-01T00:00:00Z"},
                              format="json")
        self.assertEqual(r.status_code, 409)
