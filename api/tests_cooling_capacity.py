"""Cooling (#434): how hardware is cooled, what a rack's cooling takes and
how much heat it removes - the attributes, how they travel (rack types,
bundles, the spreadsheet import), the heat a rack carries against its
capacity, and which hardware a rack may take."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .devicetype_import import import_racktype_yaml
from .models import (
    Device,
    DeviceType,
    Manufacturer,
    ModuleType,
    Rack,
    RackType,
    Site,
)

User = get_user_model()


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
