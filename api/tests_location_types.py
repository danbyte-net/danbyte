"""Location types: the editable catalog, the Location link, tenancy, site
roles, bulk edit and delete, and the colour a location is drawn in."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from core.models import Organization, Tenant

from .models import FloorPlan, FloorPlanArea, Location, LocationType, Room, Site


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Depot")
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.theirs = LocationType.objects.create(
            tenant=self.tenant2, name="Building", slug="building", color="#000000"
        )
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=types, actions=actions
        )
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u


class CatalogTests(_Base):
    def test_ships_empty(self):
        self.assertEqual(LocationType.objects.filter(tenant=self.tenant).count(), 0)
        self.assertEqual(self.client.get("/api/location-types/").json()["count"], 0)

    def test_create_slug_and_unique_per_tenant(self):
        r = self.client.post("/api/location-types/", {
            "name": "Building", "color": "#2563EB", "icon": "building",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["slug"], "building")
        self.assertEqual(r.json()["color"], "#2563eb")
        # Another tenant's "Building" is no clash; a second one here is.
        r = self.client.post("/api/location-types/", {"name": "Building"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())

    def test_bad_colour(self):
        r = self.client.post("/api/location-types/", {"name": "X", "color": "blue"},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_other_tenant_is_invisible_and_unlinkable(self):
        self.assertEqual(self.client.get(f"/api/location-types/{self.theirs.id}/").status_code,
                         404)
        r = self.client.post("/api/locations/", {
            "name": "Hall", "site_id": str(self.site.id),
            "location_type_id": str(self.theirs.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_type_id", r.json())

    def test_counts_and_picker(self):
        t = LocationType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        Location.objects.create(tenant=self.tenant, site=self.site, name="F1", slug="f1",
                                location_type=t)
        row = self.client.get("/api/location-types/").json()["results"][0]
        self.assertEqual(row["location_count"], 1)
        pick = self.client.get("/api/location-types/?picker=1").json()["results"][0]
        self.assertLessEqual({"id", "name", "slug", "color", "icon"}, set(pick))
        self.assertNotIn("location_count", pick)

    def test_registered_and_logged(self):
        self.assertTrue(is_registered("locationtype"))
        tid = self.client.post("/api/location-types/", {"name": "Hall"},
                               format="json").json()["id"]
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.locationtype", object_id=tid, action="create"
        ).exists())

    def test_delete_unlinks_its_locations(self):
        t = LocationType.objects.create(tenant=self.tenant, name="Floor", slug="floor")
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="F1",
                                      slug="f1", location_type=t)
        self.assertEqual(self.client.delete(f"/api/location-types/{t.id}/").status_code, 204)
        loc.refresh_from_db()
        self.assertIsNone(loc.location_type_id)

    def test_bulk_edit_and_delete(self):
        a = LocationType.objects.create(tenant=self.tenant, name="A", slug="a")
        b = LocationType.objects.create(tenant=self.tenant, name="B", slug="b")
        fields = self.client.get("/api/location-types/bulk-edit-fields/")
        self.assertEqual(fields.status_code, 200, fields.content)
        r = self.client.post("/api/location-types/bulk-update/", {
            "ids": [str(a.id), str(b.id)], "fields": {"color": "#22c55e"},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertEqual(a.color, "#22c55e")
        r = self.client.post("/api/location-types/bulk-delete/", {
            "ids": [str(a.id), str(b.id)],
        }, format="json")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.assertFalse(LocationType.objects.filter(pk__in=[a.id, b.id]).exists())

    def test_site_scoped_editor_reads_but_cannot_write_types(self):
        LocationType.objects.create(tenant=self.tenant, name="Building", slug="building")
        u = self._user("siteed", ["location", "locationtype"], ["view"], sites=[self.site])
        self._login(u)
        self.assertEqual(self.client.get("/api/location-types/").json()["count"], 1)
        r = self.client.post("/api/location-types/", {"name": "Hut"}, format="json")
        self.assertEqual(r.status_code, 403)


class LocationLinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.building = LocationType.objects.create(
            tenant=self.tenant, name="Building", slug="building", color="#2563eb",
            icon="building",
        )

    def test_location_carries_type_and_code(self):
        r = self.client.post("/api/locations/", {
            "name": "Building A", "site_id": str(self.site.id), "code": "A1",
            "location_type_id": str(self.building.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["code"], "A1")
        self.assertEqual(body["location_type"]["name"], "Building")
        pick = self.client.get("/api/locations/?picker=1").json()["results"][0]
        self.assertEqual(pick["color"], "#2563eb")  # its own is blank: the type's
        self.assertEqual(pick["icon"], "building")
        self.assertEqual(pick["location_type"]["id"], str(self.building.id))

    def test_filter_by_type(self):
        Location.objects.create(tenant=self.tenant, site=self.site, name="A", slug="a",
                                location_type=self.building)
        Location.objects.create(tenant=self.tenant, site=self.site, name="B", slug="b")
        rows = self.client.get(f"/api/locations/?location_type={self.building.id}").json()
        self.assertEqual([r["name"] for r in rows["results"]], ["A"])
        rows = self.client.get("/api/locations/?location_type=none").json()
        self.assertEqual([r["name"] for r in rows["results"]], ["B"])
        self.assertEqual(self.client.get("/api/locations/?location_type=x").status_code, 400)

    def test_own_colour_wins_then_type(self):
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="A",
                                      slug="a", location_type=self.building)
        self.assertEqual(loc.display_color, "#2563eb")
        loc.color = "#f97316"
        self.assertEqual(loc.display_color, "#f97316")

    def test_room_and_area_refs_use_the_drawn_colour(self):
        loc = Location.objects.create(tenant=self.tenant, site=self.site, name="A",
                                      slug="a", location_type=self.building)
        room = Room.objects.create(tenant=self.tenant, location=loc, name="R", slug="r")
        body = self.client.get(f"/api/rooms/{room.id}/").json()
        self.assertEqual(body["location"]["color"], "#2563eb")
        plan = FloorPlan.objects.create(tenant=self.tenant, site=self.site, location=loc,
                                        name="G")
        area = FloorPlanArea.objects.create(floor_plan=plan, location=loc)
        body = self.client.get(f"/api/floor-plan-areas/{area.id}/").json()
        self.assertEqual(body["location"]["color"], "#2563eb")
