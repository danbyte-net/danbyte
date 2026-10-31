"""Area types: the editable catalog, tenancy, site roles, bulk edit and
delete, and the type a plain floor-plan area carries (never a linked one)."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import site_role_catalog_types
from core.models import Organization, Tenant

from .models import AreaType, FloorPlan, FloorPlanArea, Location, Room, Site
from .search_index import SPECS


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Depot")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Yard", slug="yard"
        )
        self.loc_b = Location.objects.create(
            tenant=self.tenant, site=self.site_b, name="Depot yard", slug="depot-yard"
        )
        self.room = Room.objects.create(
            tenant=self.tenant, location=self.loc, name="Gatehouse", slug="gatehouse"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site, location=self.loc, name="Ground",
            grid_width=40, grid_height=20,
        )
        self.plan_b = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site_b, location=self.loc_b, name="Depot",
            grid_width=40, grid_height=20,
        )
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        self.theirs = AreaType.objects.create(
            tenant=self.tenant2, name="Parking", slug="parking", color="#000000"
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

    def _type(self, name="Parking", **kw):
        return AreaType.objects.create(
            tenant=self.tenant, name=name, slug=name.lower(), **kw
        )

    def _area(self, **body):
        body.setdefault("floor_plan_id", str(self.plan.id))
        body.setdefault("x", 1)
        body.setdefault("y", 1)
        body.setdefault("width", 4)
        body.setdefault("height", 3)
        return self.client.post("/api/floor-plan-areas/", body, format="json")


class CatalogTests(_Base):
    def test_ships_empty(self):
        self.assertEqual(AreaType.objects.filter(tenant=self.tenant).count(), 0)
        self.assertEqual(self.client.get("/api/area-types/").json()["count"], 0)

    def test_create_slug_pattern_and_unique_per_tenant(self):
        r = self.client.post("/api/area-types/", {
            "name": "Parking", "color": "#2563EB", "icon": "car", "pattern": "hatched",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["slug"], "parking")
        self.assertEqual(body["color"], "#2563eb")
        self.assertEqual(body["pattern"], "hatched")
        # Another tenant's "Parking" is no clash; a second one here is.
        r = self.client.post("/api/area-types/", {"name": "Parking"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())

    def test_defaults_and_bad_values(self):
        r = self.client.post("/api/area-types/", {"name": "Lawn"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["pattern"], "solid")
        for bad in ({"color": "blue"}, {"pattern": "plaid"}):
            with self.subTest(bad=bad):
                r = self.client.post("/api/area-types/", {"name": "X", **bad},
                                     format="json")
                self.assertEqual(r.status_code, 400)

    def test_other_tenant_is_invisible_and_unlinkable(self):
        self.assertEqual(
            self.client.get(f"/api/area-types/{self.theirs.id}/").status_code, 404
        )
        self.assertEqual(self.client.get("/api/area-types/").json()["count"], 0)
        r = self._area(area_type_id=str(self.theirs.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("area_type_id", r.json())

    def test_counts_and_picker(self):
        t = self._type()
        FloorPlanArea.objects.create(floor_plan=self.plan, area_type=t)
        FloorPlanArea.objects.create(floor_plan=self.plan_b, area_type=t)
        row = self.client.get("/api/area-types/").json()["results"][0]
        self.assertEqual(row["area_count"], 2)
        self.assertEqual(self.client.get(f"/api/area-types/{t.id}/").json()["area_count"], 2)
        pick = self.client.get("/api/area-types/?picker=1").json()["results"][0]
        self.assertLessEqual({"id", "name", "slug", "color", "pattern", "icon"}, set(pick))
        self.assertNotIn("area_count", pick)

    def test_search(self):
        self._type("Parking", description="Cars")
        self._type("Fence")
        rows = self.client.get("/api/area-types/?search=car").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["Parking"])

    def test_registered_logged_and_indexed(self):
        self.assertTrue(is_registered("areatype"))
        self.assertIn("areatype", SPECS)
        self.assertIn("areatype", site_role_catalog_types())
        tid = self.client.post("/api/area-types/", {"name": "Gate"},
                               format="json").json()["id"]
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.areatype", object_id=tid, action="create"
        ).exists())

    def test_delete_unlinks_its_areas(self):
        t = self._type()
        area = FloorPlanArea.objects.create(floor_plan=self.plan, area_type=t)
        self.assertEqual(self.client.delete(f"/api/area-types/{t.id}/").status_code, 204)
        area.refresh_from_db()
        self.assertIsNone(area.area_type_id)

    def test_bulk_edit_and_delete(self):
        a = self._type("A")
        b = self._type("B")
        fields = self.client.get("/api/area-types/bulk-edit-fields/")
        self.assertEqual(fields.status_code, 200, fields.content)
        r = self.client.post("/api/area-types/bulk-update/", {
            "ids": [str(a.id), str(b.id)],
            "fields": {"color": "#22c55e", "pattern": "dotted"},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertEqual((a.color, a.pattern), ("#22c55e", "dotted"))
        r = self.client.post("/api/area-types/bulk-delete/", {
            "ids": [str(a.id), str(b.id)],
        }, format="json")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.assertFalse(AreaType.objects.filter(pk__in=[a.id, b.id]).exists())

    def test_bulk_cannot_reach_another_tenant(self):
        r = self.client.post("/api/area-types/bulk-update/", {
            "ids": [str(self.theirs.id)], "fields": {"color": "#22c55e"},
        }, format="json")
        # Out of reach: nothing of theirs is matched, nothing changes.
        if r.status_code == 200:
            self.assertEqual(r.json().get("updated"), 0)
        else:
            self.assertIn(r.status_code, (400, 404), r.content)
        self.theirs.refresh_from_db()
        self.assertEqual(self.theirs.color, "#000000")

    def test_site_scoped_reader_reads_but_cannot_write_types(self):
        t = self._type()
        u = self._user("siteed", ["floorplanarea", "areatype"], ["view"], sites=[self.site])
        self._login(u)
        self.assertEqual(self.client.get("/api/area-types/").json()["count"], 1)
        r = self.client.post("/api/area-types/", {"name": "Hut"}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.patch(f"/api/area-types/{t.id}/", {"color": "#ffffff"},
                              format="json")
        self.assertEqual(r.status_code, 403)

    def test_count_is_what_the_reader_may_view(self):
        t = self._type()
        FloorPlanArea.objects.create(floor_plan=self.plan, area_type=t)
        FloorPlanArea.objects.create(floor_plan=self.plan_b, area_type=t)
        u = self._user("siteview", ["floorplanarea", "areatype"], ["view"],
                       sites=[self.site])
        self._login(u)
        row = self.client.get("/api/area-types/").json()["results"][0]
        self.assertEqual(row["area_count"], 1)


class AreaLinkTests(_Base):
    def setUp(self):
        super().setUp()
        self.parking = self._type(color="#2563eb", icon="car", pattern="hatched")

    def test_plain_area_carries_its_type(self):
        r = self._area(area_type_id=str(self.parking.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["area_type"], {
            "id": str(self.parking.id), "name": "Parking", "color": "#2563eb",
            "pattern": "hatched", "icon": "car",
        })
        area = FloorPlanArea.objects.get(pk=r.json()["id"])
        # Unnamed, it is called by its type.
        self.assertEqual(str(area), "Parking")
        r = self.client.patch(f"/api/floor-plan-areas/{area.id}/",
                              {"area_type_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["area_type"])

    def test_linked_area_refuses_a_type(self):
        for link in ({"room_id": str(self.room.id)}, {"location_id": str(self.loc.id)}):
            with self.subTest(link=link):
                r = self._area(area_type_id=str(self.parking.id), **link)
                self.assertEqual(r.status_code, 400)
                self.assertIn("area_type_id", r.json())
        area = FloorPlanArea.objects.create(floor_plan=self.plan, room=self.room)
        r = self.client.patch(f"/api/floor-plan-areas/{area.id}/",
                              {"area_type_id": str(self.parking.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_linking_drops_the_type(self):
        area = FloorPlanArea.objects.create(floor_plan=self.plan, area_type=self.parking)
        r = self.client.patch(f"/api/floor-plan-areas/{area.id}/",
                              {"room_id": str(self.room.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["area_type"])
        area.refresh_from_db()
        self.assertIsNone(area.area_type_id)

    def test_bulk_save_writes_the_type(self):
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {
            "areas": {"create": [{"x": 0, "y": 0, "width": 5, "height": 5,
                                  "area_type_id": str(self.parking.id)}]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["areas"][0]["area_type"]["name"], "Parking")
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/bulk/", {
            "areas": {"create": [{"x": 0, "y": 0, "width": 5, "height": 5,
                                  "area_type_id": str(self.theirs.id)}]},
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_contents_and_clone_carry_the_type(self):
        FloorPlanArea.objects.create(floor_plan=self.plan, area_type=self.parking)
        body = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/").json()
        self.assertEqual(body["areas"][0]["area_type"]["pattern"], "hatched")
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/clone/",
                             {"name": "Copy"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlanArea.objects.get(floor_plan_id=r.json()["id"])
        self.assertEqual(copy.area_type_id, self.parking.id)
