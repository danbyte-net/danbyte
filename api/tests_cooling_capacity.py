"""Cooling (#434): how hardware is cooled, what a rack's cooling takes and
how much heat it removes - the attributes, how they travel (rack types,
bundles, the spreadsheet import), the heat a rack carries against its
capacity, and which hardware a rack may take."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import capacity
from .devicetype_import import import_racktype_yaml
from .models import (
    Device,
    DeviceType,
    Manufacturer,
    ModuleType,
    PowerOutlet,
    PowerPort,
    Rack,
    RackType,
    Site,
)

User = get_user_model()

#: The cooling methods each rack capability takes (#434) - the rule under
#: test, written out once more on purpose.
ADMITS = {
    "air": {"air"},
    "hybrid": {"air", "liquid", "hybrid"},
    "liquid": {"liquid", "hybrid"},
    "immersion": {"immersion"},
}
METHODS = ("air", "liquid", "hybrid", "immersion")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Vendor")
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def dtype(self, name, method="", **extra):
        return DeviceType.objects.create(
            tenant=self.tenant, name=name, manufacturer=self.mfr,
            cooling_method=method, **extra,
        )

    def rack(self, name="R12", capability="", capacity=None, **extra):
        return Rack.objects.create(
            tenant=self.tenant, site=self.site, name=name,
            cooling_capability=capability, cooling_capacity_w=capacity, **extra,
        )


class ChoicesTests(_Base):
    def test_the_choices_endpoint_serves_airflow_and_the_cooling_lists(self):
        body = self.client.get("/api/dcim/choices/").json()
        pairs = {k: [(r["value"], r["label"]) for r in body[k]]
                 for k in ("airflow", "cooling_method", "cooling_capability")}
        self.assertEqual(pairs["airflow"], list(Device._meta.get_field("airflow").choices))
        self.assertEqual(
            pairs["cooling_method"],
            [("air", "Air"), ("liquid", "Liquid"), ("hybrid", "Hybrid"),
             ("immersion", "Immersion")],
        )
        self.assertEqual(
            pairs["cooling_capability"],
            [("air", "Air"), ("hybrid", "Hybrid"), ("liquid", "Liquid"),
             ("immersion", "Immersion")],
        )
        # The model fields take exactly these lists.
        for model in (Device, DeviceType, ModuleType):
            self.assertEqual(
                list(model._meta.get_field("cooling_method").choices),
                pairs["cooling_method"],
            )
        for model in (Rack, RackType):
            self.assertEqual(
                list(model._meta.get_field("cooling_capability").choices),
                pairs["cooling_capability"],
            )


class HardwareAttributeTests(_Base):
    def test_effective_method_is_the_device_then_its_type_then_air(self):
        liquid = self.dtype("DLC node", "liquid")
        plain = self.dtype("Switch")
        own = Device.objects.create(
            tenant=self.tenant, name="own", device_type=liquid, cooling_method="hybrid")
        inherits = Device.objects.create(tenant=self.tenant, name="inherits", device_type=liquid)
        default = Device.objects.create(tenant=self.tenant, name="default", device_type=plain)
        bare = Device.objects.create(tenant=self.tenant, name="bare")
        self.assertEqual(
            [d.effective_cooling_method for d in (own, inherits, default, bare)],
            ["hybrid", "liquid", "air", "air"],
        )
        body = self.client.get(f"/api/devices/{inherits.id}/").json()
        self.assertEqual((body["cooling_method"], body["effective_cooling_method"]),
                         ("", "liquid"))
        # Clearing an override falls back to the type's.
        r = self.client.patch(f"/api/devices/{own.id}/", {"cooling_method": ""},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["effective_cooling_method"], "liquid")
        bad = self.client.patch(f"/api/devices/{own.id}/", {"cooling_method": "oil"},
                                format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("cooling_method", bad.json())

    def test_device_type_and_module_type_fields_round_trip(self):
        r = self.client.post(
            "/api/device-types/",
            {"name": "GPU node", "cooling_method": "liquid", "heat_output_w": 900},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["cooling_method"], r.json()["heat_output_w"]),
                         ("liquid", 900))
        clone = self.client.get(f"/api/device-types/{r.json()['id']}/clone/").json()
        self.assertEqual(clone["initial"]["cooling_method"], "liquid")
        self.assertEqual(clone["initial"]["heat_output_w"], 900)
        for bad in ({"heat_output_w": -1}, {"cooling_method": "oil"}):
            r2 = self.client.patch(f"/api/device-types/{r.json()['id']}/", bad,
                                   format="json")
            self.assertEqual(r2.status_code, 400, bad)
            self.assertIn(next(iter(bad)), r2.json())
        m = self.client.post("/api/module-types/",
                             {"name": "Cold plate", "cooling_method": "liquid"},
                             format="json")
        self.assertEqual(m.status_code, 201, m.content)
        self.assertEqual(m.json()["cooling_method"], "liquid")

    def test_a_device_clone_carries_its_method(self):
        d = Device.objects.create(tenant=self.tenant, name="n1", cooling_method="immersion")
        clone = self.client.get(f"/api/devices/{d.id}/clone/").json()
        self.assertEqual(clone["initial"]["cooling_method"], "immersion")

    def test_the_list_columns_name_the_choice_lists_and_the_switch(self):
        fields = {
            f["key"]: f for f in self.client.get(
                "/api/list-fields/", {"path": "/api/devices/"}).json()["fields"]
        }
        for key in ("cooling_method", "effective_cooling_method"):
            self.assertEqual(fields[key]["kind"], "choice")
            self.assertEqual(fields[key]["choices"], "cooling_method")
            self.assertEqual(fields[key]["setting"], "cooling_method")
        racks = {
            f["key"]: f for f in self.client.get(
                "/api/list-fields/", {"path": "/api/racks/"}).json()["fields"]
        }
        self.assertEqual(racks["cooling_capability"]["choices"], "cooling_capability")
        self.assertEqual(racks["cooling_capacity_w"]["label"], "Cooling capacity (W)")

    def test_planned_changes_offer_the_device_method(self):
        body = self.client.get("/api/editable-fields/", {"model": "device"}).json()
        spec = {f["key"]: f for f in body["fields"]}["cooling_method"]
        self.assertEqual((spec["kind"], spec["choices"]), ("choice", "cooling_method"))


class DeviceFieldVisibilityTests(_Base):
    def test_the_device_method_is_an_optional_field_off_by_default(self):
        self.assertIs(self.client.get("/api/device-fields/").json()["cooling_method"], False)
        self.assertIs(
            self.client.get("/api/deployment/device-fields/").json()["cooling_method"], False)
        r = self.client.put("/api/deployment/device-fields/", {"cooling_method": True},
                            format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIs(self.client.get("/api/device-fields/").json()["cooling_method"], True)


class RackTypeCoolingTests(_Base):
    def test_rack_type_fields_ride_the_picker_and_the_rack(self):
        r = self.client.post(
            "/api/rack-types/",
            {"name": "DLC cabinet", "cooling_capability": "liquid",
             "cooling_capacity_w": 40000, "max_power_w": 38000},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        row = self.client.get("/api/rack-types/?picker=1").json()["results"][0]
        self.assertEqual(
            (row["cooling_capability"], row["cooling_capacity_w"], row["max_power_w"]),
            ("liquid", 40000, 38000),
        )
        rack = self.rack(rack_type_id=r.json()["id"])
        embedded = self.client.get(f"/api/racks/{rack.id}/").json()["rack_type"]
        self.assertEqual(embedded["cooling_capability"], "liquid")
        self.assertEqual(embedded["cooling_capacity_w"], 40000)

    def test_sync_reports_and_copies_the_cooling(self):
        rt = RackType.objects.create(
            tenant=self.tenant, name="Tank", cooling_capability="immersion",
            cooling_capacity_w=50000, max_power_w=45000,
        )
        rack = self.rack(rack_type=rt)
        dry = self.client.post(f"/api/racks/{rack.id}/sync-from-type/", {},
                               format="json").json()
        self.assertEqual(dry["diff"]["dims"]["cooling_capability"],
                         {"rack": "", "type": "immersion"})
        self.assertEqual(dry["diff"]["dims"]["cooling_capacity_w"],
                         {"rack": None, "type": 50000})
        self.assertEqual(dry["diff"]["dims"]["max_power_w"],
                         {"rack": None, "type": 45000})
        r = self.client.post(f"/api/racks/{rack.id}/sync-from-type/",
                             {"apply": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rack.refresh_from_db()
        self.assertEqual(
            (rack.cooling_capability, rack.cooling_capacity_w, rack.max_power_w),
            ("immersion", 50000, 45000),
        )
        again = self.client.post(f"/api/racks/{rack.id}/sync-from-type/", {},
                                 format="json").json()
        self.assertNotIn("dims", again["diff"])

    def test_the_rack_type_file_keys(self):
        yaml = ("manufacturer: Vendor\nmodel: Tank 42\nwidth: 19\nu_height: 42\n"
                "cooling_capability: immersion\ncooling_capacity_w: 60000\n")
        r = import_racktype_yaml(self.tenant, yaml)
        self.assertTrue(r["ok"], r)
        rt = RackType.objects.get(tenant=self.tenant, name="Tank 42")
        self.assertEqual((rt.cooling_capability, rt.cooling_capacity_w),
                         ("immersion", 60000))
        bad = import_racktype_yaml(
            self.tenant,
            yaml.replace("Tank 42", "Tank 43").replace("immersion", "oil")
            .replace("60000", "-5"),
        )
        self.assertTrue(bad["ok"], bad)
        rt = RackType.objects.get(tenant=self.tenant, name="Tank 43")
        self.assertEqual((rt.cooling_capability, rt.cooling_capacity_w), ("", None))
        self.assertTrue(any("cooling_capability" in s for s in bad["skipped"]))
        self.assertTrue(any("cooling_capacity_w" in s for s in bad["skipped"]))


class TravelTests(_Base):
    """The attributes leave and come back unchanged: a device-type bundle and
    the spreadsheet export and import."""

    def test_a_bundle_round_trips_the_method_and_heat_output(self):
        dt = self.dtype("GPU node", "liquid", heat_output_w=1200)
        bundle = self.client.get(f"/api/device-types/{dt.id}/library-export/").json()
        self.assertEqual((bundle["cooling_method"], bundle["heat_output_w"]),
                         ("liquid", 1200))
        dt.delete()
        r = self.client.post("/api/device-types/import-bundle/", bundle, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        back = DeviceType.objects.get(tenant=self.tenant, name="GPU node")
        self.assertEqual((back.cooling_method, back.heat_output_w), ("liquid", 1200))
        bundle["name"] = "Bad node"
        bundle["cooling_method"] = "oil"
        bad = self.client.post("/api/device-types/import-bundle/", bundle, format="json")
        self.assertEqual(bad.status_code, 400, bad.content)
        self.assertFalse(DeviceType.objects.filter(name="Bad node").exists())

    def _export(self, slug):
        r = self.client.get(f"/api/io/{slug}/export/?fmt=csv")
        self.assertEqual(r.status_code, 200)
        return b"".join(r.streaming_content).decode()

    def _import(self, slug, text):
        r = self.client.post(f"/api/io/{slug}/import/",
                             {"format": "csv", "content": text}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_the_spreadsheet_round_trips_devices_and_racks(self):
        dt = self.dtype("DLC node", "liquid", heat_output_w=800)
        self.rack(capability="hybrid", capacity=30000)
        Device.objects.create(tenant=self.tenant, name="n1", site=self.site,
                              device_type=dt, cooling_method="hybrid")
        for slug in ("devicetype", "rack", "device"):
            text = self._export(slug)
            self.assertIn("cooling", text.splitlines()[0], slug)
            body = self._import(slug, text)
            self.assertEqual((body["errors"], body["created"]), ([], 0), (slug, body))
        dt.refresh_from_db()
        self.assertEqual((dt.cooling_method, dt.heat_output_w), ("liquid", 800))
        rack = Rack.objects.get(name="R12")
        self.assertEqual((rack.cooling_capability, rack.cooling_capacity_w),
                         ("hybrid", 30000))
        self.assertEqual(Device.objects.get(name="n1").cooling_method, "hybrid")
        # A changed cell is written.
        text = self._export("device").replace("hybrid", "immersion")
        self.assertEqual(self._import("device", text)["updated"], 1)
        self.assertEqual(Device.objects.get(name="n1").cooling_method, "immersion")


class HeatLoadTests(_Base):
    """A rack's heat against its cooling capacity (api.capacity.rack_cooling):
    each device's type heat output where set, else its power draw, PDUs
    aside."""

    def setUp(self):
        super().setUp()
        self.server = self.dtype("1U server", u_height=1)
        self.gpu = self.dtype("GPU node", "liquid", u_height=2, heat_output_w=1500)
        self.strip = self.dtype("PDU strip", u_height=0, heat_output_w=90)
        self.n = 0

    def device(self, rack, dtype, allocated=None, maximum=None, **extra):
        self.n += 1
        d = Device.objects.create(
            tenant=self.tenant, site=self.site, rack=rack, name=f"d{self.n}",
            device_type=dtype, **extra,
        )
        if allocated is not None or maximum is not None:
            PowerPort.objects.create(device=d, name="psu", allocated_draw=allocated,
                                     maximum_draw=maximum)
        return d

    def loaded(self, name="R1", capability="hybrid", capacity=10000):
        """300 W / 500 W, nothing allocated / 400 W, a GPU node whose type
        gives off 1500 W whatever it draws, and a PDU with outlets."""
        rack = self.rack(name, capability=capability, capacity=capacity)
        self.device(rack, self.server, 300, 500, position=1, face="front")
        self.device(rack, self.server, None, 400, position=2, face="front")
        self.device(rack, self.gpu, 2000, 2500, position=3, face="front")
        pdu = self.device(rack, self.strip, None, 3680, mount="side_left")
        PowerOutlet.objects.create(device=pdu, name="C13-1")
        return rack

    def get(self, rack):
        return self.client.get(f"/api/racks/{rack.id}/").json()

    def test_heat_is_the_types_output_else_the_draw_and_a_pdu_adds_none(self):
        body = self.get(self.loaded())
        self.assertEqual(body["cooling"], {
            "available_w": 10000, "heat_allocated_w": 300 + 1500,
            "heat_maximum_w": 500 + 400 + 1500, "supply": "budget", "mismatched": 0,
        })
        self.assertEqual(body["cooling_free_w"], 10000 - 1800)

    def test_without_a_capacity_there_is_no_supply(self):
        body = self.get(self.loaded(capacity=None))
        self.assertEqual(
            (body["cooling"]["available_w"], body["cooling"]["supply"],
             body["cooling"]["heat_allocated_w"]),
            (0, None, 1800),
        )
        self.assertIsNone(body["cooling_free_w"])

    def test_the_free_heat_filter_and_its_sql_agree_with_the_figures(self):
        roomy = self.loaded("roomy", capacity=10000)            # 8200 W free
        tight = self.loaded("tight", capacity=2000)             # 200 W free
        over = self.loaded("over", capacity=1000)               # -800 W free
        self.loaded("unrated", capacity=None)                   # no figure
        empty = self.rack("empty", capability="air", capacity=500)  # 500 W free

        def names(**params):
            r = self.client.get("/api/racks/", params)
            self.assertEqual(r.status_code, 200, r.content)
            return sorted(row["name"] for row in r.json()["results"])

        self.assertEqual(names(cooling_free_w_gte=1000), ["roomy"])
        self.assertEqual(names(cooling_free_w_gte=0), ["empty", "roomy", "tight"])
        self.assertEqual(names(cooling_free_w_gte=-5000),
                         ["empty", "over", "roomy", "tight"])
        bad = self.client.get("/api/racks/", {"cooling_free_w_gte": "lots"})
        self.assertEqual(bad.status_code, 400)
        self.assertIn("cooling_free_w_gte", bad.json())
        # The SQL the filter reads is the figure every row shows.
        sql = dict(
            Rack.objects.filter(tenant=self.tenant)
            .annotate(free=capacity.cooling_free_annotation())
            .values_list("name", "free")
        )
        rows = {r["name"]: r["cooling_free_w"]
                for r in self.client.get("/api/racks/").json()["results"]}
        self.assertEqual(sql, rows)
        self.assertEqual(
            (rows["roomy"], rows["tight"], rows["over"], rows["unrated"], rows["empty"]),
            (8200, 200, -800, None, 500),
        )
        self.assertEqual(self.get(over)["cooling"]["heat_allocated_w"], 1800)
        self.assertEqual(self.get(empty)["cooling"]["heat_allocated_w"], 0)
        self.assertEqual(self.get(tight)["cooling_free_w"], 200)
        self.assertEqual(self.get(roomy)["cooling_free_w"], 8200)

    def test_the_capability_filter(self):
        self.rack("a", capability="air")
        self.rack("l", capability="liquid")
        self.rack("n")

        def names(value):
            r = self.client.get("/api/racks/", {"cooling_capability": value})
            return r.status_code, sorted(row["name"] for row in r.json().get("results", []))

        self.assertEqual(names("liquid"), (200, ["l"]))
        self.assertEqual(names("none"), (200, ["n"]))
        self.assertEqual(names("oil")[0], 400)

    def test_a_page_of_racks_costs_the_same_whatever_they_hold(self):
        self.loaded("first")

        def count():
            self.client.get("/api/racks/")
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get("/api/racks/")
            self.assertEqual(r.status_code, 200)
            return len(ctx.captured_queries)

        small = count()
        for i in range(4):
            self.loaded(f"more{i}")
        self.assertEqual(count(), small)

    def test_a_site_adds_the_racks_up(self):
        self.loaded("R1")
        self.loaded("R2", capacity=None)
        body = self.client.get(f"/api/sites/{self.site.id}/capacity/").json()
        self.assertEqual(body["totals"]["cooling"], {
            "available_w": 10000, "heat_allocated_w": 3600, "heat_maximum_w": 4800,
            "budget": 1, "no_supply": 1, "mismatched": 0,
        })
        entry = {r["name"]: r for r in body["unplaced"]["racks"]}["R1"]
        self.assertEqual(entry["cooling"], self.get(Rack.objects.get(name="R1"))["cooling"])


class PlacementTests(_Base):
    """Which hardware a rack takes: the admit matrix on create, on update -
    a move into a rack, a re-typed device, a re-marked one - and through the
    spreadsheet import. A rack made stricter keeps its devices."""

    def setUp(self):
        super().setUp()
        # One type per method; "air" is a type with none set, which reads
        # as air.
        self.types = {m: self.dtype(f"{m} box", "" if m == "air" else m) for m in METHODS}
        self.racks = {c: self.rack(f"rack-{c}", capability=c) for c in ADMITS}
        self.n = 0

    def post(self, rack, method, **extra):
        self.n += 1
        return self.client.post("/api/devices/", {
            "name": f"dev{self.n}", "site_id": str(self.site.id),
            "rack_id": str(rack.id), "device_type_id": str(self.types[method].id),
            **extra,
        }, format="json")

    @staticmethod
    def refusal(capability, method, subject="this device type"):
        return f"Rack rack-{capability} is {capability}-cooled; {subject} is {method}-cooled."

    def test_create_every_cell(self):
        for capability, allowed in ADMITS.items():
            for method in METHODS:
                with self.subTest(capability=capability, method=method):
                    r = self.post(self.racks[capability], method)
                    if method in allowed:
                        self.assertEqual(r.status_code, 201, r.content)
                    else:
                        self.assertEqual(r.status_code, 400, r.content)
                        # The type sets every method but air, which is the
                        # default of a type with none.
                        subject = "this device" if method == "air" else "this device type"
                        self.assertEqual(r.json(), {
                            "rack_id": [self.refusal(capability, method, subject)]})

    def test_a_rack_without_a_capability_takes_anything(self):
        bare = self.rack("bare")
        for method in METHODS:
            self.assertEqual(self.post(bare, method).status_code, 201)

    def test_moving_into_a_rack_every_cell(self):
        for capability, allowed in ADMITS.items():
            for method in METHODS:
                with self.subTest(capability=capability, method=method):
                    d = Device.objects.create(
                        tenant=self.tenant, site=self.site, name=f"m-{capability}-{method}",
                        device_type=self.types[method])
                    r = self.client.patch(f"/api/devices/{d.id}/",
                                          {"rack_id": str(self.racks[capability].id)},
                                          format="json")
                    self.assertEqual(r.status_code, 200 if method in allowed else 400,
                                     r.content)
                    if method not in allowed:
                        self.assertIn("rack_id", r.json())

    def test_a_new_type_or_method_is_judged_on_the_field_that_changed(self):
        d = self.post(self.racks["liquid"], "liquid").json()
        url = f"/api/devices/{d['id']}/"
        r = self.client.patch(url, {"cooling_method": "air"}, format="json")
        self.assertEqual(r.json(), {"cooling_method": [
            self.refusal("liquid", "air", "this device")]})
        r = self.client.patch(url, {"device_type_id": str(self.types["immersion"].id)},
                              format="json")
        self.assertEqual(r.json(), {"device_type_id": [
            self.refusal("liquid", "immersion")]})
        # The device's own method stands over its type's.
        r = self.client.patch(url, {"cooling_method": "hybrid",
                                    "device_type_id": str(self.types["air"].id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["effective_cooling_method"], "hybrid")
        r = self.client.post("/api/devices/", {
            "name": "own-air", "rack_id": str(self.racks["liquid"].id),
            "device_type_id": str(self.types["liquid"].id), "cooling_method": "air",
        }, format="json")
        self.assertEqual(r.json(), {"rack_id": [self.refusal("liquid", "air", "this device")]})

    def test_a_stricter_rack_keeps_its_devices_and_lists_them(self):
        rack = self.racks["hybrid"]
        liquid = self.post(rack, "liquid").json()
        fits = self.post(rack, "air").json()
        r = self.client.patch(f"/api/racks/{rack.id}/", {"cooling_capability": "air"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cooling"]["mismatched"], 1)
        # Nothing is judged again until the placement, type or method changes:
        # the form sends the rack back unchanged.
        r = self.client.patch(f"/api/devices/{liquid['id']}/",
                              {"description": "kept", "rack_id": str(rack.id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

        def listed(**params):
            r = self.client.get("/api/devices/", {"rack": str(rack.id), **params})
            self.assertEqual(r.status_code, 200, r.content)
            return [row["id"] for row in r.json()["results"]]

        self.assertEqual(listed(cooling_mismatch="1"), [liquid["id"]])
        self.assertEqual(listed(cooling_mismatch="0"), [fits["id"]])
        self.assertEqual(
            self.client.get("/api/devices/", {"cooling_mismatch": "maybe"}).status_code, 400)

    def test_the_method_filter_reads_the_effective_method(self):
        Device.objects.create(tenant=self.tenant, name="own", cooling_method="immersion",
                              device_type=self.types["liquid"])
        Device.objects.create(tenant=self.tenant, name="typed", device_type=self.types["liquid"])
        Device.objects.create(tenant=self.tenant, name="plain", device_type=self.types["air"])
        Device.objects.create(tenant=self.tenant, name="bare")

        def names(method):
            r = self.client.get("/api/devices/", {"cooling_method": method})
            self.assertEqual(r.status_code, 200, r.content)
            return sorted(row["name"] for row in r.json()["results"])

        self.assertEqual(names("immersion"), ["own"])
        self.assertEqual(names("liquid"), ["typed"])
        self.assertEqual(names("air"), ["bare", "plain"])
        self.assertEqual(
            self.client.get("/api/devices/", {"cooling_method": "oil"}).status_code, 400)

    def test_the_import_refuses_what_the_form_refuses(self):
        rows = ["name,site,rack,device_type"]
        for capability in ADMITS:
            for method in METHODS:
                rows.append(f"imp-{capability}-{method},dc1,{self.racks[capability].id},"
                            f"{self.types[method].id}")
        r = self.client.post("/api/io/device/import/",
                             {"format": "csv", "content": "\n".join(rows) + "\n"},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        made = set(Device.objects.filter(name__startswith="imp-").values_list("name", flat=True))
        expected = {f"imp-{c}-{m}" for c, allowed in ADMITS.items() for m in allowed}
        self.assertEqual(made, expected)
        self.assertEqual(body["created"], len(expected))
        self.assertEqual(len(body["errors"]), 16 - len(expected))
        self.assertIn("is liquid-cooled", str(body["errors"]))

    def test_a_rack_move_takes_its_devices_as_they_are(self):
        # Moving a rack to another site keeps every device in its rack, so
        # the rule has nothing new to judge - not even a device placed
        # before the rack was made stricter.
        rack = self.racks["hybrid"]
        self.post(rack, "liquid")
        Rack.objects.filter(pk=rack.pk).update(cooling_capability="air")
        other = Site.objects.create(tenant=self.tenant, name="dc2")
        r = self.client.post(f"/api/racks/{rack.id}/move/", {"site_id": str(other.id)},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        rack.refresh_from_db()
        self.assertEqual((rack.site_id, rack.cooling_capability), (other.id, "air"))
        self.assertEqual(Device.objects.get(name="dev1").site_id, other.id)
