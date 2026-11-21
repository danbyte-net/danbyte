"""The library's two pass-through port forms: front ports carrying
``rear_port`` / ``rear_port_position`` inline, and the newer top-level
``port-mappings`` list (api.devicetype_import.with_port_mappings), on create
and on a model-pack re-import."""
from __future__ import annotations

import copy
import os
import unittest

import yaml
from django.test import SimpleTestCase, TestCase

from core.models import Organization, Tenant

from .devicetype_import import import_devicetype_yaml, with_port_mappings
from .models import DeviceType
from .tests_model_pack_update import _Base

PANDUIT = "/home/crosk/device-library/device-types/Panduit/DP485E88TGY.yaml"


def panel(form: str, n: int = 3) -> dict:
    """A small patch panel in the ``inline`` or ``mappings`` form."""
    names = [f"{i:02d}" for i in range(1, n + 1)]
    doc = {
        "manufacturer": "Generic", "model": "Panel 3", "part_number": "PNL-3",
        "u_height": 1,
        "front-ports": [{"name": x, "type": "8p8c", "positions": 1} for x in names],
        "rear-ports": [{"name": x, "type": "110-punch", "positions": 1} for x in names],
    }
    if form == "inline":
        for r in doc["front-ports"]:
            r.pop("positions")
            r["rear_port"], r["rear_port_position"] = r["name"], 1
    else:
        doc["port-mappings"] = [{"front_port": x, "front_port_position": 1,
                                 "rear_port": x, "rear_port_position": 1} for x in names]
    return doc


def links(dt) -> dict:
    return {f.name: (f.rear_port_template.name, f.rear_port_position)
            for f in dt.front_port_templates.select_related("rear_port_template")}


class HelperTests(SimpleTestCase):
    def test_mappings_fold_into_the_front_ports(self):
        out, notes = with_port_mappings(panel("mappings"))
        self.assertEqual(notes, [])
        self.assertNotIn("port-mappings", out)
        self.assertEqual(out["front-ports"][1],
                         {"name": "02", "type": "8p8c", "positions": 1,
                          "rear_port": "02", "rear_port_position": 1})

    def test_the_inline_form_is_untouched(self):
        doc = panel("inline")
        out, notes = with_port_mappings(doc)
        self.assertIs(out, doc)
        self.assertEqual(notes, [])

    def test_a_second_call_is_a_no_op_and_the_input_is_not_changed(self):
        doc = panel("mappings")
        before = copy.deepcopy(doc)
        out, _ = with_port_mappings(doc)
        self.assertEqual(doc, before)
        again, notes = with_port_mappings(out)
        self.assertIs(again, out)
        self.assertEqual(notes, [])

    def test_both_forms_take_the_mappings_with_a_note(self):
        doc = panel("mappings")
        doc["front-ports"][0].update(rear_port="03", rear_port_position=1)
        out, notes = with_port_mappings(doc)
        self.assertEqual(out["front-ports"][0]["rear_port"], "01")
        self.assertEqual(notes, ["port-mappings: used instead of the front ports' own "
                                 "rear_port fields (1 front port)."])

    def test_several_mappings_keep_the_first_and_name_the_rest(self):
        doc = panel("mappings", 2)
        doc["front-ports"][0]["positions"] = 2
        doc["port-mappings"].insert(0, {"front_port": "01", "front_port_position": 2,
                                        "rear_port": "02", "rear_port_position": 1})
        out, notes = with_port_mappings(doc)
        self.assertEqual((out["front-ports"][0]["rear_port"],
                          out["front-ports"][0]["rear_port_position"]), ("01", 1))
        self.assertEqual(notes, [
            "front port 01: 2 port mappings - Danbyte links a front port to one rear "
            "port; imported with 01 position 1, left out: position 2 → 02 position 1."])

    def test_a_front_port_without_a_mapping_gets_no_rear_port(self):
        doc = panel("mappings")
        doc["port-mappings"].pop()
        doc["port-mappings"].append({"front_port": "99", "rear_port": "01"})
        out, notes = with_port_mappings(doc)
        self.assertNotIn("rear_port", out["front-ports"][2])
        self.assertEqual(notes, ["port-mappings: front port 99 not in front-ports - ignored."])


class CreateTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def create(self, doc):
        rep = import_devicetype_yaml(self.tenant, yaml.safe_dump(doc, sort_keys=False))
        self.assertTrue(rep["ok"], rep)
        return rep, DeviceType.objects.get(pk=rep["id"])

    def test_both_forms_give_the_same_links(self):
        rep, dt = self.create(panel("mappings"))
        self.assertEqual(rep["created"]["front_ports"], 3)
        self.assertEqual(rep["skipped"], [])
        self.assertEqual(links(dt), {"01": ("01", 1), "02": ("02", 1), "03": ("03", 1)})
        dt.delete()
        rep, dt = self.create(panel("inline"))
        self.assertEqual(links(dt), {"01": ("01", 1), "02": ("02", 1), "03": ("03", 1)})

    def test_many_mappings_and_a_missing_one_are_noted_not_fatal(self):
        doc = panel("mappings")
        doc["port-mappings"].append({"front_port": "01", "front_port_position": 2,
                                     "rear_port": "02", "rear_port_position": 1})
        doc["port-mappings"] = [m for m in doc["port-mappings"] if m["front_port"] != "03"]
        rep, dt = self.create(doc)
        self.assertEqual(links(dt), {"01": ("01", 1), "02": ("02", 1)})
        self.assertIn("front port 01: 2 port mappings - Danbyte links a front port to one "
                      "rear port; imported with 01 position 1, left out: position 2 → 02 "
                      "position 1.", rep["skipped"])
        self.assertIn("front port 03: no rear port mapped - left out (a front port needs "
                      "its rear port); the type is imported without it.", rep["skipped"])
        self.assertEqual(dt.rear_port_templates.count(), 3)

    @unittest.skipUnless(os.path.exists(PANDUIT), "device library checkout not present")
    def test_the_real_library_file(self):
        with open(PANDUIT) as fh:
            text = fh.read()
        self.assertIn("port-mappings:", text)
        rep = import_devicetype_yaml(self.tenant, text)
        self.assertTrue(rep["ok"], rep)
        self.assertEqual(rep["created"]["front_ports"], 48)
        self.assertEqual(rep["created"]["rear_ports"], 48)
        self.assertFalse([n for n in rep["skipped"] if "rear port" in n], rep["skipped"])
        got = links(DeviceType.objects.get(pk=rep["id"]))
        self.assertEqual(got["01"], ("01", 1))
        self.assertEqual(got["48"], ("48", 1))


class PackTests(_Base):
    def test_create_then_re_import_changes_nothing(self):
        row = self.row(self.run_pack({"PNL-3": panel("mappings")}), "PNL-3")
        self.assertEqual(row.action, "created")
        self.assertFalse([n for n in row.notes if "rear port" in n], row.notes)
        dt = self.dt("PNL-3")
        self.assertEqual(links(dt), {"01": ("01", 1), "02": ("02", 1), "03": ("03", 1)})
        row = self.row(self.run_pack({"PNL-3": panel("mappings")}, version="2.0.0"), "PNL-3")
        self.assertEqual(row.changes, {"added": 0, "updated": 0, "removed": 0, "kept": 0})

    def test_a_pack_moving_to_mappings_changes_nothing(self):
        self.run_pack({"PNL-3": panel("inline")})
        row = self.row(self.run_pack({"PNL-3": panel("mappings")}, version="2.0.0"), "PNL-3")
        self.assertEqual(row.action, "matched")
        self.assertEqual(row.changes, {"added": 0, "updated": 0, "removed": 0, "kept": 0})
        self.assertEqual(links(self.dt("PNL-3")),
                         {"01": ("01", 1), "02": ("02", 1), "03": ("03", 1)})

    def test_a_type_imported_without_links_gets_them(self):
        # What the old importer left of a mappings-form panel: no front ports.
        doc = panel("mappings")
        bare = {k: v for k, v in doc.items() if k != "port-mappings"}
        self.run_pack({"PNL-3": bare})
        self.assertEqual(links(self.dt("PNL-3")), {})
        row = self.row(self.run_pack({"PNL-3": doc}, version="2.0.0"), "PNL-3")
        self.assertIn("added 3 front ports: 01, 02, 03", row.notes)

    def test_many_and_missing_mappings_are_noted_once(self):
        doc = panel("mappings")
        doc["port-mappings"].append({"front_port": "01", "front_port_position": 2,
                                     "rear_port": "02", "rear_port_position": 1})
        doc["port-mappings"] = [m for m in doc["port-mappings"] if m["front_port"] != "03"]
        row = self.row(self.run_pack({"PNL-3": doc}), "PNL-3")
        many = [n for n in row.notes if n.startswith("front port 01:")]
        missing = [n for n in row.notes if n.startswith("front port 03:")]
        self.assertEqual(len(many), 1, row.notes)
        self.assertIn("left out: position 2 → 02 position 1", many[0])
        self.assertEqual(missing, ["front port 03: no rear port mapped - left out (a front "
                                   "port needs its rear port); skipped."])
        self.assertEqual(links(self.dt("PNL-3")), {"01": ("01", 1), "02": ("02", 1)})
