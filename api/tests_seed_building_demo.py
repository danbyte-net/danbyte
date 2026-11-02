"""``manage.py seed_building_demo``: the opt-in demo building (aligned levels)."""
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .cable_routing import riser_links
from .floor_stacks import ordered_floors, stack_elevations
from .models import (
    Cable,
    Device,
    FloorPlan,
    FloorPlanArea,
    FloorPlanCablePath,
    FloorPlanStack,
    FloorPlanTile,
    FloorPlanTray,
    FloorPlanWall,
    Interface,
    Room,
)

User = get_user_model()

COUNTED = (Cable, Device, Interface, FloorPlan, FloorPlanArea, FloorPlanTile, FloorPlanTray,
           FloorPlanWall, FloorPlanCablePath, Room)


class SeedBuildingDemoTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Demo", slug="demo")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)

    def run_seed(self) -> str:
        out = StringIO()
        call_command("seed_building_demo", tenant="demo", stdout=out)
        return out.getvalue()

    def counts(self):
        return {m.__name__: m.objects.count() for m in COUNTED}

    def test_seeds_once_and_a_rerun_changes_nothing(self):
        out = self.run_seed()
        first = self.counts()
        self.assertIn("/floorplans/", out)
        again = self.run_seed()
        self.assertEqual(self.counts(), first)
        self.assertIn("0 objects made this run", again)

    def test_an_aligned_stack_of_five_levels_with_paired_risers(self):
        self.run_seed()
        self.run_seed()
        stack = FloorPlanStack.objects.get(name="Demo tower")
        self.assertTrue(stack.aligned)
        self.assertEqual(stack.location.name, "Tower")
        floors = list(ordered_floors(stack))
        self.assertEqual([f.name for f in floors], ["B1", "Ground", "1", "2", "3"])
        elev = stack_elevations(floors)
        self.assertLess(elev[floors[0].pk], 0)
        self.assertEqual(elev[floors[1].pk], 0)
        self.assertEqual(sorted(elev.values()), [elev[f.pk] for f in floors])
        for f in floors:
            # The shell is copied to every level, marked exterior.
            shell = FloorPlanWall.objects.get(floor_plan=f, label="Shell")
            self.assertTrue(shell.exterior)
            self.assertTrue(FloorPlanWall.objects.filter(floor_plan=f, label="Core").exists())
            self.assertTrue(FloorPlanArea.objects.filter(floor_plan=f, room__isnull=False))
            risers = list(FloorPlanTile.objects.filter(floor_plan=f, riser=True))
            self.assertEqual(sorted(r.label for r in risers), ["Riser A", "Riser B"])
            links = riser_links(f, risers)
            for r in risers:
                # Each riser reaches the same riser on every other level.
                self.assertEqual(len(links[r.pk]), 4)
                self.assertEqual({p.label for p in links[r.pk]}, {r.label})
        b1 = floors[0]
        for f in floors[1:]:
            key = {"Ground": "G"}.get(f.name, f"L{f.name}")
            for side in ("A", "B"):
                c = Cable.objects.get(label=f"TWR-F-{key}-{side}")
                here = FloorPlanCablePath.objects.get(floor_plan=f, cable=c)
                down = FloorPlanCablePath.objects.get(floor_plan=b1, cable=c)
                self.assertIsNotNone(here.riser_id)
                self.assertEqual(here.riser.label, f"Riser {side}")
                self.assertEqual(here.riser_mm, elev[f.pk] - elev[b1.pk])
                self.assertEqual(down.riser.floor_plan_id, b1.pk)
        ap = FloorPlanCablePath.objects.get(cable__label="TWR-L1-AP1")
        self.assertEqual(ap.kind, "trays")

    def test_the_levels_load(self):
        self.run_seed()
        stack = FloorPlanStack.objects.get(name="Demo tower")
        for f in ordered_floors(stack):
            r = self.client.get(f"/api/floor-plans/{f.id}/contents/")
            self.assertEqual(r.status_code, 200, r.content[:300])
            paths = self.client.get(f"/api/floor-plans/{f.id}/cable-paths/")
            self.assertEqual(paths.status_code, 200, paths.content[:300])

    def test_an_unknown_tenant_is_refused(self):
        with self.assertRaises(CommandError):
            call_command("seed_building_demo", tenant="nope", stdout=StringIO())
