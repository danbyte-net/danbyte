"""``manage.py seed_floorplan_demo``: the opt-in demo floor plan."""
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    Device,
    FloorPlan,
    FloorPlanArea,
    FloorPlanCablePath,
    FloorPlanLabel,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    Interface,
)

User = get_user_model()

COUNTED = (Cable, Device, Interface, FloorPlan, FloorPlanArea, FloorPlanLabel, FloorPlanTile,
           FloorPlanTray, FloorPlanWall, FloorPlanCablePath)


class SeedFloorplanDemoTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Demo", slug="demo")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)

    def run_seed(self) -> str:
        out = StringIO()
        call_command("seed_floorplan_demo", tenant="demo", stdout=out)
        return out.getvalue()

    def counts(self):
        return {m.__name__: m.objects.count() for m in COUNTED}

    def test_seeds_once_and_a_rerun_changes_nothing(self):
        out = self.run_seed()
        first = self.counts()
        self.assertIn("/floorplans/", out)
        self.assertEqual(first["Cable"], 12)
        self.assertEqual(first["Device"], 5)
        again = self.run_seed()
        self.assertEqual(self.counts(), first)
        self.assertIn("0 objects made this run", again)

    def test_routes_inferred_stale_riser_and_planned(self):
        self.run_seed()
        ground = FloorPlan.objects.get(stack__name="Demo HQ", name="Ground")
        first = FloorPlan.objects.get(stack__name="Demo HQ", name="First")
        paths = {p.cable.label: p for p in FloorPlanCablePath.objects.filter(floor_plan=ground)}
        # Every cable has a stored route here but the inferred one and the
        # patch inside one rack (both ends on one tile: nothing to route).
        self.assertNotIn("DEMO-C09", paths)
        self.assertNotIn("DEMO-C06", paths)
        self.assertEqual(len(paths), 10)
        self.assertTrue(paths["DEMO-C10"].stale)
        self.assertEqual(sum(p.stale for p in paths.values()), 1)
        for label in ("DEMO-C01", "DEMO-C03", "DEMO-C04", "DEMO-C05", "DEMO-C07",
                      "DEMO-C12"):
            self.assertEqual(paths[label].kind, "trays", label)
        oh1 = FloorPlanTray.objects.get(floor_plan=ground, name="OH-1")
        self.assertIn(str(oh1.pk), [str(t) for t in paths["DEMO-C01"].tray_order])
        uf1 = FloorPlanTray.objects.get(floor_plan=ground, name="UF-1")
        self.assertIn(str(uf1.pk), [str(t) for t in paths["DEMO-C05"].tray_order])
        # The breakout routes a leg to each far tile.
        self.assertEqual(len(paths["DEMO-C07"].legs), 2)
        # Up the riser: a row on each floor.
        self.assertIsNotNone(paths["DEMO-C11"].riser_id)
        self.assertTrue(FloorPlanCablePath.objects.filter(
            floor_plan=first, cable__label="DEMO-C11").exists())
        planned = Cable.objects.get(label="DEMO-C08")
        self.assertTrue(planned.status.is_planned)
        self.assertTrue(ground.state["show_cable_links"])
        self.assertTrue(ground.state["show_cable_labels"])
        self.assertFalse(first.state.get("show_cable_links", False))

    def test_the_plans_load(self):
        self.run_seed()
        ground = FloorPlan.objects.get(stack__name="Demo HQ", name="Ground")
        first = FloorPlan.objects.get(stack__name="Demo HQ", name="First")
        overview = FloorPlan.objects.get(stack__name="Demo campus overview")
        body = self.client.get(f"/api/floor-plans/{ground.id}/contents/").json()
        self.assertEqual(len(body["walls"]), 2)
        self.assertTrue(any(w["openings"] for w in body["walls"]))
        self.assertEqual(len(body["trays"]), 4)
        labels = {lb["text"]: lb for lb in body["labels"]}
        self.assertEqual(labels["First floor ↑"]["opens"]["id"], str(first.id))
        back = self.client.get(f"/api/floor-plans/{first.id}/contents/").json()["labels"]
        self.assertTrue(any(lb["opens"] and lb["opens"]["id"] == str(ground.id) for lb in back))
        paths = self.client.get(f"/api/floor-plans/{ground.id}/cable-paths/")
        self.assertEqual(paths.status_code, 200, paths.content[:300])
        self.assertEqual(len(paths.json()["cables"]), 12)
        sched = self.client.get(f"/api/floor-plans/{ground.id}/cable-schedule/").json()
        self.assertEqual(sched["total"]["count"], 12)
        self.assertIn("Server room", [g["name"] for g in sched["groups"]])
        areas = FloorPlanArea.objects.filter(floor_plan=overview)
        self.assertEqual(areas.count(), 2)
        self.assertEqual(areas.get(location__name="Building A").opens_id, ground.id)
        r = self.client.get(f"/api/floor-plans/{overview.id}/contents/")
        self.assertEqual(r.status_code, 200)

    def test_an_unknown_tenant_is_refused(self):
        with self.assertRaises(CommandError):
            call_command("seed_floorplan_demo", tenant="nope", stdout=StringIO())
