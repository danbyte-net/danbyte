"""Site-wide floor plans: a floor plan and its floors name a site, and the
location is optional. The 0231 backfill, creating and listing site-wide
plans, the location-in-site rule, older clients that send only a location,
site scope, area links and placement across the site, and snapshots."""

from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from auth_api.site_paths import SITE_PATHS
from core.models import Organization, Tenant

from .models import (
    Device,
    FloorPlan,
    FloorPlanStack,
    FloorPlanTile,
    FloorTileType,
    Location,
    Rack,
    Room,
    Site,
)

MIG = importlib.import_module("api.migrations.0231_floor_plan_site")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Campus")
        self.site2 = Site.objects.create(tenant=self.tenant, name="Branch")
        self.bldg_a = Location.objects.create(tenant=self.tenant, site=self.site,
                                              name="Building A", slug="building-a")
        self.bldg_b = Location.objects.create(tenant=self.tenant, site=self.site,
                                              name="Building B", slug="building-b")
        self.level = Location.objects.create(tenant=self.tenant, site=self.site,
                                             name="Level 1", slug="level-1",
                                             parent=self.bldg_a)
        self.annex = Location.objects.create(tenant=self.tenant, site=self.site2,
                                             name="Annex", slug="annex")
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _user(self, name, types, actions, sites=None):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=list(types), actions=actions
        )
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _site_wide(self, name="Campus map", site=None):
        r = self.client.post("/api/floor-plans/", {
            "name": name, "site_id": str((site or self.site).id),
            "grid_width": 40, "grid_height": 20,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return FloorPlan.objects.get(pk=r.data["id"])


class BackfillTests(_Base):
    def test_every_plan_and_stack_gets_its_locations_site(self):
        a = FloorPlan.objects.create(tenant=self.tenant, location=self.level, name="L1")
        b = FloorPlan.objects.create(tenant=self.tenant, location=self.annex, name="Annex")
        # As the rows stood before 0231: no site.
        FloorPlan.objects.update(site=None)
        FloorPlanStack.objects.update(site=None)
        MIG.backfill_site(django_apps, None)
        MIG.backfill_site(django_apps, None)  # a second run changes nothing
        for plan, site in ((a, self.site), (b, self.site2)):
            plan.refresh_from_db()
            self.assertEqual(plan.site_id, site.pk)
            self.assertEqual(plan.stack.site_id, site.pk)
            self.assertEqual(plan.location.site_id, plan.site_id)

    def test_orm_callers_naming_only_a_location_get_its_site(self):
        plan = FloorPlan.objects.create(tenant=self.tenant, location=self.bldg_b, name="B")
        self.assertEqual(plan.site_id, self.site.pk)
        self.assertEqual(plan.stack.site_id, self.site.pk)
        self.assertEqual(plan.stack.location_id, self.bldg_b.pk)

    def test_site_paths_key_on_the_plans_site(self):
        self.assertEqual(SITE_PATHS["floorplan"], "site|location__site")
        self.assertEqual(SITE_PATHS["floorplanstack"], "site|location__site")
        for slug in ("floorplantile", "floorplandrawing", "floorplantray",
                     "floorplanraisedfloorarea", "floorplanwall", "floorplanarea",
                     "floorplanlabel"):
            self.assertEqual(SITE_PATHS[slug],
                             "floor_plan__site|floor_plan__location__site", slug)


class CreateAndListTests(_Base):
    def test_a_site_wide_plan(self):
        plan = self._site_wide()
        self.assertIsNone(plan.location_id)
        self.assertEqual(plan.site_id, self.site.pk)
        self.assertIsNone(plan.stack.location_id)
        self.assertEqual(plan.stack.site_id, self.site.pk)
        r = self.client.get(f"/api/floor-plans/{plan.id}/")
        self.assertIsNone(r.data["location"])
        self.assertEqual(r.data["site"]["id"], str(self.site.pk))
        r = self.client.get(f"/api/floor-plan-stacks/{plan.stack_id}/")
        self.assertIsNone(r.data["location"])
        self.assertEqual(r.data["site"]["name"], "Campus")
        self.assertIsNone(r.data["floors"][0]["location_id"])

    def test_a_site_wide_stack(self):
        r = self.client.post("/api/floor-plan-stacks/", {
            "name": "Campus", "site_id": str(self.site.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        stack = FloorPlanStack.objects.get(pk=r.data["id"])
        self.assertIsNone(stack.location_id)
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/floors/",
                             {"name": "Ground"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        floor = FloorPlan.objects.get(pk=r.data["id"])
        self.assertIsNone(floor.location_id)
        self.assertEqual(floor.site_id, self.site.pk)

    def test_names_are_unique_per_site_when_site_wide(self):
        self._site_wide("Campus map")
        r = self.client.post("/api/floor-plans/", {
            "name": "Campus map", "site_id": str(self.site.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("site-wide", str(r.data["name"]))
        # Another site, or a location of this one, may use the name.
        self._site_wide("Campus map", site=self.site2)
        r = self.client.post("/api/floor-plans/", {
            "name": "Campus map", "site_id": str(self.site.id),
            "location_id": str(self.bldg_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_site_or_a_location_is_needed(self):
        r = self.client.post("/api/floor-plans/", {"name": "Nowhere"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_id", r.data)
        r = self.client.post("/api/floor-plan-stacks/", {"name": "Nowhere"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_id", r.data)

    def test_the_location_must_be_at_the_site(self):
        for url in ("/api/floor-plans/", "/api/floor-plan-stacks/"):
            r = self.client.post(url, {
                "name": "Wrong", "site_id": str(self.site.id),
                "location_id": str(self.annex.id),
            }, format="json")
            self.assertEqual(r.status_code, 400, url)
            self.assertIn("location_id", r.data)
        self.assertFalse(FloorPlan.objects.filter(name="Wrong").exists())

    def test_old_clients_send_only_a_location(self):
        r = self.client.post("/api/floor-plans/", {
            "name": "Hall", "location_id": str(self.bldg_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data["site"]["id"], str(self.site.pk))
        self.assertEqual(r.data["location"]["id"], str(self.bldg_a.pk))
        r = self.client.post("/api/floor-plan-stacks/", {
            "name": "Annex hall", "location_id": str(self.annex.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(FloorPlanStack.objects.get(pk=r.data["id"]).site_id, self.site2.pk)

    def test_a_plan_stays_at_its_site(self):
        plan = self._site_wide()
        r = self.client.patch(f"/api/floor-plans/{plan.id}/",
                              {"site_id": str(self.site2.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/floor-plan-stacks/{plan.stack_id}/",
                              {"site_id": str(self.site2.id)}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_filters(self):
        wide = self._site_wide()
        bound = FloorPlan.objects.create(tenant=self.tenant, location=self.bldg_a, name="A")
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.annex, name="X")
        r = self.client.get(f"/api/floor-plans/?site={self.site.id}")
        ids = {row["id"] for row in r.data["results"]}
        self.assertEqual(ids, {str(wide.pk), str(bound.pk)})
        r = self.client.get(f"/api/floor-plan-stacks/?site={self.site.id}")
        ids = {row["id"] for row in r.data["results"]}
        self.assertEqual(ids, {str(wide.stack_id), str(bound.stack_id)})
        self.assertNotIn(str(other.stack_id), ids)
        r = self.client.get(f"/api/floor-plan-stacks/?site={self.site.id}&site_wide=1")
        self.assertEqual([row["id"] for row in r.data["results"]], [str(wide.stack_id)])

    def test_floors_of_a_site_wide_stack_may_name_any_location_of_the_site(self):
        plan = self._site_wide()
        r = self.client.patch(f"/api/floor-plans/{plan.id}/",
                              {"location_id": str(self.bldg_b.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"/api/floor-plans/{plan.id}/",
                              {"location_id": str(self.annex.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/floor-plans/{plan.id}/",
                              {"location_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_stack_bound_to_a_location_keeps_its_floors_inside_it(self):
        plan = self._site_wide()
        # The site-wide floor would fall outside Building A.
        r = self.client.patch(f"/api/floor-plan-stacks/{plan.stack_id}/",
                              {"location_id": str(self.bldg_a.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("location_id", r.data)
        # A located stack may go site-wide; its floors keep their locations.
        bound = FloorPlan.objects.create(tenant=self.tenant, location=self.level, name="L")
        r = self.client.patch(f"/api/floor-plan-stacks/{bound.stack_id}/",
                              {"location_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        bound.refresh_from_db()
        self.assertEqual(bound.location_id, self.level.pk)
        self.assertIsNone(bound.stack.location_id)

    def test_moving_a_site_wide_floor_into_a_located_floor_plan(self):
        plan = self._site_wide()
        target = FloorPlanStack.objects.create(tenant=self.tenant, location=self.bldg_a,
                                               name="A")
        FloorPlan.objects.create(tenant=self.tenant, location=self.bldg_a, stack=target,
                                 name="Ground")
        r = self.client.post(f"/api/floor-plans/{plan.id}/move/",
                             {"stack_id": str(target.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        plan.refresh_from_db()
        self.assertEqual(plan.location_id, self.bldg_a.pk)
        self.assertEqual(plan.stack_id, target.pk)

    def test_deleting_the_site_takes_its_plans(self):
        plan = self._site_wide(site=self.site2)
        stack_id = plan.stack_id
        self.site2.delete()
        self.assertFalse(FloorPlan.objects.filter(pk=plan.pk).exists())
        self.assertFalse(FloorPlanStack.objects.filter(pk=stack_id).exists())


class SiteScopeTests(_Base):
    def test_a_site_scoped_user_sees_site_wide_plans_of_their_sites_only(self):
        mine = self._site_wide("Campus map")
        theirs = self._site_wide("Branch map", site=self.site2)
        tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        FloorPlanTile.objects.create(floor_plan=theirs, tile_type=tt, x=0, y=0)
        u = self._user("viewer", ("floorplan", "floorplantile"), ["view"], sites=[self.site])
        self._login(u)
        r = self.client.get("/api/floor-plans/")
        self.assertEqual([row["id"] for row in r.data["results"]], [str(mine.pk)])
        r = self.client.get("/api/floor-plan-stacks/")
        self.assertEqual([row["id"] for row in r.data["results"]], [str(mine.stack_id)])
        self.assertEqual(self.client.get(f"/api/floor-plans/{theirs.id}/").status_code, 404)
        r = self.client.get(f"/api/floor-plan-tiles/?floor_plan={theirs.id}")
        self.assertEqual(r.data["count"] if "count" in r.data else len(r.data), 0)

    def test_a_site_scoped_editor_creates_site_wide_plans_only_at_their_sites(self):
        u = self._user("editor", ("floorplan",), ["view", "add", "change"],
                       sites=[self.site])
        self._login(u)
        r = self.client.post("/api/floor-plans/", {
            "name": "Mine", "site_id": str(self.site.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post("/api/floor-plans/", {
            "name": "Theirs", "site_id": str(self.site2.id),
        }, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(FloorPlan.objects.filter(name="Theirs").exists())


class AcrossTheSiteTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = self._site_wide()
        self.room_a = Room.objects.create(tenant=self.tenant, location=self.level,
                                          name="Room A1", slug="room-a1")
        self.room_b = Room.objects.create(tenant=self.tenant, location=self.bldg_b,
                                          name="Room B1", slug="room-b1")
        self.room_x = Room.objects.create(tenant=self.tenant, location=self.annex,
                                          name="Annex room", slug="annex-room")

    def _area(self, **link):
        return self.client.post("/api/floor-plan-areas/", {
            "floor_plan_id": str(self.plan.id), "x": 1, "y": 1, "width": 4, "height": 3,
            **link,
        }, format="json")

    def test_areas_link_rooms_and_locations_anywhere_in_the_site(self):
        for link in ({"room_id": str(self.room_a.id)}, {"room_id": str(self.room_b.id)},
                     {"location_id": str(self.bldg_b.id)},
                     {"location_id": str(self.level.id)}):
            r = self._area(**link)
            self.assertEqual(r.status_code, 201, (link, r.content))
        r = self._area(room_id=str(self.room_x.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("site", str(r.data["room_id"]))
        r = self._area(location_id=str(self.annex.id))
        self.assertEqual(r.status_code, 400)

    def test_placement_spans_the_site_ranked_by_the_room_under_the_pointer(self):
        near = Rack.objects.create(tenant=self.tenant, name="R-A1", site=self.site,
                                   location=self.level, room=self.room_a)
        same_bldg = Rack.objects.create(tenant=self.tenant, name="R-A", site=self.site,
                                        location=self.bldg_a)
        other_bldg = Device.objects.create(tenant=self.tenant, name="sw-b", site=self.site,
                                           location=self.bldg_b)
        branch = Device.objects.create(tenant=self.tenant, name="sw-x", site=self.site2,
                                       location=self.annex)
        url = f"/api/floor-plans/{self.plan.id}/placeable/"
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        ranks = {row["id"]: row["rank"] for row in r.data["results"]}
        self.assertNotIn(str(branch.pk), ranks)
        self.assertEqual({ranks[str(o.pk)] for o in (near, same_bldg, other_bldg)}, {2})
        # The room under the pointer, then its building, then the site.
        r = self.client.get(f"{url}?near_room={self.room_a.id}")
        ranks = {row["id"]: row["rank"] for row in r.data["results"]}
        self.assertEqual(ranks[str(near.pk)], 0)
        self.assertEqual(ranks[str(other_bldg.pk)], 2)
        r = self.client.get(f"{url}?near_location={self.bldg_a.id}")
        ranks = {row["id"]: row["rank"] for row in r.data["results"]}
        self.assertEqual(ranks[str(near.pk)], 0)
        self.assertEqual(ranks[str(same_bldg.pk)], 0)
        self.assertEqual(ranks[str(other_bldg.pk)], 2)
        # Unplaced: the whole site's objects that stand on no plan.
        r = self.client.get(f"{url}?unplaced=1")
        ids = {row["id"] for row in r.data["results"]}
        self.assertEqual(ids, {str(near.pk), str(same_bldg.pk), str(other_bldg.pk)})

    def test_rank_one_is_the_near_rooms_building(self):
        in_bldg = Rack.objects.create(tenant=self.tenant, name="R-L", site=self.site,
                                      location=self.bldg_a)
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/placeable/?near_room={self.room_a.id}"
        )
        ranks = {row["id"]: row["rank"] for row in r.data["results"]}
        # Room A1 is in Level 1; the floor ranks Level 1 and what is inside it.
        self.assertEqual(ranks[str(in_bldg.pk)], 2)
        on_level = Rack.objects.create(tenant=self.tenant, name="R-L1", site=self.site,
                                       location=self.level)
        r = self.client.get(
            f"/api/floor-plans/{self.plan.id}/placeable/?near_room={self.room_a.id}"
        )
        ranks = {row["id"]: row["rank"] for row in r.data["results"]}
        self.assertEqual(ranks[str(on_level.pk)], 1)

    def test_room_pickers_list_the_sites_rooms(self):
        r = self.client.get(f"/api/rooms/?picker=1&site={self.site.id}")
        names = {row["name"] for row in (r.data["results"] if "results" in r.data
                                         else r.data)}
        self.assertEqual(names, {"Room A1", "Room B1"})


class SnapshotTests(_Base):
    def test_a_snapshot_of_a_site_wide_plan_is_site_wide(self):
        plan = self._site_wide()
        for mode, name in (("copy", "North copy"), ("view", "North view")):
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(f"/api/floor-plans/{plan.id}/snapshot/", {
                    "name": name, "mode": mode, "target": "plan",
                    "crop": {"x": 0, "y": 0, "w": 10, "h": 10},
                }, format="json")
            self.assertEqual(r.status_code, 201, r.content)
            snap = FloorPlan.objects.get(pk=r.data["id"])
            self.assertIsNone(snap.location_id)
            self.assertEqual(snap.site_id, self.site.pk)
            self.assertIsNone(snap.stack.location_id)
            self.assertEqual(snap.stack.site_id, self.site.pk)
        # A second site-wide floor plan of that name is refused.
        r = self.client.post(f"/api/floor-plans/{plan.id}/snapshot/", {
            "name": "North copy", "mode": "copy", "target": "plan",
            "crop": {"x": 0, "y": 0, "w": 10, "h": 10},
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_clone_of_a_site_wide_plan_is_site_wide(self):
        plan = self._site_wide()
        r = self.client.post(f"/api/floor-plans/{plan.id}/clone/", {}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        dst = FloorPlan.objects.get(pk=r.data["id"])
        self.assertIsNone(dst.location_id)
        self.assertEqual(dst.site_id, self.site.pk)
        self.assertEqual(dst.name, "Campus map copy")
