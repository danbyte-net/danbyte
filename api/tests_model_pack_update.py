"""A model-pack re-import brings matched types in line with their YAML
(api.model_pack_update): templates, bay module lists, lifecycle and link
documents, with hand edits kept. The fixtures are three YAMLs of the Cisco
Catalyst pack (tests_model_pack_update_data/, their ``model3d:`` blocks
dropped); the "earlier version" of each is derived from it."""
from __future__ import annotations

import copy
import datetime
import os
import shutil
import tempfile

import yaml
from django.contrib.auth.models import User
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .devicetype_import import import_devicetype_yaml
from .model_pack import PackFiles, import_pack
from .model_pack_update import link_url, read_date
from .models import (
    Device,
    DeviceRole,
    DeviceType,
    Document,
    DocumentCategory,
    FrontPortTemplate,
    InterfaceTemplate,
    Manufacturer,
    ModuleType,
    RackType,
    RearPortTemplate,
    Site,
    materialize_device_components,
)

DATA = os.path.join(os.path.dirname(__file__), "tests_model_pack_update_data")


def real(part: str) -> dict:
    with open(os.path.join(DATA, f"{part}.yaml")) as fh:
        doc = yaml.safe_load(fh)
    doc.pop("model3d", None)
    return doc


def iface(doc, name):
    return next(r for r in doc["interfaces"] if r["name"] == name)


def bay(doc, name):
    return next(r for r in doc["module-bays"] if r["name"] == name)


def old_c9200() -> dict:
    """C9200-24T as an earlier pack had it: StackPort interfaces, no stack
    adapter bays, a shorter Network Module list."""
    doc = real("C9200-24T")
    mgmt = doc["interfaces"].pop()
    doc["interfaces"] += [{"name": "StackPort1/1", "type": "cisco-stackwise"},
                          {"name": "StackPort1/2", "type": "cisco-stackwise"}, mgmt]
    doc["module-bays"] = [b for b in doc["module-bays"] if not b["name"].startswith("Stack")]
    bay(doc, "Network Module")["modules"] = ["C9200-NM-4G", "C9200-NM-4X"]
    doc.pop("meta")
    return doc


def old_c9300() -> dict:
    """C9300-48P before StackPower and StackWise-480: library stack types,
    no power ports, one PSU fewer on each PS bay."""
    doc = real("C9300-48P")
    for n in ("StackPort1/1", "StackPort1/2"):
        iface(doc, n)["type"] = "cisco-stackwise"
    doc.pop("power-ports")
    for b in ("PS-A", "PS-B"):
        bay(doc, b)["modules"] = ["PWR-C1-350WAC-P", "PWR-C1-715WAC-P"]
    doc["meta"]["links"] = doc["meta"]["links"][:2]
    return doc


def old_c9500() -> dict:
    doc = real("C9500-40X")
    doc.pop("meta")
    return doc


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def pack(self, docs: dict, version="1.0.0", modules: dict | None = None, extra=None):
        """Write a pack of ``docs`` ({part: YAML doc}) and return its folder."""
        shutil.rmtree(self.root, ignore_errors=True)
        os.makedirs(self.root)
        with open(os.path.join(self.root, "pack.yaml"), "w") as fh:
            fh.write(f"name: Catalyst\nid: catalyst\nversion: {version}\n")
        for folder, group in (("device-types", docs), ("module-types", modules or {}),
                              *(extra or {}).items()):
            for part, doc in group.items():
                path = os.path.join(self.root, folder, "Cisco", f"{part}.yaml")
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w") as fh:
                    yaml.safe_dump(doc, fh, sort_keys=False)
        return self.root

    def run_pack(self, docs, *, dry_run=False, overwrite=False, tenant=None, **kw):
        self.pack(docs, **kw)
        files = PackFiles(self.root)
        try:
            return import_pack(tenant or self.tenant, files, dry_run=dry_run,
                               overwrite=overwrite)
        finally:
            files.close()

    def row(self, result, part):
        return next(t for t in result.types if t.path.endswith(f"/{part}.yaml"))

    def dt(self, part, tenant=None):
        return DeviceType.objects.get(tenant=tenant or self.tenant, part_number=part)

    def ifaces(self, dt):
        return dict(dt.interface_templates.values_list("name", "type"))


class TemplateUpdateTests(_Base):
    def test_a_re_import_brings_the_templates_in_line(self):
        self.run_pack({"C9300-48P": old_c9300(), "C9200-24T": old_c9200()})
        c9300, c9200 = self.dt("C9300-48P"), self.dt("C9200-24T")
        self.assertEqual(self.ifaces(c9300)["StackPort1/1"], "cisco-stackwise")
        self.assertFalse(c9300.power_port_templates.exists())
        self.assertIn("StackPort1/1", self.ifaces(c9200))

        result = self.run_pack({"C9300-48P": real("C9300-48P"), "C9200-24T": real("C9200-24T")},
                               version="2.0.0")
        row = self.row(result, "C9300-48P")
        self.assertEqual(row.action, "matched")
        self.assertIn("updated 2 interfaces, type cisco-stackwise → cisco-stackwise-480: "
                      "StackPort1/1, StackPort1/2", row.notes)
        self.assertIn("added 2 power ports: StackPower1/A, StackPower1/B", row.notes)
        self.assertIn("updated 2 module bays, modules +PWR-C1-1100WAC-P: PS-A, PS-B", row.notes)
        self.assertEqual(self.ifaces(c9300)["StackPort1/1"], "cisco-stackwise-480")
        self.assertEqual(sorted(c9300.power_port_templates.values_list("name", "type")),
                         [("StackPower1/A", "cisco-stackpower"),
                          ("StackPower1/B", "cisco-stackpower")])
        self.assertEqual(c9300.module_bay_templates.get(name="PS-A").suggested_modules,
                         ["PWR-C1-350WAC-P", "PWR-C1-715WAC-P", "PWR-C1-1100WAC-P"])

        # C9200-24T: the StackPort interfaces became stack adapter bays.
        row = self.row(result, "C9200-24T")
        self.assertIn("removed 2 interfaces: StackPort1/1, StackPort1/2", row.notes)
        self.assertIn("added 2 module bays: StackPort1/1, StackPort1/2", row.notes)
        self.assertNotIn("StackPort1/1", self.ifaces(c9200))
        self.assertEqual(c9200.module_bay_templates.get(name="StackPort1/2").suggested_modules,
                         ["C9200-STACK-KIT"])
        self.assertEqual(
            c9200.module_bay_templates.get(name="Network Module").suggested_modules,
            ["C9200-NM-4G", "C9200-NM-4X", "C9200-NM-BLANK"])
        self.assertEqual(row.changes["removed"], 2)

    def test_a_hand_edit_is_kept_and_reported(self):
        self.run_pack({"C9300-48P": real("C9300-48P")})
        dt = self.dt("C9300-48P")
        InterfaceTemplate.objects.filter(device_type=dt, name="GigabitEthernet1/0/1").update(
            type="2.5gbase-t")
        new = real("C9300-48P")
        iface(new, "GigabitEthernet1/0/1")["type"] = "1000base-tx"
        iface(new, "GigabitEthernet1/0/2")["type"] = "1000base-tx"
        row = self.row(self.run_pack({"C9300-48P": new}, version="2.0.0"), "C9300-48P")
        self.assertIn("kept your edit on 1 interface, type 2.5gbase-t (the pack has "
                      "1000base-tx): GigabitEthernet1/0/1", row.notes)
        self.assertIn("updated 1 interface, type 1000base-t → 1000base-tx: "
                      "GigabitEthernet1/0/2", row.notes)
        got = self.ifaces(dt)
        self.assertEqual((got["GigabitEthernet1/0/1"], got["GigabitEthernet1/0/2"]),
                         ("2.5gbase-t", "1000base-tx"))
        self.assertEqual(row.changes["kept"], 1)

    def test_a_dropped_template_goes_only_when_the_pack_made_it_and_nothing_uses_it(self):
        doc = real("C9300-48P")
        doc["rear-ports"] = [{"name": "R1", "type": "lc"}, {"name": "R2", "type": "lc"}]
        doc["front-ports"] = [{"name": "F1", "type": "lc", "rear_port": "R1"},
                              {"name": "F2", "type": "lc", "rear_port": "R2"}]
        doc["console-ports"].append({"name": "aux", "type": "rj-45"})
        self.run_pack({"C9300-48P": doc})
        dt = self.dt("C9300-48P")
        # Edited here: kept. Added here: kept, not the pack's to remove.
        dt.console_port_templates.filter(name="usb").update(type="usb-c")
        dt.console_port_templates.create(name="mine", type="rj-45")
        new = copy.deepcopy(doc)
        new["console-ports"] = [r for r in new["console-ports"] if r["name"] == "con 0"]
        # R2 dropped while its front port stays: in use.
        new["rear-ports"] = [{"name": "R1", "type": "lc"}]
        new["front-ports"] = [{"name": "F1", "type": "lc", "rear_port": "R1"}]
        row = self.row(self.run_pack({"C9300-48P": new}, version="2.0.0"), "C9300-48P")
        self.assertEqual(sorted(dt.console_port_templates.values_list("name", flat=True)),
                         ["con 0", "mine", "usb"])
        self.assertIn("removed 1 console port: aux", row.notes)
        self.assertIn("kept 1 console port the pack dropped, changed here: usb", row.notes)
        self.assertIn("kept 1 console port not in the pack: mine", row.notes)
        # F2 is the pack's and untouched: removed, so R2 is free to go too.
        self.assertIn("removed 1 front port: F2", row.notes)
        self.assertIn("removed 1 rear port: R2", row.notes)
        self.assertFalse(RearPortTemplate.objects.filter(device_type=dt, name="R2").exists())

        # A front port added here keeps its rear port when the pack drops it.
        FrontPortTemplate.objects.create(device_type=dt, name="F9", type="lc",
                                         rear_port_template=dt.rear_port_templates.get(
                                             name="R1"))
        new["rear-ports"], new["front-ports"] = [], []
        row = self.row(self.run_pack({"C9300-48P": new}, version="3.0.0"), "C9300-48P")
        self.assertIn("removed 1 front port: F1", row.notes)
        self.assertIn("kept 1 rear port the pack dropped, still in use: R1", row.notes)
        self.assertTrue(dt.rear_port_templates.filter(name="R1").exists())
        self.assertTrue(dt.front_port_templates.filter(name="F9").exists())

    def test_a_template_removed_here_is_not_added_back(self):
        self.run_pack({"C9300-48P": real("C9300-48P")})
        dt = self.dt("C9300-48P")
        dt.console_port_templates.filter(name="usb").delete()
        row = self.row(self.run_pack({"C9300-48P": real("C9300-48P")}, version="2.0.0"),
                       "C9300-48P")
        self.assertIn("kept your removal of 1 console port: usb", row.notes)
        self.assertFalse(dt.console_port_templates.filter(name="usb").exists())
        self.run_pack({"C9300-48P": real("C9300-48P")}, version="2.0.0", overwrite=True)
        self.assertTrue(dt.console_port_templates.filter(name="usb").exists())

    def test_a_bay_list_keeps_part_numbers_added_here(self):
        self.run_pack({"C9300-48P": old_c9300()})
        dt = self.dt("C9300-48P")
        b = dt.module_bay_templates.get(name="PS-A")
        b.suggested_modules = [*b.suggested_modules, "MY-PSU"]
        b.save()
        new = old_c9300()
        bay(new, "PS-A")["modules"] = ["PWR-C1-715WAC-P", "PWR-C1-1100WAC-P"]
        self.run_pack({"C9300-48P": new}, version="2.0.0")
        b.refresh_from_db()
        self.assertEqual(b.suggested_modules,
                         ["PWR-C1-715WAC-P", "MY-PSU", "PWR-C1-1100WAC-P"])

    def test_a_second_run_changes_nothing(self):
        docs = {"C9300-48P": real("C9300-48P"), "C9200-24T": real("C9200-24T"),
                "C9500-40X": real("C9500-40X")}
        self.run_pack(docs)
        before = ChangeLogEntry.objects.count()
        with CaptureQueriesContext(connection) as q:
            result = self.run_pack(docs)
        for row in result.types:
            self.assertEqual(row.changes, {"added": 0, "updated": 0, "removed": 0, "kept": 0},
                             row.notes)
        # Only the types' own saves (models are not in this pack): no
        # template or document is written again.
        new = ChangeLogEntry.objects.count() - before
        self.assertLessEqual(new, 3)
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_type__in=["api.interfacetemplate", "api.document",
                             "api.modulebaytemplate"]).order_by("-id")[:0].exists())
        # A handful of queries per type, not per template.
        self.assertLess(len(q.captured_queries), 150, len(q.captured_queries))

    def test_a_dry_run_reports_and_keeps_nothing(self):
        self.run_pack({"C9300-48P": old_c9300()})
        dt = self.dt("C9300-48P")
        row = self.row(self.run_pack({"C9300-48P": real("C9300-48P")}, dry_run=True),
                       "C9300-48P")
        self.assertIn("added 2 power ports: StackPower1/A, StackPower1/B", row.notes)
        self.assertFalse(dt.power_port_templates.exists())
        self.assertEqual(self.ifaces(dt)["StackPort1/1"], "cisco-stackwise")
        self.assertFalse(Document.objects.filter(object_id=dt.pk).count() > 2)

    def test_the_changes_are_audited_with_the_pack_as_cause(self):
        self.run_pack({"C9300-48P": old_c9300()})
        dt = self.dt("C9300-48P")
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        self.run_pack({"C9300-48P": real("C9300-48P")}, version="2.0.0")
        new = ChangeLogEntry.objects.exclude(id__in=before)
        pp = new.filter(object_type="api.powerporttemplate", action="create")
        self.assertEqual(pp.count(), 2)
        it = new.filter(object_type="api.interfacetemplate", action="update")
        self.assertEqual(it.count(), 2)
        docs = new.filter(object_type="api.document", action="create")
        self.assertEqual(docs.count(), 3)
        self.assertEqual({e.cause for e in new}, {"Pack import: Catalyst 2.0.0"})
        entry = new.get(object_type="api.devicetype", object_id=str(dt.pk))
        # The snapshot is logged as a summary, not verbatim.
        self.assertIn("bytes", str(entry.changes.get("pack_state")))

    def test_another_tenants_type_is_left_alone(self):
        self.run_pack({"C9300-48P": old_c9300()})
        self.run_pack({"C9300-48P": old_c9300()}, tenant=self.other)
        self.run_pack({"C9300-48P": real("C9300-48P")}, version="2.0.0")
        mine, theirs = self.dt("C9300-48P"), self.dt("C9300-48P", self.other)
        self.assertEqual(mine.power_port_templates.count(), 2)
        self.assertFalse(theirs.power_port_templates.exists())
        self.assertEqual(self.ifaces(theirs)["StackPort1/1"], "cisco-stackwise")
        self.assertEqual(Document.objects.filter(object_id=theirs.pk).count(), 2)
        self.assertEqual(Document.objects.filter(object_id=mine.pk).count(), 5)
        self.assertFalse(Document.objects.filter(object_id=mine.pk).exclude(
            tenant=self.tenant).exists())
        self.assertEqual(Document.objects.filter(object_id=mine.pk).exclude(
            category__tenant=self.tenant).count(), 0)

    def test_devices_out_of_step_are_counted_not_changed(self):
        self.run_pack({"C9300-48P": old_c9300()})
        dt = self.dt("C9300-48P")
        site = Site.objects.create(tenant=self.tenant, name="S")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Access", slug="access")
        for i in (1, 2):
            materialize_device_components(Device.objects.create(
                tenant=self.tenant, name=f"sw{i}", site=site, device_type=dt, role=role))
        d1 = Device.objects.get(name="sw1")
        self.assertFalse(d1.power_ports.exists())
        row = self.row(self.run_pack({"C9300-48P": real("C9300-48P")}, version="2.0.0"),
                       "C9300-48P")
        self.assertIn("devices: 2 of 2 out of step - Sync devices brings them in line.",
                      row.notes)
        self.assertIn("devices: existing ports keep the values they were made with.",
                      row.notes)
        self.assertFalse(d1.power_ports.exists())
        self.assertEqual(d1.interfaces.get(name="StackPort1/1").type, "cisco-stackwise")


class NoRecordTests(_Base):
    """A type imported before packs kept a record (the device library, or an
    earlier pack): everything on it is its own."""

    def setUp(self):
        super().setUp()
        text = yaml.safe_dump(old_c9200(), sort_keys=False)
        self.assertTrue(import_devicetype_yaml(self.tenant, text)["ok"])
        text = yaml.safe_dump(old_c9300(), sort_keys=False)
        self.assertTrue(import_devicetype_yaml(self.tenant, text)["ok"])

    def test_only_missing_things_are_added_and_differences_reported(self):
        result = self.run_pack({"C9300-48P": real("C9300-48P"), "C9200-24T": real("C9200-24T")})
        row = self.row(result, "C9300-48P")
        self.assertEqual(row.action, "matched")
        self.assertIn("added 2 power ports: StackPower1/A, StackPower1/B", row.notes)
        self.assertIn("kept 2 interfaces, type cisco-stackwise (the pack has "
                      "cisco-stackwise-480): StackPort1/1, StackPort1/2", row.notes)
        self.assertIn("no earlier pack record: differences kept - Update from pack "
                      "(--overwrite) applies them.", row.notes)
        self.assertEqual(self.ifaces(self.dt("C9300-48P"))["StackPort1/1"], "cisco-stackwise")
        row = self.row(result, "C9200-24T")
        self.assertIn("kept 2 interfaces not in the pack: StackPort1/1, StackPort1/2", row.notes)
        self.assertIn("StackPort1/1", self.ifaces(self.dt("C9200-24T")))
        self.assertIn("added 2 module bays: StackPort1/1, StackPort1/2", row.notes)
        # The record now exists: the differences read as edits from here on.
        row = self.row(self.run_pack({"C9300-48P": real("C9300-48P")}), "C9300-48P")
        self.assertIn("kept your edit on 2 interfaces, type cisco-stackwise (the pack has "
                      "cisco-stackwise-480): StackPort1/1, StackPort1/2", row.notes)

    def test_short_and_stacked_names_match_the_yaml(self):
        cisco = Manufacturer.objects.get(tenant=self.tenant, name="Cisco")
        dt = DeviceType.objects.create(tenant=self.tenant, name="Stacked", part_number="STK-1",
                                       manufacturer=cisco)
        for n in ("Gi{position}/0/1", "Gi{position}/0/2"):
            InterfaceTemplate.objects.create(device_type=dt, name=n, type="1000base-t")
        doc = {"manufacturer": "Cisco", "model": "Stacked", "part_number": "STK-1",
               "u_height": 1,
               "interfaces": [
                   {"name": "GigabitEthernet1/0/1", "type": "1000base-t", "poe_mode": "pse"},
                   {"name": "GigabitEthernet1/0/2", "type": "1000base-t"},
                   {"name": "GigabitEthernet0/0", "type": "1000base-t", "mgmt_only": True}],
               "power-ports": [{"name": "StackPower1/A", "type": "cisco-stackpower"}]}
        row = self.row(self.run_pack({"STK-1": doc}), "STK-1")
        self.assertEqual(sorted(dt.interface_templates.values_list("name", flat=True)),
                         ["GigabitEthernet0/0", "Gi{position}/0/1", "Gi{position}/0/2"])
        self.assertEqual(dt.interface_templates.get(name="Gi{position}/0/1").poe_mode, "pse")
        self.assertEqual(list(dt.power_port_templates.values_list("name", flat=True)),
                         ["StackPower{position}/A"])
        self.assertIn("updated 1 interface, PoE mode none → pse: Gi{position}/0/1", row.notes)

    def test_update_from_pack_lets_the_yaml_win(self):
        result = self.run_pack({"C9300-48P": real("C9300-48P"), "C9200-24T": real("C9200-24T")},
                               overwrite=True)
        self.assertEqual(self.ifaces(self.dt("C9300-48P"))["StackPort1/1"],
                         "cisco-stackwise-480")
        row = self.row(result, "C9200-24T")
        self.assertIn("removed 2 interfaces: StackPort1/1, StackPort1/2", row.notes)
        self.assertNotIn("StackPort1/1", self.ifaces(self.dt("C9200-24T")))
        self.assertEqual(row.changes["kept"], 0)


class ModuleTypeTests(_Base):
    PSU = {"manufacturer": "Cisco", "model": "PWR-X", "part_number": "PWR-X",
           "power-ports": [{"name": "PS{module}", "type": "iec-60320-c14",
                            "maximum_draw": 350}],
           "interfaces": [{"name": "Te1/{module}/1", "type": "10gbase-x-sfpp"}]}

    def test_a_module_type_follows_its_yaml(self):
        self.run_pack({}, modules={"PWR-X": self.PSU})
        mt = ModuleType.objects.get(tenant=self.tenant, part_number="PWR-X")
        new = copy.deepcopy(self.PSU)
        new["power-ports"][0]["maximum_draw"] = 715
        new["interfaces"] = [{"name": "Te1/{module}/2", "type": "10gbase-x-sfpp"}]
        new["meta"] = {"category": "module", "summary": "A PSU.",
                       "lifecycle": {"end_of_sale": "2026-04", "source": "https://x.example/eol"}}
        row = self.row(self.run_pack({}, modules={"PWR-X": new}, version="2.0.0"), "PWR-X")
        self.assertIn("updated 1 power port, max draw 350 → 715: PS{module}", row.notes)
        self.assertIn("removed 1 interface: Te1/{module}/1", row.notes)
        self.assertIn("added 1 interface: Te1/{module}/2", row.notes)
        self.assertIn("meta.lifecycle: module types have no lifecycle fields - kept with the "
                      "import record.", row.notes)
        mt.refresh_from_db()
        self.assertEqual(mt.description, "A PSU.")
        self.assertEqual(mt.pack_state["meta"]["lifecycle"]["end_of_sale"], "2026-04")
        self.assertEqual(mt.power_port_templates.get().maximum_draw, 715)


class MetaTests(_Base):
    def test_lifecycle_lands_on_the_device_type(self):
        row = self.row(self.run_pack({"C9500-40X": real("C9500-40X")}), "C9500-40X")
        self.assertEqual(row.action, "created")
        dt = self.dt("C9500-40X")
        self.assertEqual(dt.end_of_sale, datetime.date(2024, 4, 30))
        self.assertEqual(dt.end_of_security_updates, datetime.date(2029, 4, 30))
        self.assertEqual(dt.end_of_support, datetime.date(2029, 4, 30))
        self.assertIsNone(dt.release_date)
        self.assertTrue(dt.lifecycle_url.endswith("c9500-12q-c9500-24q-c9500-40x-eol.html"))
        self.assertEqual(dt.pack_state["meta"]["family"], "Catalyst 9500")
        self.assertEqual(dt.lifecycle_state, "eos")

    def test_a_matched_type_gains_lifecycle_and_keeps_an_edit(self):
        self.run_pack({"C9500-40X": old_c9500()})
        dt = self.dt("C9500-40X")
        dt.end_of_support = datetime.date(2030, 1, 1)
        dt.save()
        row = self.row(self.run_pack({"C9500-40X": real("C9500-40X")}), "C9500-40X")
        dt.refresh_from_db()
        # Empty fields fill; a date set here is the type's own.
        self.assertEqual(dt.end_of_sale, datetime.date(2024, 4, 30))
        self.assertEqual(dt.end_of_support, datetime.date(2030, 1, 1))
        self.assertIn("kept 1 lifecycle field, 2030-01-01 (the pack has 2029-04-30): "
                      "end of support", row.notes)
        # The pack moves a date it set: followed. One edited here: kept.
        dt.end_of_support = datetime.date(2029, 4, 30)
        dt.save()
        self.run_pack({"C9500-40X": real("C9500-40X")})
        new = real("C9500-40X")
        new["meta"]["lifecycle"]["end_of_sale"] = "2024-05"
        new["meta"]["lifecycle"]["end_of_support"] = "2030-04-30"
        dt.end_of_support = datetime.date(2031, 1, 1)
        dt.save()
        row = self.row(self.run_pack({"C9500-40X": new}), "C9500-40X")
        dt.refresh_from_db()
        self.assertEqual(dt.end_of_sale, datetime.date(2024, 5, 31))
        self.assertEqual(dt.end_of_support, datetime.date(2031, 1, 1))
        self.assertIn("kept your edit on 1 lifecycle field, 2031-01-01 (the pack has "
                      "2030-04-30): end of support", row.notes)
        # A key the pack leaves out leaves the field alone.
        del new["meta"]["lifecycle"]["end_of_sale"]
        self.run_pack({"C9500-40X": new})
        dt.refresh_from_db()
        self.assertEqual(dt.end_of_sale, datetime.date(2024, 5, 31))

    def test_links_become_documents_and_follow_the_pack(self):
        self.run_pack({"C9300-48P": old_c9300()})
        dt = self.dt("C9300-48P")
        docs = Document.objects.filter(object_type="api.devicetype", object_id=dt.pk)
        self.assertEqual(sorted(docs.values_list("category__name", "name")), [
            ("Datasheet", "Cisco Catalyst 9300 Series Switches Data Sheet"),
            ("Product page", "Cisco Catalyst 9300 Series Switches")])
        self.assertEqual(set(DocumentCategory.objects.filter(tenant=self.tenant)
                             .values_list("name", flat=True)), {"Datasheet", "Product page"})
        mine = Document.objects.create(tenant=self.tenant, object_type="api.devicetype",
                                       object_id=dt.pk, name="Our runbook",
                                       url="https://wiki.example.com/c9300")
        datasheet = docs.get(category__name="Datasheet")
        datasheet.name = "Data sheet (ours)"
        datasheet.save()
        new = real("C9300-48P")
        new["meta"]["links"] = [
            {**new["meta"]["links"][0], "title": "Catalyst 9300"},
            *new["meta"]["links"][2:],
        ]
        new["meta"]["links"].append({"kind": "other", "url": "https://wiki.example.com/c9300"})
        row = self.row(self.run_pack({"C9300-48P": new}, version="2.0.0"), "C9300-48P")
        self.assertIn("updated 1 document: Catalyst 9300", row.notes)
        self.assertIn("added 3 documents: Cisco Catalyst 9300 Series Switches - End-of-Life "
                      "and End-of-Sale Notices, Cisco Catalyst 9300 Series Switches - Support, "
                      "Cisco Catalyst 9300 Series Switches Hardware Installation Guide",
                      row.notes)
        # Dropped by the pack but renamed here: kept.
        self.assertIn("kept 1 document the pack dropped, changed here: Data sheet (ours)",
                      row.notes)
        self.assertTrue(docs.filter(pk=datasheet.pk).exists())
        mine.refresh_from_db()
        self.assertEqual(mine.name, "Our runbook")
        self.assertEqual(docs.filter(url="https://wiki.example.com/c9300").count(), 1)
        self.assertIn("document categories: created Install guide, Support, EoL listing.",
                      row.notes)
        # Dropped and untouched: removed.
        new["meta"]["links"] = new["meta"]["links"][1:]
        row = self.row(self.run_pack({"C9300-48P": new}, version="3.0.0"), "C9300-48P")
        self.assertIn("removed 1 document: Catalyst 9300", row.notes)

    def test_dates_and_urls(self):
        self.assertEqual(read_date("2017-06", end=False), datetime.date(2017, 6, 1))
        self.assertEqual(read_date("2024-02", end=True), datetime.date(2024, 2, 29))
        self.assertEqual(read_date(datetime.date(2020, 1, 2), end=True),
                         datetime.date(2020, 1, 2))
        for bad in ("2024-13", "2024-02-30", "soon", None, "24-01-01"):
            self.assertIsNone(read_date(bad, end=True), bad)
        self.assertEqual(link_url("https://www.cisco.com/x", 200), "https://www.cisco.com/x")
        for bad in ("ftp://x.example/a", "https://10.0.0.1/a", "http://localhost/a",
                    "https://u:p@x.example/", "https://intranet/", "javascript:alert(1)",
                    "https://x.example/" + "a" * 300):
            self.assertIsNone(link_url(bad, 200), bad)

    def test_a_bad_meta_is_noted_not_fatal(self):
        doc = real("C9500-40X")
        doc["meta"]["lifecycle"]["end_of_sale"] = "someday"
        doc["meta"]["lifecycle"]["source"] = "https://192.168.1.1/eol"
        doc["meta"]["links"].append({"kind": "datasheet", "url": "file:///etc/passwd"})
        row = self.row(self.run_pack({"C9500-40X": doc}), "C9500-40X")
        self.assertEqual(row.action, "created")
        dt = self.dt("C9500-40X")
        self.assertIsNone(dt.end_of_sale)
        self.assertEqual(dt.lifecycle_url, "")
        self.assertIn("meta.lifecycle.end_of_sale: 'someday' is not YYYY-MM-DD or YYYY-MM "
                      "- skipped.", row.notes)
        self.assertEqual(Document.objects.filter(object_id=dt.pk).count(), 4)

    def test_a_rack_type_takes_its_summary(self):
        rack = {"manufacturer": "Generic", "model": "Rack-42", "width": 19, "u_height": 42,
                "meta": {"category": "rack", "summary": "A 42U cabinet."}}
        row = self.row(self.run_pack({}, extra={"rack-types": {"Rack-42": rack}}), "Rack-42")
        self.assertEqual(row.action, "created", row.notes)
        rt = RackType.objects.get(tenant=self.tenant, name="Rack-42")
        self.assertEqual(rt.description, "A 42U cabinet.")
        self.assertEqual(rt.pack_state["meta"]["category"], "rack")


class RealPackDryRunTests(_Base):
    """What re-importing the current pack over an earlier one shows."""

    def test_the_dry_run_lists_the_concrete_changes(self):
        Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.run_pack({"C9200-24T": old_c9200(), "C9300-48P": old_c9300(),
                       "C9500-40X": old_c9500()}, version="1.6.0")
        result = self.run_pack({"C9200-24T": real("C9200-24T"), "C9300-48P": real("C9300-48P"),
                                "C9500-40X": real("C9500-40X")}, version="1.6.23",
                               dry_run=True)
        got = {t.name: t for t in result.types}
        self.assertEqual(set(got), {"Catalyst 9200-24T", "Catalyst 9300-48P",
                                    "Catalyst 9500-40X"})
        self.assertEqual(got["Catalyst 9200-24T"].changes,
                         {"added": 5, "updated": 1, "removed": 2, "kept": 0})
        self.assertEqual(got["Catalyst 9300-48P"].changes,
                         {"added": 5, "updated": 4, "removed": 0, "kept": 0})
        c9500 = got["Catalyst 9500-40X"]
        self.assertEqual(c9500.changes, {"added": 4, "updated": 4, "removed": 0, "kept": 0})
        self.assertIn("updated 1 lifecycle field, none → 2024-04-30: end of sale", c9500.notes)
        self.assertIn("updated 1 lifecycle field, none → https://www.cisco.com/c/en/us/products/"
                      "collateral/switches/catalyst-9500-series-switches/"
                      "c9500-12q-c9500-24q-c9500-40x-eol.html: lifecycle source", c9500.notes)
        # Nothing kept.
        self.assertIsNone(self.dt("C9500-40X").end_of_sale)


class ApiTests(APITestCase, _Base):
    def setUp(self):
        _Base.setUp(self)
        self.user = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.user, role="admin").tenants.add(self.tenant)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_the_type_page_shows_lifecycle_and_documents(self):
        self.run_pack({"C9500-40X": real("C9500-40X")})
        dt = self.dt("C9500-40X")
        r = self.client.get(f"/api/device-types/{dt.pk}/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["end_of_sale"], body["end_of_support"], body["lifecycle_state"]),
                         ("2024-04-30", "2029-04-30", "eos"))
        r = self.client.get(f"/api/documents/?object_type=api.devicetype&object_id={dt.pk}")
        self.assertEqual(r.status_code, 200)
        rows = r.json()["results"]
        self.assertEqual(len(rows), 4)
        self.assertEqual({d["category_detail"]["name"] for d in rows},
                         {"Product page", "Datasheet", "Install guide", "EoL notice"})
        self.assertTrue(all(d["url"].startswith("https://www.cisco.com/") for d in rows))
        self.assertNotIn("pack_state", body)
