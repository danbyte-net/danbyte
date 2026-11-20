"""Markdown links in a type's description move to its Documents
(api.description_links): the helper, the library and pack imports, and the
``description_links`` command for types imported before."""
from __future__ import annotations

import copy
import io

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from . import tests_model_pack_update as mpu
from .description_links import link_kind, split
from .devicetype_import import import_devicetype_yaml, import_moduletype_yaml
from .models import DeviceType, Document, Manufacturer, ModuleType

DS = "https://www.cisco.com/c/en/us/products/collateral/switches/c9200-ds.html"


class SplitTests(SimpleTestCase):
    def test_only_a_link_leaves_no_text(self):
        self.assertEqual(split(f"[Catalyst 9200 Data Sheet]({DS})"),
                         ("", [("Catalyst 9200 Data Sheet", DS)]))

    def test_several_links_with_bullets_and_separators(self):
        text = ("- [A](https://a.example.com/1)\n* [B](https://b.example.com/2 \"Bee\")\n"
                "1. [C](https://c.example.com/3) | <https://d.example.com/4>")
        plain, links = split(text)
        self.assertEqual(plain, "")
        self.assertEqual([u for _, u in links], ["https://a.example.com/1",
                                                 "https://b.example.com/2",
                                                 "https://c.example.com/3",
                                                 "https://d.example.com/4"])
        self.assertEqual(links[3][0], "https://d.example.com/4")

    def test_a_link_mid_sentence_keeps_its_label(self):
        self.assertEqual(
            split("48-port switch. See the [data   sheet](https://a.example.com/x)  "
                  "and\n\n\n\nthe [guide](https://a.example.com/g)."),
            ("48-port switch. See the data sheet and\n\nthe guide.",
             [("data sheet", "https://a.example.com/x"),
              ("guide", "https://a.example.com/g")]))

    def test_parentheses_in_a_url(self):
        self.assertEqual(split("Read [this](https://en.example.org/wiki/A_(b)) first."),
                         ("Read this first.", [("this", "https://en.example.org/wiki/A_(b)")]))
        self.assertEqual(split("[x](https://a.example.com/a(b(c))d)")[1],
                         [("x", "https://a.example.com/a(b(c))d")])

    def test_plain_text_comes_back_unchanged(self):
        for text in ("48-port  switch\n\n\n", "a [b] c (d)", "x < y > z", "", "see ](x)"):
            self.assertEqual(split(text), (text, []))
        self.assertEqual(split(None), ("", []))

    def test_images_and_other_schemes_are_not_links(self):
        for text in ("![front](https://a.example.com/f.png)", "[mail](mailto:a@example.com)",
                     "[f](ftp://a.example.com/x)", "<ftp://a.example.com/x>"):
            self.assertEqual(split(text), (text, []))
        image = "![i](https://a.example.com/i.png)"
        self.assertEqual(split(f"{image} [d](https://a.example.com/d)"),
                         (f"{image} d", [("d", "https://a.example.com/d")]))

    def test_a_url_a_pack_may_not_attach_stays_as_written(self):
        for url in ("http://10.0.0.1/x", "http://wiki.local/x", "https://u:p@a.example.com/",
                    "https://a.example.com/" + "x" * 2100):
            text = f"[x]({url})"
            self.assertEqual(split(text), (text, []))
        self.assertEqual(split("[a](http://10.0.0.1/x) [b](https://b.example.com/)"),
                         ("[a](http://10.0.0.1/x) b", [("b", "https://b.example.com/")]))

    def test_a_url_twice_is_one_link(self):
        self.assertEqual(split("[a](https://a.example.com/) or [A](https://a.example.com/)"),
                         ("a or A", [("a", "https://a.example.com/")]))

    def test_kinds_from_the_title(self):
        self.assertEqual(link_kind("Catalyst 9200 Series Switches Data Sheet"), "datasheet")
        self.assertEqual(link_kind("Hardware Installation Guide"), "install-guide")
        self.assertEqual(link_kind("Software Configuration Guide"), "config-guide")
        self.assertEqual(link_kind("End-of-Sale and End-of-Life Announcement"), "eol-notice")
        self.assertEqual(link_kind("Product page"), "other")


def _yaml(comments: str, *, module=False) -> str:
    import yaml

    doc = {"manufacturer": "Cisco", "model": "X1", "part_number": "X1",
           "comments": comments}
    if not module:
        doc.update({"slug": "cisco-x1", "u_height": 1})
    return yaml.safe_dump(doc)


class _Tenants(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")

    def docs(self, obj):
        return Document.objects.filter(object_type=obj._meta.label_lower, object_id=obj.pk)


class LibraryImportTests(_Tenants):
    def test_a_device_types_comment_links_become_documents(self):
        rep = import_devicetype_yaml(
            self.tenant, _yaml(f"[Catalyst Data Sheet]({DS})\n[Support](https://a.example.com/s)"),
            image_inventory=set())
        self.assertTrue(rep["ok"], rep)
        dt = DeviceType.objects.get(pk=rep["id"])
        self.assertEqual(dt.description, "")
        self.assertEqual(sorted(self.docs(dt).values_list("category__name", "name", "url")), [
            ("Datasheet", "Catalyst Data Sheet", DS),
            ("Other", "Support", "https://a.example.com/s")])
        self.assertFalse(self.docs(dt).exclude(tenant=self.tenant).exists())
        self.assertFalse(self.docs(dt).exclude(object_site_id=None).exists())
        self.assertIn("comments: 2 links added as documents", rep["skipped"])
        self.assertIsNone(dt.pack_state)
        self.assertEqual(ChangeLogEntry.objects.filter(object_type="api.document").count(), 2)

    def test_a_module_types_comment_links_become_documents(self):
        rep = import_moduletype_yaml(
            self.tenant, _yaml(f"Hot-swap PSU, see [the data sheet]({DS}).", module=True))
        self.assertTrue(rep["ok"], rep)
        mt = ModuleType.objects.get(pk=rep["id"])
        self.assertEqual(mt.description, "Hot-swap PSU, see the data sheet.")
        self.assertEqual(list(self.docs(mt).values_list("name", flat=True)),
                         ["the data sheet"])
        self.assertIn("comments: 1 link added as documents", rep["skipped"])

    def test_plain_comments_stay_and_make_no_document(self):
        rep = import_devicetype_yaml(self.tenant, _yaml("Fixed 1U switch."),
                                     image_inventory=set())
        dt = DeviceType.objects.get(pk=rep["id"])
        self.assertEqual(dt.description, "Fixed 1U switch.")
        self.assertFalse(self.docs(dt).exists())


class PackImportTests(mpu._Base):
    def docs(self, obj):
        return Document.objects.filter(object_type=obj._meta.label_lower, object_id=obj.pk)

    def test_comment_links_are_the_packs_and_the_summary_fills_the_description(self):
        doc = mpu.real("C9200-24T")
        doc["meta"] = {"summary": "24-port access switch."}
        self.run_pack({"C9200-24T": doc})
        dt = self.dt("C9200-24T")
        self.assertEqual(dt.description, "24-port access switch.")
        url = next(iter(dt.pack_state["links"]))
        self.assertIn("nb-06-cat9200-ser-data-sheet", url)
        self.assertEqual(list(self.docs(dt).values_list("category__name", flat=True)),
                         ["Datasheet"])
        # Again: nothing changes.
        row = self.row(self.run_pack({"C9200-24T": doc}), "C9200-24T")
        self.assertEqual(row.changes["added"], 0, row.notes)
        self.assertEqual(self.docs(dt).count(), 1)

    def test_a_meta_link_with_the_same_url_wins(self):
        doc = mpu.real("C9200-24T")
        url = doc["comments"].split("(", 1)[1].rstrip(")")
        doc["meta"] = {"links": [{"kind": "product-page", "title": "Ours", "url": url}]}
        self.run_pack({"C9200-24T": doc})
        dt = self.dt("C9200-24T")
        self.assertEqual(list(self.docs(dt).values_list("name", "category__name")),
                         [("Ours", "Product page")])

    def test_a_deleted_comment_link_is_not_added_back(self):
        doc = mpu.real("C9200-24T")
        doc.pop("meta", None)
        self.run_pack({"C9200-24T": doc})
        dt = self.dt("C9200-24T")
        self.docs(dt).delete()
        row = self.row(self.run_pack({"C9200-24T": doc}, version="2.0.0"), "C9200-24T")
        self.assertFalse(self.docs(dt).exists())
        self.assertTrue(any(n.startswith("kept your removal of 1 document") for n in row.notes),
                        row.notes)

    def test_a_matched_type_holding_the_raw_comments_gets_plain_text(self):
        doc = mpu.real("C9200-24T")
        doc["meta"] = {"summary": "24-port access switch."}
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="Catalyst 9200-24T", model="C9200-24T",
            part_number="C9200-24T",
            manufacturer=Manufacturer.objects.create(tenant=self.tenant, name="Cisco"),
            description=doc["comments"])
        self.run_pack({"C9200-24T": doc})
        dt.refresh_from_db()
        self.assertEqual(dt.description, "24-port access switch.")
        self.assertEqual(self.docs(dt).count(), 1)

    def test_an_edited_description_is_kept(self):
        doc = mpu.real("C9200-24T")
        self.run_pack({"C9200-24T": doc})
        dt = self.dt("C9200-24T")
        dt.description = "Ours."
        dt.save()
        self.run_pack({"C9200-24T": doc}, version="2.0.0")
        dt.refresh_from_db()
        self.assertEqual(dt.description, "Ours.")

    def test_a_module_type_from_a_pack(self):
        d = copy.deepcopy(mpu.ModuleTypeTests.PSU)
        d["comments"] = f"[PSU Data Sheet]({DS})"
        self.run_pack({}, modules={"PWR-X": d})
        mt = ModuleType.objects.get(tenant=self.tenant, part_number="PWR-X")
        self.assertEqual(mt.description, "")
        self.assertIn(DS, mt.pack_state["links"])
        self.assertEqual(self.docs(mt).count(), 1)

    def test_a_dry_run_keeps_nothing(self):
        self.run_pack({"C9200-24T": mpu.real("C9200-24T")}, dry_run=True)
        self.assertFalse(Document.objects.exists())


class CommandTests(_Tenants):
    def setUp(self):
        super().setUp()
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="A", model="A", manufacturer=self.mfr,
            description=f"[A Data Sheet]({DS})")
        self.mt = ModuleType.objects.create(
            tenant=self.tenant, name="M", manufacturer=self.mfr,
            description="PSU. [Guide](https://a.example.com/g)")
        other_mfr = Manufacturer.objects.create(tenant=self.other, name="Cisco")
        self.theirs = DeviceType.objects.create(
            tenant=self.other, name="B", model="B", manufacturer=other_mfr,
            description=f"[B]({DS})")

    def run_cmd(self, *args):
        out = io.StringIO()
        call_command("description_links", *args, stdout=out)
        return out.getvalue()

    def test_a_dry_run_reports_and_keeps_nothing(self):
        out = self.run_cmd("--tenant", "t")
        self.assertIn("Would convert 2 type(s): 2 link(s), 2 document(s) added", out)
        self.assertIn("t: device type A: 1 link(s), 1 document(s) added; description empty",
                      out)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.description, f"[A Data Sheet]({DS})")
        self.assertFalse(Document.objects.exists())

    def test_apply_converts_once_within_the_tenant(self):
        mine = Document.objects.create(tenant=self.tenant, object_type="api.moduletype",
                                       object_id=self.mt.pk, name="Ours",
                                       url="https://a.example.com/g")
        out = self.run_cmd("--tenant", "t", "--apply")
        self.assertIn("Converted 2 type(s): 2 link(s), 1 document(s) added", out)
        self.dt.refresh_from_db()
        self.mt.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual(self.dt.description, "")
        self.assertEqual(self.mt.description, "PSU. Guide")
        self.assertEqual(list(self.docs(self.dt).values_list("name", "category__name",
                                                              "tenant")),
                         [("A Data Sheet", "Datasheet", self.tenant.pk)])
        self.assertEqual(list(self.docs(self.mt)), [mine])
        self.assertEqual(self.theirs.description, f"[B]({DS})")
        self.assertTrue(ChangeLogEntry.objects.filter(object_type="api.document",
                                                      cause="Description links").exists())
        self.assertIn("Converted 0 type(s)", self.run_cmd("--tenant", "t", "--apply"))
        self.assertIn("Converted 1 type(s)", self.run_cmd("--apply"))
        self.assertEqual(self.docs(self.theirs).get().tenant, self.other)
        self.assertIn("Converted 0 type(s)", self.run_cmd("--apply"))

    def test_a_pack_type_records_the_links_and_takes_its_summary(self):
        self.dt.pack_state = {"pack": {"name": "P"}, "meta": {"summary": "A switch."}}
        self.dt.save()
        self.run_cmd("--apply", "--tenant", str(self.tenant.pk))
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.description, "A switch.")
        self.assertEqual(self.dt.pack_state["description"], "A switch.")
        self.assertIn(DS, self.dt.pack_state["links"])

    def test_an_unknown_tenant(self):
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            self.run_cmd("--tenant", "nope")
