"""Rack pathways (docs/dcim/racks.md → Pathways, the export spec §14 v1.13):
what the four generic kit shapes yield, the defaults per frame, inheritance
from the kit through the rack type to the rack and the overlays on it, the
row checks, the API with its permissions and its tenant and site fences, a
pack re-import updating what came from the kit, a 0U device's channel and
the 0U vertical cable manager (CM-VERT-2POST)."""
from __future__ import annotations

from types import SimpleNamespace as NS

from django.contrib.auth.models import User
from django.test import SimpleTestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile

from . import rack_pathways as rp
from .model_3d import validate_glb
from .models import (
    AccessoryType,
    Device,
    DeviceType,
    Manufacturer,
    Rack,
    RackKit,
    RackPathway,
    RackType,
    Site,
)
from .rack_kits import scan_parts
from .tests_model_anchors import model
from .tests_rack_look_kits import KIT, PACK_YAML, KitPack, _Base

# ── fixtures: the four generic kit shapes, as the real kits name them ──────

STRETCH_XY = {"danbyte_stretch": "xy", "danbyte_ref_mm": 1000}
STRETCH_YZ = {"danbyte_stretch": "yz", "danbyte_ref_mm": 1000}
U_M = 0.04445


class Nodes:
    def __init__(self):
        self.nodes: list[dict] = []

    def add(self, node: dict, parent: int | None = None) -> int:
        self.nodes.append(dict(node))
        i = len(self.nodes) - 1
        if parent is not None:
            self.nodes[parent].setdefault("children", []).append(i)
        return i

    def frame(self, u1: float, ref_u: int):
        """A post segment at unit 1 and a post top over the reference units."""
        self.add({"name": "post:segment", "mesh": "FRAME", "translation": [0.2326, u1, -0.1]})
        self.add({"name": "post:top", "mesh": "FRAME",
                  "translation": [0.2326, u1 + ref_u * U_M + 0.5, -0.1]})

    def vertical(self, side: str, face: str, inner, kind: str, z: float = -0.145):
        x = -0.2985 if side == "left" else 0.2985
        i = self.add({"name": f"path:vertical:{side}:{face}", "mesh": "FRAME",
                      "extras": STRETCH_YZ, "translation": [x, 0.13, z]})
        self.add({"name": "path", "translation": [0.0275, 0.5, -0.5],
                  "extras": {"danbyte_inner_w": inner[0], "danbyte_inner_d": inner[1],
                             "danbyte_kind": kind}}, i)

    def roof(self, kind: str, entries=True, y=2.01):
        i = self.add({"name": f"top:{kind}", "mesh": "FRAME", "extras": STRETCH_XY,
                      "translation": [-0.3, y, 0.0]})
        if entries:
            for name, t in (("front-left", [0.22, 0.005, -0.1]),
                            ("rear-right", [0.78, 0.005, -0.9])):
                self.add({"name": f"entry:top:{name}", "translation": t,
                          "extras": {"danbyte_w": 200.0, "danbyte_h": 80.0,
                                     "danbyte_kind": "brush"}}, i)
                self.add({"name": f"brush:{name}", "mesh": "Metal"}, i)

    def doc(self) -> dict:
        return validate_glb(self.glb())

    def glb(self) -> bytes:
        return model(self.nodes, materials=("FRAME", "Metal"))


def cabinet() -> Nodes:
    """CABINET: rear corner channels, front and full-depth add-ons, two roof
    entries on each roof, a rear plinth entry and two rear 0U channels."""
    n = Nodes()
    n.frame(0.13, 42)
    for side in ("left", "right"):
        n.vertical(side, "front", (52.0, 88.5), "channel")
        n.vertical(side, "full", (52.0, 688.0), "channel")
        n.vertical(side, "rear", (52.0, 88.5), "channel", z=-0.885)
    n.roof("vented")
    n.roof("solid")
    plinth = n.add({"name": "base:plinth", "mesh": "FRAME", "extras": STRETCH_XY,
                    "translation": [-0.3, 0.0, 0.0]})
    n.add({"name": "entry:bottom:rear", "translation": [0.5, 0.098, -0.93],
           "extras": {"danbyte_w": 400.0, "danbyte_h": 100.0, "danbyte_kind": "open"}}, plinth)
    for side, x, turn in (("left", -0.258, 0.7071068), ("right", 0.258, -0.7071068)):
        ch = n.add({"name": f"channel:0u:{side}:rear", "translation": [x, 0.165, -0.93075],
                    "rotation": [0, turn, 0, 0.7071068],
                    "extras": {"danbyte_depth": 830.8, "danbyte_len_u": 40}})
        n.add({"name": "pdu:bracket", "mesh": "FRAME",
               "extras": {"danbyte_stretch": "z", "danbyte_ref_mm": 1000}}, ch)
    return n


def two_post() -> Nodes:
    n = Nodes()
    n.frame(0.06, 42)
    for side in ("left", "right"):
        n.vertical(side, "full", (150.0, 121.0), "finger", z=0.0)
    n.add({"name": "base:plate", "mesh": "FRAME", "translation": [-0.3085, 0, 0]})
    return n


def wall_cabinet() -> Nodes:
    n = Nodes()
    n.frame(0.04, 12)
    n.roof("solid", y=0.5934)
    n.roof("vented", y=0.5934)
    n.add({"name": "base:panel", "mesh": "FRAME", "extras": STRETCH_XY})
    return n


def open_four_post() -> Nodes:
    n = Nodes()
    n.frame(0.13, 42)
    n.add({"name": "base:feet", "mesh": "FRAME", "translation": [0.25, 0, -0.12]})
    return n


def scan(nodes: Nodes, w=600, d=1000):
    doc = nodes.doc()
    parts, _ = scan_parts(doc)
    return rp.scan_pathways(doc, parts["post:segment"].get("fit"), w, d)


def frame(kind, *, kit=None, top="vented", base="plinth", units=42, width=None, depth=None,
          side_panels=True):
    return rp.Frame(frame=kind, kit=kit, top=top, base=base, side_panels=side_panels,
                    start=1, units=units, width_mm=width, depth_mm=depth)


def by_key(items):
    return {i["key"]: i for i in items}


# ── the kits ────────────────────────────────────────────────────────────────

class KitScanTests(SimpleTestCase):
    def test_cabinet(self):
        got, notes = scan(cabinet())
        self.assertEqual(notes, [])
        keys = [p["key"] for p in got]
        self.assertEqual(sum(1 for p in got if p["kind"] == "vertical"), 6)
        # One entry per roof it sits on: the rack's Look picks the roof.
        self.assertEqual(keys.count("entry:top:front-left"), 2)
        rear = next(p for p in got if p["key"] == "path:vertical:left:rear")
        self.assertEqual((rear["side"], rear["face"], rear["subkind"]), ("left", "rear", "channel"))
        self.assertEqual((rear["inner_w_mm"], rear["inner_d_mm"]), (52, 88))
        entry = next(p for p in got if p["key"] == "entry:top:rear-right")
        self.assertEqual((entry["fx"], entry["fd"], entry["on"]), (0.78, 0.9, "top:solid"))
        self.assertEqual((entry["inner_w_mm"], entry["inner_d_mm"], entry["subkind"]),
                         (200, 80, "brush"))
        floor = next(p for p in got if p["key"] == "entry:bottom:rear")
        self.assertEqual((floor["on"], floor["subkind"], floor["fd"]), ("base:plinth", "open", 0.93))
        ch = next(p for p in got if p["key"] == "channel:0u:right:rear")
        self.assertEqual((ch["depth_mm"], ch["len_u"], ch["ref_u"], ch["offset_mm"]),
                         (831, 40, 42, 35))
        self.assertEqual(rp.kit_summary(got), "pathways: 6 vertical, 3 entries, 2 0U channels.")

    def test_two_post_wall_and_open(self):
        got, _ = scan(two_post(), 520, 380)
        self.assertEqual([(p["key"], p["subkind"], p["inner_w_mm"], p["inner_d_mm"])
                          for p in got],
                         [("path:vertical:left:full", "finger", 150, 121),
                          ("path:vertical:right:full", "finger", 150, 121)])
        got, _ = scan(wall_cabinet(), 600, 450)
        self.assertEqual({p["key"] for p in got}, {"entry:top:front-left", "entry:top:rear-right"})
        self.assertEqual(scan(open_four_post())[0], [])
        self.assertEqual(rp.kit_summary([]), "pathways: none.")

    def test_notes(self):
        n = open_four_post()
        n.add({"name": "path:vertical:left:rear", "mesh": "FRAME"})
        n.add({"name": "entry:top:hole"})
        _, notes = scan(n)
        self.assertIn("path:vertical:left:rear: no path empty; its inner size is unknown.", notes)
        self.assertIn("entry:top:hole: danbyte_w / danbyte_h missing.", notes)

    def test_cabinet_installs_rear_and_offers_the_rest(self):
        got, _ = scan(cabinet())
        kit = NS(pathways=got, widths_mm=[600, 800], depths_mm=[1000, 1200])
        items = by_key(rp.finish(rp.base_items(frame("cabinet", kit=kit)), frame("cabinet")))
        self.assertFalse(items["path:vertical:left:rear"]["hidden"])
        for key in ("path:vertical:left:front", "path:vertical:left:full"):
            self.assertTrue(items[key]["hidden"] and items[key]["addon"], key)
        self.assertEqual(items["path:vertical:left:rear"]["source"], "kit")
        # Vented roof: its entries; casters would drop the plinth's entry.
        self.assertIn("entry:top:front-left", items)
        self.assertIn("entry:bottom:rear", items)
        no_plinth = by_key(rp.base_items(frame("cabinet", kit=kit, base="casters", top="none")))
        self.assertNotIn("entry:bottom:rear", no_plinth)
        self.assertNotIn("entry:top:front-left", no_plinth)

    def test_scaled_to_the_rack(self):
        got, _ = scan(cabinet())
        kit = NS(pathways=got, widths_mm=[600, 800], depths_mm=[1000, 1200])
        fr = frame("cabinet", kit=kit, units=47, width=800, depth=1200)
        items = by_key(rp.finish(rp.base_items(fr), fr))
        rear = items["path:vertical:right:rear"]
        self.assertEqual((rear["u_from"], rear["u_to"], rear["inner_d_mm"]), (1, 47, 88))
        # A full-depth manager grows with the rack; a corner channel doesn't.
        self.assertEqual(items["path:vertical:left:full"]["inner_d_mm"], 688 + 200)
        ch = items["channel:0u:left:rear"]
        self.assertEqual((ch["u_from"], ch["u_to"], ch["depth_mm"], ch["offset_mm"]),
                         (1, 45, 831 + 200, 35))
        entry = items["entry:top:rear-right"]
        self.assertEqual((entry["x_mm"], entry["y_mm"]), (round(0.28 * 800), 1080))
        self.assertEqual(entry["label"], "Roof rear-right")
        self.assertEqual(ch["label"], "0U left rear")
        self.assertEqual(ch["fill_limit_pct"], 40)

    def test_two_post_kit(self):
        got, _ = scan(two_post(), 520, 380)
        kit = NS(pathways=got, widths_mm=[520], depths_mm=[380])
        items = rp.base_items(frame("2-post", kit=kit, units=45))
        self.assertEqual([(i["key"], i["hidden"], i["u_to"], i["inner_d_mm"]) for i in items],
                         [("path:vertical:left:full", False, 45, 121),
                          ("path:vertical:right:full", False, 45, 121)])


class FrameDefaultTests(SimpleTestCase):
    def keys(self, kind, **kw):
        return {i["key"] for i in rp.base_items(frame(kind, **kw))}

    def test_defaults(self):
        self.assertEqual(self.keys("cabinet"), {
            "path:vertical:left:rear", "path:vertical:right:rear", "entry:top:roof",
            "entry:bottom:floor", "channel:0u:left:rear", "channel:0u:right:rear"})
        self.assertEqual(self.keys("wall-cabinet"), {"entry:top:roof", "entry:bottom:floor"})
        self.assertEqual(self.keys("2-post"),
                         {"path:vertical:left:full", "path:vertical:right:full"})
        self.assertEqual(self.keys("4-post"), set())
        items = rp.base_items(frame("cabinet", depth=1200))
        self.assertTrue(all(i["source"] == "default" and not i["hidden"] for i in items))
        roof = by_key(items)["entry:top:roof"]
        self.assertEqual((roof["x_mm"], roof["y_mm"]), (0, 1020))

    def test_a_kit_without_pathway_data_takes_the_frames(self):
        kit = NS(pathways=None, widths_mm=[600], depths_mm=[1000])
        items = rp.base_items(frame("2-post", kit=kit))
        self.assertEqual({i["source"] for i in items}, {"default"})
        kit.pathways = []
        self.assertEqual(rp.base_items(frame("2-post", kit=kit)), [])


# ── the database ────────────────────────────────────────────────────────────

class _PathBase(_Base):
    def setUp(self):
        super().setUp()
        self.rt = RackType.objects.create(tenant=self.tenant, name="Cab 42", frame="cabinet")
        self.rack = Rack.objects.create(tenant=self.tenant, name="R1", site=self.site,
                                        rack_type=self.rt)

    def resolved(self, **params):
        r = self.client.get("/api/rack-pathways/resolved/", params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def items(self, **params):
        return by_key(self.resolved(**params)["items"])

    def post(self, data, code=201):
        r = self.client.post("/api/rack-pathways/", data, format="json")
        self.assertEqual(r.status_code, code, r.content)
        return r.json()


class InheritanceTests(_PathBase):
    def test_a_rack_without_a_kit_takes_its_frames_defaults(self):
        doc = self.resolved(rack=self.rack.pk)
        self.assertEqual((doc["frame"], doc["kit"], doc["units"]), ("cabinet", None, [1, 42]))
        items = by_key(doc["items"])
        self.assertEqual(items["path:vertical:left:rear"]["source"], "default")
        self.assertIsNone(items["path:vertical:left:rear"]["id"])
        self.assertEqual(items["channel:0u:left:rear"]["devices"], [])

    def test_type_rows_then_rack_rows(self):
        # The type hides a default and adds one of its own.
        self.post({"rack_type_id": str(self.rt.pk), "key": "entry:bottom:floor", "hidden": True})
        own = self.post({"rack_type_id": str(self.rt.pk), "kind": "vertical", "side": "left",
                         "face": "front", "subkind": "finger", "inner_w_mm": 100,
                         "inner_d_mm": 120})
        t = self.items(rack_type=self.rt.pk)
        self.assertTrue(t["entry:bottom:floor"]["hidden"])
        self.assertEqual(t["entry:bottom:floor"]["overridden"], ["hidden"])
        self.assertEqual(t[f"type:{own['id']}"]["source"], "type")
        # The rack inherits both, overrides the type's own and adds a manual one.
        r = self.items(rack=self.rack.pk)
        self.assertTrue(r["entry:bottom:floor"]["hidden"])
        self.assertIsNone(r[f"type:{own['id']}"]["id"])
        ov = self.post({"rack_id": str(self.rack.pk), "key": f"type:{own['id']}",
                        "inner_w_mm": 150, "name": "Front left"})
        man = self.post({"rack_id": str(self.rack.pk), "kind": "entry", "surface": "side",
                         "side": "right", "subkind": "gland", "inner_w_mm": 60,
                         "inner_d_mm": 60})
        r = self.items(rack=self.rack.pk)
        it = r[f"type:{own['id']}"]
        self.assertEqual((it["id"], it["inner_w_mm"], it["inner_d_mm"], it["label"]),
                         (ov["id"], 150, 120, "Front left"))
        self.assertEqual(it["overridden"], ["inner_w_mm", "name"])
        self.assertEqual(r[f"manual:{man['id']}"]["source"], "manual")
        # Another rack of the type is untouched by this rack's rows.
        other = Rack.objects.create(tenant=self.tenant, name="R2", site=self.site,
                                    rack_type=self.rt)
        self.assertEqual(self.items(rack=other.pk)[f"type:{own['id']}"]["inner_w_mm"], 100)

    def test_show_an_add_on_and_an_orphan(self):
        kit = RackKit.objects.create(tenant=self.tenant, name="K", frame="cabinet",
                                     widths_mm=[600], depths_mm=[1000],
                                     pathways=scan(cabinet())[0])
        self.rt.kit = kit
        self.rt.save()
        items = self.items(rack=self.rack.pk)
        self.assertTrue(items["path:vertical:left:front"]["addon"])
        self.assertEqual(items["path:vertical:left:rear"]["source"], "kit")
        self.post({"rack_id": str(self.rack.pk), "key": "path:vertical:left:front",
                   "hidden": False})
        self.assertFalse(self.items(rack=self.rack.pk)["path:vertical:left:front"]["hidden"])
        # The kit loses that part: the rack's row stays, marked.
        kit.pathways = [p for p in kit.pathways if p["key"] != "path:vertical:left:front"]
        kit.save()
        it = self.items(rack=self.rack.pk)["path:vertical:left:front"]
        self.assertTrue(it["orphan"])
        self.assertEqual(it["source"], "kit")

    def test_a_vertical_manager_model(self):
        acc = AccessoryType.objects.create(
            tenant=self.tenant, vendor="Generic", name="CM-VERT-2POST", kind="cable-manager",
            pathway={"kind": "finger", "inner_w_mm": 150, "inner_d_mm": 115})
        row = self.post({"rack_id": str(self.rack.pk), "kind": "vertical", "side": "right",
                         "face": "front", "accessory_type_id": str(acc.pk)})
        it = self.items(rack=self.rack.pk)[f"manual:{row['id']}"]
        self.assertEqual((it["subkind"], it["inner_w_mm"], it["inner_d_mm"]),
                         ("finger", 150, 115))
        self.assertEqual(it["accessory_type"], {"id": str(acc.pk), "name": "CM-VERT-2POST"})
        self.assertEqual(it["u_from"], 1)
        one_u = AccessoryType.objects.create(tenant=self.tenant, name="CM-1U", u_height=1,
                                             kind="cable-manager")
        r = self.client.post("/api/rack-pathways/", {
            "rack_id": str(self.rack.pk), "kind": "vertical", "side": "left", "face": "front",
            "accessory_type_id": str(one_u.pk)}, format="json")
        self.assertIn("0U", r.json()["accessory_type_id"][0])

    def test_a_horizontal_manager_takes_its_devices_units(self):
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="G", slug="g")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="CM-2U",
                                       u_height=2)
        dev = Device.objects.create(tenant=self.tenant, name="cm", site=self.site,
                                    rack=self.rack, position=12, face="front", device_type=dt)
        row = self.post({"rack_id": str(self.rack.pk), "kind": "horizontal", "face": "front",
                         "device_id": str(dev.pk)})
        it = self.items(rack=self.rack.pk)[f"manual:{row['id']}"]
        self.assertEqual((it["u_from"], it["u_to"], it["label"]), (12, 13, "U12 front"))
        self.assertEqual(it["device"], {"id": str(dev.pk), "name": "cm"})


class CheckTests(_PathBase):
    def errors(self, data):
        r = self.client.post("/api/rack-pathways/", data, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        return {k: v[0] if isinstance(v, list) else v for k, v in r.json().items()}

    def test_field_errors(self):
        rack = str(self.rack.pk)
        self.assertEqual(self.errors({"rack_id": rack})["kind"], "Pick a kind.")
        e = self.errors({"rack_id": rack, "kind": "vertical"})
        self.assertEqual((e["side"], e["face"]), ("Pick a side.", "Pick front, rear or full depth."))
        e = self.errors({"rack_id": rack, "kind": "vertical", "side": "left", "face": "front",
                         "u_from": 10, "u_to": 50})
        self.assertEqual(e["u_to"], "Not a unit of this rack (U1-U42).")
        e = self.errors({"rack_id": rack, "kind": "vertical", "side": "left", "face": "front",
                         "u_from": 10, "u_to": 5})
        self.assertIn("u_to", e)
        e = self.errors({"rack_id": rack, "kind": "channel", "side": "left", "face": "full"})
        self.assertEqual(e["face"], "A 0U channel is at the front or the rear.")
        e = self.errors({"rack_id": rack, "kind": "entry", "subkind": "finger",
                         "surface": "top"})
        self.assertIn("subkind", e)
        e = self.errors({"rack_id": rack, "key": "path:vertical:left:front"})
        self.assertEqual(e["key"], "Not a pathway this rack inherits.")
        e = self.errors({"rack_id": rack, "key": "entry:top:roof", "kind": "vertical"})
        self.assertEqual(e["kind"], "An inherited pathway keeps its kind.")
        e = self.errors({"rack_id": rack, "rack_type_id": str(self.rt.pk), "kind": "entry"})
        self.assertIn("rack_id", e)
        self.assertIn("inner_w_mm", self.errors({"rack_id": rack, "kind": "entry",
                                                 "surface": "top", "inner_w_mm": 5000}))

    def test_overlaps(self):
        rack = str(self.rack.pk)
        e = self.errors({"rack_id": rack, "kind": "vertical", "side": "left", "face": "full"})
        self.assertEqual(e["u_from"], "Overlaps Left rear (U1-U42). Hide one or move it.")
        # Hidden, the default no longer blocks it; another side never did.
        self.post({"rack_id": rack, "key": "path:vertical:left:rear", "hidden": True})
        self.post({"rack_id": rack, "kind": "vertical", "side": "left", "face": "full"})
        self.post({"rack_id": rack, "kind": "vertical", "side": "right", "face": "front",
                   "u_from": 1, "u_to": 20})
        e = self.errors({"rack_id": rack, "key": "path:vertical:left:rear", "hidden": False})
        self.assertEqual(e["key"], "That pathway has its row already; edit it instead.")
        # Two channels on one side at different depths are fine.
        self.post({"rack_id": rack, "kind": "channel", "side": "left", "face": "rear",
                   "depth_mm": 700})
        e = self.errors({"rack_id": rack, "kind": "channel", "side": "left", "face": "rear",
                         "depth_mm": 700})
        self.assertIn("Overlaps 0U left rear", e["u_from"])

    def test_the_frame_decides(self):
        rt = RackType.objects.create(tenant=self.tenant, name="2P", frame="2-post")
        rack = Rack.objects.create(tenant=self.tenant, name="R2", site=self.site, rack_type=rt)
        e = self.errors({"rack_id": str(rack.pk), "kind": "vertical", "side": "left",
                         "face": "rear"})
        self.assertEqual(e["face"], "A 2-post frame has no front or rear; use full depth.")
        e = self.errors({"rack_id": str(rack.pk), "kind": "entry", "surface": "top"})
        self.assertIn("open frame", e["surface"])
        self.rt.side_panels = False
        self.rt.save()
        e = self.errors({"rack_id": str(self.rack.pk), "kind": "entry", "surface": "side",
                         "side": "left"})
        self.assertEqual(e["surface"], "This rack has no side panels.")

    def test_owner_and_key_stay(self):
        row = self.post({"rack_id": str(self.rack.pk), "key": "entry:top:roof",
                         "inner_w_mm": 300})
        other = Rack.objects.create(tenant=self.tenant, name="R2", site=self.site)
        r = self.client.patch(f"/api/rack-pathways/{row['id']}/",
                              {"rack_id": str(other.pk)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/rack-pathways/{row['id']}/", {"inner_w_mm": 250},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.items(rack=self.rack.pk)["entry:top:roof"]["inner_w_mm"], 250)
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=row["id"]).exists())


class PinAndDeviceTests(_PathBase):
    def setUp(self):
        super().setUp()
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="G", slug="g")
        self.pdu_type = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr,
                                                  model="PDU", u_height=0)
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu-a", site=self.site,
                                         rack=self.rack, mount="side_left", face="rear",
                                         device_type=self.pdu_type)

    def pin(self, key, code=201, rack=None):
        r = self.client.post("/api/rack-pathways/pin/",
                             {"rack_id": str((rack or self.rack).pk), "key": key},
                             format="json")
        self.assertEqual(r.status_code, code, r.content)
        return r.json()

    def test_pin_once(self):
        row = self.pin("channel:0u:left:rear")
        self.assertEqual(self.pin("channel:0u:left:rear", code=200)["id"], row["id"])
        self.assertEqual(RackPathway.objects.filter(rack=self.rack).count(), 1)
        self.assertIn("key", self.pin("channel:0u:left:front", code=400))

    def test_a_pdu_in_its_channel(self):
        row = self.pin("channel:0u:left:rear")
        url = f"/api/devices/{self.pdu.pk}/"
        r = self.client.patch(url, {"mount_pathway_id": row["id"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["mount_pathway"], row["id"])
        it = self.items(rack=self.rack.pk)["channel:0u:left:rear"]
        self.assertEqual(it["devices"], [{"id": str(self.pdu.pk), "name": "pdu-a"}])
        # The wrong rail, the wrong face, another rack's channel.
        right = self.pin("channel:0u:right:rear")
        r = self.client.patch(url, {"mount_pathway_id": right["id"]}, format="json")
        self.assertIn("right", r.json()["mount_pathway_id"][0])
        r = self.client.patch(url, {"face": "front"}, format="json")
        self.assertIn("rear", r.json()["mount_pathway_id"][0])
        other = Rack.objects.create(tenant=self.tenant, name="R2", site=self.site)
        far = self.pin("channel:0u:left:rear", rack=other)
        r = self.client.patch(url, {"mount_pathway_id": far["id"]}, format="json")
        self.assertEqual(r.json()["mount_pathway_id"][0], "Not a 0U channel of this device's rack.")
        # Moved to another rack, the device leaves its channel.
        r = self.client.patch(url, {"rack_id": str(other.pk)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.pdu.refresh_from_db()
        self.assertIsNone(self.pdu.mount_pathway_id)

    def test_unset_keeps_todays_placement(self):
        r = self.client.patch(f"/api/devices/{self.pdu.pk}/", {"mount_offset_mm": 20},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["mount_pathway"])


class PermissionTests(_PathBase):
    def test_default_closed(self):
        self.login(self.user_with(["rack"], ("view",)))
        self.assertEqual(self.client.get("/api/rack-pathways/resolved/",
                                         {"rack": self.rack.pk}).status_code, 403)
        self.assertEqual(self.client.post("/api/rack-pathways/", {}).status_code, 403)
        self.client.logout()
        self.assertIn(self.client.get("/api/rack-pathways/").status_code, (401, 403))

    def test_the_rack_must_be_in_view(self):
        self.login(self.user_with(["rackpathway"], ("view",)))
        r = self.client.get("/api/rack-pathways/resolved/", {"rack": self.rack.pk})
        self.assertEqual(r.status_code, 404)

    def test_other_tenant(self):
        other_site = Site.objects.create(tenant=self.other, name="Far")
        far = Rack.objects.create(tenant=self.other, name="X", site=other_site)
        r = self.client.get("/api/rack-pathways/resolved/", {"rack": far.pk})
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/api/rack-pathways/", {"rack_id": str(far.pk), "kind": "entry",
                                                     "surface": "top"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("rack_id", r.json())
        mine = RackPathway.objects.create(tenant=self.other, rack=far, key="entry:top:roof")
        self.assertEqual(self.client.get(f"/api/rack-pathways/{mine.pk}/").status_code, 404)
        r = self.client.post("/api/rack-pathways/pin/", {"rack_id": str(far.pk),
                                                         "key": "entry:top:roof"},
                             format="json")
        self.assertEqual(r.status_code, 404)

    def test_type_rows_need_rack_type_change(self):
        self.login(self.user_with(["rackpathway", "rack", "racktype"],
                                  ("view", "add", "change", "delete")))
        self.post({"rack_type_id": str(self.rt.pk), "key": "entry:top:roof", "hidden": True})
        self.login(self.user_with(["rackpathway", "rack"], ("view", "add", "change")))
        r = self.client.post("/api/rack-pathways/", {"rack_type_id": str(self.rt.pk),
                                                     "key": "entry:bottom:floor",
                                                     "hidden": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.post({"rack_id": str(self.rack.pk), "key": "entry:top:roof", "hidden": False})

    def test_site_scope(self):
        far_site = Site.objects.create(tenant=self.tenant, name="Branch")
        far = Rack.objects.create(tenant=self.tenant, name="B1", site=far_site)
        user = User.objects.create_user("site", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="site", object_types=["rackpathway", "rack", "racktype"],
            actions=["view", "add", "change", "delete"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site)
        self.login(user)
        self.post({"rack_id": str(self.rack.pk), "key": "entry:top:roof", "hidden": True})
        self.assertEqual(self.client.get("/api/rack-pathways/resolved/",
                                         {"rack": far.pk}).status_code, 404)
        r = self.client.post("/api/rack-pathways/", {"rack_id": str(far.pk),
                                                     "key": "entry:top:roof"}, format="json")
        self.assertIn(r.status_code, (400, 403))
        # A rack type's rows have no site: shared to read, not theirs to write.
        r = self.client.post("/api/rack-pathways/", {"rack_type_id": str(self.rt.pk),
                                                     "key": "entry:top:roof",
                                                     "hidden": True}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.get("/api/rack-pathways/resolved/",
                                         {"rack_type": self.rt.pk}).status_code, 200)


# ── packs ───────────────────────────────────────────────────────────────────

CM_VERT = """\
name: CM-VERT-2POST
kind: cable-manager
u_height: 0
model3d:
  file: models/Generic/CM-VERT-2POST.glb
"""


class PackTests(_PathBase):
    def pack(self, glb):
        pack = KitPack(kit=KIT, glb=glb, pack=PACK_YAML.replace(
            "accessory: [BLANK-1U]", "accessory: [BLANK-1U, CM-VERT-2POST]"))
        pack.write("accessory-types/Generic/CM-VERT-2POST.yaml", CM_VERT)
        pack.write("models/Generic/CM-VERT-2POST.glb", model([
            {"name": "CM-VERT-2POST", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "z", "danbyte_ref_mm": 1000}, "children": [1]},
            {"name": "path", "translation": [0.077, 0.5, 0.06],
             "extras": {"danbyte_inner_w": 150.0, "danbyte_inner_d": 115.0,
                        "danbyte_kind": "finger"}},
        ], materials=("FRAME",)))
        return pack

    def test_import_and_re_import(self):
        res = self.install(self.pack(cabinet().glb()))
        kit_row = next(t for t in res.types if t.kind == "rack-kit")
        self.assertIn("pathways: 6 vertical, 3 entries, 2 0U channels.", kit_row.notes)
        cm = next(t for t in res.types if t.kind == "accessory-type" and t.name == "CM-VERT-2POST")
        self.assertNotEqual(cm.action, "error", cm.notes)
        acc = AccessoryType.objects.get(tenant=self.tenant, name="CM-VERT-2POST")
        self.assertIsNone(acc.u_height)
        self.assertEqual(acc.pathway, {"kind": "finger", "inner_w_mm": 150, "inner_d_mm": 115})
        rt = RackType.objects.get(tenant=self.tenant, name="Generic 42U 600x1000 cabinet")
        rack = Rack.objects.create(tenant=self.tenant, name="K1", site=self.site, rack_type=rt)
        items = self.items(rack=rack.pk)
        self.assertEqual(items["path:vertical:left:rear"]["source"], "kit")
        # The type's base is casters: no plinth, so no floor entry.
        self.assertNotIn("entry:bottom:rear", items)
        self.post({"rack_id": str(rack.pk), "key": "path:vertical:left:rear", "name": "Left"})
        # The pack's next version makes the channels wider: the rack follows,
        # its own name stays.
        n = cabinet()
        for node in n.nodes:
            if node["name"] == "path":
                node["extras"] = {**node["extras"], "danbyte_inner_w": 60.0}
        self.install(self.pack(n.glb()))
        it = self.items(rack=rack.pk)["path:vertical:left:rear"]
        self.assertEqual((it["inner_w_mm"], it["label"]), (60, "Left"))

    def test_a_cable_manager_without_a_height(self):
        pack = self.pack(cabinet().glb())
        pack.write("accessory-types/Generic/CM-VERT-2POST.yaml",
                   CM_VERT.replace("u_height: 0\n", ""))
        res = self.install(pack)
        cm = next(t for t in res.types if t.kind == "accessory-type" and t.name != "BLANK-1U")
        self.assertEqual(cm.action, "error")
        self.assertIn("or 0 for a vertical one", " ".join(cm.notes))
