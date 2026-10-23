"""Cooling sources on floor plans (#434): a tile links to a cooling source as
it links to a power panel - tenant-checked, one link at a time, cleared when
the source goes, and found again by ``?cooling_source=``."""

from __future__ import annotations

from django.db import IntegrityError, transaction

from .models import CoolingSource, FloorPlan, FloorPlanTile, FloorTileType, Site
from .tests_floorplan import _Base


class FloorPlanCoolingTests(_Base):
    def setUp(self):
        super().setUp()
        self.plan = FloorPlan.objects.create(tenant=self.tenant, location=self.loc,
                                             name="Hall A")
        self.tt = FloorTileType.objects.create(tenant=self.tenant, name="CRAH", slug="crah")
        self.crah = CoolingSource.objects.create(
            tenant=self.tenant, site=self.site, name="CRAH-1", type="crah",
            rated_capacity_w=30000)

    def tile(self, link_id, **kw):
        return self.client.post("/api/floor-plan-tiles/", {
            "floor_plan_id": str(self.plan.id), "tile_type_id": str(self.tt.id),
            "x": kw.get("x", 3), "y": 3, "link_kind": "coolingsource", "link_id": link_id,
        }, format="json")

    def test_a_tile_links_to_a_cooling_source_of_the_tenant(self):
        r = self.tile(str(self.crah.id))
        self.assertEqual(r.status_code, 201, r.content)
        linked = r.json()["linked"]
        self.assertEqual((linked["kind"], linked["name"]), ("coolingsource", "CRAH-1"))
        self.assertEqual(linked["route"], f"/cooling-sources/{self.crah.id}")
        listed = self.client.get(f"/api/floor-plan-tiles/?cooling_source={self.crah.id}")
        self.assertEqual(len(listed.json()["results"]), 1)

        site = Site.objects.get(tenant=self.other)
        theirs = CoolingSource.objects.create(tenant=self.other, site=site, name="X")
        self.assertEqual(self.tile(str(theirs.id), x=5).status_code, 400)

    def test_relinking_clears_the_source(self):
        tile = FloorPlanTile.objects.get(pk=self.tile(str(self.crah.id)).json()["id"])
        r = self.client.patch(f"/api/floor-plan-tiles/{tile.id}/", {
            "link_kind": "rack", "link_id": str(self.rack.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        tile.refresh_from_db()
        self.assertIsNone(tile.cooling_source_id)
        self.assertEqual(tile.rack_id, self.rack.id)

    def test_a_tile_links_to_one_thing(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=0, y=0,
                                         rack=self.rack, cooling_source=self.crah)

    def test_deleting_the_source_unlinks_the_tile(self):
        tile = FloorPlanTile.objects.create(floor_plan=self.plan, tile_type=self.tt, x=1, y=1,
                                            link_kind="coolingsource",
                                            cooling_source=self.crah)
        self.assertEqual(self.client.delete(f"/api/cooling-sources/{self.crah.id}/")
                         .status_code, 204)
        tile.refresh_from_db()
        self.assertIsNone(tile.cooling_source_id)
