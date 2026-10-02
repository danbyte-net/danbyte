"""Devices on DIN rails (#277): a device sits in a cabinet, on one of its rails
at an offset where its type's width fits, at the cabinet's site; rails,
cabinets and types refuse changes their devices would not survive."""

from __future__ import annotations

from .models import Cabinet, Device, DeviceType, DinRail, Location
from .search_index import SPECS, _context
from .tests_cabinets import CabinetTestCase
from .tests_din_rails import rail


class DinMountingTestCase(CabinetTestCase):
    def setUp(self):
        super().setUp()
        self.hall = Location.objects.create(tenant=self.tenant, site=self.site, name="Hall A")
        cab = self._cabinet(location_id=str(self.hall.id), rails=[
            rail("R1", 0, 100, 400), rail("R2", 0, 300, 400, "ts15"),
        ]).json()
        self.cab = Cabinet.objects.get(pk=cab["id"])
        self.r1 = DinRail.objects.get(cabinet=self.cab, label="R1")
        self.r2 = DinRail.objects.get(cabinet=self.cab, label="R2")
        self.plc = DeviceType.objects.create(tenant=self.tenant, name="PLC", width_mm=90,
                                             height_mm=100, din_profiles=["ts35"])
        self.relay = DeviceType.objects.create(tenant=self.tenant, name="Relay", width_mm=18,
                                               height_mm=80, din_profiles=["ts35", "ts15"])
        self.switch = DeviceType.objects.create(tenant=self.tenant, name="Switch", u_height=1)

    def mount(self, name, rail_=None, offset=None, dtype=None, **extra):
        body = {"name": name, "device_type_id": str((dtype or self.plc).id), **extra}
        if rail_ is not None:
            body["din_rail_id"] = str(rail_.id)
        if offset is not None:
            body["din_offset_mm"] = offset
        return self.client.post("/api/devices/", body, format="json")


class DevicePlacementTests(DinMountingTestCase):
    def test_a_rail_puts_the_device_in_its_cabinet_site_and_location(self):
        r = self.mount("plc-1", self.r1, 10)
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual(d["cabinet"], {"id": str(self.cab.id), "name": "K1"})
        self.assertEqual(d["din_rail"], {"id": str(self.r1.id), "label": "R1", "profile": "ts35"})
        self.assertEqual(d["din_offset_mm"], 10.0)
        self.assertEqual(d["site"]["id"], str(self.site.id))
        self.assertEqual(d["location"]["id"], str(self.hall.id))
        self.assertEqual(d["device_type"]["width_mm"], 90.0)

    def test_without_an_offset_the_first_gap_is_taken(self):
        self.assertEqual(self.mount("a", self.r1, 100).json()["din_offset_mm"], 100.0)
        got = [self.mount(n, self.r1).json()["din_offset_mm"] for n in ("b", "c", "d")]
        self.assertEqual(got, [0.0, 190.0, 280.0])
        r = self.mount("e", self.r1)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"din_rail_id": ["No gap on R1 is 90 mm wide."]})
        # A narrower device still fits the 30 mm left at the end.
        self.assertEqual(self.mount("f", self.r1, dtype=self.relay).json()["din_offset_mm"], 370.0)

    def test_devices_may_touch_but_not_overlap_or_run_off_the_rail(self):
        self.assertEqual(self.mount("a", self.r1, 0).status_code, 201)
        r = self.mount("b", self.r1, 89.9)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"din_offset_mm": ["Overlaps a at 0-90 mm."]})
        self.assertEqual(self.mount("b", self.r1, 90).status_code, 201)
        r = self.mount("c", self.r1, 310.1)
        self.assertEqual(r.json(), {"din_offset_mm": ["Runs past the rail's end (400 mm)."]})

    def test_the_type_must_mount_on_the_rails_profile(self):
        r = self.mount("sw", self.r1, 0, dtype=self.switch)
        self.assertEqual(r.json(), {"din_rail_id": ["Give the device a type that mounts on DIN rails."]})
        r = self.mount("plc", self.r2, 0)
        self.assertEqual(r.json(), {"din_rail_id": ["PLC does not mount on a TS 15 rail."]})
        self.assertEqual(self.mount("relay", self.r2, 0, dtype=self.relay).status_code, 201)

    def test_placement_rules(self):
        from .models import Rack

        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R-1")
        r = self.mount("a", self.r1, 0, rack_id=str(rack.id))
        self.assertEqual(r.json(), {"cabinet_id": ["A device sits in a rack or a cabinet, not both."]})
        other = self._cabinet(name="K2", rails=[rail("R1", 0, 100, 400)]).json()
        r = self.mount("a", self.r1, 0, cabinet_id=other["id"])
        self.assertEqual(r.json(), {"din_rail_id": ["Pick a rail in the device's cabinet."]})
        r = self.mount("a", None, 0, cabinet_id=str(self.cab.id))
        self.assertEqual(r.json(), {"din_offset_mm": ["An offset needs a rail."]})
        # In the cabinet without a rail is fine.
        r = self.mount("a", None, None, cabinet_id=str(self.cab.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["din_rail"])

    def test_the_device_is_at_its_cabinets_site(self):
        r = self.mount("a", self.r1, 0, site_id=str(self.site2.id))
        self.assertEqual(r.json(), {"site_id": ["K1 is at plant-1; the device must be too."]})
        d = Device.objects.create(tenant=self.tenant, name="b", site=self.site2,
                                  device_type=self.plc)
        r = self.client.patch(f"/api/devices/{d.id}/", {"din_rail_id": str(self.r1.id)},
                              format="json")
        self.assertEqual(r.json(), {"cabinet_id": ["K1 is at plant-1; the device must be too."]})
        ok = self.mount("c", self.r1, 0).json()
        r = self.client.patch(f"/api/devices/{ok['id']}/", {"site_id": str(self.site2.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("site_id", r.json())

    def test_leaving_the_rail_or_the_cabinet(self):
        d = self.mount("a", self.r1, 50).json()
        url = f"/api/devices/{d['id']}/"
        r = self.client.patch(url, {"din_rail_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["cabinet"]["name"], r.json()["din_rail"],
                          r.json()["din_offset_mm"]), ("K1", None, None))
        self.client.patch(url, {"din_rail_id": str(self.r1.id), "din_offset_mm": 50},
                          format="json")
        r = self.client.patch(url, {"cabinet_id": None}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["cabinet"], r.json()["din_rail"], r.json()["din_offset_mm"]),
                         (None, None, None))
        # Another rail without an offset takes its first gap.
        self.mount("b", self.r1, 0, dtype=self.relay)
        r = self.client.patch(url, {"din_rail_id": str(self.r1.id)}, format="json")
        self.assertEqual(r.json()["din_offset_mm"], 18.0)

    def test_a_new_type_is_placed_again(self):
        self.mount("a", self.r1, 0, dtype=self.relay)
        b = self.mount("b", self.r1, 18, dtype=self.relay).json()
        r = self.client.patch(f"/api/devices/{b['id']}/", {"device_type_id": str(self.switch.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        a = Device.objects.get(name="a")
        r = self.client.patch(f"/api/devices/{a.id}/", {"device_type_id": str(self.plc.id)},
                              format="json")
        self.assertEqual(r.json(), {"din_offset_mm": ["Overlaps b at 18-36 mm."]})

    def test_another_tenants_rail_is_not_found(self):
        theirs = Cabinet.objects.create(tenant=self.tenant2, site=self.their_site, name="X",
                                        inner_width_mm=500, inner_height_mm=600)
        their_rail = DinRail.objects.create(cabinet=theirs, label="R1", x_mm=0, y_mm=100,
                                            length_mm=400)
        r = self.mount("a", their_rail, 0)
        self.assertEqual(r.status_code, 400)
        self.assertIn("din_rail_id", r.json())
        self.assertFalse(Device.objects.filter(din_rail=their_rail).exists())

    def test_filters(self):
        self.mount("a", self.r1, 0)
        self.mount("b", self.r2, 0, dtype=self.relay)
        Device.objects.create(tenant=self.tenant, name="c", site=self.site)

        def names(q):
            return [d["name"] for d in self.client.get(f"/api/devices/?{q}").json()["results"]]

        self.assertEqual(names(f"cabinet={self.cab.id}"), ["a", "b"])
        self.assertEqual(names(f"din_rail={self.r2.id}"), ["b"])
        self.assertEqual(self.client.get("/api/devices/?cabinet=nope").status_code, 400)
        # What a rail's Assign offers: devices whose type fits its profile.
        self.assertEqual(names("din_profile=ts15"), ["b"])
        self.assertEqual(names("din_profile=ts35"), ["a", "b"])
        self.assertEqual(self.client.get("/api/devices/?din_profile=x").status_code, 400)

    def test_the_rail_field_reads_din(self):
        from .field_labels import label_for_field

        self.assertEqual(label_for_field("api.device", Device._meta.get_field("din_rail")),
                         "DIN rail")

    def test_search_shows_where_on_the_rail(self):
        d = Device.objects.get(pk=self.mount("plc-1", self.r1, 120).json()["id"])
        self.assertEqual(_context(d, SPECS["device"])["cabinet"], "K1 · R1 @ 120 mm")


class RailsWithDevicesTests(DinMountingTestCase):
    def setUp(self):
        super().setUp()
        self.mount("plc-1", self.r1, 200)
        self.url = f"/api/cabinets/{self.cab.id}/"
        self.rails = self.client.get(self.url).json()["rails"]

    def test_a_rail_with_devices_cannot_be_removed(self):
        r = self.client.patch(self.url, {"rails": [self.rails[1]]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"rails": ["R1 carries 1 device (plc-1) - move them first."]})

    def test_a_rail_keeps_room_and_a_profile_for_its_devices(self):
        r1 = {**self.rails[0], "length_mm": 280}
        r = self.client.patch(self.url, {"rails": [r1, self.rails[1]]}, format="json")
        self.assertEqual(r.json(), {"rails": [
            {"length_mm": ["Too short for its devices (needs 290 mm)."]}, {},
        ]})
        r1 = {**self.rails[0], "profile": "g32"}
        r = self.client.patch(self.url, {"rails": [r1, self.rails[1]]}, format="json")
        self.assertEqual(r.json()["rails"][0], {"profile": ["plc-1 cannot mount on a G 32 rail."]})
        # Moving the rail is fine: its devices move with it.
        r1 = {**self.rails[0], "x_mm": 50, "y_mm": 120, "length_mm": 300}
        r = self.client.patch(self.url, {"rails": [r1, self.rails[1]]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_cabinet_with_devices_on_its_rails_is_not_deleted(self):
        loose = Device.objects.create(tenant=self.tenant, name="loose", site=self.site,
                                      cabinet=self.cab)
        r = self.client.delete(self.url)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json(), {"detail": "1 device is on its rails - take them off first."})
        Device.objects.filter(name="plc-1").update(din_rail=None, din_offset_mm=None)
        self.assertEqual(self.client.delete(self.url).status_code, 204)
        loose.refresh_from_db()
        self.assertIsNone(loose.cabinet)

    def test_a_cabinet_with_devices_stays_at_its_site(self):
        r = self.client.patch(self.url, {"site_id": str(self.site2.id), "location_id": None},
                              format="json")
        self.assertEqual(r.json(), {"site_id": ["1 device is in it, at its site - move them out first."]})
        r = self.client.get(self.url)
        self.assertEqual(r.json()["device_count"], 1)

    def test_sync_does_not_strand_devices(self):
        t = self._type(name="T", rail_templates=[rail("R1", 0, 100, 250),
                                                 rail("R3", 0, 500, 400)]).json()
        Cabinet.objects.filter(pk=self.cab.pk).update(cabinet_type_id=t["id"])
        url = f"/api/cabinets/{self.cab.id}/sync-from-type/"
        diff = self.client.post(url, {}, format="json").json()["diff"]["rails"]
        self.assertEqual(diff["blocked"], [{
            "label": "R1", "changes": {"length_mm": {"cabinet": 400.0, "type": 250.0}},
            "reason": "Too short for its devices (needs 290 mm).",
        }])
        self.assertEqual((diff["add"], diff["update"], diff["extra"]), (["R3"], [], ["R2"]))
        r = self.client.post(url, {"apply": True, "sizes": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.r1.refresh_from_db()
        self.assertEqual(self.r1.length_mm, 400)
        self.assertTrue(DinRail.objects.filter(cabinet=self.cab, label="R3").exists())


class DinDeviceTypeTests(DinMountingTestCase):
    def test_a_din_type_needs_its_body_size_and_keeps_its_rail_on_it(self):
        r = self.client.post("/api/device-types/", {
            "name": "Breaker", "din_profiles": ["ts35"]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()), {"width_mm", "height_mm"})
        r = self.client.post("/api/device-types/", {
            "name": "Breaker", "din_profiles": ["ts15", "ts35", "ts35"], "width_mm": 17.5,
            "height_mm": 85, "din_rail_mm": 90}, format="json")
        self.assertEqual(r.json(), {"din_rail_mm": ["Below the body (85 mm tall)."]})
        r = self.client.post("/api/device-types/", {
            "name": "Breaker", "din_profiles": ["ts15", "ts35", "ts35"], "width_mm": 17.5,
            "height_mm": 85, "depth_mm": 70, "din_rail_mm": 42.5}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["din_profiles"], ["ts35", "ts15"])
        r = self.client.post("/api/device-types/", {"name": "X", "din_profiles": ["ts99"]},
                             format="json")
        self.assertIn("din_profiles", r.json())

    def test_devices_on_rails_survive_a_changed_type(self):
        self.mount("a", self.r1, 0, dtype=self.relay)
        self.mount("b", self.r1, 18, dtype=self.relay)
        self.mount("c", self.r2, 0, dtype=self.relay)
        url = f"/api/device-types/{self.relay.id}/"
        r = self.client.patch(url, {"width_mm": 20}, format="json")
        self.assertEqual(r.json(), {"width_mm": ["a would overlap b on K1 R1."]})
        r = self.client.patch(url, {"din_profiles": ["ts35"]}, format="json")
        self.assertEqual(r.json(), {"din_profiles": ["c is on rails of another profile."]})
        r = self.client.patch(url, {"width_mm": 17.5, "height_mm": 70}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_bundle_carries_the_din_fields(self):
        from rest_framework.exceptions import ValidationError

        from .device_library import export_bundle, import_bundle

        bundle = export_bundle(self.relay)
        self.assertEqual(bundle["din_profiles"], ["ts35", "ts15"])
        import_bundle({**bundle, "name": "Relay 2", "din_profiles": ["g32", "nope"]},
                      self.tenant)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Relay 2")
        self.assertEqual((dt.din_profiles, dt.width_mm), (["g32"], 18))
        # Replacing a type whose devices are on rails must not strand them.
        self.mount("a", self.r1, 0, dtype=self.relay)
        self.mount("b", self.r1, 18, dtype=self.relay)
        with self.assertRaises(ValidationError):
            import_bundle({**bundle, "width_mm": 30}, self.tenant, replace=True)
        self.relay.refresh_from_db()
        self.assertEqual(self.relay.width_mm, 18)


class DinRoundTripTests(DinMountingTestCase):
    def test_a_mounted_device_exports_and_imports_unchanged(self):
        self.mount("plc-1", self.r1, 120)
        # A second cabinet with an R1 of its own: labels repeat across cabinets.
        other = self._cabinet(name="K2", rails=[rail("R1", 0, 100, 400)]).json()
        self.mount("plc-2", DinRail.objects.get(cabinet_id=other["id"]), 0)
        r = self.client.get("/api/io/device/export/?fmt=csv")
        text = b"".join(r.streaming_content).decode()
        r = self.client.post("/api/io/device/import/", {"format": "csv", "content": text},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["errors"], body["created"]), ([], 0), body)
        d1, d2 = Device.objects.get(name="plc-1"), Device.objects.get(name="plc-2")
        self.assertEqual((d1.din_rail_id, d1.din_offset_mm), (self.r1.id, 120))
        self.assertEqual(d2.cabinet.name, "K2")


class ArrangeTests(DinMountingTestCase):
    """Many moves in one save, checked as a whole (the cabinet page's
    Arrange mode)."""

    def setUp(self):
        super().setUp()
        self.a = Device.objects.get(pk=self.mount("a", self.r1, 0).json()["id"])
        self.b = Device.objects.get(pk=self.mount("b", self.r1, 90).json()["id"])
        self.relay = Device.objects.get(
            pk=self.mount("relay", self.r2, 0, dtype=self.relay).json()["id"])
        self.url = f"/api/cabinets/{self.cab.id}/arrange/"

    def place(self, device, rail_, offset):
        return {"device_id": str(device.id),
                "din_rail_id": str(rail_.id) if rail_ else None, "din_offset_mm": offset}

    def arrange(self, *placements):
        return self.client.post(self.url, {"placements": list(placements)}, format="json")

    def where(self, device):
        device.refresh_from_db()
        return (device.din_rail_id, device.din_offset_mm)

    def test_two_devices_swap_places_in_one_save(self):
        r = self.arrange(self.place(self.a, self.r1, 90), self.place(self.b, self.r1, 0))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.where(self.a), (self.r1.id, 90))
        self.assertEqual(self.where(self.b), (self.r1.id, 0))
        self.assertEqual(len(r.json()["devices"]), 2)

    def test_moves_across_rails_and_off_a_rail(self):
        r = self.arrange(self.place(self.relay, self.r1, 200), self.place(self.b, None, None))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.where(self.relay), (self.r1.id, 200))
        self.assertEqual(self.where(self.b), (None, None))
        self.b.refresh_from_db()
        self.assertEqual(self.b.cabinet_id, self.cab.id)

    def test_a_bad_arrangement_changes_nothing(self):
        # a leaves R1 in the same save, so the relay meets b, not a.
        r = self.arrange(self.place(self.relay, self.r1, 80), self.place(self.a, self.r2, 0))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"placements": [
            {"din_offset_mm": ["Overlaps b at 90-180 mm."]},
            {"din_rail_id": ["PLC does not mount on a TS 15 rail."]},
        ]})
        r = self.arrange(self.place(self.b, self.r1, 350))
        self.assertEqual(r.json(), {"placements": [
            {"din_offset_mm": ["Runs past the rail's end (400 mm)."]},
        ]})
        self.assertEqual(self.where(self.a), (self.r1.id, 0))
        self.assertEqual(self.where(self.relay), (self.r2.id, 0))

    def test_only_this_cabinets_devices_and_rails(self):
        other = self._cabinet(name="K2", rails=[rail("R1", 0, 100, 400)]).json()
        far = DinRail.objects.get(cabinet_id=other["id"])
        stranger = Device.objects.get(pk=self.mount("x", far, 0).json()["id"])
        r = self.arrange(self.place(stranger, self.r1, 300), self.place(self.a, far, 0),
                         self.place(self.a, self.r1, 0), {"device_id": "nope"})
        errors = r.json()["placements"]
        self.assertEqual(errors[1], {"din_rail_id": ["Not one of this cabinet's rails."]})
        self.assertEqual(errors[2], {"device_id": ["This device is listed twice."]})
        self.assertEqual(errors[3], {"device_id": ["Not an id."]})
        r = self.arrange(self.place(stranger, self.r1, 300))
        self.assertEqual(r.json(), {"placements": [{"device_id": ["Not a device in this cabinet."]}]})
        self.assertEqual(self.arrange().status_code, 400)

    def test_arranging_needs_change_on_the_devices(self):
        viewer = self._limited_user("viewer", ["cabinet", "device"], ["view"])
        self._login(viewer)
        r = self.arrange(self.place(self.a, self.r1, 200))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.where(self.a), (self.r1.id, 0))
        mover = self._limited_user("mover", ["cabinet", "device"], ["view", "change"])
        self._login(mover)
        r = self.arrange(self.place(self.a, self.r1, 200))
        self.assertEqual(r.status_code, 200, r.content)

    def test_each_moved_device_is_logged(self):
        from audit.models import ChangeLogEntry

        self.arrange(self.place(self.a, self.r1, 200))
        entry = ChangeLogEntry.objects.filter(object_type="api.device", object_id=str(self.a.id),
                                              action="update").latest("timestamp")
        self.assertIn("din_offset_mm", entry.changes)
