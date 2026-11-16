"""Plugs in cabled ports (export spec §13, api.port_plugs): which accessory
type a port takes, importing accessory types from a pack, the
``/api/device-leds/`` and device studio payloads' ``plugs`` (in a query
count that does not grow with the devices), the reader's scope, and the
accessory model endpoints."""
from __future__ import annotations

import io
import os
import shutil
import tempfile
from types import SimpleNamespace

from django.contrib.auth.models import User
from django.core.management import call_command
from django.db import connection
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext

from auth_api.models import ObjectPermission, UserProfile

from .model_pack import PackFiles
from .model_pack_check import check_pack
from .models import (
    AccessoryType,
    Cable,
    CableTermination,
    ConsolePort,
    ConsolePortTemplate,
    DeviceType,
    Interface,
    ModuleInterfaceTemplate,
)
from .port_plugs import cable_medium, choose, connector_medium, read_accessory
from .tests_model_anchors import OUT_FRONT, model
from .tests_model_pack_install import PackDir
from .tests_port_covers import _Base as _CoverBase


def _part(name, connector, fits, vendor="Generic"):
    return SimpleNamespace(name=name, vendor=vendor, connector=connector, fits=fits)


SFP = ["1000base-x-sfp", "10gbase-x-sfpp", "25gbase-x-sfp28"]
SR = _part("SFP-SR-LC", "lc", SFP)
DAC = _part("SFP-DAC", "dac", SFP)
SFPT = _part("SFP-T", "rj45", ["1000base-x-sfp"])
RJ45 = _part("RJ45-PLUG", "rj45", ["1000base-t", "10gbase-t", "rj-45"])
C13 = _part("IEC-C13", "iec-c13", ["iec-60320-c14"])
ALL = [SR, DAC, SFPT, RJ45, C13]


class ChoiceTests(SimpleTestCase):
    def test_media(self):
        self.assertEqual([connector_medium(c) for c in ("lc", "MPO", "dac", "rj45", "iec-c13")],
                         ["fibre", "fibre", "dac", "copper", ""])
        self.assertEqual([cable_medium(t) for t in ("mmf-om4", "smf-os2", "dac-passive",
                                                    "cat6a", "power", "")],
                         ["fibre", "fibre", "dac", "copper", "", ""])

    def test_the_port_type_picks_the_part(self):
        self.assertIs(choose(ALL, "1000base-t"), RJ45)
        self.assertIs(choose(ALL, "rj-45"), RJ45)
        self.assertIs(choose(ALL, "iec-60320-c14", "power"), C13)
        self.assertIsNone(choose(ALL, "40gbase-x-qsfpp"))
        self.assertIsNone(choose(ALL, ""))

    def test_a_cage_takes_the_cables_medium(self):
        self.assertIs(choose(ALL, "10gbase-x-sfpp", "dac-passive"), DAC)
        self.assertIs(choose(ALL, "10gbase-x-sfpp", "mmf-om4"), SR)
        self.assertIs(choose(ALL, "1000base-x-sfp", "cat6"), SFPT)

    def test_an_unknown_medium_takes_the_optic(self):
        self.assertIs(choose(ALL, "10gbase-x-sfpp"), SR)
        self.assertIs(choose(ALL, "10gbase-x-sfpp", "coaxial"), SR)

    def test_a_known_medium_no_part_has_shows_nothing(self):
        self.assertIsNone(choose([SR, DAC], "10gbase-x-sfpp", "cat6"))

    def test_read_accessory(self):
        doc = {"name": "RJ45-PLUG", "kind": "plug", "connector": "RJ45",
               "fits": ["1000base-t", "1000BASE-T", "bad slug"],
               "model3d": {"file": "models/Generic/RJ45-PLUG.glb"}}
        fields, notes = read_accessory("accessory-types/Generic/RJ45-PLUG.yaml", doc)
        self.assertEqual(fields, {"vendor": "Generic", "name": "RJ45-PLUG", "kind": "plug",
                                  "connector": "rj45", "fits": ["1000base-t"],
                                  "file": "models/Generic/RJ45-PLUG.glb"})
        self.assertEqual(notes, ["fits: 'bad slug' is not a type slug - ignored."])
        for bad, why in (({**doc, "kind": "cable"}, "kind"), ({**doc, "fits": []}, "fits"),
                         ({**doc, "model3d": {"file": "../x.glb"}}, "model3d.file"),
                         ({**doc, "name": ""}, "name")):
            fields, notes = read_accessory("accessory-types/Generic/X.yaml", bad)
            self.assertIsNone(fields)
            self.assertIn(why, notes[0])


# ── packs ───────────────────────────────────────────────────────────────────

ACCESSORY = """\
name: RJ45-PLUG
kind: plug
connector: rj45
fits: [1000base-t, 10gbase-t, rj-45]
model3d:
  file: models/Generic/RJ45-PLUG.glb
"""


def plug_glb() -> bytes:
    """A tiny part: a body behind the origin, a CABLE jacket and the
    ``cable`` empty at the stub's end."""
    return model([
        {"name": "Body", "mesh": "Metal", "translation": [0, 0, -0.01]},
        {"name": "Boot", "mesh": "CABLE", "translation": [0, 0, 0.01]},
        {"name": "cable", "translation": [0, 0, 0.04], "rotation": OUT_FRONT},
    ], materials=("Metal", "CABLE"))


class _AccessoryPack(PackDir):
    def __init__(self):
        super().__init__()
        self.write("models/Generic/RJ45-PLUG.glb", plug_glb())
        self.write("accessory-types/Generic/RJ45-PLUG.yaml", ACCESSORY)
        with open(os.path.join(self.root, "pack.yaml"), "a") as fh:
            fh.write("  accessory: [RJ45-PLUG]\n")


class PackCheckTests(SimpleTestCase):
    def setUp(self):
        self.p = _AccessoryPack()

    def tearDown(self):
        self.p.cleanup()

    def check(self):
        files = PackFiles(self.p.root)
        try:
            return check_pack(files)
        finally:
            files.close()

    def test_a_pack_with_an_accessory_passes_clean(self):
        rep = self.check()
        self.assertTrue(rep.ok, [f.message for f in rep.findings])
        self.assertEqual(rep.warnings, 0, [f"{f.path}: {f.message}" for f in rep.findings])
        part = next(p for p in rep.parts if p.kind == "accessory-type")
        self.assertEqual((part.part, part.triangles), ("RJ45-PLUG", 2))

    def test_unlisted_and_broken_accessories(self):
        self.p.write("accessory-types/Generic/BAD.yaml", "name: BAD\nkind: cable\n")
        rep = self.check()
        msgs = [f"{f.level} {f.path}: {f.message}" for f in rep.findings]
        self.assertIn("error accessory-types/Generic/BAD.yaml: kind: 'cable' is not one of "
                      "plug, transceiver, cord.", msgs)
        self.assertIn("warning pack.yaml: types.accessory doesn't list BAD.", msgs)


class PackImportTests(_CoverBase):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        self.p = _AccessoryPack()

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        self.p.cleanup()
        super().tearDown()

    def run_import(self, *extra) -> str:
        out = io.StringIO()
        call_command("import_model_pack", self.p.root, "--tenant", "t", *extra, stdout=out)
        return out.getvalue()

    def test_dry_run_keeps_nothing(self):
        out = self.run_import()
        self.assertIn("accessory type RJ45-PLUG: created "
                      "(accessory-types/Generic/RJ45-PLUG.yaml)", out)
        self.assertIn("  - model: 2 triangles.", out)
        self.assertIn("  - plug, fits 1000base-t, 10gbase-t, rj-45.", out)
        self.assertNotIn("models/Generic/RJ45-PLUG.glb", out.split("Models no YAML")[-1]
                         if "Models no YAML" in out else "")
        self.assertFalse(AccessoryType.objects.exists())

    def test_apply_creates_then_matches(self):
        self.run_import("--apply")
        acc = AccessoryType.objects.get(tenant=self.tenant)
        self.assertEqual((acc.vendor, acc.name, acc.kind, acc.connector, acc.fits),
                         ("Generic", "RJ45-PLUG", "plug", "rj45",
                          ["1000base-t", "10gbase-t", "rj-45"]))
        self.assertEqual(acc.pack_import, {"pack": {"name": "Acme test", "version": "1.1.0"}})
        with acc.model_3d.open("rb") as fh:
            self.assertEqual(fh.read(), plug_glb())
        out = self.run_import("--apply")
        self.assertIn("accessory type RJ45-PLUG: matched", out)
        self.assertEqual(AccessoryType.objects.filter(tenant=self.tenant).count(), 1)
        self.assertFalse(AccessoryType.objects.filter(tenant=self.other).exists())


# ── the payload ─────────────────────────────────────────────────────────────

class _Base(_CoverBase):
    def setUp(self):
        super().setUp()
        self.dt.model_anchors = {**self.dt.model_anchors, "ports": {
            "Te1/0/1": {"node": 30}, "Te1/0/2": {"node": 31}, "con 0": {"node": 32}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=self.dt.model_anchors)
        ConsolePortTemplate.objects.create(device_type=self.dt, name="con 0", type="rj-45")
        self.sr = self._acc("SFP-SR-LC", "lc", SFP)
        self.dac = self._acc("SFP-DAC", "dac", SFP)
        self.rj45 = self._acc("RJ45-PLUG", "rj45", ["1000base-t", "rj-45"])
        self._typed(self.dev)

    def _acc(self, name, connector, fits, tenant=None):
        acc = AccessoryType(tenant=tenant or self.tenant, vendor="Generic", name=name,
                            kind="plug", connector=connector, fits=fits)
        acc.model_3d.name = f"device-models/{name.lower()}.glb"
        acc.save()
        return acc

    def _typed(self, dev):
        Interface.objects.filter(device=dev).update(type="10gbase-x-sfpp")
        ConsolePort.objects.get_or_create(device=dev, name="con 0", defaults={"type": "rj-45"})

    def _cable(self, iface=None, *, console=None, type="", color=""):
        cable = Cable.objects.create(tenant=self.tenant, type=type, color=color)
        CableTermination.objects.create(cable=cable, end="A", interface=iface,
                                        console_port=console)
        return cable

    def _plugs(self, dev=None):
        return self._entry(dev)["plugs"]

    def _url(self, acc):
        from .model_3d import version_of

        return f"/api/accessory-types/{acc.pk}/model/?v={version_of(acc.model_3d)}"


class PayloadTests(_Base):
    def test_free_ports_have_no_plugs(self):
        self.assertEqual(self._plugs(), [])

    def test_cabled_ports_get_their_part_and_colour(self):
        self._cable(self._iface(self.dev, "Te1/0/1"), type="dac-passive", color="#FF0000")
        self._cable(self._iface(self.dev, "Te1/0/2"), type="mmf-om4")
        self._cable(console=ConsolePort.objects.get(device=self.dev))
        url = {p["port"]: p for p in self._plugs()}
        self.assertEqual(url["Te1/0/1"], {"port": "Te1/0/1", "bay": None, "name": "Te1/0/1",
                                          "url": self._url(self.dac), "color": "#ff0000"})
        self.assertEqual((url["Te1/0/2"]["url"], url["Te1/0/2"]["color"]),
                         (self._url(self.sr), None))
        self.assertEqual(url["con 0"]["url"], self._url(self.rj45))

    def test_marked_connected_takes_the_default_part(self):
        Interface.objects.filter(device=self.dev, name="Te1/0/2").update(mark_connected=True)
        self.assertEqual([(p["port"], p["url"], p["color"]) for p in self._plugs()],
                         [("Te1/0/2", self._url(self.sr), None)])

    def test_nothing_fits(self):
        Interface.objects.filter(device=self.dev).update(type="100gbase-x-qsfp28")
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self.assertEqual(self._plugs(), [])

    def test_another_tenants_parts_never_seat(self):
        AccessoryType.objects.filter(tenant=self.tenant).delete()
        self._acc("SFP-SR-LC", "lc", SFP, tenant=self.other)
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self.assertEqual(self._plugs(), [])

    def test_module_ports_take_the_bay_position(self):
        ModuleInterfaceTemplate.objects.create(module_type=self.psu, name="Te1/{module}/9")
        self.psu.model_anchors = {**self.psu.model_anchors, "ports": {"Te1/{module}/9": {}}}
        self.psu.save()
        self._cable(Interface.objects.create(device=self.dev, name="Te1/1/9",
                                             type="1000base-t"))
        self.assertEqual([(p["bay"], p["port"], p["url"]) for p in self._plugs()],
                         [("PS-1", "Te1/1/9", self._url(self.rj45))])

    def test_query_count_does_not_grow_with_devices(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        with CaptureQueriesContext(connection) as one:
            self._leds(self.dev)
        more = [self._device(f"sw{i}") for i in range(2, 7)]
        for d in more:
            self._typed(d)
            self._cable(self._iface(d, "Te1/0/2"), type="dac-active")
        with CaptureQueriesContext(connection) as six:
            out = self._leds(self.dev, *more)
        self.assertEqual(len(six), len(one))
        self.assertEqual({k: [(p["port"], p["url"]) for p in v["plugs"]]
                          for k, v in out.items()},
                         {str(self.dev.id): [("Te1/0/1", self._url(self.sr))],
                          **{str(d.id): [("Te1/0/2", self._url(self.dac))] for d in more}})

    def test_without_accessory_types_one_query_more_at_most(self):
        AccessoryType.objects.all().delete()
        self._cable(self._iface(self.dev, "Te1/0/1"))
        with CaptureQueriesContext(connection) as q:
            self.assertEqual(self._plugs(), [])
        self.assertEqual(sum("api_accessorytype" in x["sql"] for x in q.captured_queries), 1)
        self.assertFalse(any("api_cabletermination" in x["sql"] and "UNION" in x["sql"]
                             for x in q.captured_queries))

    def test_device_studio_payload(self):
        self._cable(self._iface(self.dev, "Te1/0/2"), type="dac-passive")
        res = self.client.get(f"/api/devices/{self.dev.id}/studio/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([(p["port"], p["url"]) for p in res.json()["plugs"]],
                         [("Te1/0/2", self._url(self.dac))])


class ScopeTests(_Base):
    def _reader(self, types):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="r", object_types=types,
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)

    def test_without_interface_view_no_plugs(self):
        self._cable(self._iface(self.dev, "Te1/0/1"))
        self._reader(["device", "devicetype", "moduletype", "cable"])
        self.assertEqual(self._plugs(), [])

    def test_without_cable_view_no_colour_or_medium(self):
        self._cable(self._iface(self.dev, "Te1/0/1"), type="dac-passive", color="#ff0000")
        self._reader(["device", "devicetype", "interface", "moduletype"])
        # The medium is unknown: the default part, grey.
        self.assertEqual([(p["url"], p["color"]) for p in self._plugs()],
                         [(self._url(self.sr), None)])

    def test_without_module_type_view_the_part_comes_through_the_device(self):
        self._cable(self._iface(self.dev, "Te1/0/1"), type="mmf")
        self._reader(["device", "devicetype", "interface", "cable"])
        [p] = self._plugs()
        self.assertTrue(p["url"].startswith(
            f"/api/devices/{self.dev.id}/accessory-model/{self.sr.id}/?v="), p["url"])
        self.assertEqual(self.client.get("/api/accessory-types/").status_code, 403)


class EndpointTests(_Base):
    def setUp(self):
        super().setUp()
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        from . import model_3d

        model_3d.store(self.sr, plug_glb())

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        super().tearDown()

    def test_list_and_download(self):
        res = self.client.get("/api/accessory-types/")
        self.assertEqual(res.status_code, 200, res.content)
        names = [r["name"] for r in res.json()["results"]]
        self.assertEqual(names, ["RJ45-PLUG", "SFP-DAC", "SFP-SR-LC"])
        res = self.client.get(f"/api/accessory-types/{self.sr.id}/model/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Content-Type"], "model/gltf-binary")
        self.assertEqual(b"".join(res.streaming_content), plug_glb())

    def test_through_the_device(self):
        res = self.client.get(f"/api/devices/{self.dev.id}/accessory-model/{self.sr.id}/")
        self.assertEqual(res.status_code, 200)
        other = self._acc("X", "lc", SFP, tenant=self.other)
        res = self.client.get(f"/api/devices/{self.dev.id}/accessory-model/{other.id}/")
        self.assertEqual(res.status_code, 404)
        res = self.client.get(f"/api/accessory-types/{other.id}/model/")
        self.assertEqual(res.status_code, 404)
