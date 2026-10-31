"""Opens links, Back buttons and label plates on floor plans.

An area or label may name a floor plan a click opens (``opens``): any plan
of the tenant the writer may view, never its own. A reader who may not view
the target reads it null with ``opens_hidden``, and a save that leaves
``opens_id`` out keeps it. A Site map outline's ``opens`` is the floor its
Open floor plan button opens. ``back-link/`` makes, renames, moves and deletes
the paired label a Back button keeps on the target. A label's ``plate_color``
is a palette token.
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from auth_api.api import assemble_site_role
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import (
    FloorPlan,
    FloorPlanArea,
    FloorPlanLabel,
    FloorPlanStack,
    Location,
    Site,
    SiteMapOutline,
)
from .status_registry import seed_builtin_statuses

User = get_user_model()


class _Fixture(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        seed_builtin_statuses(self.tenant)
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.loc_a = Location.objects.create(
            tenant=self.tenant, site=self.site_a, name="Hall A", slug="hall-a"
        )
        loc_b = Location.objects.create(
            tenant=self.tenant, site=self.site_b, name="Hall B", slug="hall-b"
        )
        self.stack = FloorPlanStack.objects.create(
            tenant=self.tenant, site=self.site_a, name="Campus"
        )
        self.campus = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site_a, name="Site", stack=self.stack
        )
        self.b1 = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site_a, name="B1", stack=self.stack,
            floor_order=-10,
        )
        self.hall = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.loc_a, name="Hall A"
        )
        self.plan_b = FloorPlan.objects.create(
            tenant=self.tenant, site=self.site_b, location=loc_b, name="plan-b"
        )
        org2 = Organization.objects.create(name="E", slug="e")
        self.tenant2 = Tenant.objects.create(org=org2, name="E", slug="e")
        site2 = Site.objects.create(tenant=self.tenant2, name="Theirs")
        self.theirs = FloorPlan.objects.create(
            tenant=self.tenant2, site=site2, name="theirs"
        )
        self.area = FloorPlanArea.objects.create(
            floor_plan=self.campus, x=2, y=2, width=4, height=3
        )
        self.label = FloorPlanLabel.objects.create(
            floor_plan=self.campus, text="Go to B1", x=8, y=1
        )
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def silo_editor(self):
        user = User.objects.create_user("ed-a", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "editor", [self.site_a], user_ids=[user.id],
                           silo=True)
        return user

    def patch_area(self, body, area=None):
        return self.client.patch(
            f"/api/floor-plan-areas/{(area or self.area).id}/", body, format="json"
        )

    def contents(self, plan=None):
        r = self.client.get(f"/api/floor-plans/{(plan or self.campus).id}/contents/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class OpensWriteTests(_Fixture):
    def test_area_opens_another_floor(self):
        r = self.patch_area({"opens_id": str(self.b1.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["opens"], {
            "id": str(self.b1.id), "name": "B1", "stack_name": "Campus",
            "kind": "plan", "can_change": True,
        })
        self.assertFalse(r.json()["opens_hidden"])
        self.area.refresh_from_db()
        self.assertEqual(self.area.opens_id, self.b1.id)
        # Cleared with null.
        r = self.patch_area({"opens_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["opens"])

    def test_label_opens_through_bulk(self):
        r = self.client.post(f"/api/floor-plans/{self.campus.id}/bulk/", {
            "labels": {"update": [{"id": str(self.label.id), "opens_id": str(self.hall.id)}]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        row = next(lb for lb in r.json()["labels"] if lb["id"] == str(self.label.id))
        self.assertEqual(row["opens"]["id"], str(self.hall.id))

    def test_another_tenants_plan_is_refused(self):
        r = self.patch_area({"opens_id": str(self.theirs.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.area.refresh_from_db()
        self.assertIsNone(self.area.opens_id)

    def test_own_plan_is_refused(self):
        r = self.patch_area({"opens_id": str(self.campus.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("opens_id", r.json())

    def test_a_plan_the_writer_may_not_view_is_refused(self):
        self.login(self.silo_editor())
        r = self.patch_area({"opens_id": str(self.plan_b.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("opens_id", r.json())
        r = self.patch_area({"opens_id": str(self.hall.id)})
        self.assertEqual(r.status_code, 200, r.content)


class OpensReadTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.area.opens = self.plan_b
        self.area.save()
        self.label.opens = self.b1
        self.label.save()

    def test_hidden_target_is_masked(self):
        self.login(self.silo_editor())
        data = self.contents()
        area = next(a for a in data["areas"] if a["id"] == str(self.area.id))
        self.assertIsNone(area["opens"])
        self.assertTrue(area["opens_hidden"])
        self.assertNotIn("plan-b", str(data))
        self.assertNotIn(str(self.plan_b.id), str(data))
        label = next(lb for lb in data["labels"] if lb["id"] == str(self.label.id))
        self.assertEqual(label["opens"]["name"], "B1")
        self.assertFalse(label["opens_hidden"])

    def test_a_save_without_opens_keeps_the_hidden_target(self):
        self.login(self.silo_editor())
        r = self.client.post(f"/api/floor-plans/{self.campus.id}/bulk/", {
            "areas": {"update": [{"id": str(self.area.id), "label": "Yard"}]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.area.refresh_from_db()
        self.assertEqual(self.area.opens_id, self.plan_b.id)
        self.assertEqual(self.area.label, "Yard")

    def test_clone_copies_opens(self):
        r = self.client.post(f"/api/floor-plans/{self.campus.id}/clone/",
                             {"name": "Campus copy"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertEqual(copy.areas.get().opens_id, self.plan_b.id)
        self.assertEqual(copy.labels.get().opens_id, self.b1.id)

    def test_snapshot_copy_keeps_opens_drops_pair(self):
        self.label.pair_id = self.area.pk
        self.label.save()
        r = self.client.post(f"/api/floor-plans/{self.campus.id}/snapshot/", {
            "name": "Corner", "mode": "copy", "crop": {"x": 0, "y": 0, "w": 12, "h": 8},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        lb = copy.labels.get()
        self.assertEqual(lb.opens_id, self.b1.id)
        self.assertIsNone(lb.pair_id)

    def test_live_view_reads_opens(self):
        r = self.client.post(f"/api/floor-plans/{self.campus.id}/snapshot/", {
            "name": "Live", "mode": "view", "crop": {"x": 0, "y": 0, "w": 12, "h": 8},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        data = self.contents(FloorPlan.objects.get(pk=r.json()["id"]))
        self.assertEqual(data["labels"][0]["opens"]["id"], str(self.b1.id))


class BackLinkTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.label.opens = self.b1
        self.label.save()

    def back(self, body, plan=None):
        return self.client.post(
            f"/api/floor-plans/{(plan or self.campus).id}/back-link/", body, format="json"
        )

    def test_makes_renames_and_removes_the_back_label(self):
        r = self.back({"kind": "label", "id": str(self.label.id), "on": True,
                       "target_id": str(self.b1.id)})
        self.assertEqual(r.status_code, 200, r.content)
        made = FloorPlanLabel.objects.get(pair_id=self.label.pk)
        self.assertEqual(made.floor_plan_id, self.b1.id)
        self.assertEqual(made.opens_id, self.campus.id)
        self.assertEqual(made.text, "Back to Campus · Site")
        self.assertEqual((made.x, made.y), (0.5, 0.5))
        self.assertEqual(r.json()["back_label"]["id"], str(made.id))
        # The shape reads its back label.
        data = self.contents()
        row = next(lb for lb in data["labels"] if lb["id"] == str(self.label.id))
        self.assertEqual(row["back_label"]["floor_plan_id"], str(self.b1.id))
        # The back label opens this plan and reads as a pair.
        back = next(lb for lb in self.contents(self.b1)["labels"])
        self.assertEqual(back["opens"]["id"], str(self.campus.id))
        self.assertEqual(back["pair_id"], str(self.label.id))
        # Renaming edits only the back label.
        r = self.back({"kind": "label", "id": str(self.label.id), "on": True,
                       "target_id": str(self.b1.id), "text": "Go back"})
        self.assertEqual(r.status_code, 200, r.content)
        made.refresh_from_db()
        self.assertEqual(made.text, "Go back")
        self.label.refresh_from_db()
        self.assertEqual(self.label.text, "Go to B1")
        # Moving to another target moves the label.
        r = self.back({"kind": "label", "id": str(self.label.id), "on": True,
                       "target_id": str(self.hall.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            list(FloorPlanLabel.objects.filter(pair_id=self.label.pk)
                 .values_list("floor_plan_id", flat=True)),
            [self.hall.id],
        )
        r = self.back({"kind": "label", "id": str(self.label.id), "on": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(FloorPlanLabel.objects.filter(pair_id=self.label.pk).exists())

    def test_on_a_view_it_lives_on_the_source_inside_the_crop(self):
        r = self.client.post(f"/api/floor-plans/{self.hall.id}/snapshot/", {
            "name": "Corner", "mode": "view", "crop": {"x": 3, "y": 2, "w": 6, "h": 5},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        view = FloorPlan.objects.get(pk=r.json()["id"])
        r = self.back({"kind": "area", "id": str(self.area.id), "on": True,
                       "target_id": str(view.id)})
        self.assertEqual(r.status_code, 200, r.content)
        made = FloorPlanLabel.objects.get(pair_id=self.area.pk)
        self.assertEqual(made.floor_plan_id, self.hall.id)
        self.assertEqual((made.x, made.y), (3.5, 2.5))
        shown = self.contents(view)["labels"]
        self.assertEqual([lb["id"] for lb in shown], [str(made.id)])

    def test_needs_change_on_the_target(self):
        self.login(self.silo_editor())
        r = self.back({"kind": "label", "id": str(self.label.id), "on": True,
                       "target_id": str(self.plan_b.id)})
        self.assertIn(r.status_code, (400, 403), r.content)
        self.assertFalse(FloorPlanLabel.objects.filter(pair_id=self.label.pk).exists())

    def test_unknown_shape(self):
        other = FloorPlanLabel.objects.create(floor_plan=self.hall, text="x", x=1, y=1)
        r = self.back({"kind": "label", "id": str(other.id), "on": True,
                       "target_id": str(self.b1.id)})
        self.assertEqual(r.status_code, 400, r.content)


class OutlineOpensTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.outline = SiteMapOutline.objects.create(
            tenant=self.tenant, site=self.site_a, location=self.loc_a,
            points=[[55.0, 12.0], [55.0, 12.001], [55.001, 12.001]],
        )

    def test_opens_wins_in_drilldown(self):
        url = f"/api/site-map-outlines/{self.outline.id}/"
        r = self.client.get(url + "drilldown/")
        self.assertEqual(r.json()["open_floor_id"], str(self.hall.id))
        r = self.client.patch(url, {"opens_id": str(self.b1.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["opens"]["id"], str(self.b1.id))
        r = self.client.get(url + "drilldown/")
        self.assertEqual(r.json()["open_floor_id"], str(self.b1.id))

    def test_refuses_another_tenants_plan(self):
        r = self.client.patch(f"/api/site-map-outlines/{self.outline.id}/",
                              {"opens_id": str(self.theirs.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)


class PlateColourTests(_Fixture):
    def test_plate_colour_round_trips(self):
        r = self.client.patch(f"/api/floor-plan-labels/{self.label.id}/",
                              {"plate": True, "plate_color": "amber"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["plate_color"], "amber")
        r = self.client.patch(f"/api/floor-plan-labels/{self.label.id}/",
                              {"plate_color": "pink"}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_migration_defaults(self):
        f = FloorPlanLabel._meta.get_field("plate_color")
        self.assertEqual(f.db_default, "")
        self.assertTrue(FloorPlanArea._meta.get_field("opens").null)
