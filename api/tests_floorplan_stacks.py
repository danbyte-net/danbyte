"""Floors (floor plans P1a): a FloorPlanStack is a floor plan as users see it,
each FloorPlan one of its floors. The migration that groups existing plans,
adding, renaming, ordering, moving, splitting, merging and deleting floors,
tenancy and site scope, and the registries the stack joins."""

from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from auth_api.object_types import is_registered
from auth_api.site_paths import SITE_PATHS, site_role_types
from core.models import Organization, Tenant

from .models import (
    FloorPlan,
    FloorPlanStack,
    FloorPlanTile,
    FloorTileType,
    Location,
    SearchEntry,
    Site,
)

MIG = importlib.import_module("api.migrations.0226_floor_plan_stacks")
SITE_VIEW = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
ROLES = importlib.import_module("auth_api.migrations.0044_site_roles_floor_plan_stacks")


class StackTestCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.site2 = Site.objects.create(tenant=self.tenant, name="Branch")
        self.bldg = Location.objects.create(tenant=self.tenant, site=self.site,
                                            name="Building A", slug="building-a")
        self.level2 = Location.objects.create(tenant=self.tenant, site=self.site,
                                              name="Level 2", slug="level-2", parent=self.bldg)
        self.other_bldg = Location.objects.create(tenant=self.tenant, site=self.site,
                                                  name="Building B", slug="building-b")
        self.annex = Location.objects.create(tenant=self.tenant, site=self.site2,
                                             name="Annex", slug="annex")
        org2 = Organization.objects.create(name="Evil", slug="evil")
        self.tenant2 = Tenant.objects.create(org=org2, name="Evil", slug="evil")
        their_site = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.their_loc = Location.objects.create(tenant=self.tenant2, site=their_site,
                                                 name="Theirs", slug="theirs")
        self.their_stack = FloorPlanStack.objects.create(
            tenant=self.tenant2, location=self.their_loc, name="Their hall")
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _limited_user(self, name, actions, sites=None, types=("floorplan",)):
        u = User.objects.create_user(name, password="x")
        prof = UserProfile.objects.create(user=u, role="custom")
        prof.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"{name}-grant", object_types=list(types), actions=actions
        )
        if sites:
            perm.sites.set(sites)
        perm.users.add(u)
        return u

    def _stack(self, name="HQ hall", location=None, floors=("Ground", "1")):
        stack = FloorPlanStack.objects.create(
            tenant=self.tenant, location=location or self.bldg, name=name)
        for i, f in enumerate(floors):
            FloorPlan.objects.create(tenant=self.tenant, location=stack.location,
                                     stack=stack, name=f, floor_order=i * 10)
        return stack

    def _names(self, stack):
        return list(FloorPlan.objects.filter(stack=stack)
                    .order_by("floor_order", "name").values_list("name", flat=True))


class MigrationGroupingTests(StackTestCase):
    """0226 groups the plans of each location into one stack, in the order
    the switcher showed them, and touches nothing else."""

    def _unstacked(self, location, name, **extra):
        plan = FloorPlan.objects.create(tenant=self.tenant, location=location, name=name,
                                        **extra)
        stack = plan.stack
        FloorPlan.objects.filter(pk=plan.pk).update(stack=None, floor_order=0)
        stack.delete()
        plan.refresh_from_db()
        return plan

    def test_plans_are_grouped_per_location_without_loss(self):
        ft = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        b = [self._unstacked(self.bldg, n) for n in ("Floor 10", "Basement", "Floor 2")]
        FloorPlanTile.objects.create(floor_plan=b[0], tile_type=ft, x=1, y=1)
        lone = self._unstacked(self.other_bldg, "Hall B", grid_width=40)
        annex = self._unstacked(self.annex, "Annex floor")
        before = FloorPlan.objects.count()

        MIG.group_plans_into_stacks(django_apps, None)
        MIG.group_plans_into_stacks(django_apps, None)  # a second run is a no-op

        self.assertEqual(FloorPlan.objects.count(), before)
        self.assertFalse(FloorPlan.objects.filter(stack__isnull=True).exists())
        self.assertEqual(FloorPlanStack.objects.filter(tenant=self.tenant).count(), 3)
        bldg_stack = FloorPlanStack.objects.get(location=self.bldg)
        # Several plans: the location's name; natural name order, as the
        # switcher listed them.
        self.assertEqual(bldg_stack.name, "Building A")
        self.assertEqual(self._names(bldg_stack), ["Basement", "Floor 2", "Floor 10"])
        self.assertEqual(
            list(FloorPlan.objects.filter(stack=bldg_stack).order_by("floor_order")
                 .values_list("floor_order", flat=True)), [0, 10, 20])
        # One plan: the stack keeps the plan's name, so the list reads the same.
        lone.refresh_from_db()
        self.assertEqual((lone.stack.name, lone.name, lone.grid_width),
                         ("Hall B", "Hall B", 40))
        annex.refresh_from_db()
        self.assertEqual(annex.stack.location, self.annex)
        self.assertEqual(FloorPlanTile.objects.filter(floor_plan=b[0]).count(), 1)


class StackApiTests(StackTestCase):
    def test_a_new_plan_without_a_stack_is_a_floor_plan_of_its_own(self):
        r = self.client.post("/api/floor-plans/", {
            "name": "Server room", "location_id": str(self.bldg.id),
            "description": "Main DC",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        stack = FloorPlanStack.objects.get(pk=body["stack"]["id"])
        self.assertEqual((stack.name, stack.location, stack.description),
                         ("Server room", self.bldg, "Main DC"))
        self.assertEqual(body["floor_order"], 0)
        # The same name again at that location is refused, as before.
        r = self.client.post("/api/floor-plans/", {
            "name": "Server room", "location_id": str(self.bldg.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("name", r.json())

    def test_the_list_shows_stacks_with_their_floors_in_order(self):
        stack = self._stack(floors=("2", "B1", "Ground"))
        FloorPlan.objects.filter(stack=stack, name="B1").update(floor_order=-10)
        self._stack(name="Hall B", location=self.other_bldg, floors=("1",))
        rows = self.client.get("/api/floor-plan-stacks/").json()["results"]
        self.assertEqual([(r["name"], r["floor_count"]) for r in rows],
                         [("Hall B", 1), ("HQ hall", 3)])
        hq = rows[1]
        self.assertEqual([f["name"] for f in hq["floors"]], ["B1", "2", "Ground"])
        self.assertEqual(hq["site"]["id"], str(self.site.id))
        # ?stack= lists one stack's floors in floor order.
        floors = self.client.get(f"/api/floor-plans/?stack={stack.id}").json()["results"]
        self.assertEqual([f["name"] for f in floors], ["B1", "2", "Ground"])
        self.assertEqual(floors[0]["stack"], {"id": str(stack.id), "name": "HQ hall"})
        # The picker names each floor's floor plan.
        picks = self.client.get("/api/floor-plans/?picker=1").json()["results"]
        self.assertEqual([p["stack_name"] for p in picks if p["name"] == "B1"], ["HQ hall"])
        # Search matches a floor's name too.
        rows = self.client.get("/api/floor-plan-stacks/?search=ground").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["HQ hall"])

    def test_add_a_floor(self):
        stack = self._stack()
        ground = FloorPlan.objects.get(stack=stack, name="Ground")
        FloorPlan.objects.filter(pk=ground.pk).update(grid_width=60, cell_mm=500)
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/floors/",
                             {"name": "Basement", "position": 0,
                              "copy_from": str(ground.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["grid_width"], r.json()["cell_mm"]), (60, 500))
        self.assertEqual(self._names(stack), ["Basement", "Ground", "1"])
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/floors/",
                             {"name": "Roof"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._names(stack)[-1], "Roof")
        # A name the stack already has is refused.
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/floors/",
                             {"name": "Roof"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["name"],
                         ["This floor plan already has a floor with that name."])

    def test_two_stacks_at_one_location_may_both_have_a_floor_1(self):
        a = self._stack(name="East", floors=("1",))
        b = self._stack(name="West", floors=())
        r = self.client.post(f"/api/floor-plan-stacks/{b.id}/floors/", {"name": "1"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(FloorPlan.objects.filter(location=self.bldg, name="1").count(), 2)
        self.assertEqual(self._names(a), ["1"])

    def test_rename_a_floor(self):
        stack = self._stack()
        one = FloorPlan.objects.get(stack=stack, name="1")
        r = self.client.patch(f"/api/floor-plans/{one.id}/", {"name": "First"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"/api/floor-plans/{one.id}/", {"name": "Ground"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_reorder(self):
        stack = self._stack(floors=("A", "B", "C"))
        ids = {p.name: str(p.id) for p in FloorPlan.objects.filter(stack=stack)}
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/reorder/",
                             {"order": [ids["C"], ids["A"], ids["B"]]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([f["name"] for f in r.json()["floors"]], ["C", "A", "B"])
        self.assertEqual(self._names(stack), ["C", "A", "B"])
        # Every floor, once.
        r = self.client.post(f"/api/floor-plan-stacks/{stack.id}/reorder/",
                             {"order": [ids["C"], ids["A"]]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_move_a_floor_to_another_stack_at_the_site(self):
        a = self._stack(name="A", floors=("1", "2"))
        b = self._stack(name="B", location=self.other_bldg, floors=("1",))
        two = FloorPlan.objects.get(stack=a, name="2")
        r = self.client.post(f"/api/floor-plans/{two.id}/move/", {"stack_id": str(b.id)},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        two.refresh_from_db()
        self.assertEqual((two.stack, two.location), (b, self.other_bldg))
        self.assertEqual(self._names(b), ["1", "2"])
        # A clashing name is refused; the last floor out takes its stack along.
        one = FloorPlan.objects.get(stack=a, name="1")
        r = self.client.post(f"/api/floor-plans/{one.id}/move/", {"stack_id": str(b.id)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        FloorPlan.objects.filter(pk=one.pk).update(name="Mezzanine")
        r = self.client.post(f"/api/floor-plans/{one.id}/move/", {"stack_id": str(b.id)},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(FloorPlanStack.objects.filter(pk=a.pk).exists())

    def test_a_floor_may_sit_at_a_child_location_and_keeps_it_when_moved_inside(self):
        stack = self._stack(floors=("1",))
        r = self.client.post("/api/floor-plans/", {
            "name": "2", "stack_id": str(stack.id), "location_id": str(self.level2.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["location"]["id"], str(self.level2.id))
        # Not a location outside the stack's, nor one at another site.
        for loc in (self.other_bldg, self.annex):
            r = self.client.post("/api/floor-plans/", {
                "name": f"x{loc.name}", "stack_id": str(stack.id), "location_id": str(loc.id),
            }, format="json")
            self.assertEqual(r.status_code, 400, loc.name)

    def test_move_and_merge_refuse_another_site(self):
        a = self._stack(name="A", floors=("1", "2"))
        far = self._stack(name="Far", location=self.annex, floors=("9",))
        two = FloorPlan.objects.get(stack=a, name="2")
        r = self.client.post(f"/api/floor-plans/{two.id}/move/", {"stack_id": str(far.id)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/api/floor-plan-stacks/{a.id}/merge/",
                             {"stacks": [str(far.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self._names(far), ["9"])

    def test_split_a_floor_into_its_own_stack(self):
        a = self._stack(floors=("1", "2"))
        two = FloorPlan.objects.get(stack=a, name="2")
        r = self.client.post(f"/api/floor-plans/{two.id}/split/", {}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        two.refresh_from_db()
        self.assertEqual(r.json()["id"], str(two.stack_id))
        self.assertEqual((two.stack.name, two.stack.location), ("2", self.bldg))
        self.assertEqual(self._names(a), ["1"])
        # The last floor is already a floor plan of its own.
        one = FloorPlan.objects.get(stack=a)
        r = self.client.post(f"/api/floor-plans/{one.id}/split/", {}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_merge_moves_floors_and_lists_clashes(self):
        a = self._stack(name="A", floors=("1", "2"))
        b = self._stack(name="B", location=self.other_bldg, floors=("2", "3"))
        c = self._stack(name="C", floors=("4",))
        r = self.client.post(f"/api/floor-plan-stacks/{a.id}/merge/",
                             {"stacks": [str(b.id), str(c.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["clashes"], ["B · 2"])
        self.assertTrue(FloorPlanStack.objects.filter(pk=b.pk).exists())
        FloorPlan.objects.filter(stack=b, name="2").update(name="2b")
        r = self.client.post(f"/api/floor-plan-stacks/{a.id}/merge/",
                             {"stacks": [str(b.id), str(c.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([f["name"] for f in r.json()["floors"]], ["1", "2", "2b", "3", "4"])
        self.assertFalse(FloorPlanStack.objects.filter(pk__in=[b.pk, c.pk]).exists())
        # Floors from Building B now sit at Building A.
        self.assertFalse(FloorPlan.objects.filter(location=self.other_bldg).exists())

    def test_delete_a_floor_and_the_last_one_takes_the_stack(self):
        a = self._stack(floors=("1", "2"))
        one, two = FloorPlan.objects.filter(stack=a).order_by("floor_order")
        self.assertEqual(self.client.delete(f"/api/floor-plans/{one.id}/").status_code, 204)
        self.assertTrue(FloorPlanStack.objects.filter(pk=a.pk).exists())
        self.assertEqual(self.client.delete(f"/api/floor-plans/{two.id}/").status_code, 204)
        self.assertFalse(FloorPlanStack.objects.filter(pk=a.pk).exists())

    def test_deleting_a_stack_deletes_its_floors(self):
        a = self._stack(floors=("1", "2"))
        self.assertEqual(self.client.delete(f"/api/floor-plan-stacks/{a.id}/").status_code, 204)
        self.assertFalse(FloorPlan.objects.filter(location=self.bldg).exists())

    def test_rename_a_stack_and_its_name_is_unique_per_location(self):
        a = self._stack(name="A")
        self._stack(name="B")
        r = self.client.patch(f"/api/floor-plan-stacks/{a.id}/", {"name": "B"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/floor-plan-stacks/{a.id}/", {"name": "Hall A"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_clone_lands_in_a_stack_of_its_own(self):
        a = self._stack(floors=("1", "2"))
        two = FloorPlan.objects.get(stack=a, name="2")
        r = self.client.post(f"/api/floor-plans/{two.id}/clone/")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertEqual(copy.name, "2 copy")
        self.assertNotEqual(copy.stack_id, a.pk)
        self.assertEqual(copy.stack.name, "2 copy")
        self.assertEqual(self._names(a), ["1", "2"])

    def test_changes_are_logged_and_searchable(self):
        r = self.client.post("/api/floor-plan-stacks/", {
            "name": "Hall", "location_id": str(self.bldg.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        sid = r.json()["id"]
        self.client.patch(f"/api/floor-plan-stacks/{sid}/", {"description": "x"},
                          format="json")
        actions = list(ChangeLogEntry.objects.filter(
            object_type="api.floorplanstack", object_id=sid
        ).order_by("timestamp").values_list("action", flat=True))
        self.assertEqual(actions, ["create", "update"])
        entry = SearchEntry.objects.get(object_type="floorplanstack", object_id=sid)
        self.assertEqual(entry.url, f"/floorplans/stacks/{sid}")
        self.assertEqual(entry.site_id, self.site.id)


class StackTenancyTests(StackTestCase):
    def test_another_tenants_stacks_are_invisible_and_unusable(self):
        mine = self._stack(floors=("1", "2"))
        rows = self.client.get("/api/floor-plan-stacks/").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["HQ hall"])
        sid = self.their_stack.id
        self.assertEqual(self.client.get(f"/api/floor-plan-stacks/{sid}/").status_code, 404)
        r = self.client.post(f"/api/floor-plan-stacks/{sid}/floors/", {"name": "x"},
                             format="json")
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/api/floor-plans/", {"name": "x", "stack_id": str(sid)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        one = FloorPlan.objects.get(stack=mine, name="1")
        r = self.client.post(f"/api/floor-plans/{one.id}/move/", {"stack_id": str(sid)},
                             format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/api/floor-plan-stacks/{mine.id}/merge/",
                             {"stacks": [str(sid)]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/floor-plan-stacks/", {
            "name": "x", "location_id": str(self.their_loc.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(FloorPlan.objects.filter(stack=self.their_stack).count(), 0)


class StackSiteScopeTests(StackTestCase):
    def test_a_site_scoped_user_sees_and_writes_only_their_sites_stacks(self):
        hq = self._stack(floors=("1",))
        far = self._stack(name="Far", location=self.annex, floors=("1",))
        u = self._limited_user("hq", ["view", "add", "change", "delete"], sites=[self.site])
        self._login(u)
        rows = self.client.get("/api/floor-plan-stacks/").json()["results"]
        self.assertEqual([r["name"] for r in rows], ["HQ hall"])
        r = self.client.post(f"/api/floor-plan-stacks/{hq.id}/floors/", {"name": "2"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post(f"/api/floor-plan-stacks/{far.id}/floors/", {"name": "2"},
                             format="json")
        self.assertEqual(r.status_code, 404)
        r = self.client.post(f"/api/floor-plan-stacks/{far.id}/reorder/",
                             {"order": []}, format="json")
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/api/floor-plan-stacks/", {
            "name": "Elsewhere", "location_id": str(self.annex.id)}, format="json")
        self.assertIn(r.status_code, (400, 403))
        self.assertFalse(FloorPlanStack.objects.filter(name="Elsewhere").exists())
        self.assertEqual(self.client.delete(f"/api/floor-plan-stacks/{far.id}/").status_code,
                         404)

    def test_a_viewer_cannot_change_floors(self):
        hq = self._stack(floors=("1", "2"))
        self._login(self._limited_user("viewer", ["view"]))
        self.assertEqual(self.client.get("/api/floor-plan-stacks/").status_code, 200)
        ids = [str(p.id) for p in FloorPlan.objects.filter(stack=hq)]
        for path, body in (
            (f"/api/floor-plan-stacks/{hq.id}/floors/", {"name": "3"}),
            (f"/api/floor-plan-stacks/{hq.id}/reorder/", {"order": ids[::-1]}),
            (f"/api/floor-plans/{ids[0]}/split/", {}),
        ):
            self.assertEqual(self.client.post(path, body, format="json").status_code, 403,
                             path)
        self.assertEqual(self.client.delete(f"/api/floor-plan-stacks/{hq.id}/").status_code,
                         403)

    def test_without_a_floorplan_grant_nothing_is_listed(self):
        self._stack()
        self._login(self._limited_user("nobody", ["view"], types=("rack",)))
        self.assertEqual(self.client.get("/api/floor-plan-stacks/").status_code, 403)

    def test_stacks_are_registered_site_bound_and_in_the_site_roles(self):
        self.assertTrue(is_registered("floorplanstack"))
        self.assertEqual(SITE_PATHS["floorplanstack"], "site|location__site")
        self.assertIn("floorplanstack", site_role_types())


class SiteRoleStackUpgradeTests(TestCase):
    """auth_api 0044 gives the site roles built before it the stacks."""

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

    def test_viewer_and_editor_gain_stacks_once_and_hand_built_stay(self):
        types = (set(site_role_types()) & ROLES.KNOWN) - {"floorplanstack"}
        view = self._perm(f"A{SITE_VIEW.VIEW_SUFFIX}", ["view"], types)
        edit = self._perm(f"A{SITE_VIEW.EDIT_SUFFIX}", ["view", "add", "change", "delete"],
                          types)
        custom = self._perm(f"Ops{SITE_VIEW.VIEW_SUFFIX}", ["view"], {"device", "prefix"})
        ROLES.forwards(django_apps, None)
        ROLES.forwards(django_apps, None)
        for perm in (view, edit, custom):
            perm.refresh_from_db()
        self.assertEqual(view.object_types.count("floorplanstack"), 1)
        self.assertEqual(edit.object_types.count("floorplanstack"), 1)
        self.assertEqual(custom.object_types, ["device", "prefix"])
