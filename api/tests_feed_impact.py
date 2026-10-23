"""The derived impact of a power or cooling source (#434): the ``affected``
action walks source → feeds → racks → devices and marks each rack and device
*outage* or *reduced redundancy*, listing only what the caller may view."""
from __future__ import annotations

from api.models import CoolingSource, PowerFeed, PowerPanel

from .tests_cooling import FEEDS, SOURCES, _Base


class AffectedTests(_Base):
    def test_source_takes_its_racks_and_devices_down(self):
        self.feed("A", rack=self.rack)
        self.feed("B", rack=self.rack2)
        other = CoolingSource.objects.create(tenant=self.tenant, site=self.site, name="CRAH-2")
        self.feed("Z", rack=self.rack2, source=other)
        body = self.client.get(f"{SOURCES}{self.crah.id}/affected/").json()
        self.assertEqual([f["name"] for f in body["feeds"]], ["A", "B"])
        self.assertEqual({r["name"]: r["level"] for r in body["racks"]},
                         {"R1": "outage", "R2": "reduced_redundancy"})
        self.assertEqual({d["name"]: d["level"] for d in body["devices"]},
                         {"srv1": "outage", "srv2": "reduced_redundancy"})
        kinds = [(i["object_type"], i["level"]) for i in body["impacts"]]
        self.assertEqual(kinds[0], ("coolingsource", "outage"))
        self.assertEqual(len(body["impacts"]), 1 + 2 + 2 + 2)

    def test_feed_and_power_paths(self):
        f = self.feed("A", rack=self.rack)
        body = self.client.get(f"{FEEDS}{f.id}/affected/").json()
        self.assertEqual([r["name"] for r in body["racks"]], ["R1"])
        self.assertEqual(body["impacts"][0]["object_type"], "coolingfeed")
        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="MDB")
        pf = PowerFeed.objects.create(tenant=self.tenant, power_panel=panel, name="P1",
                                      rack=self.rack2)
        body = self.client.get(f"/api/power-panels/{panel.id}/affected/").json()
        self.assertEqual([d["name"] for d in body["devices"]], ["srv2"])
        body = self.client.get(f"/api/power-feeds/{pf.id}/affected/").json()
        self.assertEqual([r["level"] for r in body["racks"]], ["outage"])

    def test_lists_only_what_the_caller_may_see(self):
        self.feed("A", rack=self.rack)
        self.member((["coolingsource"], ["view"], []), (["rack"], ["view"], []))
        body = self.client.get(f"{SOURCES}{self.crah.id}/affected/").json()
        self.assertEqual(body["feeds"], [])
        self.assertEqual([r["name"] for r in body["racks"]], ["R1"])
        self.assertEqual(body["devices"], [])
