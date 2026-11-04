"""Cooling for hardware in a rack through another device (#469): a blade in
a chassis' device bay with no rack of its own, and a module installed in a
device. Both are judged by the rack that cools them, count in its
mismatch, and a blade's heat counts in its heat load."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import capacity
from .models import (
    Device,
    DeviceBay,
    DeviceType,
    Manufacturer,
    Module,
    ModuleBay,
    ModuleBayTemplate,
    ModuleType,
    PowerPort,
    Rack,
    Site,
    materialize_device_components,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Vendor")
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.chassis_t = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="chassis", u_height=2,
            subdevice_role="parent", heat_output_w=200,
        )
        self.blade_t = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="blade", u_height=0,
            subdevice_role="child", cooling_method="liquid", heat_output_w=500,
        )
        self.air_blade_t = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="air blade", u_height=0,
            subdevice_role="child",
        )
        self.liq_module = ModuleType.objects.create(
            tenant=self.tenant, name="liq-module", cooling_method="liquid",
        )
        self.air_module = ModuleType.objects.create(tenant=self.tenant, name="air-module")
        self.n = 0

    def rack(self, name="air-rack", capability="air", capacity=None):
        return Rack.objects.create(
            tenant=self.tenant, site=self.site, name=name,
            cooling_capability=capability, cooling_capacity_w=capacity,
        )

    def device(self, dtype, rack=None, position=None, **extra):
        self.n += 1
        return Device.objects.create(
            tenant=self.tenant, site=self.site, name=extra.pop("name", f"d{self.n}"),
            device_type=dtype, rack=rack, position=position,
            face="front" if position else "", **extra,
        )

    def chassis(self, rack, position=1, bays=1):
        c = self.device(self.chassis_t, rack, position)
        for i in range(bays):
            DeviceBay.objects.create(device=c, name=f"bay{i + 1}")
        return c

    def install(self, bay, child):
        bay.installed_device = child
        bay.save()

    def module(self, device, mtype, name="m1"):
        bay = ModuleBay.objects.create(device=device, name=name)
        return Module.objects.create(device=device, module_bay=bay, module_type=mtype)

    @staticmethod
    def refusal(rack, method, subject="this device type"):
        return f"Rack {rack.name} is {rack.cooling_capability}-cooled; {subject} is {method}-cooled."

    def cooling(self, rack):
        return self.client.get(f"/api/racks/{rack.id}/").json()["cooling"]


class BayInstallTests(_Base):
    def test_a_liquid_blade_is_refused_in_an_air_racks_chassis(self):
        rack = self.rack()
        bay = self.chassis(rack).device_bays.get()
        blade = self.device(self.blade_t)
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(blade.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"installed_device_id": [self.refusal(rack, "liquid")]})
        # A new bay created with the blade in it is refused the same way.
        r = self.client.post("/api/device-bays/", {
            "device_id": str(bay.device_id), "name": "bay9",
            "installed_device_id": str(blade.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("installed_device_id", r.json())
        self.assertIsNone(DeviceBay.objects.get(pk=bay.pk).installed_device_id)

    def test_the_device_and_its_modules_are_judged_and_a_fitting_one_goes_in(self):
        rack = self.rack()
        bay = self.chassis(rack).device_bays.get()
        own = self.device(self.air_blade_t, cooling_method="immersion")
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(own.id)}, format="json")
        self.assertEqual(r.json(), {"installed_device_id": [
            self.refusal(rack, "immersion", "this device")]})
        carrier = self.device(self.air_blade_t, name="carrier")
        self.module(carrier, self.liq_module, "slot1")
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(carrier.id)}, format="json")
        self.assertEqual(r.json(), {"installed_device_id": [
            "Rack air-rack is air-cooled; module liq-module in carrier:slot1 is liquid-cooled."]})
        fits = self.device(self.air_blade_t)
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(fits.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_rack_that_takes_it_an_unracked_chassis_or_a_racked_blade_is_not_judged(self):
        hybrid = self.rack("hyb", capability="hybrid")
        bay = self.chassis(hybrid).device_bays.get()
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(self.device(self.blade_t).id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        loose = self.chassis(None, position=None).device_bays.get()
        r = self.client.patch(f"/api/device-bays/{loose.id}/",
                              {"installed_device_id": str(self.device(self.blade_t).id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        # A blade with a rack of its own is judged there, not by the chassis'.
        air = self.rack()
        bay = self.chassis(air).device_bays.get()
        racked = self.device(self.blade_t, rack=hybrid)
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(racked.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_installed_blade_is_judged_when_re_typed_or_re_marked(self):
        rack = self.rack()
        bay = self.chassis(rack).device_bays.get()
        blade = self.device(self.air_blade_t)
        self.install(bay, blade)
        url = f"/api/devices/{blade.id}/"
        r = self.client.patch(url, {"cooling_method": "liquid"}, format="json")
        self.assertEqual(r.json(), {"cooling_method": [
            self.refusal(rack, "liquid", "this device")]})
        r = self.client.patch(url, {"device_type_id": str(self.blade_t.id)}, format="json")
        self.assertEqual(r.json(), {"device_type_id": [self.refusal(rack, "liquid")]})
        r = self.client.patch(url, {"description": "kept"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_another_tenants_device_is_never_installed(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        foreign = Device.objects.create(tenant=other, name="theirs", device_type=self.blade_t)
        bay = self.chassis(self.rack("hyb", capability="hybrid")).device_bays.get()
        r = self.client.patch(f"/api/device-bays/{bay.id}/",
                              {"installed_device_id": str(foreign.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("installed_device_id", r.json())


class ModuleInstallTests(_Base):
    def post(self, device, mtype, name="slot1"):
        bay = ModuleBay.objects.create(device=device, name=name)
        return self.client.post("/api/modules/", {
            "device_id": str(device.id), "module_bay_id": str(bay.id),
            "module_type_id": str(mtype.id),
        }, format="json")

    def test_a_liquid_module_is_refused_in_an_air_racked_device(self):
        rack = self.rack()
        host = self.device(self.chassis_t, rack, 1)
        r = self.post(host, self.liq_module)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"module_type_id": [
            "Rack air-rack is air-cooled; this module type is liquid-cooled."]})
        self.assertEqual(self.post(host, self.air_module, "slot2").status_code, 201)
        # Re-typed to liquid: refused on the type.
        m = Module.objects.get(device=host)
        r = self.client.patch(f"/api/modules/{m.id}/",
                              {"module_type_id": str(self.liq_module.id)}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("module_type_id", r.json())

    def test_a_module_in_a_blade_is_judged_by_the_chassis_rack(self):
        rack = self.rack()
        blade = self.device(self.air_blade_t)
        self.install(self.chassis(rack).device_bays.get(), blade)
        r = self.post(blade, self.liq_module)
        self.assertEqual(r.status_code, 400, r.content)

    def test_moving_a_module_to_a_racked_device_is_judged_on_the_device(self):
        rack = self.rack()
        loose = self.device(self.chassis_t)
        m = self.module(loose, self.liq_module)
        racked = self.device(self.chassis_t, rack, 1)
        bay = ModuleBay.objects.create(device=racked, name="slot1")
        r = self.client.patch(f"/api/modules/{m.id}/", {
            "device_id": str(racked.id), "module_bay_id": str(bay.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("device_id", r.json())

    def test_unracked_or_admitting_racks_take_it(self):
        self.assertEqual(self.post(self.device(self.chassis_t), self.liq_module).status_code, 201)
        hybrid = self.rack("hyb", capability="hybrid")
        host = self.device(self.chassis_t, hybrid, 1)
        self.assertEqual(self.post(host, self.liq_module).status_code, 201)

    def test_a_default_module_the_rack_cannot_cool_is_left_out(self):
        dtype = DeviceType.objects.create(tenant=self.tenant, name="line card host", u_height=1)
        ModuleBayTemplate.objects.create(device_type=dtype, name="lc1",
                                         default_module_type=self.liq_module)
        ModuleBayTemplate.objects.create(device_type=dtype, name="lc2",
                                         default_module_type=self.air_module)
        air = self.device(dtype, self.rack(), 1)
        materialize_device_components(air)
        self.assertEqual(
            list(air.modules.values_list("module_type__name", flat=True)), ["air-module"])
        hybrid = self.device(dtype, self.rack("hyb", capability="hybrid"), 1)
        materialize_device_components(hybrid)
        self.assertEqual(hybrid.modules.count(), 2)


class ParentPlacementTests(_Base):
    def test_a_chassis_carrying_a_liquid_blade_is_refused_in_an_air_rack(self):
        rack = self.rack()
        chassis = self.chassis(None, position=None)
        blade = self.device(self.blade_t, name="blade1")
        self.install(chassis.device_bays.get(), blade)
        r = self.client.patch(f"/api/devices/{chassis.id}/",
                              {"rack_id": str(rack.id), "position": 1, "face": "front"},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"rack_id": [
            "Rack air-rack is air-cooled; blade1 in bay bay1 is liquid-cooled."]})

    def test_a_device_carrying_a_liquid_module_is_refused(self):
        rack = self.rack()
        host = self.device(self.chassis_t, name="host")
        self.module(host, self.liq_module, "slot1")
        r = self.client.patch(f"/api/devices/{host.id}/",
                              {"rack_id": str(rack.id), "position": 1, "face": "front"},
                              format="json")
        self.assertEqual(r.json(), {"rack_id": [
            "Rack air-rack is air-cooled; module liq-module in host:slot1 is liquid-cooled."]})
        # A blade's module too.
        other = self.chassis(None, position=None)
        blade = self.device(self.air_blade_t, name="b")
        self.install(other.device_bays.get(), blade)
        self.module(blade, self.liq_module)
        r = self.client.patch(f"/api/devices/{other.id}/",
                              {"rack_id": str(rack.id), "position": 3, "face": "front"},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        # A hybrid rack takes both.
        hybrid = self.rack("hyb", capability="hybrid")
        r = self.client.patch(f"/api/devices/{other.id}/",
                              {"rack_id": str(hybrid.id), "position": 1, "face": "front"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)


class MismatchAndHeatTests(_Base):
    def stocked(self, name="air-rack", capability="hybrid", capacity=None):
        """A chassis (200 W) with a liquid blade (500 W) and an air host
        carrying a liquid module, in a rack that takes both."""
        rack = self.rack(name, capability=capability, capacity=capacity)
        chassis = self.chassis(rack)
        blade = self.device(self.blade_t, name=f"{name}-blade")
        self.install(chassis.device_bays.get(), blade)
        host = self.device(self.air_blade_t, rack, 5, name=f"{name}-host")
        self.module(host, self.liq_module)
        return rack, chassis, blade, host

    def test_a_stricter_rack_flags_the_blade_and_the_modules_device(self):
        rack, chassis, blade, host = self.stocked()
        self.assertEqual(self.cooling(rack)["mismatched"], 0)
        r = self.client.patch(f"/api/racks/{rack.id}/", {"cooling_capability": "air"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cooling"]["mismatched"], 2)

        def listed(**params):
            r = self.client.get("/api/devices/", params)
            self.assertEqual(r.status_code, 200, r.content)
            return sorted(row["name"] for row in r.json()["results"])

        self.assertEqual(listed(cooling_mismatch="1"), [blade.name, host.name])
        self.assertEqual(listed(cooling_mismatch="0"), [chassis.name])
        # The rack's Devices pane: its own devices, and with bay_children its
        # blades too.
        self.assertEqual(listed(rack=str(rack.id), cooling_mismatch="1"), [host.name])
        self.assertEqual(
            listed(rack=str(rack.id), cooling_mismatch="1", bay_children="1"),
            [blade.name, host.name])
        self.assertEqual(listed(rack=str(rack.id), bay_children="1"),
                         sorted([chassis.name, blade.name, host.name]))
        totals = self.client.get(f"/api/sites/{self.site.id}/capacity/").json()["totals"]
        self.assertEqual(totals["cooling"]["mismatched"], 2)
        # The chassis and the host keep editing.
        r = self.client.patch(f"/api/devices/{host.id}/", {"description": "kept"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_mismatch_list_stays_in_its_tenant(self):
        rack, *_ = self.stocked()
        Rack.objects.filter(pk=rack.pk).update(cooling_capability="air")
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        session = self.client.session
        session["current_tenant_id"] = str(other.id)
        session.save()
        r = self.client.get("/api/devices/", {"cooling_mismatch": "1"})
        self.assertEqual(r.json()["results"], [])

    def test_a_blades_heat_counts_through_its_chassis_once(self):
        rack, chassis, blade, host = self.stocked(capacity=2000)
        PowerPort.objects.create(device=host, name="psu", allocated_draw=100, maximum_draw=150)
        cooling = self.cooling(rack)
        self.assertEqual(
            (cooling["heat_allocated_w"], cooling["heat_maximum_w"]),
            (200 + 500 + 100, 200 + 500 + 150),
        )
        body = self.client.get(f"/api/racks/{rack.id}/").json()
        self.assertEqual(body["cooling_free_w"], 2000 - 800)
        sql = Rack.objects.filter(pk=rack.pk).annotate(
            free=capacity.cooling_free_annotation()).values_list("free", flat=True).get()
        self.assertEqual(sql, 1200)
        names = [r["name"] for r in self.client.get(
            "/api/racks/", {"cooling_free_w_gte": 1200}).json()["results"]]
        self.assertEqual(names, [rack.name])
        # A blade with a rack of its own counts there, not again here.
        elsewhere = self.rack("other", capability="hybrid", capacity=5000)
        Device.objects.filter(pk=blade.pk).update(rack=elsewhere)
        self.assertEqual(self.cooling(rack)["heat_allocated_w"], 300)
        self.assertEqual(self.cooling(elsewhere)["heat_allocated_w"], 500)
        sql = dict(Rack.objects.filter(tenant=self.tenant).annotate(
            free=capacity.cooling_free_annotation()).values_list("name", "free"))
        self.assertEqual(sql, {rack.name: 1700, "other": 4500})

    def test_power_leaves_blades_to_the_chassis(self):
        rack, chassis, blade, _host = self.stocked()
        PowerPort.objects.create(device=chassis, name="psu", allocated_draw=900)
        PowerPort.objects.create(device=blade, name="psu", allocated_draw=400)
        power = self.client.get(f"/api/racks/{rack.id}/").json()["power"]
        self.assertEqual(power["allocated_w"], 900)

    def test_a_page_of_racks_costs_the_same_whatever_they_hold(self):
        self.stocked("first")

        def count(url):
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries)

        racks = count("/api/racks/")
        site = count(f"/api/sites/{self.site.id}/capacity/")
        for i in range(4):
            _rack, chassis, _blade, host = self.stocked(f"more{i}")
            # More blades and modules per rack.
            DeviceBay.objects.create(device=chassis, name="bay2",
                                     installed_device=self.device(self.blade_t))
            self.module(host, self.air_module, "m2")
        self.assertEqual(count("/api/racks/"), racks)
        self.assertEqual(count(f"/api/sites/{self.site.id}/capacity/"), site)
