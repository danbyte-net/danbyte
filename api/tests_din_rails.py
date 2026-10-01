"""DIN rails on a cabinet's mounting plate (#277): written as a set through
the cabinet or its type, checked as a set (on the plate, no overlaps, unique
labels), copied from the type, synced from it, and logged on the parent."""

from __future__ import annotations

from audit.models import ChangeLogEntry

from .models import Cabinet, CabinetType, DinRail, DinRailTemplate
from .tests_cabinets import CabinetTestCase


def rail(label, x, y, length, profile="ts35", **extra):
    return {"label": label, "profile": profile, "x_mm": x, "y_mm": y,
            "length_mm": length, **extra}


class DinRailTests(CabinetTestCase):
    def setUp(self):
        super().setUp()
        # A 500 x 600 mm plate.
        self.cab = self._cabinet().json()
        self.url = f"/api/cabinets/{self.cab['id']}/"

    def put_rails(self, rails):
        return self.client.patch(self.url, {"rails": rails}, format="json")

    def test_rails_round_trip_in_plate_order(self):
        r = self.put_rails([rail("R2", 20, 300, 460), rail("R1", 20, 100.5, 460, "ts15")])
        self.assertEqual(r.status_code, 200, r.content)
        got = [(x["label"], x["profile"], x["x_mm"], x["y_mm"], x["length_mm"])
               for x in r.json()["rails"]]
        self.assertEqual(got, [("R1", "ts15", 20.0, 100.5, 460.0),
                               ("R2", "ts35", 20.0, 300.0, 460.0)])
        listed = self.client.get(f"/api/cabinets/?site={self.site.id}").json()["results"]
        self.assertEqual([x["label"] for x in listed[0]["rails"]], ["R1", "R2"])

    def test_a_rail_must_lie_on_the_plate(self):
        r = self.put_rails([rail("R1", 50, 100, 460), rail("R2", 0, 10, 100),
                            rail("R3", 0, 590, 100), rail("R4", 0, 300, 100)])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["rails"], [
            {"length_mm": ["Runs past the plate's right edge (500 mm)."]},
            {"y_mm": ["Sticks out above the plate."]},
            {"y_mm": ["Sticks out below the plate (600 mm)."]},
            {},
        ])
        # Field rules first: at least 10 mm long, in tenths of a millimetre.
        r = self.put_rails([rail("R1", 0, 100, 5), rail("R2", 0, 300, 12.34)])
        self.assertEqual(r.status_code, 400)
        self.assertEqual([set(e) for e in r.json()["rails"]], [{"length_mm"}, {"length_mm"}])
        self.assertFalse(DinRail.objects.exists())

    def test_rails_may_touch_but_not_overlap(self):
        # Side by side on one line, and two bands stacked edge to edge.
        ok = [rail("A", 0, 100, 200), rail("B", 200, 100, 200), rail("C", 0, 135, 200)]
        self.assertEqual(self.put_rails(ok).status_code, 200)
        r = self.put_rails([*ok, rail("D", 150, 160, 100)])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["rails"][3], {"y_mm": ["Overlaps rail C."]})
        r = self.put_rails([rail("A", 0, 100, 200), rail("A", 300, 100, 100)])
        self.assertEqual(r.json()["rails"][1], {"label": ["Another rail has this label."]})

    def test_ids_keep_rails_and_omitted_rails_go(self):
        rails = self.put_rails([rail("R1", 0, 100, 400), rail("R2", 0, 300, 400)]).json()["rails"]
        r1, r2 = rails
        # Swap the labels, move R1, drop nothing - same rows.
        r = self.put_rails([{**r1, "label": "R2", "x_mm": 10},
                            {**r2, "label": "R1"}])
        self.assertEqual(r.status_code, 200, r.content)
        by_id = {x["id"]: x for x in r.json()["rails"]}
        self.assertEqual((by_id[r1["id"]]["label"], by_id[r1["id"]]["x_mm"]), ("R2", 10.0))
        self.assertEqual(by_id[r2["id"]]["label"], "R1")
        # Omit one: it goes; a rail without an id is new.
        r = self.put_rails([by_id[r1["id"]], rail("R3", 0, 500, 100)])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(sorted(x["label"] for x in r.json()["rails"]), ["R2", "R3"])
        self.assertFalse(DinRail.objects.filter(pk=r2["id"]).exists())

    def test_ids_must_be_this_cabinets_rails(self):
        other = self._cabinet(name="K2").json()
        theirs = self.client.patch(f"/api/cabinets/{other['id']}/",
                                   {"rails": [rail("X", 0, 100, 100)]},
                                   format="json").json()["rails"][0]
        r = self.put_rails([theirs])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["rails"][0], {"id": ["Not one of these rails."]})
        mine = self.put_rails([rail("R1", 0, 100, 100)]).json()["rails"][0]
        r = self.put_rails([mine, {**mine, "label": "R2", "y_mm": 300}])
        self.assertEqual(r.json()["rails"][1], {"id": ["This rail is listed twice."]})
        # On a new cabinet, ids name nothing: the rails are new.
        r = self._cabinet(name="K3", rails=[mine])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotEqual(r.json()["rails"][0]["id"], mine["id"])
        self.assertTrue(DinRail.objects.filter(pk=mine["id"]).exists())

    def test_the_plate_cannot_shrink_past_its_rails(self):
        self.put_rails([rail("R1", 0, 100, 450), rail("R2", 0, 550, 100)])
        r = self.client.patch(self.url, {"inner_width_mm": 400, "inner_height_mm": 500},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {
            "inner_width_mm": ["Rail R1: Runs past the plate's right edge (400 mm)."],
            "inner_height_mm": ["Rail R2: Sticks out below the plate (500 mm)."],
        })
        # Moving the rails in the same write is fine.
        r = self.client.patch(self.url, {
            "inner_width_mm": 400, "inner_height_mm": 500,
            "rails": [rail("R1", 0, 100, 400), rail("R2", 0, 450, 100)],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_rail_changes_are_logged_on_the_cabinet(self):
        self.put_rails([rail("R1", 20, 100, 460)])
        self.put_rails([rail("R1", 20, 100, 460)])          # no change, no entry
        entries = ChangeLogEntry.objects.filter(
            object_type="api.cabinet", object_id=self.cab["id"], changes__has_key="rails"
        )
        self.assertEqual(entries.count(), 1)
        self.assertEqual(entries.get().changes["rails"], {
            "old": None, "new": ["R1: TS 35 at 20.0, 100.0 mm, 460.0 mm long"],
        })
        self.assertEqual(entries.get().object_site_id, self.site.id)

    def test_deleting_the_cabinet_takes_its_rails(self):
        self.put_rails([rail("R1", 0, 100, 100)])
        self.assertEqual(self.client.delete(self.url).status_code, 204)
        self.assertFalse(DinRail.objects.exists())


class CabinetTypeRailTests(CabinetTestCase):
    def _type_with_rails(self, **extra):
        r = self._type(rail_templates=[rail("R1", 20, 100, 480), rail("R2", 20, 300, 480)],
                       **extra)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_a_new_cabinet_takes_its_types_rails(self):
        t = self._type_with_rails()
        self.assertEqual([x["label"] for x in t["rail_templates"]], ["R1", "R2"])
        r = self.client.post("/api/cabinets/", {
            "name": "K1", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([(x["label"], x["y_mm"]) for x in r.json()["rails"]],
                         [("R1", 100.0), ("R2", 300.0)])
        # Rails sent with it win, even none.
        r = self.client.post("/api/cabinets/", {
            "name": "K2", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "rails": [],
        }, format="json")
        self.assertEqual(r.json()["rails"], [])
        # A plate given smaller than the type's rails is refused on the plate.
        r = self.client.post("/api/cabinets/", {
            "name": "K3", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "inner_width_mm": 400,
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()), {"inner_width_mm"})
        self.assertFalse(Cabinet.objects.filter(name="K3").exists())

    def test_type_rails_are_checked_and_logged_on_the_type(self):
        t = self._type_with_rails()
        url = f"/api/cabinet-types/{t['id']}/"
        r = self.client.patch(url, {"rail_templates": [rail("R1", 20, 100, 480),
                                                       rail("R9", 20, 120, 100)]},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["rail_templates"][1], {"y_mm": ["Overlaps rail R1."]})
        r = self.client.patch(url, {"inner_height_mm": 250}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("inner_height_mm", r.json())
        r = self.client.patch(url, {"rail_templates": t["rail_templates"][:1]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(DinRailTemplate.objects.count(), 1)
        entry = ChangeLogEntry.objects.get(object_type="api.cabinettype",
                                           changes__has_key="rails")
        self.assertEqual(entry.changes["rails"]["new"],
                         ["R1: TS 35 at 20.0, 100.0 mm, 480.0 mm long"])

    def test_sync_from_type(self):
        t = self._type_with_rails()
        cab = self.client.post("/api/cabinets/", {
            "name": "K1", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "outer_depth_mm": 300,
            "rails": [rail("R1", 20, 120, 480), rail("X", 20, 500, 100)],
        }, format="json").json()
        url = f"/api/cabinets/{cab['id']}/sync-from-type/"
        r = self.client.post(url, {}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"applied": False, "diff": {
            "sizes": {"outer_depth_mm": {"cabinet": 300, "type": 210}},
            "rails": {"add": ["R2"],
                      "update": [{"label": "R1",
                                  "changes": {"y_mm": {"cabinet": 120.0, "type": 100.0}}}],
                      "extra": ["X"]},
        }})
        r = self.client.post(url, {"apply": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"applied": True, "diff": {
            "rails": {"add": [], "update": [], "extra": ["X"]},
        }})
        cabinet = Cabinet.objects.get(pk=cab["id"])
        self.assertEqual(cabinet.outer_depth_mm, 210)
        self.assertEqual(sorted(cabinet.rails.values_list("label", flat=True)), ["R1", "R2", "X"])
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=cab["id"], changes__has_key="rails").exists())

    def test_a_sync_that_does_not_fit_changes_nothing(self):
        t = self._type_with_rails()
        cab = self.client.post("/api/cabinets/", {
            "name": "K1", "site_id": str(self.site.id), "cabinet_type_id": t["id"],
            "outer_depth_mm": 300,
            "rails": [rail("R1", 20, 100, 480), rail("X", 20, 290, 480)],
        }, format="json").json()
        r = self.client.post(f"/api/cabinets/{cab['id']}/sync-from-type/",
                             {"apply": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"detail": "The type's rails do not fit this cabinet - "
                                              "R2: Overlaps rail X."})
        cabinet = Cabinet.objects.get(pk=cab["id"])
        self.assertEqual(cabinet.outer_depth_mm, 300)
        self.assertEqual(sorted(cabinet.rails.values_list("label", flat=True)), ["R1", "X"])

    def test_sync_needs_a_type_and_change(self):
        cab = self._cabinet().json()
        r = self.client.post(f"/api/cabinets/{cab['id']}/sync-from-type/", {}, format="json")
        self.assertEqual(r.status_code, 400)
        CabinetType.objects.create(tenant=self.tenant, name="T", inner_width_mm=500,
                                   inner_height_mm=600)
        Cabinet.objects.filter(pk=cab["id"]).update(cabinet_type=CabinetType.objects.get())
        self._login(self._limited_user("viewer", ["cabinet"], ["view"]))
        r = self.client.post(f"/api/cabinets/{cab['id']}/sync-from-type/",
                             {"apply": True}, format="json")
        self.assertEqual(r.status_code, 403)
