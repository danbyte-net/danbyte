"""Cabinets on floor plans (#277): a tile links to a cabinet like it links to
a rack - overlays, cable routing through it, and a closed box in 3D."""

from __future__ import annotations

from django.db import IntegrityError, transaction

from .models import (
    Cabinet,
    Cable,
    CableTermination,
    Device,
    DeviceType,
    DinRail,
    FloorPlan,
    FloorPlanTile,
    FloorTileType,
    Interface,
    Rack,
)
from .tests_floorplan import _Base


class FloorPlanCabinetTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(tenant=self.tenant, location=self.loc,
                                             name="Hall A")
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="Cabinet",
                                               slug="cabinet")
        self.cab = Cabinet.objects.create(tenant=self.tenant, site=self.site, name="K1",
                                          inner_width_mm=500, inner_height_mm=600)
        self.rail = DinRail.objects.create(cabinet=self.cab, label="R1", x_mm=0, y_mm=100,
                                           length_mm=400)
        self.plc_type = DeviceType.objects.create(tenant=self.tenant, name="PLC", width_mm=90,
                                                  height_mm=100, din_profiles=["ts35"])
        self.plc = Device.objects.create(tenant=self.tenant, name="plc-1", site=self.site,
                                         device_type=self.plc_type, cabinet=self.cab,
                                         din_rail=self.rail, din_offset_mm=0)
        self.tile = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                                 x=2, y=2, width=1, height=1,
                                                 link_kind="cabinet", cabinet=self.cab)

    def test_a_tile_links_to_a_cabinet_of_the_tenant(self):
        r = self.client.post("/api/floor-plan-tiles/", {
            "floor_plan_id": str(self.plan.id), "tile_type_id": str(self.tt.id),
            "x": 5, "y": 5, "link_kind": "cabinet", "link_id": str(self.cab.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["linked"]["kind"], "cabinet")
        self.assertEqual(r.json()["linked"]["route"], f"/cabinets/{self.cab.id}")
        theirs = Cabinet.objects.create(tenant=self.other, site=self.other_rack.site, name="X",
                                        inner_width_mm=100, inner_height_mm=100)
        r = self.client.post("/api/floor-plan-tiles/", {
            "floor_plan_id": str(self.plan.id), "tile_type_id": str(self.tt.id),
            "x": 6, "y": 6, "link_kind": "cabinet", "link_id": str(theirs.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        listed = self.client.get(f"/api/floor-plan-tiles/?cabinet={self.cab.id}").json()
        self.assertEqual(len(listed["results"]), 2)

    def test_a_tile_links_to_one_thing(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R9")
        with self.assertRaises(IntegrityError), transaction.atomic():
            FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=0, y=0,
                                         rack=rack, cabinet=self.cab)

    def test_the_overlay_counts_the_cabinets_devices(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/state/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["tiles"][str(self.tile.id)], {
            "kind": "cabinet", "device_count": 1, "rail_count": 1, "check": None,
        })

    def test_routes_reach_a_device_through_its_cabinet(self):
        FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=8, y=2,
                                     link_kind="rack", rack=self.rack)
        url = f"/api/floor-plans/{self.plan.id}/route/"
        r = self.client.post(url, {"from": {"kind": "device", "id": str(self.plc.id)},
                                   "to": {"kind": "rack", "id": str(self.rack.id)}},
                             format="json")
        self.assertNotIn(r.status_code, (400, 500), r.content)
        r = self.client.post(url, {"from": {"kind": "cabinet", "id": str(self.cab.id)},
                                   "to": {"kind": "rack", "id": str(self.rack.id)}},
                             format="json")
        self.assertNotIn(r.status_code, (400, 500), r.content)

    def test_a_device_in_neither_is_not_on_the_plan(self):
        # It used to match any tile without a rack - the cabinet's tile here.
        loose = Device.objects.create(tenant=self.tenant, name="loose", site=self.site)
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/route/", {
            "from": {"kind": "device", "id": str(loose.id)},
            "to": {"kind": "cabinet", "id": str(self.cab.id)},
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["detail"],
                         "That device (or its rack or cabinet) isn't placed on this plan.")
        r = self.client.post(f"/api/floor-plans/{self.plan.id}/route/", {
            "from": {"kind": "device", "id": "nope"},
            "to": {"kind": "cabinet", "id": str(self.cab.id)},
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_cable_from_a_cabinet_device_ends_on_the_cabinets_tile(self):
        rack_tile = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt,
                                                 x=8, y=2, link_kind="rack", rack=self.rack)
        sw = Device.objects.create(tenant=self.tenant, name="sw-1", site=self.site,
                                   rack=self.rack)
        a = Interface.objects.create(device=self.plc, name="eth0")
        b = Interface.objects.create(device=sw, name="Gi1/0/1")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=a)
        CableTermination.objects.create(cable=cable, end="B", interface=b)
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/cable-paths/")
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = [c for c in r.json()["cables"] if c["id"] == str(cable.id)]
        self.assertEqual((row["a_tiles"], row["b_tiles"]),
                         ([str(self.tile.id)], [str(rack_tile.id)]))

    def test_the_room_draws_the_cabinet_as_a_box(self):
        r = self.client.get(f"/api/floor-plans/{self.plan.id}/scene/")
        self.assertEqual(r.status_code, 200, r.content)
        (tile,) = [t for t in r.json()["tiles"] if t["id"] == str(self.tile.id)]
        self.assertEqual(tile["kind"], "cabinet")
        self.assertEqual(tile["cabinet"], {
            "id": str(self.cab.id), "name": "K1", "outer_width_mm": 550,
            "outer_height_mm": 650, "outer_depth_mm": 200, "device_count": 1,
        })
