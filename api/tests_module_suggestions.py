"""Suggested modules per bay (api.module_suggestions): the template's list,
the YAML and model pack ``module-bays: - modules:`` extension, a device
bay reading it through its type, and the install warning."""
from __future__ import annotations

import os
import shutil
import tempfile

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .devicetype_import import import_yaml_auto
from .model_pack import PackFiles, import_pack
from .models import (
    Device,
    DeviceType,
    Manufacturer,
    ModuleBayTemplate,
    ModuleType,
    VirtualChassis,
)
from .module_suggestions import clean

User = get_user_model()

C9300_YAML = """\
manufacturer: Cisco
model: C9300-48P
part_number: C9300-48P
u_height: 1
module-bays:
  - name: PS-A
    position: A
    modules: [PWR-C1-350WAC-P, PWR-C1-715WAC-P, PWR-C1-1100WAC-P]
  - name: PS-B
    position: B
    modules: PWR-C1-350WAC-P, pwr-c1-350wac-p
  - name: Network Module
    position: '1'
interfaces:
  - name: GigabitEthernet1/0/1
    type: 1000base-t
"""


class CleanTests(SimpleTestCase):
    def test_trimmed_and_deduplicated(self):
        self.assertEqual(clean([" A ", "b", "a", "", "B"]), ["A", "b"])
        self.assertEqual(clean("A, B ,,A"), ["A", "B"])
        self.assertEqual(clean(None), [])
        self.assertEqual(clean([1100]), ["1100"])

    def test_refused(self):
        for bad in ({"a": 1}, [["x"]], [True], ["x" * 129], [f"p{i}" for i in range(101)]):
            with self.subTest(bad=str(bad)[:20]), self.assertRaises(ValueError):
                clean(bad)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        r = import_yaml_auto(self.tenant, C9300_YAML)
        assert r["ok"], r
        self.dt = DeviceType.objects.get(tenant=self.tenant, part_number="C9300-48P")
        mfr = self.dt.manufacturer
        self.p350 = ModuleType.objects.create(tenant=self.tenant, manufacturer=mfr,
                                              name="350W", part_number="PWR-C1-350WAC-P")
        self.nm = ModuleType.objects.create(tenant=self.tenant, manufacturer=mfr,
                                            name="NM-8X", part_number="C9300-NM-8X")

    def _device(self, name="sw1", **kw):
        resp = self.client.post("/api/devices/", {"name": name,
                                                  "device_type_id": str(self.dt.id), **kw},
                                format="json")
        assert resp.status_code == 201, resp.content
        return Device.objects.get(tenant=self.tenant, name=name)

    def _bay(self, device, name):
        return device.module_bays.get(name=name)


class ImportTests(_Base):
    def test_yaml_sets_the_bay_lists(self):
        bays = {b.name: b.suggested_modules for b in self.dt.module_bay_templates.all()}
        self.assertEqual(bays, {
            "PS-A": ["PWR-C1-350WAC-P", "PWR-C1-715WAC-P", "PWR-C1-1100WAC-P"],
            "PS-B": ["PWR-C1-350WAC-P"],
            "Network Module": [],
        })

    def test_an_unreadable_list_is_skipped_with_a_note(self):
        r = import_yaml_auto(self.tenant, C9300_YAML.replace(
            "C9300-48P", "C9300-24P").replace(
            "modules: PWR-C1-350WAC-P, pwr-c1-350wac-p", "modules: {x: 1}"))
        self.assertTrue(r["ok"], r)
        self.assertTrue(any("PS-B: modules" in n for n in r["skipped"]), r["skipped"])
        dt = DeviceType.objects.get(tenant=self.tenant, part_number="C9300-24P")
        self.assertEqual(dt.module_bay_templates.get(name="PS-B").suggested_modules, [])


class TemplateApiTests(_Base):
    def test_edit_the_list(self):
        t = self.dt.module_bay_templates.get(name="Network Module")
        res = self.client.patch(f"/api/module-bay-templates/{t.id}/",
                                {"suggested_modules": [" C9300-NM-8X ", "C9300-NM-8X"]},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["suggested_modules"], ["C9300-NM-8X"])
        t.refresh_from_db()
        self.assertEqual(t.suggested_modules, ["C9300-NM-8X"])

    def test_a_bad_list_is_a_field_error(self):
        t = self.dt.module_bay_templates.get(name="Network Module")
        res = self.client.patch(f"/api/module-bay-templates/{t.id}/",
                                {"suggested_modules": {"x": 1}}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("suggested_modules", res.json())


class BayApiTests(_Base):
    def test_a_devices_bay_reads_its_templates_list(self):
        dev = self._device()
        res = self.client.get(f"/api/module-bays/?device={dev.id}")
        self.assertEqual(res.status_code, 200, res.content)
        rows = {r["name"]: r for r in res.json()["results"]}
        self.assertEqual(rows["PS-B"]["suggested_modules"], ["PWR-C1-350WAC-P"])
        self.assertEqual(rows["Network Module"]["suggested_modules"], [])
        self.assertEqual(rows["PS-A"]["chassis_manufacturer"]["name"], "Cisco")
        # A template edit reaches devices built before it.
        ModuleBayTemplate.objects.filter(device_type=self.dt, name="Network Module").update(
            suggested_modules=["C9300-NM-8X"])
        res = self.client.get(f"/api/module-bays/{self._bay(dev, 'Network Module').id}/")
        self.assertEqual(res.json()["suggested_modules"], ["C9300-NM-8X"])

    def test_a_stack_members_bay_matches_its_rendered_template(self):
        ModuleBayTemplate.objects.create(device_type=self.dt, name="Uplink {position}",
                                         position="1", suggested_modules=["C9300-NM-8X"])
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        dev = self._device("sw2")
        Device.objects.filter(pk=dev.pk).update(virtual_chassis=vc, vc_position=2)
        from .models import materialize_device_components

        materialize_device_components(Device.objects.get(pk=dev.pk))
        bay = self._bay(dev, "Uplink 2")
        res = self.client.get(f"/api/module-bays/{bay.id}/")
        self.assertEqual(res.json()["suggested_modules"], ["C9300-NM-8X"])

    def test_another_tenants_bay_is_not_found(self):
        dev = self._device()
        bay = self._bay(dev, "PS-A")
        s = self.client.session
        s["current_tenant_id"] = str(self.other.id)
        s.save()
        self.assertEqual(self.client.get(f"/api/module-bays/{bay.id}/").status_code, 404)


class InstallWarningTests(_Base):
    def _install(self, bay, mt):
        return self.client.post("/api/modules/", {
            "device_id": str(bay.device_id), "module_bay_id": str(bay.id),
            "module_type_id": str(mt.id)}, format="json")

    def test_a_suggested_module_installs_quietly(self):
        dev = self._device()
        res = self._install(self._bay(dev, "PS-A"), self.p350)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["warnings"], [])

    def test_another_module_installs_with_a_warning(self):
        dev = self._device()
        res = self._install(self._bay(dev, "PS-A"), self.nm)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(len(res.json()["warnings"]), 1)
        self.assertIn("NM-8X is not among the modules suggested for PS-A",
                      res.json()["warnings"][0])

    def test_a_bay_without_suggestions_never_warns(self):
        dev = self._device()
        res = self._install(self._bay(dev, "Network Module"), self.p350)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["warnings"], [])

    def test_a_replace_warns_too(self):
        dev = self._device()
        res = self._install(self._bay(dev, "PS-A"), self.p350)
        res = self.client.patch(f"/api/modules/{res.json()['id']}/",
                                {"module_type_id": str(self.nm.id), "confirm_remove": True},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()["warnings"]), 1)


class PackTests(_Base):
    def setUp(self):
        super().setUp()
        self.pack = tempfile.mkdtemp()
        self._write("pack.yaml", "name: Test\nversion: 1.0.0\n")

    def tearDown(self):
        shutil.rmtree(self.pack, ignore_errors=True)
        super().tearDown()

    def _write(self, rel, text):
        path = os.path.join(self.pack, rel)
        os.makedirs(os.path.dirname(path) or self.pack, exist_ok=True)
        with open(path, "w") as fh:
            fh.write(text)

    def _import(self, dry_run=False):
        files = PackFiles(self.pack)
        try:
            return import_pack(self.tenant, files, dry_run=dry_run)
        finally:
            files.close()

    def test_a_matched_type_gains_the_packs_part_numbers(self):
        t = self.dt.module_bay_templates.get(name="PS-B")
        t.suggested_modules = ["MY-OWN-PSU"]
        t.save()
        self._write("device-types/Cisco/C9300-48P.yaml", C9300_YAML.replace(
            "modules: PWR-C1-350WAC-P, pwr-c1-350wac-p",
            "modules: [PWR-C1-715WAC-P, my-own-psu]"))
        result = self._import()
        self.assertEqual(result.types[0].action, "matched")
        self.assertIn("module bays: suggested modules added to 1 bay.", result.types[0].notes)
        t.refresh_from_db()
        self.assertEqual(t.suggested_modules, ["MY-OWN-PSU", "PWR-C1-715WAC-P"])

    def test_a_dry_run_changes_nothing(self):
        self._write("device-types/Cisco/C9300-48P.yaml", C9300_YAML.replace(
            "modules: PWR-C1-350WAC-P, pwr-c1-350wac-p", "modules: [PWR-C1-715WAC-P]"))
        self._import(dry_run=True)
        t = self.dt.module_bay_templates.get(name="PS-B")
        self.assertEqual(t.suggested_modules, ["PWR-C1-350WAC-P"])

    def test_a_created_type_takes_the_lists(self):
        Manufacturer.objects.get_or_create(tenant=self.tenant, name="Acme",
                                           defaults={"slug": "acme"})
        self._write("device-types/Acme/X1.yaml", C9300_YAML.replace(
            "Cisco", "Acme").replace("C9300-48P", "X1"))
        result = self._import()
        self.assertEqual(result.types[0].action, "created", result.types[0].notes)
        dt = DeviceType.objects.get(tenant=self.tenant, part_number="X1")
        self.assertEqual(dt.module_bay_templates.get(name="PS-B").suggested_modules,
                         ["PWR-C1-350WAC-P"])
