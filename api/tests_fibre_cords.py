"""Transceivers and their cords stacked in a port (export spec §13 v1.9,
api.port_plugs): a cord's ``cable:`` block (read, imported, checked), the
per-kind triangle budgets and the empties stacking needs, which two parts a
port shows (the ANSWERS table: record, generic fallback, SFP-T, one-piece
DAC/AOC, host RJ45, LC panel ports, MPO), the payload, the reader's scope,
and a query count that does not grow with the devices."""
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
    DeviceType,
    FrontPort,
    FrontPortTemplate,
    Interface,
    InventoryItem,
    RearPort,
    RearPortTemplate,
)
from .port_plugs import cord_for, generic_transceiver, read_accessory, read_cable, stack
from .tests_model_anchors import OUT_FRONT, model
from .tests_port_plugs import SFP, _AccessoryPack, _Base

ZIP = {"profile": "zipcord", "jacket_mm": 1.8, "pitch_mm": 1.84, "min_bend_mm": 30.0}


def _part(name, kind, connector, fits, parts=(), cable=None, vendor="Generic"):
    return SimpleNamespace(name=name, vendor=vendor, kind=kind, connector=connector,
                           fits=list(fits), parts=list(parts), cable=cable, pk=name)


GEN = _part("SFP-GENERIC", "transceiver", "lc", SFP)
SR10 = _part("SFP-10G-SR", "transceiver", "lc", ["10gbase-x-sfpp"], ["SFP-10G-SR"], vendor="Cisco")
SFPT = _part("GLC-TE", "transceiver", "rj45", ["1000base-x-sfp"], ["GLC-TE"], vendor="Cisco")
QSR4 = _part("QSFP-40G-SR4", "transceiver", "mpo", ["40gbase-x-qsfpp"], ["QSFP-40G-SR4"])
LC = _part("LC-DUPLEX", "plug", "lc", ["lc-duplex", "lc-apc-duplex"], cable=ZIP)
MPO = _part("MPO-12", "plug", "mpo", ["mpo"], cable={"profile": "round", "jacket_mm": 3.0,
                                                    "pitch_mm": None, "min_bend_mm": None})
RJ = _part("RJ45-PLUG", "plug", "rj45", ["1000base-t", "10gbase-t", "rj-45"])
DAC = _part("SFP-DAC", "cord", "dac", SFP)
AOC = _part("SFP-AOC", "cord", "aoc", SFP)
C13 = _part("IEC-C13", "plug", "iec-c13", ["iec-60320-c14"])
ALL = [GEN, SR10, SFPT, QSR4, LC, MPO, RJ, DAC, AOC, C13]
BY_ID = {a.pk: a for a in ALL}
BY_PART = {"SFP-10G-SR": SR10, "GLC-TE": SFPT, "QSFP-40G-SR4": QSR4}


def _stack(kind, ptype, ctype="", cabled=True, record=None):
    t, c = stack(ALL, BY_ID, BY_PART, kind, ptype, ctype, cabled, record)
    return (t.name if t else None, c.name if c else None)


def _rec(part="", acc="", connector=""):
    return (acc, part, "S1", connector)


class CableBlockTests(SimpleTestCase):
    def test_a_zipcord(self):
        notes = []
        self.assertEqual(read_cable(dict(ZIP), notes), ZIP)
        self.assertEqual(notes, [])

    def test_a_round_cable_has_no_pitch(self):
        notes = []
        got = read_cable({"profile": "Round", "jacket_mm": 3, "pitch_mm": 2}, notes)
        self.assertEqual(got, {"profile": "round", "jacket_mm": 3.0, "pitch_mm": None,
                               "min_bend_mm": None})
        self.assertEqual(notes, ["cable.pitch_mm: a round cable has no pitch - ignored."])

    def test_a_zipcord_pitch_is_at_least_its_jacket(self):
        notes = []
        self.assertEqual(read_cable({"profile": "zipcord", "jacket_mm": 2}, notes)["pitch_mm"],
                         2.0)
        got = read_cable({"profile": "zipcord", "jacket_mm": 2, "pitch_mm": 1}, notes)
        self.assertEqual(got["pitch_mm"], 2.0)
        self.assertIn("narrower than the jacket", notes[-1])

    def test_bad_blocks_are_noted_and_dropped(self):
        for raw, why in (("zipcord", "not a mapping"),
                         ({"profile": "ribbon", "jacket_mm": 2}, "cable.profile"),
                         ({"profile": "round"}, "jacket_mm: needed"),
                         ({"profile": "round", "jacket_mm": -1}, "cable.jacket_mm"),
                         ({"profile": "round", "jacket_mm": True}, "cable.jacket_mm")):
            notes = []
            self.assertIsNone(read_cable(raw, notes), raw)
            self.assertTrue(any(why in n for n in notes), (raw, notes))
        notes = []
        got = read_cable({"profile": "round", "jacket_mm": 3, "min_bend_mm": "30",
                          "colour": "red"}, notes)
        self.assertIsNone(got["min_bend_mm"])
        self.assertEqual(len(notes), 2)

    def test_read_accessory_carries_it(self):
        doc = {"name": "LC-DUPLEX", "kind": "plug", "connector": "lc",
               "fits": ["lc-duplex"], "cable": dict(ZIP),
               "model3d": {"file": "models/Generic/LC-DUPLEX.glb"}}
        fields, notes = read_accessory("accessory-types/Generic/LC-DUPLEX.yaml", doc)
        self.assertEqual((fields["cable"], notes), (ZIP, []))
        fields, _ = read_accessory("accessory-types/Generic/X.yaml",
                                   {k: v for k, v in doc.items() if k != "cable"})
        self.assertIsNone(fields["cable"])
        fields, notes = read_accessory("accessory-types/Generic/X.yaml",
                                       {**doc, "kind": "transceiver"})
        self.assertIsNone(fields["cable"])
        self.assertIn("a transceiver has no cable", notes[0])


class StackTests(SimpleTestCase):
    """The ANSWERS §1 table, one row per test."""

    def test_record_without_a_cable_shows_the_transceiver_alone(self):
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", cabled=False,
                                record=_rec("SFP-10G-SR")), ("SFP-10G-SR", None))

    def test_record_with_a_cable_adds_the_cord_by_connector(self):
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "smf-os2",
                                record=_rec("SFP-10G-SR")), ("SFP-10G-SR", "LC-DUPLEX"))
        # The record's own connector wins over the transceiver's.
        self.assertEqual(_stack("interface", "40gbase-x-qsfpp", "mmf-om4",
                                record=_rec("QSFP-40G-SR4", connector="mpo-12")),
                         ("QSFP-40G-SR4", "MPO-12"))

    def test_hand_set_part_beats_the_part_id(self):
        self.assertEqual(_stack("interface", "1000base-x-sfp", "mmf",
                                record=_rec("GLC-TE", acc="SFP-GENERIC")),
                         ("SFP-GENERIC", "LC-DUPLEX"))

    def test_fibre_in_a_cage_without_a_record_takes_the_generic(self):
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "mmf-om4"),
                         ("SFP-GENERIC", "LC-DUPLEX"))
        # Unknown medium (no type, or a cable the reader may not view):
        # the optical generic.
        self.assertEqual(_stack("interface", "25gbase-x-sfp28", ""),
                         ("SFP-GENERIC", "LC-DUPLEX"))
        # An unmatched record is a transceiver of unknown model.
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", cabled=False,
                                record=_rec("NOPE")), ("SFP-GENERIC", None))

    def test_copper_in_an_sfp_cage_is_an_sfp_t_and_its_rj45(self):
        self.assertEqual(_stack("interface", "1000base-x-sfp", "cat6"), ("GLC-TE", "RJ45-PLUG"))
        # A cage no copper transceiver fits shows nothing rather than a wrong part.
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "cat6a"), (None, None))

    def test_dac_and_aoc_take_the_port_alone_and_only_cabled(self):
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "dac-passive"), (None, "SFP-DAC"))
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "aoc"), (None, "SFP-AOC"))
        dac = _part("SFP-H10GB-CU3M", "cord", "dac", SFP, ["SFP-H10GB-CU3M"])
        t, c = stack([*ALL, dac], BY_ID, {"SFP-H10GB-CU3M": dac}, "interface",
                     "10gbase-x-sfpp", "", True, _rec("SFP-H10GB-CU3M"))
        self.assertEqual((t, c), (None, dac))
        t, c = stack([*ALL, dac], BY_ID, {"SFP-H10GB-CU3M": dac}, "interface",
                     "10gbase-x-sfpp", "", False, _rec("SFP-H10GB-CU3M"))
        self.assertEqual((t, c), (None, None))
        # A record that says DAC with no model for it: a DAC head.
        self.assertEqual(_stack("interface", "10gbase-x-sfpp", "",
                                record=_rec("X", connector="dac")), (None, "SFP-DAC"))

    def test_host_ports_take_the_cord_alone(self):
        self.assertEqual(_stack("interface", "1000base-t", "cat6"), (None, "RJ45-PLUG"))
        self.assertEqual(_stack("front-port", "lc-duplex", "smf-os2"), (None, "LC-DUPLEX"))
        self.assertEqual(_stack("front-port", "lc-apc-duplex", ""), (None, "LC-DUPLEX"))
        self.assertEqual(_stack("power-port", "iec-60320-c14", "power"), (None, "IEC-C13"))
        self.assertEqual(_stack("interface", "1000base-t", "cat6", cabled=False), (None, None))

    def test_cords_are_never_cage_heads_or_transceivers(self):
        old = _part("SFP-SR-LC", "plug", "lc", SFP)
        self.assertIs(cord_for([old, LC, GEN], "lc"), LC)
        self.assertIsNone(cord_for([old, GEN], "lc"))
        self.assertIs(cord_for(ALL, "mpo-16"), MPO)
        self.assertIsNone(cord_for(ALL, ""))

    def test_a_pack_without_a_transceiver_keeps_its_one_piece_heads(self):
        old = _part("SFP-SR-LC", "plug", "lc", SFP)
        t, c = stack([old, RJ], {}, {}, "interface", "10gbase-x-sfpp", "mmf", True, None)
        self.assertEqual((t, c), (None, old))

    def test_generic_prefers_no_parts(self):
        self.assertIs(generic_transceiver([SR10, GEN], "10gbase-x-sfpp", "fibre"), GEN)
        self.assertIs(generic_transceiver([SR10], "10gbase-x-sfpp", "fibre"), SR10)
        self.assertIsNone(generic_transceiver([SR10], "1000base-x-sfp", "fibre"))


# ── import and check ───────────────────────────────────────────────────────

def transceiver_glb(*, port="port:lc", meshes=1) -> bytes:
    """A transceiver: a body in the cage and the ``port:lc`` empty on its
    receptacle face, 12 mm out."""
    nodes = [{"name": f"Body{i}", "mesh": "Metal", "translation": [0, 0, -0.02]}
             for i in range(meshes)]
    if port:
        nodes.append({"name": port, "translation": [0, 0, 0.012], "rotation": OUT_FRONT,
                      "extras": {"danbyte_w": 0.0125, "danbyte_h": 0.0062}})
    return model(nodes, materials=("Metal",))


def cord_glb(*, cable=True) -> bytes:
    """A duplex LC cord: bodies and the jacket stub, and the ``cable`` empty."""
    nodes = [{"name": "Bodies", "mesh": "LC_BODY", "translation": [0, 0, -0.005]},
             {"name": "Jackets", "mesh": "FIBRE", "translation": [0, 0, 0.02]}]
    if cable:
        nodes.append({"name": "cable", "translation": [0, 0, 0.04]})
    return model(nodes, materials=("LC_BODY", "FIBRE"))


TRANSCEIVER = """\
name: SFP-10G-SR
kind: transceiver
connector: lc
fits: [10gbase-x-sfpp]
parts: [SFP-10G-SR]
model3d:
  file: models/Cisco/SFP-10G-SR.glb
"""

CORD = """\
name: LC-DUPLEX
kind: plug
connector: lc
fits: [lc-duplex, lc-apc-duplex]
cable:
  profile: zipcord
  jacket_mm: 1.8
  pitch_mm: 1.84
  min_bend_mm: 30
model3d:
  file: models/Generic/LC-DUPLEX.glb
"""


class _CordPack(_AccessoryPack):
    def __init__(self, transceiver=None, cord=None):
        super().__init__()
        self.write("models/Cisco/SFP-10G-SR.glb", transceiver or transceiver_glb())
        self.write("accessory-types/Cisco/SFP-10G-SR.yaml", TRANSCEIVER)
        self.write("models/Generic/LC-DUPLEX.glb", cord or cord_glb())
        self.write("accessory-types/Generic/LC-DUPLEX.yaml", CORD)
        path = os.path.join(self.root, "pack.yaml")
        with open(path) as fh:
            text = fh.read()
        with open(path, "w") as fh:
            fh.write(text.replace("accessory: [RJ45-PLUG]",
                                  "accessory: [RJ45-PLUG, SFP-10G-SR, LC-DUPLEX]"))


def _check(pack):
    files = PackFiles(pack.root)
    try:
        return check_pack(files)
    finally:
        files.close()


def _msgs(rep):
    return [f"{f.level} {f.path}: {f.message}" for f in rep.findings]


class CheckTests(SimpleTestCase):
    def test_a_stacking_pack_passes_clean(self):
        p = _CordPack()
        try:
            rep = _check(p)
        finally:
            p.cleanup()
        self.assertTrue(rep.ok, _msgs(rep))
        self.assertEqual(rep.warnings, 0, _msgs(rep))

    def test_missing_empties_warn(self):
        p = _CordPack(transceiver=transceiver_glb(port=None), cord=cord_glb(cable=False))
        try:
            msgs = _msgs(_check(p))
        finally:
            p.cleanup()
        self.assertIn("warning models/Cisco/SFP-10G-SR.glb: no port:lc empty; a cord in it "
                      "is seated at the cage instead.", msgs)
        self.assertIn("warning models/Generic/LC-DUPLEX.glb: no cable empty; the run starts "
                      "at the port instead.", msgs)

    def test_a_bad_cable_block_warns(self):
        p = _CordPack()
        p.write("accessory-types/Generic/LC-DUPLEX.yaml",
                CORD.replace("profile: zipcord", "profile: ribbon"))
        try:
            msgs = _msgs(_check(p))
        finally:
            p.cleanup()
        self.assertIn("warning accessory-types/Generic/LC-DUPLEX.yaml: cable.profile: "
                      "'ribbon' is not one of zipcord, round - the block is ignored.", msgs)

    def test_budgets_by_kind(self):
        # 1,600 triangles: over a transceiver's budget, within a cord's.
        p = _CordPack(transceiver=transceiver_glb(meshes=1_600))
        p.write("models/Generic/LC-DUPLEX.glb", model(
            [{"name": f"J{i}", "mesh": "FIBRE"} for i in range(1_600)]
            + [{"name": "cable"}], materials=("FIBRE",)))
        try:
            msgs = _msgs(_check(p))
        finally:
            p.cleanup()
        self.assertIn("warning models/Cisco/SFP-10G-SR.glb: 1600 triangles; a transceiver's "
                      "budget is 1500.", msgs)
        self.assertFalse(any("LC-DUPLEX.glb" in m and "budget" in m for m in msgs), msgs)


class ImportTests(_Base):
    def setUp(self):
        super().setUp()
        AccessoryType.objects.all().delete()
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        self.p = _CordPack()

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        self.p.cleanup()
        super().tearDown()

    def run_import(self, *extra) -> str:
        out = io.StringIO()
        call_command("import_model_pack", self.p.root, "--tenant", "t", *extra, stdout=out)
        return out.getvalue()

    def test_dry_run_reports_the_cable_and_keeps_nothing(self):
        out = self.run_import()
        self.assertIn("  - cable: zipcord, jacket 1.8 mm, pitch 1.84 mm, bend 30 mm.", out)
        self.assertFalse(AccessoryType.objects.exists())

    def test_apply_stores_the_cable(self):
        self.run_import("--apply")
        cord = AccessoryType.objects.get(tenant=self.tenant, name="LC-DUPLEX")
        self.assertEqual(cord.cable, ZIP)
        self.assertIsNone(AccessoryType.objects.get(tenant=self.tenant,
                                                    name="SFP-10G-SR").cable)
        res = self.client.get("/api/accessory-types/")
        self.assertEqual({r["name"]: r["cable"] for r in res.json()["results"]}["LC-DUPLEX"],
                         ZIP)

    def test_missing_empties_are_import_notes(self):
        self.p.write("models/Generic/LC-DUPLEX.glb", cord_glb(cable=False))
        out = self.run_import()
        self.assertIn("  - model: no cable empty; the run starts at the port instead.", out)


# ── the payload ─────────────────────────────────────────────────────────────

class PayloadTests(_Base):
    def setUp(self):
        super().setUp()
        AccessoryType.objects.all().delete()
        self.gen = self._typed_acc("SFP-GENERIC", "transceiver", "lc", SFP)
        self.sr = self._typed_acc("SFP-10G-SR", "transceiver", "lc", ["10gbase-x-sfpp"],
                                  parts=["SFP-10G-SR"])
        self.lc = self._typed_acc("LC-DUPLEX", "plug", "lc", ["lc-duplex", "lc-apc-duplex"],
                                  cable=ZIP)
        self.dac = self._typed_acc("SFP-DAC", "cord", "dac", SFP)
        self.rj = self._typed_acc("RJ45-PLUG", "plug", "rj45", ["1000base-t", "rj-45"])
        self.te1 = self._iface(self.dev, "Te1/0/1")
        self.te2 = self._iface(self.dev, "Te1/0/2")

    def _typed_acc(self, name, kind, connector, fits, *, parts=(), cable=None, tenant=None):
        acc = self._acc(name, connector, fits, tenant=tenant)
        AccessoryType.objects.filter(pk=acc.pk).update(kind=kind, parts=list(parts),
                                                       cable=cable)
        acc.refresh_from_db()
        return acc

    def _part(self, acc, *, cable=False):
        doc = {"url": self._url(acc), "kind": acc.kind, "connector": acc.connector}
        if cable:
            doc["cable"] = acc.cable
        return doc

    def _by_port(self):
        return {p["port"]: p for p in self._plugs()}

    def test_record_and_cable_stack_two_parts(self):
        InventoryItem.objects.create(device=self.dev, name="SFP 1", kind="transceiver",
                                     interface=self.te1, part_id="SFP-10G-SR=",
                                     serial_number="S1")
        self._cable(self.te1, type="smf-os2", color="#00FF00")
        p = self._by_port()["Te1/0/1"]
        self.assertEqual(p, {
            "port": "Te1/0/1", "bay": None, "name": "Te1/0/1", "port_type": "10gbase-x-sfpp",
            "cabled": True, "color": "#00ff00", "cable_type": "smf-os2",
            "transceiver": {"part_id": "SFP-10G-SR=", "serial": "S1"},
            "transceiver_part": self._part(self.sr),
            "cord_part": self._part(self.lc, cable=True)})

    def test_fibre_without_a_record_takes_the_generic_and_its_cord(self):
        self._cable(self.te2, type="mmf-om4")
        p = self._by_port()["Te1/0/2"]
        self.assertEqual((p["transceiver_part"], p["cord_part"], p["transceiver"]),
                         (self._part(self.gen), self._part(self.lc, cable=True), None))

    def test_a_dac_takes_the_port_alone(self):
        self._cable(self.te2, type="dac-passive")
        p = self._by_port()["Te1/0/2"]
        self.assertEqual((p["transceiver_part"], p["cord_part"]),
                         (None, self._part(self.dac, cable=True)))

    def test_lc_panel_front_ports_take_the_cord_at_their_anchor(self):
        rpt = RearPortTemplate.objects.create(device_type=self.dt, name="R1", type="lc",
                                              positions=1)
        FrontPortTemplate.objects.create(device_type=self.dt, name="F1", type="lc-apc-duplex",
                                         rear_port_template=rpt)
        anchors = {**self.dt.model_anchors,
                   "ports": {**self.dt.model_anchors["ports"], "F1": {"node": 40}}}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=anchors)
        rear = RearPort.objects.create(device=self.dev, name="R1", type="lc", positions=1)
        front = FrontPort.objects.create(device=self.dev, name="F1", type="lc-apc-duplex",
                                         rear_port=rear)
        from .models import Cable, CableTermination

        cable = Cable.objects.create(tenant=self.tenant, type="smf-os2")
        CableTermination.objects.create(cable=cable, end="A", front_port=front)
        self.dev.refresh_from_db()
        p = self._by_port()["F1"]
        self.assertEqual((p["port_type"], p["transceiver_part"], p["cord_part"]["url"]),
                         ("lc-apc-duplex", None, self._url(self.lc)))

    def test_another_tenants_cord_never_seats(self):
        AccessoryType.objects.filter(pk=self.lc.pk).delete()
        self._typed_acc("LC-DUPLEX", "plug", "lc", ["lc-duplex"], cable=ZIP, tenant=self.other)
        self._cable(self.te2, type="mmf-om4")
        p = self._by_port()["Te1/0/2"]
        self.assertEqual((p["transceiver_part"], p["cord_part"]), (self._part(self.gen), None))

    def test_a_reader_without_cable_view_gets_no_type_or_colour(self):
        self._cable(self.te2, type="dac-passive", color="#ff0000")
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="r", object_types=["device", "devicetype", "moduletype", "interface"],
            actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        p = self._by_port()["Te1/0/2"]
        # The medium is unknown: the optical generic and its cord, grey.
        self.assertEqual((p["cable_type"], p["color"], p["transceiver_part"]["url"],
                          p["cord_part"]["url"]),
                         ("", None, self._url(self.gen), self._url(self.lc)))

    def test_query_count_does_not_grow_with_devices(self):
        InventoryItem.objects.create(device=self.dev, name="SFP 1", kind="transceiver",
                                     interface=self.te1, part_id="SFP-10G-SR")
        self._cable(self.te1, type="smf-os2")
        with CaptureQueriesContext(connection) as one:
            self._leds(self.dev)
        more = [self._device(f"sw{i}") for i in range(2, 7)]
        for d in more:
            self._typed(d)
            te1 = Interface.objects.get(device=d, name="Te1/0/1")
            InventoryItem.objects.create(device=d, name="SFP 1", kind="transceiver",
                                         interface=te1, part_id="SFP-10G-SR")
            self._cable(te1, type="smf-os2")
            self._cable(Interface.objects.get(device=d, name="Te1/0/2"), type="mmf-om3")
        with CaptureQueriesContext(connection) as six:
            out = self._leds(self.dev, *more)
        self.assertEqual(len(six), len(one))
        for d in more:
            got = {p["port"]: (p["transceiver_part"]["url"], p["cord_part"]["url"])
                   for p in out[str(d.id)]["plugs"]}
            self.assertEqual(got, {"Te1/0/1": (self._url(self.sr), self._url(self.lc)),
                                   "Te1/0/2": (self._url(self.gen), self._url(self.lc))})
