"""Stored cable routes on floor plans (floor-plan cables, phase 2).

``FloorPlanCablePath`` - one documented route per cable per plan - and the
routing service in ``api/cable_routing.py``: routes through the plan's
trays (the shared router cases), lengths by the tenant's rules, a computed
length never written over one a person entered unless asked, paths going
out of date when an end's tile or a tray moves, the ``bulk/`` save of
paths (cable change, path grants, 409 on a stale version), the
``cable-plan`` preview, ``cable-paths`` answering stored paths (hidden
cables stay hidden), and live views translating them.
"""
import json
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant, TenantSettings

from . import floor_plan_snapshots as snaps
from .cable_routing import PlanRouter, length_total, save_path, write_length
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    FloorPlan,
    FloorPlanCablePath,
    FloorPlanTile,
    FloorPlanTray,
    FloorTileType,
    Interface,
    Location,
    Rack,
    Site,
)

User = get_user_model()

SHARED_CASES = (
    Path(settings.BASE_DIR) / "frontend/src/components/floorplan/cable-route.cases.json"
)


class _Plan(APITestCase):
    """Two racks on a plan, an overhead tray between them, a cable between
    a device in each."""

    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.loc = Location.objects.create(
            tenant=self.tenant, site=self.site, name="Hall", slug="hall"
        )
        self.plan = FloorPlan.objects.create(
            tenant=self.tenant, location=self.loc, name="Hall A",
            cell_mm=600, ceiling_mm=3000, grid_width=40, grid_height=20,
        )
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Rack", slug="rack")
        self.rack_a = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="RA", u_height=42
        )
        self.rack_b = Rack.objects.create(
            tenant=self.tenant, site=self.site, name="RB", u_height=42
        )
        self.tile_a = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=0, y=2, rack=self.rack_a,
            link_kind="rack",
        )
        self.tile_b = FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=10, y=2, rack=self.rack_b,
            link_kind="rack",
        )
        self.tray = FloorPlanTray.objects.create(
            floor_plan=self.plan, name="OH-1", level="overhead", points=[[0, 1], [11, 1]],
        )
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, name="1U", u_height=1
        )
        self.dev_a = Device.objects.create(
            tenant=self.tenant, name="sw-a", site=self.site, rack=self.rack_a,
            device_type=self.dtype, position=41,
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant, name="sw-b", site=self.site, rack=self.rack_b,
            device_type=self.dtype, position=41,
        )
        self.cable = self._cable("C-1", self.dev_a, self.dev_b)
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)

    _port = 0

    def _cable(self, label, a, b):
        type(self)._port += 1
        cable = Cable.objects.create(tenant=self.tenant, label=label)
        CableTermination.objects.create(
            cable=cable, end="A",
            interface=Interface.objects.create(device=a, name=f"e{self._port}"),
        )
        CableTermination.objects.create(
            cable=cable, end="B",
            interface=Interface.objects.create(device=b, name=f"e{self._port}"),
        )
        return cable

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def route(self, cable=None, plan=None, **kw):
        return PlanRouter(plan or self.plan, **kw).route(cable or self.cable)

    def store(self, cable=None):
        cable = cable or self.cable
        return save_path(self.plan, cable, self.route(cable))

    def bulk(self, body, plan=None):
        return self.client.post(
            f"/api/floor-plans/{(plan or self.plan).id}/bulk/", body, format="json"
        )

    def cable_paths(self, plan=None):
        r = self.client.get(f"/api/floor-plans/{(plan or self.plan).id}/cable-paths/")
        self.assertEqual(r.status_code, 200, r.content)
        return {c["id"]: c for c in r.json()["cables"]}


class RoutingServiceTests(_Plan):
    def test_routes_through_the_tray_with_its_breakdown(self):
        r = self.route()
        self.assertTrue(r["reachable"])
        self.assertEqual(r["kind"], "trays")
        self.assertEqual(r["tray_order"], [str(self.tray.id)])
        (leg,) = r["legs"]
        self.assertEqual(leg["from"]["tile"], str(self.tile_a.id))
        self.assertEqual(leg["to"]["tile"], str(self.tile_b.id))
        self.assertEqual(leg["from"]["at"], [0.5, 2.5])
        self.assertEqual(leg["points"][0], [0.5, 2.5])
        self.assertEqual(leg["points"][-1], [10.5, 2.5])
        (span,) = leg["trays"]
        self.assertEqual(span["id"], str(self.tray.id))
        self.assertEqual(span["entry"], [0.5, 1.0])
        self.assertEqual(span["exit"], [10.5, 1.0])
        self.assertEqual(span["elevation_mm"], 2700)
        # 1.5 cells up, 10 along, 1.5 down = 13 cells of 600 mm.
        self.assertEqual(r["run_mm"], 7800)
        # A 1U device at U41: 100 + 40.5 × 44.45 ≈ 1900 mm; the tray at 2700.
        self.assertEqual(r["drop_a_mm"], 800)
        self.assertEqual(r["drop_b_mm"], 800)
        self.assertEqual(r["extra_mm"], 0)
        # (7800 + 1600) × 1.1 = 10340 → up to 10500.
        self.assertEqual(r["slack_mm"], 940)
        self.assertEqual(r["length_mm"], 10500)

    def test_tenant_length_rules(self):
        TenantSettings.objects.create(
            tenant=self.tenant, cable_slack_pct=0, cable_service_loop_mm=1000,
            cable_length_step_mm=0,
        )
        r = self.route()
        self.assertEqual(r["extra_mm"], 2000)
        self.assertEqual(r["slack_mm"], 0)
        self.assertAlmostEqual(r["length_mm"], 7800 + 1600 + 2000, delta=1)

    def test_length_total_rounds_up_to_the_step(self):
        rules = {"slack_pct": 10, "service_loop_mm": 0, "step_mm": 500}
        self.assertEqual(length_total(1000, rules), (0, 100, 1500))
        self.assertEqual(length_total(4545.4545, rules)[2], 5000)
        self.assertEqual(length_total(0, rules)[2], 0)

    def test_standalone_device_uses_the_standalone_height(self):
        TenantSettings.objects.create(tenant=self.tenant, cable_standalone_height_mm=700)
        lone = Device.objects.create(tenant=self.tenant, name="ap", site=self.site)
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=10, y=0, device=lone,
            link_kind="device",
        )
        r = self.route(self._cable("C-2", self.dev_a, lone))
        self.assertEqual(r["drop_b_mm"], 2000)

    def test_no_tray_path_is_a_direct_elbow(self):
        self.tray.delete()
        r = self.route()
        self.assertFalse(r["reachable"])
        self.assertEqual(r["kind"], "direct")
        self.assertEqual(r["tray_order"], [])
        self.assertEqual(r["legs"][0]["points"], [[0.5, 2.5], [10.5, 2.5]])
        self.assertEqual(r["run_mm"], 6000)

    def test_unplaced_end_routes_nothing(self):
        ghost = Device.objects.create(tenant=self.tenant, name="ghost", site=self.site)
        self.assertIsNone(self.route(self._cable("C-3", self.dev_a, ghost)))

    def test_breakout_has_a_leg_per_far_tile(self):
        lone = Device.objects.create(tenant=self.tenant, name="ap", site=self.site)
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=5, y=2, device=lone,
            link_kind="device",
        )
        CableTermination.objects.create(
            cable=self.cable, end="B",
            interface=Interface.objects.create(device=lone, name="x9"),
        )
        r = self.route()
        self.assertEqual(len(r["legs"]), 2)
        self.assertEqual(
            {leg["to"]["tile"] for leg in r["legs"]},
            {str(self.tile_b.id), str(FloorPlanTile.objects.get(device=lone).id)},
        )

    def test_positions_route_against_an_unsaved_move(self):
        r = self.route(positions={str(self.tile_b.id): {"x": 6, "y": 2}})
        self.assertEqual(r["legs"][0]["to"]["at"], [6.5, 2.5])
        self.assertEqual(r["run_mm"], 9 * 600)


class SharedCaseServiceTests(TestCase):
    """The service routes the shared router cases as the client and
    ``route_through_trays`` do: ends on 1x1 tiles centred on the case's
    points, trays at the case's elevations."""

    def test_cases(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        site = Site.objects.create(tenant=tenant, name="S")
        tt = FloorTileType.objects.create(tenant=tenant, name="Box", slug="box")
        cases = json.loads(SHARED_CASES.read_text())["cases"]
        ran = 0
        for n, case in enumerate(cases):
            elevations = [t["elevation_mm"] for t in case["trays"]]
            if case["levels"] and None in elevations:
                continue  # every stored tray resolves to an elevation
            with self.subTest(case["name"]):
                plan = FloorPlan.objects.create(
                    tenant=tenant, site=site, name=f"P{n}", cell_mm=1000, ceiling_mm=3000,
                )
                devs = []
                for i, p in enumerate((case["a"], case["b"])):
                    d = Device.objects.create(tenant=tenant, name=f"d{n}-{i}", site=site)
                    FloorPlanTile.objects.create(
                        floor_plan=plan, tile_type=tt, x=p[0] - 0.5, y=p[1] - 0.5,
                        width=1, height=1, device=d, link_kind="device",
                    )
                    devs.append(d)
                trays = [
                    FloorPlanTray.objects.create(
                        floor_plan=plan, name=f"T{i}", points=t["points"],
                        elevation_mm=t["elevation_mm"] if case["levels"] else 2700,
                    )
                    for i, t in enumerate(case["trays"])
                ]
                cable = Cable.objects.create(tenant=tenant, label=f"c{n}")
                for end, d in zip("AB", devs, strict=True):
                    CableTermination.objects.create(
                        cable=cable, end=end,
                        interface=Interface.objects.create(device=d, name="e0"),
                    )
                r = PlanRouter(plan).route(cable)
                self.assertEqual(r["reachable"], case["reachable"])
                if case["reachable"]:
                    self.assertEqual(
                        r["tray_order"], [str(trays[i].id) for i in case["trays_used"]]
                    )
                    self.assertAlmostEqual(r["run_mm"], case["run"] * 1000, delta=1)
                else:
                    self.assertEqual(r["kind"], "direct")
                ran += 1
        self.assertGreater(ran, 5)


class LengthWriteTests(_Plan):
    def test_fills_a_blank_length_as_computed(self):
        self.assertTrue(write_length(self.cable, 10500))
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 10.5)
        self.assertEqual(self.cable.length_unit, "m")
        self.assertEqual(self.cable.length_source, "computed")

    def test_writes_in_the_cables_own_unit(self):
        self.cable.length_unit = "ft"
        self.cable.save()
        write_length(self.cable, 3048)
        self.cable.refresh_from_db()
        self.assertEqual((float(self.cable.length), self.cable.length_unit), (10.0, "ft"))

    def test_never_over_an_entered_length_unless_asked(self):
        self.cable.length = 99
        self.cable.save()
        self.assertFalse(write_length(self.cable, 10500))
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 99)
        self.assertTrue(write_length(self.cable, 10500, replace=True))
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 10.5)

    def test_replaces_a_computed_length(self):
        write_length(self.cable, 10500)
        self.assertTrue(write_length(self.cable, 12000))
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 12.0)

    def test_editing_the_length_makes_it_entered(self):
        write_length(self.cable, 10500)
        r = self.client.patch(
            f"/api/cables/{self.cable.id}/", {"length": "11.00"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["length_source"], "")
        # A save that leaves the length as it is keeps it computed.
        self.cable.refresh_from_db()
        write_length(self.cable, 10500, replace=True)
        r = self.client.patch(
            f"/api/cables/{self.cable.id}/", {"label": "C-1b", "length": "10.50"},
            format="json",
        )
        self.assertEqual(r.json()["length_source"], "computed")

    def test_auto_route_stores_a_path_and_keeps_an_entered_length(self):
        self.cable.length = 99
        self.cable.save()
        r = self.client.post(
            f"/api/cables/{self.cable.id}/auto-route/", {"floor_plan": str(self.plan.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["length_set"])
        self.assertEqual(body["length_m"], 10.5)
        path = FloorPlanCablePath.objects.get(floor_plan=self.plan, cable=self.cable)
        self.assertEqual(path.tray_order, [str(self.tray.id)])
        self.assertEqual(path.tenant_id, self.tenant.id)
        self.assertEqual(list(self.cable.trays.all()), [self.tray])


class StaleTests(_Plan):
    def setUp(self):
        super().setUp()
        self.path = self.store()

    def stale(self):
        self.path.refresh_from_db()
        return self.path.stale

    def test_moving_an_end_tile_makes_it_stale(self):
        self.tile_b.x = 12
        self.tile_b.save()
        self.assertTrue(self.stale())
        self.assertTrue(self.cable_paths()[str(self.cable.id)]["path"]["stale"])

    def test_editing_a_tile_in_place_does_not(self):
        self.tile_b.label = "renamed"
        self.tile_b.save()
        self.assertFalse(self.stale())

    def test_bulk_tile_move_makes_it_stale(self):
        r = self.bulk({"tiles": {"update": [{"id": str(self.tile_a.id), "x": 1}]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(self.stale())

    def test_removing_an_end_tile_makes_it_stale(self):
        self.tile_b.delete()
        self.assertTrue(self.stale())

    def test_reshaping_a_tray_makes_it_stale(self):
        self.tray.points = [[0, 1], [12, 1]]
        self.tray.save()
        self.assertTrue(self.stale())

    def test_raising_a_tray_makes_it_stale(self):
        self.tray.elevation_mm = 2400
        self.tray.save()
        self.assertTrue(self.stale())

    def test_renaming_a_tray_does_not(self):
        self.tray.name = "OH-1a"
        self.tray.save()
        self.assertFalse(self.stale())

    def test_taking_the_cable_out_of_the_tray_makes_it_stale(self):
        self.tray.cables.remove(self.cable)
        self.assertTrue(self.stale())

    def test_deleting_the_tray_makes_it_stale(self):
        self.tray.delete()
        self.assertTrue(self.stale())

    def test_re_racked_device_reads_stale(self):
        rack_c = Rack.objects.create(tenant=self.tenant, site=self.site, name="RC")
        FloorPlanTile.objects.create(
            floor_plan=self.plan, tile_type=self.tt, x=20, y=2, rack=rack_c, link_kind="rack",
        )
        Device.objects.filter(pk=self.dev_b.pk).update(rack=rack_c)
        self.assertFalse(self.stale())  # stored flag untouched...
        self.assertTrue(self.cable_paths()[str(self.cable.id)]["path"]["stale"])  # ...derived

    def test_re_routing_clears_it(self):
        self.tile_b.x = 12
        self.tile_b.save()
        self.store()
        self.assertFalse(self.stale())


class CablePathsReadTests(_Plan):
    def test_stored_path_rides_along(self):
        self.store()
        row = self.cable_paths()[str(self.cable.id)]
        self.assertEqual(row["length_source"], "")
        path = row["path"]
        self.assertEqual(path["kind"], "trays")
        self.assertFalse(path["stale"])
        self.assertEqual(path["length_mm"], 10500)
        self.assertEqual(path["tray_order"], [str(self.tray.id)])
        self.assertTrue(path["version"])

    def test_contents_lists_stored_paths(self):
        path = self.store()
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/")
        (row,) = r.json()["cable_paths"]
        self.assertEqual((row["cable"], row["id"]), (str(self.cable.id), str(path.id)))
        self.assertEqual(r.json()["version"][:19], path.updated_at.isoformat()[:19])

    def test_no_stored_path_is_null(self):
        self.assertIsNone(self.cable_paths()[str(self.cable.id)]["path"])

    def test_hidden_cable_shows_no_path(self):
        self.store()
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v", object_types=["floorplan", "floorplantile", "floorplantray",
                                    "floorplancablepath"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-paths/")
        self.assertEqual(r.json()["cables"], [])
        self.assertEqual(r.json()["hidden_count"], 1)
        self.assertNotIn(str(self.cable.id), r.content.decode())
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/cable-plan/", {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cables"], [])
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/contents/")
        self.assertEqual(r.json()["cable_paths"], [])

    def test_path_needs_its_own_view_grant(self):
        self.store()
        user = User.objects.create_user("v2", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="v2", object_types=["floorplan", "floorplantile", "cable", "device"],
            actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        row = self.cable_paths()[str(self.cable.id)]
        self.assertIsNone(row["path"])


class CablePlanPreviewTests(_Plan):
    def test_preview_stores_nothing(self):
        self.cable.length = 8
        self.cable.save()
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/cable-plan/",
            {"cable_ids": [str(self.cable.id)]}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = r.json()["cables"]
        self.assertEqual(row["route"]["length_mm"], 10500)
        self.assertEqual(row["delta_mm"], 2500)
        self.assertFalse(row["write_length"])
        self.assertTrue(row["can_change"])
        self.assertIsNone(row["path"])
        self.assertEqual(r.json()["cell_mm"], 600)
        self.assertFalse(FloorPlanCablePath.objects.exists())
        self.assertEqual(self.cable.trays.count(), 0)

    def test_without_ids_lists_cables_with_both_ends_here(self):
        ghost = Device.objects.create(tenant=self.tenant, name="ghost", site=self.site)
        self._cable("C-off", self.dev_a, ghost)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/cable-plan/", {}, format="json")
        self.assertEqual([c["id"] for c in r.json()["cables"]], [str(self.cable.id)])

    def test_preview_with_positions(self):
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/cable-plan/",
            {"positions": {str(self.tile_b.id): {"x": 6, "y": 2}}}, format="json",
        )
        route = r.json()["cables"][0]["route"]
        self.assertEqual(route["legs"][0]["points"][-1], [6.5, 2.5])

    def test_another_tenants_cable_is_not_routed(self):
        other = Tenant.objects.create(org=self.org, name="X", slug="x")
        stranger = Cable.objects.create(tenant=other, label="S")
        r = self.client.post(
            f"/api/floor-plans/{self.plan.id}/cable-plan/",
            {"cable_ids": [str(stranger.id)]}, format="json",
        )
        self.assertEqual(r.json()["cables"], [])


class BulkCablePathTests(_Plan):
    def setUp(self):
        super().setUp()
        self.editor = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=self.editor).tenants.add(self.tenant)

    def grant(self, types, actions):
        perm = ObjectPermission.objects.create(
            name="g-" + "-".join(types), object_types=types, actions=actions,
        )
        perm.users.add(self.editor)
        perm.tenants.add(self.tenant)
        return perm

    def test_upsert_routes_and_fills_a_blank_length(self):
        r = self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.cable.id), "write_length": True},
        ]}})
        self.assertEqual(r.status_code, 200, r.content)
        (out,) = r.json()["cable_paths"]
        self.assertEqual(out["length_mm"], 10500)
        self.cable.refresh_from_db()
        self.assertEqual((float(self.cable.length), self.cable.length_source), (10.5, "computed"))
        self.assertEqual(list(self.cable.trays.all()), [self.tray])

    def test_upsert_keeps_an_entered_length_unless_replace(self):
        self.cable.length = 99
        self.cable.save()
        self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.cable.id), "write_length": True},
        ]}})
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 99)
        self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.cable.id), "replace_length": True},
        ]}})
        self.cable.refresh_from_db()
        self.assertEqual(float(self.cable.length), 10.5)

    def test_upsert_with_drawn_legs_is_measured_here(self):
        legs = [{"points": [[0.5, 2.5], [0.5, 1], [10.5, 1], [10.5, 2.5]],
                 "length_mm": 1}]
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "kind": "trays", "legs": legs,
            "tray_order": [str(self.tray.id)], "run_mm": 5,
        }]}})
        self.assertEqual(r.status_code, 200, r.content)
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        self.assertEqual(path.run_mm, 7800)
        self.assertEqual(path.length_mm, 10500)
        self.assertEqual(path.legs[0]["trays"][0]["id"], str(self.tray.id))

    def test_drawn_leg_must_meet_its_tiles(self):
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "kind": "manual",
            "legs": [{"points": [[3, 3], [10.5, 2.5]]}],
        }]}})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_foreign_tray_is_refused(self):
        other = FloorPlan.objects.create(tenant=self.tenant, location=self.loc, name="B")
        stranger = FloorPlanTray.objects.create(
            floor_plan=other, name="X", points=[[0, 1], [11, 1]]
        )
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "tray_order": [str(stranger.id)],
            "legs": [{"points": [[0.5, 2.5], [10.5, 2.5]]}], "kind": "direct",
        }]}})
        self.assertEqual(r.status_code, 400, r.content)

    def test_delete(self):
        self.store()
        r = self.bulk({"cable_paths": {"delete": [str(self.cable.id)]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_another_tenants_cable_is_unknown(self):
        other = Tenant.objects.create(org=self.org, name="X", slug="x")
        stranger = Cable.objects.create(tenant=other, label="S")
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(stranger.id)}]}})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_needs_cable_change(self):
        self.grant(["floorplan", "floorplantile", "floorplancablepath"],
                   ["view", "add", "change", "delete"])
        self.grant(["cable", "device"], ["view"])
        self.login(self.editor)
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_needs_the_path_grant(self):
        self.grant(["floorplan", "floorplantile"], ["view", "add", "change", "delete"])
        self.grant(["cable", "device"], ["view", "change"])
        self.login(self.editor)
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_an_editor_with_the_grants_saves(self):
        self.grant(["floorplan", "floorplantile", "floorplancablepath"],
                   ["view", "add", "change", "delete"])
        self.grant(["cable", "device"], ["view", "change"])
        self.login(self.editor)
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(FloorPlanCablePath.objects.filter(cable=self.cable).exists())

    def test_hidden_cable_is_unknown(self):
        self.grant(["floorplan", "floorplantile", "floorplancablepath"],
                   ["view", "add", "change", "delete"])
        self.login(self.editor)
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("C-1", r.content.decode())

    def test_changed_elsewhere_is_a_409_and_writes_nothing(self):
        path = self.store()
        old = path.updated_at.isoformat()
        save_path(self.plan, self.cable, self.route())  # someone else
        r = self.bulk({
            "tiles": {"update": [{"id": str(self.tile_a.id), "x": 1}]},
            "cable_paths": {"upsert": [{"cable": str(self.cable.id), "version": old}]},
        })
        self.assertEqual(r.status_code, 409, r.content)
        (c,) = r.json()["conflicts"]
        self.assertEqual((c["kind"], c["id"]), ("cable_path", str(self.cable.id)))
        self.assertEqual(c["current"]["length_mm"], 10500)
        self.tile_a.refresh_from_db()
        self.assertEqual(self.tile_a.x, 0)

    def test_version_of_a_deleted_path_conflicts(self):
        path = self.store()
        old = path.updated_at.isoformat()
        path.delete()
        r = self.bulk({"cable_paths": {"upsert": [
            {"cable": str(self.cable.id), "version": old},
        ]}})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIsNone(r.json()["conflicts"][0]["current"])

    def test_cable_length_changed_elsewhere_conflicts(self):
        stamp = Cable.objects.get(pk=self.cable.pk).updated_at.isoformat()
        self.cable.length = 3
        self.cable.save()
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "write_length": True, "cable_version": stamp,
        }]}})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["conflicts"][0]["kind"], "cable")
        self.assertFalse(FloorPlanCablePath.objects.exists())

    def test_routing_card_stores_the_trays_in_its_order(self):
        url = f"/api/cables/{self.cable.id}/routing/"
        r = self.client.put(
            url, {"floor_plan": str(self.plan.id), "tray_ids": [str(self.tray.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["path"]["tray_order"], [str(self.tray.id)])
        r = self.client.get(f"{url}?floor_plan={self.plan.id}")
        self.assertEqual(r.json()["path"]["kind"], "trays")
        # Point-to-point: a direct run, and no length written.
        r = self.client.put(url, {"floor_plan": str(self.plan.id), "tray_ids": []},
                            format="json")
        self.assertEqual(r.json()["path"]["kind"], "direct")
        self.cable.refresh_from_db()
        self.assertIsNone(self.cable.length)

    def test_saves_against_tiles_moved_in_the_same_save(self):
        r = self.bulk({
            "tiles": {"update": [{"id": str(self.tile_b.id), "x": 6}]},
            "cable_paths": {"upsert": [{"cable": str(self.cable.id)}]},
        })
        self.assertEqual(r.status_code, 200, r.content)
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        self.assertEqual(path.legs[0]["to"]["at"], [6.5, 2.5])
        self.assertFalse(path.stale)

    def test_is_audited(self):
        from audit.models import ChangeLogEntry

        self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        entry = ChangeLogEntry.objects.get(object_id=str(path.pk))
        self.assertEqual(entry.object_type, "api.floorplancablepath")
        self.assertEqual(entry.tenant_id, self.tenant.id)
        self.assertEqual(entry.object_site_id, self.site.id)


class LiveViewTests(_Plan):
    def setUp(self):
        super().setUp()
        self.view, _ = snaps.make_snapshot(
            self.plan, snaps.Crop(0, 0, 20, 10), name="View", mode="view"
        )
        # Shift the source's contents so the view's cells differ from it.
        self.view.crop = {"x": 0, "y": 1, "w": 20, "h": 8}
        self.view.save()

    def test_cable_paths_through_a_view_are_in_its_cells(self):
        self.store()
        row = self.cable_paths(self.view)[str(self.cable.id)]
        self.assertEqual(row["path"]["legs"][0]["points"][0], [0.5, 1.5])
        self.assertEqual(row["path"]["legs"][0]["from"]["at"], [0.5, 1.5])

    def test_bulk_through_a_view_writes_the_sources_path(self):
        legs = [{"points": [[0.5, 1.5], [0.5, 0], [10.5, 0], [10.5, 1.5]]}]
        r = self.bulk({"cable_paths": {"upsert": [{
            "cable": str(self.cable.id), "kind": "trays", "legs": legs,
            "tray_order": [str(self.tray.id)],
        }]}}, plan=self.view)
        self.assertEqual(r.status_code, 200, r.content)
        path = FloorPlanCablePath.objects.get(cable=self.cable)
        self.assertEqual(path.floor_plan_id, self.plan.id)
        self.assertEqual(path.legs[0]["points"][0], [0.5, 2.5])
        self.assertEqual(r.json()["cable_paths"][0]["legs"][0]["points"][0], [0.5, 1.5])

    def test_a_copy_does_not_copy_routes(self):
        self.store()
        copy, _ = snaps.make_snapshot(
            self.plan, snaps.Crop(0, 0, 20, 10), name="Copy", mode="copy"
        )
        self.assertEqual(FloorPlanCablePath.objects.filter(floor_plan=copy).count(), 0)
        self.assertEqual(FloorPlanCablePath.objects.filter(floor_plan=self.plan).count(), 1)


class SiteWidePlanTests(_Plan):
    def test_site_wide_plan_routes_and_stores(self):
        self.plan.location = None
        self.plan.site = self.site
        self.plan.save()
        r = self.bulk({"cable_paths": {"upsert": [{"cable": str(self.cable.id)}]}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.cable_paths()[str(self.cable.id)]["path"]["length_mm"], 10500)
