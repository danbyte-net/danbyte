"""Area name style: the plan's default (``state.area_names``) and each
area's ``name_style`` override - a closed set of positions and sizes, a hex
colour or blank, a boolean plate - on create, update, bulk, clone and the
change log."""

from __future__ import annotations

from audit.models import ChangeLogEntry

from .models import FloorPlan, FloorPlanArea
from .tests_floorplan_areas import _Base


class AreaNameStyleTests(_Base):
    def test_defaults_to_empty_and_inherits(self):
        r = self._area()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name_style"], {})
        # An area saved before the field keeps today's look.
        a = FloorPlanArea.objects.create(floor_plan=self.plan, x=0, y=0, width=1, height=1)
        self.assertEqual(a.name_style, {})

    def test_full_style_round_trips(self):
        style = {"position": "bottom-right", "size": "l", "color": "#10B981",
                 "plate": True}
        r = self._area(name_style=style)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            r.json()["name_style"],
            {"position": "bottom-right", "size": "l", "color": "#10b981", "plate": True},
        )

    def test_partial_style_and_blank_colour(self):
        r = self._area(name_style={"position": "center", "color": ""})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name_style"], {"position": "center", "color": ""})

    def test_invalid_styles_are_refused(self):
        for bad in (
            {"position": "middle"},
            {"size": "xl"},
            {"color": "red"},
            {"color": "#12345"},
            {"plate": "yes"},
            {"font": "Comic Sans"},
            ["top"],
        ):
            with self.subTest(bad=bad):
                r = self._area(name_style=bad)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("name_style", r.json())

    def test_patch_is_logged(self):
        aid = self._area().json()["id"]
        r = self.client.patch(
            f"/api/floor-plan-areas/{aid}/",
            {"name_style": {"position": "top", "plate": True}}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["name_style"], {"position": "top", "plate": True})
        entry = ChangeLogEntry.objects.filter(
            object_type="api.floorplanarea", object_id=aid, action="update"
        ).get()
        self.assertIn("name_style", str(entry.changes))

    def test_bulk_save_validates_and_writes(self):
        url = f"/api/floor-plans/{self.plan.id}/bulk/"
        r = self.client.post(url, {"areas": {"create": [
            {"x": 0, "y": 0, "width": 4, "height": 4, "name_style": {"size": "huge"}},
        ]}}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(self.plan.areas.exists())
        r = self.client.post(url, {"areas": {"create": [
            {"x": 0, "y": 0, "width": 4, "height": 4, "name_style": {"size": "s"}},
        ]}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.plan.areas.get().name_style, {"size": "s"})

    def test_clone_keeps_the_style(self):
        FloorPlanArea.objects.create(
            floor_plan=self.plan, x=0, y=0, width=2, height=2,
            name_style={"position": "center", "plate": True},
        )
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/clone/")
        self.assertEqual(r.status_code, 201, r.content)
        copy = FloorPlan.objects.get(pk=r.json()["id"])
        self.assertEqual(copy.areas.get().name_style, {"position": "center", "plate": True})

    def test_plan_default_in_state(self):
        url = f"/api/floor-plans/{self.plan.id}/"
        r = self.client.patch(url, {"state": {
            "grid": True,
            "area_names": {"position": "top", "size": "m", "color": "#AABBCC", "plate": False},
        }}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["state"]["area_names"],
            {"position": "top", "size": "m", "color": "#aabbcc", "plate": False},
        )
        self.assertTrue(r.json()["state"]["grid"])
        r = self.client.patch(url, {"state": {"area_names": {"position": "nowhere"}}},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("state", r.json())

    def test_other_tenants_area_untouched(self):
        theirs = FloorPlanArea.objects.create(
            floor_plan=self.their_plan, x=0, y=0, width=1, height=1
        )
        r = self.client.patch(
            f"/api/floor-plan-areas/{theirs.id}/", {"name_style": {"size": "l"}},
            format="json",
        )
        self.assertEqual(r.status_code, 404)
        theirs.refresh_from_db()
        self.assertEqual(theirs.name_style, {})
