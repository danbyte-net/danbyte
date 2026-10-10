"""``Rack.max_power_w``: a rack's power budget. When set, rack capacity
measures demand against it rather than the feeds or the PDUs' rating, on the
rack itself, a floor plan's live state and the site's Capacity tab."""
from __future__ import annotations

from .models import FloorPlanTile, PowerFeed, Rack
from .tests_rack_capacity import _Base


class RackPowerBudgetTests(_Base):
    def _power(self, rack):
        return self.client.get(f"/api/racks/{rack.id}/").json()["power"]

    def test_unset_changes_nothing(self):
        rack = self._rack(pdu_w=3680)
        self.assertIsNone(self.client.get(f"/api/racks/{rack.id}/").json()["max_power_w"])
        self.assertEqual(self._power(rack)["supply"], "pdu_rating")
        self.assertNotIn("supplied_w", self._power(rack))

    def test_the_budget_is_the_supply_and_the_feeds_are_kept(self):
        rack = self._rack()
        PowerFeed.objects.create(
            tenant=self.tenant, power_panel=self.panel, rack=rack, name="A",
            voltage=230, amperage=16, max_utilization=80,
        )
        Rack.objects.filter(pk=rack.pk).update(max_power_w=2000)
        self.assertEqual(self._power(rack), {
            "available_w": 2000, "allocated_w": 400, "maximum_w": 800,
            "supply": "budget", "supplied_w": 2944,
        })

    def test_a_budget_without_any_feed(self):
        rack = self._rack(pdu_w=None)
        Rack.objects.filter(pk=rack.pk).update(max_power_w=1500)
        power = self._power(rack)
        self.assertEqual(
            (power["available_w"], power["supply"], power["supplied_w"]), (1500, "budget", 0)
        )

    def test_written_through_the_api(self):
        rack = self._rack()
        r = self.client.patch(f"/api/racks/{rack.id}/", {"max_power_w": 4200}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["max_power_w"], 4200)
        self.assertEqual(r.json()["power"]["available_w"], 4200)
        r = self.client.patch(f"/api/racks/{rack.id}/", {"max_power_w": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["power"]["supply"], "pdu_rating")
        r = self.client.patch(f"/api/racks/{rack.id}/", {"max_power_w": -5}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_floor_plan_state_and_site_capacity_use_it(self):
        rack = self._rack()
        Rack.objects.filter(pk=rack.pk).update(max_power_w=1000)
        plan = self._plan("budget", [rack])
        tile = FloorPlanTile.objects.get(floor_plan=plan)
        state = self.client.get(f"/api/floor-plans/{plan.id}/state/").json()
        self.assertEqual(state["tiles"][str(tile.id)]["power"]["available_w"], 1000)
        body = self.client.get(f"/api/sites/{self.site.id}/capacity/").json()
        totals = body["floor_plans"][0]["totals"]["power"]
        self.assertEqual(
            (totals["available_w"], totals["budget"], totals["pdu_rating"]), (1000, 1, 0)
        )
