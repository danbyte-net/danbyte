"""Rooms (floor plans P1b): a Room under a Location, and the room a device,
rack or cabinet stands in. CRUD, tenancy, site scope, the room/location rules
on every write path (API, import, model clean, rack move), deletes, filters,
the change log and the registries a new object type joins."""

from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.test import TestCase
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import SITE_PATHS, site_role_types
from core.models import Organization, Tag, Tenant
from customization.models import CustomField

from .models import Cabinet, Device, Location, Rack, Room, SearchEntry, Site, Status
from .status_registry import seed_builtin_statuses
from .test_utils import status_for


class RoomTestCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.site2 = Site.objects.create(tenant=self.tenant, name="Branch")
        self.bldg = Location.objects.create(tenant=self.tenant, site=self.site,
                                            name="Building A", slug="building-a")
        self.floor = Location.objects.create(tenant=self.tenant, site=self.site,
                                             name="Floor 2", slug="floor-2", parent=self.bldg)
        self.other_bldg = Location.objects.create(tenant=self.tenant, site=self.site,
                                                  name="Building B", slug="building-b")
        self.branch_loc = Location.objects.create(tenant=self.tenant, site=self.site2,
                                                  name="Annex", slug="annex")
        self.active = status_for(self.tenant)
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.their_loc = Location.objects.create(tenant=self.tenant2, site=self.their_site,
                                                 name="Theirs", slug="theirs")
        self.their_room = Room.objects.create(tenant=self.tenant2, location=self.their_loc,
                                              name="Their room", slug="their-room")
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _limited_user(self, name, object_types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=object_types, actions=actions
        )
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _room(self, name="Room 210", location=None, **extra):
        body = {"name": name, "location_id": str((location or self.floor).id), **extra}
        return self.client.post("/api/rooms/", body, format="json")

    def _make(self, name, location=None, **extra):
        loc = location or self.floor
        return Room.objects.create(tenant=self.tenant, location=loc, name=name,
                                   slug=name.lower().replace(" ", "-"), **extra)


class RoomCrudTests(RoomTestCase):
    def test_a_room_round_trips(self):
        r = self._room(code="210", color="#22c55e", description="Comms room",
                       status_id=str(self.active.id))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["slug"], "room-210")
        self.assertEqual(body["code"], "210")
        self.assertEqual(body["color"], "#22c55e")
        self.assertEqual(body["location"]["id"], str(self.floor.id))
        self.assertEqual(body["site"], {"id": str(self.site.id), "name": "HQ"})
        self.assertEqual(body["status"]["id"], str(self.active.id))
        self.assertEqual((body["device_count"], body["rack_count"], body["cabinet_count"]),
                         (0, 0, 0))
        self.assertIsNotNone(Room.objects.get(pk=body["id"]).numid)

    def test_names_are_unique_per_location_and_slugs_suffix_only_there(self):
        self.assertEqual(self._room().status_code, 201)
        r = self._room()
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())
        # Another building may have its own Room 210, with the same slug.
        r = self._room(location=self.other_bldg)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "room-210")
        r = self._room(name="Room 210!", location=self.other_bldg)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "room-210-2")

    def test_a_location_is_required(self):
        r = self.client.post("/api/rooms/", {"name": "Lost"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())

    def test_custom_fields_and_tags(self):
        CustomField.objects.create(tenant=self.tenant, key="area_m2", label="Area",
                                   type="integer", applies_to=["room"])
        tag = Tag.objects.create(tenant=self.tenant, name="Cold", slug="cold")
        r = self._room(custom_fields={"area_m2": "big"})
        self.assertEqual(r.status_code, 400)
        r = self._room(custom_fields={"area_m2": 40}, tag_ids=[tag.id])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["custom_fields"], {"area_m2": 40})
        self.assertEqual([t["slug"] for t in r.json()["tags"]], ["cold"])

    def test_changes_are_logged(self):
        room = self._room().json()
        self.client.patch(f"/api/rooms/{room['id']}/", {"code": "210"}, format="json")
        actions = list(ChangeLogEntry.objects.filter(
            object_type="api.room", object_id=room["id"]
        ).order_by("timestamp").values_list("action", flat=True))
        self.assertEqual(actions, ["create", "update"])

    def test_the_location_counts_its_rooms(self):
        self._make("R1")
        self._make("R2")
        body = self.client.get(f"/api/locations/{self.floor.id}/").json()
        self.assertEqual(body["room_count"], 2)

    def test_the_search_index_finds_a_room(self):
        room = self._make("Comms 210", code="C210")
        entry = SearchEntry.objects.get(object_type="room", object_id=room.id)
        self.assertEqual(entry.url, f"/rooms/{room.id}")
        self.assertEqual(entry.site_id, self.site.id)


class RoomFilterTests(RoomTestCase):
    def setUp(self):
        super().setUp()
        planned = status_for(self.tenant, "planned")
        tag = Tag.objects.create(tenant=self.tenant, name="Cold", slug="cold")
        self.r1 = self._make("R1", location=self.bldg, code="A-1")
        self.r2 = self._make("R2", location=self.floor, status=planned)
        self.r2.tags.add(tag)
        self.r3 = self._make("R3", location=self.branch_loc)
        self.planned = planned

    def names(self, query):
        r = self.client.get(f"/api/rooms/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(x["name"] for x in r.json()["results"])

    def test_filters(self):
        self.assertEqual(self.names(""), ["R1", "R2", "R3"])
        self.assertEqual(self.names(f"site={self.site2.id}"), ["R3"])
        self.assertEqual(self.names(f"location={self.bldg.id}"), ["R1"])
        self.assertEqual(
            self.names(f"location={self.bldg.id}&include_descendants=1"), ["R1", "R2"]
        )
        self.assertEqual(self.names(f"status={self.planned.id}"), ["R2"])
        self.assertEqual(self.names("tag=cold"), ["R2"])
        self.assertEqual(self.names("search=a-1"), ["R1"])

    def test_a_malformed_filter_is_a_400(self):
        self.assertEqual(self.client.get("/api/rooms/?location=nope").status_code, 400)

    def test_picker_rows_are_mini(self):
        rows = self.client.get(f"/api/rooms/?picker=1&location={self.floor.id}").json()
        self.assertEqual(rows["results"][0]["name"], "R2")
        self.assertEqual(rows["results"][0]["location_id"], str(self.floor.id))
        self.assertNotIn("device_count", rows["results"][0])


class RoomTenancyTests(RoomTestCase):
    def test_another_tenants_rooms_are_invisible(self):
        self._make("Mine")
        rows = self.client.get("/api/rooms/").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["Mine"])
        self.assertEqual(self.client.get(f"/api/rooms/{self.their_room.id}/").status_code, 404)

    def test_another_tenants_location_cannot_hold_a_room(self):
        r = self._room(location=self.their_loc)
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())

    def test_another_tenants_room_cannot_be_referenced(self):
        r = self.client.post("/api/devices/", {
            "name": "d1", "site_id": str(self.site.id), "room_id": str(self.their_room.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("room_id", r.json())
        dev = Device.objects.create(tenant=self.tenant, name="d2", site=self.site)
        dev.room = self.their_room
        with self.assertRaises(ValidationError):
            dev.full_clean()


class RoomSiteScopeTests(RoomTestCase):
    def test_a_site_scoped_user_sees_and_writes_only_their_sites_rooms(self):
        self._make("HQ room")
        self._make("Annex room", location=self.branch_loc)
        u = self._limited_user("hq", ["room"], ["view", "add", "change"], sites=[self.site])
        self._login(u)
        rows = self.client.get("/api/rooms/").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["HQ room"])
        self.assertEqual(self._room(name="New").status_code, 201)
        r = self._room(name="Elsewhere", location=self.branch_loc)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(Room.objects.filter(name="Elsewhere").exists())

    def test_without_a_grant_nothing_is_listed(self):
        self._make("R1")
        self._login(self._limited_user("nobody", ["rack"], ["view"]))
        self.assertEqual(self.client.get("/api/rooms/").status_code, 403)

    def test_rooms_are_site_bound_and_in_the_site_roles(self):
        self.assertTrue(is_registered("room"))
        self.assertEqual(SITE_PATHS["room"], "location__site")
        self.assertIn("room", site_role_types())


class RoomAssignmentTests(RoomTestCase):
    """The room on a device, rack and cabinet: the same rules for each."""

    def setUp(self):
        super().setUp()
        self.room = self._make("Room 210")
        self.room_b = self._make("Room B1", location=self.other_bldg)
        self.annex_room = self._make("Annex 1", location=self.branch_loc)

    def _create(self, kind, **body):
        base = {"device": {"name": "d1", "site_id": str(self.site.id)},
                "rack": {"name": "r1", "site_id": str(self.site.id)},
                "cabinet": {"name": "k1", "site_id": str(self.site.id),
                            "inner_width_mm": 500, "inner_height_mm": 600}}[kind]
        return self.client.post(f"/api/{kind}s/" if kind != "cabinet" else "/api/cabinets/",
                                {**base, **body}, format="json")

    def test_a_room_alone_gives_the_object_its_location(self):
        for kind in ("device", "rack", "cabinet"):
            with self.subTest(kind=kind):
                r = self._create(kind, room_id=str(self.room.id))
                self.assertEqual(r.status_code, 201, r.content)
                body = r.json()
                self.assertEqual(body["room"], {"id": str(self.room.id), "name": "Room 210",
                                                "code": "", "color": ""})
                self.assertEqual(body["location"]["id"], str(self.floor.id))

    def test_a_room_in_another_location_is_refused(self):
        for kind in ("device", "rack", "cabinet"):
            with self.subTest(kind=kind):
                r = self._create(kind, location_id=str(self.bldg.id), room_id=str(self.room.id))
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json()["room_id"], ["Pick a room in Building A."])

    def test_a_room_at_another_site_is_refused(self):
        for kind in ("device", "rack", "cabinet"):
            with self.subTest(kind=kind):
                r = self._create(kind, room_id=str(self.annex_room.id))
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json()["room_id"], ["Pick a room at HQ."])

    def test_an_update_refuses_a_mismatching_room_and_moves_with_a_room_alone(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="r1",
                                   location=self.bldg)
        url = f"/api/racks/{rack.id}/"
        r = self.client.patch(url, {"room_id": str(self.room.id),
                                    "location_id": str(self.bldg.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(url, {"room_id": str(self.room.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rack.refresh_from_db()
        self.assertEqual((rack.location_id, rack.room_id), (self.floor.id, self.room.id))

    def test_moving_to_another_location_clears_the_room(self):
        dev = Device.objects.create(tenant=self.tenant, name="d1", site=self.site,
                                    location=self.floor, room=self.room)
        r = self.client.patch(f"/api/devices/{dev.id}/", {"location_id": str(self.bldg.id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["room"])
        dev.refresh_from_db()
        self.assertIsNone(dev.room_id)
        entry = ChangeLogEntry.objects.filter(
            object_type="api.device", object_id=dev.id, action="update"
        ).latest("timestamp")
        self.assertIn("room", entry.changes)
        # Unchanged location keeps the room; clearing the location clears it.
        cab = Cabinet.objects.create(tenant=self.tenant, site=self.site, name="k1",
                                     inner_width_mm=500, inner_height_mm=600,
                                     location=self.floor, room=self.room)
        r = self.client.patch(f"/api/cabinets/{cab.id}/", {"description": "x"}, format="json")
        self.assertEqual(r.json()["room"]["id"], str(self.room.id))
        r = self.client.patch(f"/api/cabinets/{cab.id}/", {"location_id": None}, format="json")
        self.assertIsNone(r.json()["room"])

    def test_the_room_filter(self):
        Device.objects.create(tenant=self.tenant, name="in", site=self.site,
                              location=self.floor, room=self.room)
        Device.objects.create(tenant=self.tenant, name="out", site=self.site)
        Rack.objects.create(tenant=self.tenant, site=self.site, name="r-in",
                            location=self.floor, room=self.room)
        Rack.objects.create(tenant=self.tenant, site=self.site, name="r-out")
        Cabinet.objects.create(tenant=self.tenant, site=self.site, name="k-in",
                               inner_width_mm=500, inner_height_mm=600,
                               location=self.floor, room=self.room)
        for kind, name in (("devices", "in"), ("racks", "r-in"), ("cabinets", "k-in")):
            with self.subTest(kind=kind):
                rows = self.client.get(f"/api/{kind}/?room={self.room.id}").json()["results"]
                self.assertEqual([x["name"] for x in rows], [name])
        body = self.client.get(f"/api/rooms/{self.room.id}/").json()
        self.assertEqual((body["device_count"], body["rack_count"], body["cabinet_count"]),
                         (1, 1, 1))

    def test_a_room_needs_view_on_rooms(self):
        u = self._limited_user("racker", ["rack", "site", "location"],
                               ["view", "add", "change"])
        self._login(u)
        r = self._create("rack", room_id=str(self.room.id))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["room_id"], ["Pick a room you can see."])
        self.assertEqual(self._create("rack", location_id=str(self.floor.id)).status_code,
                         201)

    def test_a_site_scoped_user_cannot_set_a_room_they_cannot_see(self):
        u = self._limited_user("annex", ["device", "room", "location", "site"],
                               ["view", "add", "change"], sites=[self.site2])
        self._login(u)
        r = self.client.post("/api/devices/", {
            "name": "d1", "site_id": str(self.site2.id), "room_id": str(self.room.id),
        }, format="json")
        self.assertIn(r.status_code, (400, 403))
        self.assertFalse(Device.objects.filter(name="d1").exists())


class RoomModelCleanTests(RoomTestCase):
    """full_clean() is the import and integration-sync path."""

    def setUp(self):
        super().setUp()
        self.room = self._make("Room 210")

    def test_a_stale_room_is_cleared_and_a_new_one_is_checked(self):
        dev = Device.objects.create(tenant=self.tenant, name="d1", site=self.site,
                                    location=self.floor, room=self.room)
        dev.location = self.bldg
        dev.full_clean()
        self.assertIsNone(dev.room)
        dev.save()
        dev.room = self.room
        with self.assertRaises(ValidationError) as ctx:
            dev.full_clean()
        self.assertIn("room", ctx.exception.message_dict)

    def test_a_new_room_without_a_location_takes_its_location(self):
        rack = Rack(tenant=self.tenant, site=self.site, name="r1", room=self.room)
        rack.full_clean()
        self.assertEqual(rack.location, self.floor)


class RoomImportTests(RoomTestCase):
    def setUp(self):
        super().setUp()
        self.room = self._make("Room 210")

    def _import(self, slug, rows, dry_run=False):
        r = self.client.post(f"/api/io/{slug}/import/", {"rows": rows, "dry_run": dry_run},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_a_device_row_with_a_room_in_another_location_is_refused(self):
        res = self._import("device", [{"name": "imp1", "site": "HQ",
                                       "location": "Building A", "room": "Room 210"}])
        self.assertEqual(res["created"], 0, res)
        self.assertIn("room", res["errors"][0]["error"])
        self.assertFalse(Device.objects.filter(name="imp1").exists())

    def test_a_rack_row_with_its_room_imports(self):
        res = self._import("rack", [{"name": "imp-r", "site": "HQ", "location": "Floor 2",
                                     "room": "Room 210"}])
        self.assertEqual(res["created"], 1, res)
        rack = Rack.objects.get(name="imp-r")
        self.assertEqual((rack.location_id, rack.room_id), (self.floor.id, self.room.id))

    def test_rooms_export_and_import(self):
        types = {t["slug"] for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertIn("room", types)
        res = self._import("room", [{"name": "Room 211", "location": "Floor 2", "code": "211"}])
        self.assertEqual(res["created"], 1, res)
        self.assertEqual(Room.objects.get(name="Room 211").location_id, self.floor.id)


class RoomDeleteTests(RoomTestCase):
    def setUp(self):
        super().setUp()
        self.room = self._make("Room 210")

    def test_deleting_a_room_leaves_its_objects_without_one(self):
        dev = Device.objects.create(tenant=self.tenant, name="d1", site=self.site,
                                    location=self.floor, room=self.room)
        r = self.client.delete(f"/api/rooms/{self.room.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        dev.refresh_from_db()
        self.assertIsNone(dev.room_id)
        self.assertEqual(dev.location_id, self.floor.id)

    def test_a_location_with_rooms_is_not_deleted(self):
        r = self.client.delete(f"/api/locations/{self.floor.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertTrue(Location.objects.filter(pk=self.floor.id).exists())

    def test_an_occupied_room_does_not_move_location(self):
        Rack.objects.create(tenant=self.tenant, site=self.site, name="r1",
                            location=self.floor, room=self.room)
        r = self.client.patch(f"/api/rooms/{self.room.id}/",
                              {"location_id": str(self.bldg.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.json())
        empty = self._make("Spare")
        r = self.client.patch(f"/api/rooms/{empty.id}/",
                              {"location_id": str(self.bldg.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_bulk_edit_and_bulk_delete(self):
        other = self._make("Room 211")
        planned = status_for(self.tenant, "planned")
        fields = self.client.get("/api/rooms/bulk-edit-fields/").json()
        kinds = {f["key"]: f["kind"] for f in fields["fields"]}
        self.assertEqual(kinds, {"status_id": "status", "color": "color",
                                 "description": "text"})
        self.assertEqual(fields["custom_fields"], "room")
        r = self.client.post("/api/rooms/bulk-update/", {
            "ids": [str(self.room.id), str(other.id)],
            "fields": {"status_id": str(planned.id), "color": "#ef4444"},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(Room.objects.filter(location=self.floor).values_list("color", flat=True)),
            {"#ef4444"},
        )
        r = self.client.post("/api/rooms/bulk-delete/",
                             {"ids": [str(self.room.id), str(other.id),
                                      str(self.their_room.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertTrue(Room.objects.filter(pk=self.their_room.id).exists())

    def test_the_tenants_delete_takes_its_rooms(self):
        from core.tenant_delete import force_delete_tenant

        force_delete_tenant(self.tenant2)
        self.assertFalse(Room.objects.filter(pk=self.their_room.id).exists())


class RoomRackMoveTests(RoomTestCase):
    def test_a_moved_rack_and_its_devices_leave_the_room_behind(self):
        room = self._make("Room 210")
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="r1",
                                   location=self.floor, room=room)
        dev = Device.objects.create(tenant=self.tenant, name="d1", site=self.site,
                                    location=self.floor, room=room, rack=rack)
        r = self.client.post(f"/api/racks/{rack.id}/move/",
                             {"site_id": str(self.site2.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rack.refresh_from_db()
        dev.refresh_from_db()
        self.assertEqual((rack.site_id, rack.room_id), (self.site2.id, None))
        self.assertEqual((dev.site_id, dev.room_id), (self.site2.id, None))


class RoomStatusSeedTests(RoomTestCase):
    def test_the_catalog_offers_room_statuses_with_active_as_default(self):
        seed_builtin_statuses(self.tenant2)
        rows = {s.slug: s for s in Status.objects.filter(tenant=self.tenant2)}
        for slug in ("active", "planned", "decommissioning", "retired"):
            self.assertIn("room", rows[slug].available_to, slug)
        self.assertIn("room", rows["active"].default_for)


ROLES = importlib.import_module("auth_api.migrations.0043_site_roles_rooms")
SITE_VIEW = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")


class SiteRoleRoomUpgradeTests(TestCase):
    """0043 gives the site roles built before it the rooms."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="A")

    def _perm(self, name, actions, types):
        perm = ObjectPermission.objects.create(name=name, object_types=sorted(types),
                                               actions=actions)
        perm.tenants.set([self.tenant])
        perm.sites.set([self.site])
        return perm

    def test_viewer_and_editor_gain_rooms_once_and_hand_built_stay(self):
        # The role as 0043 knew it: types added by later migrations would make
        # it a hand-built grant to 0043.
        types = (set(site_role_types()) & ROLES.KNOWN) - {"room"}
        view = self._perm(f"A{SITE_VIEW.VIEW_SUFFIX}", ["view"], types)
        edit = self._perm(f"A{SITE_VIEW.EDIT_SUFFIX}", ["view", "add", "change", "delete"],
                          types)
        custom = self._perm(f"Ops{SITE_VIEW.VIEW_SUFFIX}", ["view"], {"device", "prefix"})
        ROLES.forwards(django_apps, None)
        ROLES.forwards(django_apps, None)
        for perm in (view, edit, custom):
            perm.refresh_from_db()
        self.assertEqual(view.object_types.count("room"), 1)
        self.assertEqual(edit.object_types.count("room"), 1)
        self.assertEqual(custom.object_types, ["device", "prefix"])
