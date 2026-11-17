"""The Pluggables page's API (docs/dcim/pluggables.md): editing an accessory
type and its "changed by hand" protection against a pack re-import, the
usage of a part (records set by hand, records matched by part number,
ports it is the fallback for), list filters and counts, delete only when
unused, permissions and tenant scoping, one port's parts (the interface
page's thumbnail) and the Transceivers list's inventory filters."""
from __future__ import annotations

import io
import shutil
import tempfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile

from .models import AccessoryType, Interface, InventoryItem, Site
from .tests_model_anchors import model
from .tests_port_plugs import SFP, _AccessoryPack, plug_glb
from .tests_port_plugs import _Base as _PlugBase


class _Base(_PlugBase):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        self.lr = self._acc("SFP-10G-LR", "lc", SFP)
        self.lr.kind, self.lr.parts, self.lr.standard = "transceiver", ["SFP-10G-LR"], "10GBASE-LR"
        self.lr.save()
        self.gen = self._acc("SFP-GENERIC", "lc", SFP)
        self.gen.kind = "transceiver"
        self.gen.save()
        self.lcd = self._acc("LC-DUPLEX", "lc", ["lc-duplex"])
        self.lcd.kind = "cord"
        self.lcd.save()
        self.te1 = self._iface(self.dev, "Te1/0/1")
        self.te2 = self._iface(self.dev, "Te1/0/2")

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        super().tearDown()

    def _item(self, name, *, part="", iface=None, acc=None, dev=None, **kw):
        return InventoryItem.objects.create(
            device=dev or self.dev, name=name, kind="transceiver", part_id=part,
            interface=iface, accessory_type=acc, **kw)

    def _user(self, actions_by_types):
        """A user with one grant per ``(types, actions)``."""
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, actions) in enumerate(actions_by_types):
            grant = ObjectPermission.objects.create(name=f"g{user.pk}-{i}",
                                                    object_types=types, actions=actions)
            grant.users.add(user)
            grant.tenants.add(self.tenant)
        self._login(user)
        return user

    def _usage(self, acc):
        res = self.client.get(f"/api/accessory-types/{acc.id}/usage/")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["results"]

    def _patch(self, acc, data):
        return self.client.patch(f"/api/accessory-types/{acc.id}/", data,
                                 content_type="application/json")


class EditTests(_Base):
    def test_edits_mark_the_fields_changed_by_hand(self):
        res = self._patch(self.lcd, {
            "fits": ["LC-Duplex", "lc-duplex", "lc-apc-duplex"], "parts": ["X1", "x1="],
            "standard": " OS2 patch ", "wavelength_nm": 1310, "reach_m": 10,
            "cable": {"profile": "zipcord", "jacket_mm": 2.0, "pitch_mm": 3.0},
            "name": "renamed", "kind": "plug"})
        self.assertEqual(res.status_code, 200, res.content)
        self.lcd.refresh_from_db()
        self.assertEqual((self.lcd.name, self.lcd.kind), ("LC-DUPLEX", "cord"))
        self.assertEqual(self.lcd.fits, ["lc-duplex", "lc-apc-duplex"])
        self.assertEqual(self.lcd.parts, ["X1"])
        self.assertEqual((self.lcd.standard, self.lcd.wavelength_nm, self.lcd.reach_m),
                         ("OS2 patch", 1310, 10))
        self.assertEqual(self.lcd.cable, {"profile": "zipcord", "jacket_mm": 2.0,
                                          "pitch_mm": 3.0, "min_bend_mm": None})
        self.assertEqual(self.lcd.hand_edited, ["fits", "parts", "standard", "wavelength_nm",
                                                "reach_m", "cable"])
        self.assertEqual(res.json()["hand_edited"], self.lcd.hand_edited)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.accessorytype", object_id=str(self.lcd.pk)).exists())

    def test_an_unchanged_value_marks_nothing(self):
        res = self._patch(self.lr, {"standard": "10GBASE-LR", "parts": ["SFP-10G-LR"]})
        self.assertEqual(res.status_code, 200, res.content)
        self.lr.refresh_from_db()
        self.assertEqual(self.lr.hand_edited, [])

    def test_bad_values(self):
        for acc, data, field in (
                (self.lcd, {"fits": ["bad slug"]}, "fits"),
                (self.lcd, {"fits": []}, "fits"),
                (self.lcd, {"parts": "SFP"}, "parts"),
                (self.lcd, {"parts": [""]}, "parts"),
                (self.lcd, {"wavelength_nm": 0}, "wavelength_nm"),
                (self.lcd, {"reach_m": -1}, "reach_m"),
                (self.lcd, {"cable": {"profile": "flat", "jacket_mm": 2}}, "cable"),
                (self.lcd, {"cable": {"profile": "round"}}, "cable"),
                (self.lr, {"cable": {"profile": "round", "jacket_mm": 3}}, "cable"),
                (self.lcd, {"hand_edited": ["fits"]}, "hand_edited")):
            res = self._patch(acc, data)
            self.assertEqual(res.status_code, 400, (data, res.content))
            self.assertIn(field, res.json(), data)

    def test_handing_fields_back_to_the_pack(self):
        self._patch(self.lcd, {"fits": ["lc-duplex", "lc"], "standard": "x"})
        res = self._patch(self.lcd, {"hand_edited": ["standard"]})
        self.assertEqual(res.status_code, 200, res.content)
        self.lcd.refresh_from_db()
        self.assertEqual(self.lcd.hand_edited, ["standard"])

    def test_replace_the_model(self):
        up = SimpleUploadedFile("x.glb", plug_glb(), content_type="model/gltf-binary")
        res = self.client.post(f"/api/accessory-types/{self.lcd.id}/model/", {"file": up})
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["hand_edited"], ["model"])
        self.assertIn("2 triangles.", body["model_notes"])
        self.lcd.refresh_from_db()
        with self.lcd.model_3d.open("rb") as fh:
            self.assertEqual(fh.read(), plug_glb())
        bad = SimpleUploadedFile("x.glb", b"not a model")
        res = self.client.post(f"/api/accessory-types/{self.lcd.id}/model/", {"file": bad})
        self.assertEqual(res.status_code, 400)
        self.assertIn("file", res.json())


class ImportTests(_Base):
    """A pack re-import keeps what was changed by hand."""

    def setUp(self):
        super().setUp()
        AccessoryType.objects.filter(name="RJ45-PLUG").delete()
        self.p = _AccessoryPack()

    def tearDown(self):
        self.p.cleanup()
        super().tearDown()

    def _import(self) -> str:
        out = io.StringIO()
        call_command("import_model_pack", self.p.root, "--tenant", "t", "--apply", stdout=out)
        return out.getvalue()

    def test_hand_edits_survive_a_reimport(self):
        self._import()
        acc = AccessoryType.objects.get(tenant=self.tenant, name="RJ45-PLUG")
        self.assertEqual(acc.pack_import["triangles"], 2)
        self.assertEqual(self._patch(acc, {"fits": ["1000base-t"], "reach_m": 5}).status_code,
                         200)
        model_bytes = model([{"name": "Other", "mesh": "Metal"}], materials=("Metal",))
        up = SimpleUploadedFile("x.glb", model_bytes)
        self.assertEqual(self.client.post(f"/api/accessory-types/{acc.id}/model/",
                                          {"file": up}).status_code, 200)
        out = self._import()
        self.assertIn("fits: changed by hand - kept; the pack says otherwise.", out)
        self.assertIn("model: replaced by hand - kept.", out)
        acc.refresh_from_db()
        self.assertEqual(acc.fits, ["1000base-t"])
        self.assertEqual(acc.reach_m, 5)
        self.assertEqual(acc.hand_edited, ["fits", "reach_m", "model"])
        with acc.model_3d.open("rb") as fh:
            self.assertEqual(fh.read(), model_bytes)
        # Handed back: the next import sets them again.
        self.assertEqual(self._patch(acc, {"hand_edited": []}).status_code, 200)
        out = self._import()
        self.assertNotIn("changed by hand", out)
        acc.refresh_from_db()
        self.assertEqual(acc.fits, ["1000base-t", "10gbase-t", "rj-45"])
        with acc.model_3d.open("rb") as fh:
            self.assertEqual(fh.read(), plug_glb())


class UsageTests(_Base):
    def test_records_and_fallbacks(self):
        self._item("SFP 1", part="X", iface=self.te1, acc=self.lr, serial_number="S1")
        self._item("SFP 2", part="sfp-10g-lr=", iface=self.te2, serial_number="S2")
        spare = self._item("SFP 3", part="SFP-10G-LR")
        dev2 = self._device("sw2")
        self._typed(dev2)
        self._cable(self._iface(dev2, "Te1/0/1"), type="smf-os2")
        rows = self._usage(self.lr)
        self.assertEqual([(r["device"]["name"], (r["port"] or {}).get("name"), r["source"],
                           r["item"]["serial_number"]) for r in rows],
                         [("sw1", "Te1/0/1", "set", "S1"), ("sw1", "Te1/0/2", "part", "S2"),
                          ("sw1", None, "part", "")])
        self.assertEqual(rows[0]["site"], {"id": str(self.site.id), "name": "A"})
        self.assertEqual(rows[2]["item"]["id"], str(spare.id))
        gen = self._usage(self.gen)
        self.assertEqual([(r["device"]["name"], r["port"]["name"], r["source"], r["cabled"],
                           r["cable_type"]) for r in gen],
                         [("sw2", "Te1/0/1", "fallback", True, "smf-os2")])
        cord = self._usage(self.lcd)
        self.assertEqual([(r["device"]["name"], r["port"]["name"], r["role"]) for r in cord],
                         [("sw2", "Te1/0/1", "cord")])

    def test_list_counts_and_in_use_filter(self):
        self._item("SFP 1", part="SFP-10G-LR", iface=self.te1)
        self._cable(self.te2, type="mmf-om4")
        res = self.client.get("/api/accessory-types/")
        self.assertEqual(res.status_code, 200, res.content)
        counts = {r["name"]: r["in_use"] for r in res.json()["results"]}
        self.assertEqual(counts["SFP-10G-LR"], 1)
        self.assertEqual(counts["SFP-GENERIC"], 1)
        self.assertEqual(counts["LC-DUPLEX"], 1)
        self.assertEqual(counts["SFP-DAC"], 0)
        used = self.client.get("/api/accessory-types/", {"in_use": "true"}).json()["results"]
        self.assertEqual(sorted(r["name"] for r in used),
                         ["LC-DUPLEX", "SFP-10G-LR", "SFP-GENERIC"])
        free = self.client.get("/api/accessory-types/", {"in_use": "false"}).json()["results"]
        self.assertNotIn("SFP-10G-LR", [r["name"] for r in free])
        detail = self.client.get(f"/api/accessory-types/{self.lr.id}/").json()
        self.assertEqual((detail["in_use"], detail["part_records"]), (1, {"SFP-10G-LR": 1}))

    def test_without_inventory_view_records_count_for_nothing(self):
        self._item("SFP 1", part="SFP-10G-LR", iface=self.te1)
        self._user([(["moduletype", "device", "interface", "cable"], ["view"])])
        self.assertEqual(self._usage(self.lr), [])

    def test_query_count_does_not_grow_with_devices(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get("/api/accessory-types/").status_code, 200)
                self._usage(self.lr)
            return len(ctx.captured_queries)

        self._item("SFP 1", part="SFP-10G-LR", iface=self.te1)
        self._cable(self.te2, type="mmf")
        one = count()
        for n in range(3):
            d = self._device(f"x{n}")
            self._typed(d)
            self._item(f"SFP x{n}", part="SFP-10G-LR", dev=d, iface=self._iface(d, "Te1/0/1"))
            self._cable(self._iface(d, "Te1/0/2"), type="mmf")
        self.assertEqual(count(), one)


class FilterTests(_Base):
    def _names(self, **params):
        res = self.client.get("/api/accessory-types/", params)
        self.assertEqual(res.status_code, 200, res.content)
        return sorted(r["name"] for r in res.json()["results"])

    def test_filters(self):
        AccessoryType.objects.filter(pk=self.lr.pk).update(
            pack_import={"pack": {"name": "Optics", "version": "1"}})
        self.assertEqual(self._names(kind="transceiver"), ["SFP-10G-LR", "SFP-GENERIC"])
        self.assertEqual(self._names(connector="dac"), ["SFP-DAC"])
        self.assertEqual(self._names(fits="lc-duplex"), ["LC-DUPLEX"])
        self.assertEqual(self._names(pack="Optics"), ["SFP-10G-LR"])
        self.assertEqual(self._names(search="10g-lr"), ["SFP-10G-LR"])
        self.assertEqual(self._names(search="10GBASE"), ["SFP-10G-LR"])


class DeleteTests(_Base):
    def test_only_an_unused_part_goes(self):
        self._item("SFP 1", part="X", acc=self.lr)
        self.assertEqual(self.client.delete(f"/api/accessory-types/{self.lr.id}/").status_code,
                         409)
        self._cable(self.te1, type="mmf")
        self.assertEqual(self.client.delete(f"/api/accessory-types/{self.gen.id}/").status_code,
                         409)
        res = self.client.delete(f"/api/accessory-types/{self.dac.id}/")
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(AccessoryType.objects.filter(pk=self.dac.pk).exists())

    def test_use_the_reader_cannot_see_still_blocks(self):
        self._cable(self.te1, type="mmf")
        self._user([(["moduletype"], ["view", "delete"])])
        self.assertEqual(self.client.delete(f"/api/accessory-types/{self.gen.id}/").status_code,
                         409)


class PermissionTests(_Base):
    def test_view_only(self):
        self._user([(["moduletype"], ["view"])])
        self.assertEqual(self.client.get("/api/accessory-types/").status_code, 200)
        self.assertEqual(self.client.get(f"/api/accessory-types/{self.lr.id}/").status_code, 200)
        self.assertEqual(self._patch(self.lr, {"standard": "x"}).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/accessory-types/{self.dac.id}/").status_code,
                         403)
        up = SimpleUploadedFile("x.glb", plug_glb())
        self.assertEqual(self.client.post(f"/api/accessory-types/{self.lr.id}/model/",
                                          {"file": up}).status_code, 403)

    def test_change(self):
        self._user([(["moduletype"], ["view", "change"])])
        self.assertEqual(self._patch(self.lr, {"standard": "x"}).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/accessory-types/{self.dac.id}/").status_code,
                         403)

    def test_no_view(self):
        self._user([(["device"], ["view", "change"])])
        self.assertEqual(self.client.get("/api/accessory-types/").status_code, 403)
        self.assertEqual(self._patch(self.lr, {"standard": "x"}).status_code, 403)

    def test_other_tenants_parts_are_not_found(self):
        other = self._acc("X", "lc", SFP, tenant=self.other)
        for res in (self.client.get(f"/api/accessory-types/{other.id}/"),
                    self._patch(other, {"standard": "x"}),
                    self.client.delete(f"/api/accessory-types/{other.id}/"),
                    self.client.get(f"/api/accessory-types/{other.id}/usage/"),
                    self.client.get("/api/accessory-types/not-a-uuid/")):
            self.assertEqual(res.status_code, 404)
        other.refresh_from_db()
        self.assertEqual(other.standard, "")


class PortPartsTests(_Base):
    def _parts(self, iface):
        res = self.client.get(f"/api/interfaces/{iface.id}/parts/")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_a_cabled_cage(self):
        self._cable(self.te1, type="smf-os2", color="#AABBCC")
        p = self._parts(self.te1)
        self.assertEqual((p["cabled"], p["color"], p["cable_type"]),
                         (True, "#aabbcc", "smf-os2"))
        self.assertEqual(p["transceiver_part"]["id"], str(self.gen.id))
        self.assertEqual(p["cord_part"]["id"], str(self.lcd.id))
        self.assertTrue(p["cord_part"]["url"].startswith(
            f"/api/accessory-types/{self.lcd.id}/model/"))

    def test_a_record(self):
        self._item("SFP 1", part="SFP-10G-LR", iface=self.te2)
        p = self._parts(self.te2)
        self.assertEqual(p["transceiver_part"]["name"], "SFP-10G-LR")
        self.assertIsNone(p["cord_part"])

    def test_free_port_and_other_tenant(self):
        self.assertIsNone(self._parts(self.te1)["transceiver_part"])
        site = Site.objects.create(tenant=self.other, name="B")
        from .models import Device

        dev = Device.objects.create(tenant=self.other, name="far", site=site)
        far = Interface.objects.create(device=dev, name="x")
        self.assertEqual(self.client.get(f"/api/interfaces/{far.id}/parts/").status_code, 404)

    def test_without_module_type_view_no_type_link(self):
        self._cable(self.te1, type="mmf")
        self._user([(["device", "interface", "cable"], ["view"])])
        p = self._parts(self.te1)
        self.assertIsNone(p["transceiver_part"]["id"])
        self.assertTrue(p["transceiver_part"]["url"].startswith(
            f"/api/devices/{self.dev.id}/accessory-model/"))


class TransceiverListTests(_Base):
    def _rows(self, **params):
        res = self.client.get("/api/inventory-items/", {"kind": "transceiver", **params})
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["results"]

    def test_filters_and_columns(self):
        self._item("SFP 1", part="SFP-10G-LR", iface=self.te1, serial_number="FNS1",
                   standard="10GBASE-LR")
        self._item("SFP 2", part="GLC-T", serial_number="FNS2")
        self._cable(self.te1, type="smf")
        site_b = Site.objects.create(tenant=self.tenant, name="B")
        from .models import Device

        dev_b = Device.objects.create(tenant=self.tenant, name="b1", site=site_b)
        self._item("SFP 3", part="SFP-10G-LR", dev=dev_b)
        rows = self._rows()
        self.assertEqual(len(rows), 3)
        first = next(r for r in rows if r["name"] == "SFP 1")
        self.assertEqual(first["site"], {"id": str(self.site.id), "name": "A"})
        self.assertEqual(first["interface"], {"id": str(self.te1.id), "name": "Te1/0/1",
                                              "cabled": True})
        self.assertEqual(first["pluggable"]["id"], str(self.lr.id))
        self.assertIsNone(next(r for r in rows if r["name"] == "SFP 2")["pluggable"])
        self.assertEqual([r["name"] for r in self._rows(site=str(site_b.id))], ["SFP 3"])
        self.assertEqual(sorted(r["name"] for r in self._rows(part="10g-lr")),
                         ["SFP 1", "SFP 3"])
        self.assertEqual([r["name"] for r in self._rows(standard="10gbase-lr")], ["SFP 1"])
        self.assertEqual([r["name"] for r in self._rows(cabled="true")], ["SFP 1"])
        self.assertEqual([r["name"] for r in self._rows(in_port="false", search="FNS2")],
                         ["SFP 2"])

    def test_query_count_does_not_grow_with_rows(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._rows()
            return len(ctx.captured_queries)

        self._item("SFP 1", part="SFP-10G-LR", iface=self.te1)
        one = count()
        for n in range(4):
            self._item(f"SFP x{n}", part="SFP-10G-LR")
        self.assertEqual(count(), one)
