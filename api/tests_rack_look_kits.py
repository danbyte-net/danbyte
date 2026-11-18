"""Racks built from data (docs/dcim/racks.md → Look, the export spec §3,
§8 and §14): device type rack mounting and a device's ear position, the
Look fields on rack types and racks (a rack's override, else its type's,
else the default), rack kits and rack types from a model pack, the pack
checker's rows for them, rack accessory kinds, the kit endpoints and their
scope, and the 3D scene's ``look``."""
from __future__ import annotations

import os
import shutil
import tempfile

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .devicetype_import import import_devicetype_yaml, import_racktype_yaml
from .model_pack import PackFiles, import_pack
from .model_pack_check import check_pack
from .models import AccessoryType, Device, DeviceType, Rack, RackKit, RackType, Site
from .rack_kits import read_look, scan_parts
from .rack_look import resolve
from .rack_mount import check_ear_position, mount_of, normalise
from .tests_model_anchors import model

# ── fixtures ────────────────────────────────────────────────────────────────

STRETCH_Y = {"danbyte_stretch": "x", "danbyte_ref_mm": 1000}


def kit_glb(*, segment=True, hinge=True, v2=False):
    """A tiny kit: a post segment, a width beam, a solid top, a plinth, a
    side panel and a perforated door with its hinge empty. ``v2`` adds the
    spec v1.15 parts: split door and panel, ``base:panel``, a 0U channel
    with its ``pdu:bracket``, and the pathway names Danbyte knows but
    does not draw."""
    nodes = []
    if segment:
        nodes.append({"name": "post:segment", "mesh": "FRAME",
                      "translation": [-0.28, 0.12, -0.05]})
    nodes += [
        {"name": "beam:width", "mesh": "FRAME", "extras": STRETCH_Y,
         "translation": [0, 1.9, -0.02]},
        {"name": "top:solid", "mesh": "FRAME",
         "extras": {"danbyte_stretch": "xy", "danbyte_ref_mm": 1000},
         "translation": [0, 1.99, -0.5]},
        {"name": "base:plinth", "mesh": "FRAME",
         "extras": {"danbyte_stretch": "xy"}, "translation": [0, 0.05, -0.5]},
        {"name": "side:panel", "mesh": "FRAME",
         "extras": {"danbyte_stretch": "yz", "danbyte_ref_mm": 1000},
         "translation": [-0.29, 1.0, -0.5]},
        {"name": "label:u", "mesh": "Metal", "translation": [-0.27, 1.0, -0.04]},
        {"name": "frame:mystery", "mesh": "Metal"},
    ]
    door = {"name": "door:perforated", "mesh": "FRAME",
            "extras": {"danbyte_stretch": "xz", "danbyte_ref_mm": 1000},
            "translation": [0, 1.0, 0.01]}
    if hinge:
        door["children"] = [len(nodes) + 1]
        nodes += [door, {"name": "hinge", "translation": [-0.29, 0, 0]}]
    else:
        nodes.append(door)
    if v2:
        nodes += [
            {"name": "door:perforated:stile", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "z", "danbyte_ref_mm": 1000}},
            {"name": "door:perforated:rail", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "x", "danbyte_ref_mm": 1000}},
            {"name": "door:perforated:infill", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "xz", "danbyte_ref_mm": 1000}},
            {"name": "side:panel:edge", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "y", "danbyte_ref_mm": 1000}},
            {"name": "side:panel:infill", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "yz", "danbyte_ref_mm": 1000}},
            {"name": "base:panel", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "xy", "danbyte_ref_mm": 1000}},
            {"name": "channel:0u:left:rear", "translation": [-0.258, 0.165, -0.9308],
             "rotation": [0, 0.7071068, 0, 0.7071068],
             "extras": {"danbyte_depth": 830.8, "danbyte_len_u": 40},
             "children": [len(nodes) + 7]},
            {"name": "pdu:bracket", "mesh": "FRAME",
             "extras": {"danbyte_stretch": "z", "danbyte_ref_mm": 1000}},
            {"name": "entry:top:front-left", "extras": {"danbyte_kind": "brush"}},
            {"name": "brush:front-left", "mesh": "Metal"},
            {"name": "path:vertical:left:rear", "mesh": "FRAME"},
        ]
    return model(nodes, materials=("FRAME", "Metal"))


KIT = """\
name: CABINET
frame: cabinet
model3d:
  file: models/Generic/CABINET.kit.glb
  far: models/Generic/CABINET.far.glb
widths_mm: [600, 800]
depths_mm: [1000, 1200]
colours:
  black: "#1b1c1e"
  grey: "#c9ccce"
"""

RACK_TYPE = """\
manufacturer: Generic
model: Generic 42U 600x1000 cabinet
u_height: 42
width: 19
outer_width_mm: 600
outer_depth_mm: 1000
rail_depth_mm: 740
look:
  kit: CABINET
  front_door: perforated
  rear_door: split-perforated
  hinge: right
  side_panels: true
  top: vented
  base: casters
  colour: grey
"""

BLANK = """\
name: BLANK-1U
kind: blanking
u_height: 1
model3d:
  file: models/Generic/BLANK-1U.glb
"""

PACK_YAML = """\
name: Generic racks
id: generic-racks
version: 1.0.0
license: CC-BY-4.0
types:
  rack-kit: [CABINET]
  rack-type: [Generic 42U 600x1000 cabinet]
  accessory: [BLANK-1U]
"""


class KitPack:
    def __init__(self, *, kit=KIT, rack_type=RACK_TYPE, pack=PACK_YAML, glb=None):
        self.root = tempfile.mkdtemp()
        self.write("pack.yaml", pack)
        self.write("rack-kits/Generic/CABINET/kit.yaml", kit)
        self.write("models/Generic/CABINET.kit.glb", glb or kit_glb())
        self.write("models/Generic/CABINET.far.glb",
                   model([{"name": "far", "mesh": "FRAME"}], materials=("FRAME",)))
        self.write("rack-types/Generic/Generic-42U-600x1000.yaml", rack_type)
        self.write("accessory-types/Generic/BLANK-1U.yaml", BLANK)
        self.write("models/Generic/BLANK-1U.glb",
                   model([{"name": "Panel", "mesh": "Metal"}], materials=("Metal",)))

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data.encode() if isinstance(data, str) else data)

    def files(self):
        return PackFiles(self.root)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class _Base(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.admin = User.objects.create_superuser("admin", password="x")
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant, self.other)
        self.login(self.admin)

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)
        super().tearDown()

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def user_with(self, types, actions=("view",)):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name=f"p{user.pk}", object_types=list(types),
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        return user

    def install(self, pack=None, dry_run=False):
        pack = pack or KitPack()
        files = pack.files()
        try:
            return import_pack(self.tenant, files, dry_run=dry_run)
        finally:
            files.close()
            pack.cleanup()


# ── rack mounting ───────────────────────────────────────────────────────────

MOUNT = {"ears": True, "positions": {"front": 0, "mid": 220, "rear": 430},
         "default": "front", "rails": "none"}


class RackMountBlockTests(SimpleTestCase):
    def test_a_full_block_is_kept_in_order(self):
        got = normalise({"positions": {"rear": 430, "front": 0, "mid": 220.4},
                         "default": "mid", "rails": "fixed"})
        self.assertEqual(list(got["positions"]), ["front", "mid", "rear"])
        self.assertEqual(got["positions"]["mid"], 220)
        self.assertEqual((got["ears"], got["default"], got["rails"]), (True, "mid", "fixed"))

    def test_defaults_fill_in(self):
        self.assertIsNone(normalise(None))
        self.assertEqual(normalise({"ears": True, "ear_mm": 3}),
                         {"ears": True, "positions": {"front": 0}, "default": "front",
                          "rails": "none", "ear_mm": 3.0})
        self.assertEqual(normalise({"positions": {"mid": 100}})["default"], "mid")

    def test_earless_gear(self):
        got = normalise({"ears": False, "rails": "sliding"})
        self.assertEqual(got, {"ears": False, "positions": {}, "default": "",
                               "rails": "sliding"})

    def test_refusals(self):
        for bad, key in (
            ({"ears": "yes"}, "ears"),
            ({"rails": "magic"}, "rails"),
            ({"positions": {"side": 3}}, "positions"),
            ({"positions": {"front": 5000}}, "positions"),
            ({"ears": False, "positions": {"front": 0}}, "positions"),
            ({"positions": {"front": 0}, "default": "rear"}, "default"),
            ({"colour": 1}, "rack_mount"),
            ({"ear_mm": 30}, "ear_mm"),
            ({"ear_mm": True}, "ear_mm"),
            ({"ears": False, "ear_mm": 2}, "ear_mm"),
            ([1, 2], None),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValidationError) as cm:
                normalise(bad)
            if key:
                self.assertIn(key, cm.exception.message_dict)

    def test_mount_of_a_device(self):
        dt = DeviceType(rack_mount=MOUNT)
        self.assertEqual(mount_of(dt), {"ears": True, "position": "front", "offset_mm": 0,
                                        "shift_mm": 0, "rails": "none", "reversed": False,
                                        "ear_mm": 2})
        self.assertEqual(mount_of(dt, "mid")["offset_mm"], 220)
        self.assertEqual(mount_of(dt, "mid")["shift_mm"], 220)
        recessed = DeviceType(rack_mount={**MOUNT, "positions": {"front": -40, "rear": 300}})
        self.assertEqual(mount_of(recessed, "rear")["shift_mm"], 340)
        self.assertEqual(mount_of(recessed)["offset_mm"], -40)
        # A position the type doesn't offer falls back to its default.
        self.assertEqual(mount_of(recessed, "mid")["position"], "front")
        self.assertEqual(mount_of(DeviceType())["position"], "front")
        self.assertFalse(mount_of(DeviceType(rack_mount={"ears": False, "positions": {},
                                                         "default": "",
                                                         "rails": "sliding"}))["ears"])

    def test_reversed(self):
        # Cisco's C9300 rear mount: the box turned round, its rear face on
        # the ear plane (spec v1.15).
        block = normalise({"positions": {"front": 0, "mid": 98, "reversed": 0},
                           "ear_mm": 2.5})
        self.assertEqual(list(block["positions"]), ["front", "mid", "reversed"])
        dt = DeviceType(rack_mount=block)
        got = mount_of(dt, "reversed")
        self.assertEqual((got["position"], got["reversed"], got["offset_mm"],
                          got["shift_mm"], got["ear_mm"]), ("reversed", True, 0, 0, 2.5))
        self.assertFalse(mount_of(dt, "mid")["reversed"])
        self.assertIsNone(check_ear_position(dt, "reversed"))
        self.assertIn("front, mid", check_ear_position(DeviceType(rack_mount={
            **MOUNT, "positions": {"front": 0, "mid": 200}}), "reversed"))

    def test_check_ear_position(self):
        dt = DeviceType(rack_mount={**MOUNT, "positions": {"front": 0, "mid": 200}})
        self.assertIsNone(check_ear_position(dt, ""))
        self.assertIsNone(check_ear_position(dt, "mid"))
        self.assertIn("front, mid", check_ear_position(dt, "rear"))
        self.assertIn("One of", check_ear_position(dt, "side"))
        self.assertIn("front", check_ear_position(DeviceType(), "mid"))
        earless = DeviceType(rack_mount={"ears": False, "positions": {}, "default": "",
                                         "rails": "none"})
        self.assertIn("no rack ears", check_ear_position(earless, "front"))


class RackMountApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="FW-1", u_height=1)

    def test_type_takes_and_validates_its_block(self):
        res = self.client.patch(f"/api/device-types/{self.dt.id}/", {"rack_mount": MOUNT},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["rack_mount"], MOUNT)
        res = self.client.patch(f"/api/device-types/{self.dt.id}/",
                                {"rack_mount": {"positions": {"front": 0}, "default": "mid"}},
                                format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("rack_mount", res.json())
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(self.dt.id)).exists())

    def test_device_ear_position(self):
        self.dt.rack_mount = MOUNT
        self.dt.save()
        res = self.client.post("/api/devices/", {
            "name": "fw1", "device_type_id": str(self.dt.id), "site_id": str(self.site.id),
            "ear_position": "mid"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body["ear_position"], "mid")
        self.assertEqual(body["rack_mount"]["offset_mm"], 220)
        dev = Device.objects.get(pk=body["id"])
        # The type stops offering mid: refused while a device is fitted there.
        res = self.client.patch(f"/api/device-types/{self.dt.id}/",
                                {"rack_mount": {"positions": {"front": 0}}}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("fitted", str(res.json()))
        # A position the type doesn't offer is refused.
        self.dt.rack_mount = {**MOUNT, "positions": {"front": 0, "mid": 220}}
        self.dt.save()
        res = self.client.patch(f"/api/devices/{dev.id}/", {"ear_position": "rear"},
                                format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("ear_position", res.json())
        res = self.client.patch(f"/api/devices/{dev.id}/", {"ear_position": ""},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["rack_mount"]["position"], "front")

    def test_yaml_import(self):
        text = ("manufacturer: Acme\nmodel: FW-9\nu_height: 1\nrack_mount:\n  ears: true\n"
                "  positions: {front: 0, rear: 380}\n  default: rear\n  rails: none\n")
        rep = import_devicetype_yaml(self.tenant, text)
        self.assertTrue(rep["ok"], rep)
        dt = DeviceType.objects.get(tenant=self.tenant, name="FW-9")
        self.assertEqual(dt.rack_mount["default"], "rear")
        rep = import_devicetype_yaml(self.tenant, text.replace("FW-9", "FW-10").replace(
            "default: rear", "default: mid"))
        self.assertTrue(rep["ok"], rep)
        self.assertTrue(any(n.startswith("rack_mount:") for n in rep["skipped"]))
        self.assertIsNone(DeviceType.objects.get(tenant=self.tenant, name="FW-10").rack_mount)

    def test_reversed_is_kept_on_import_and_fitted_through_the_api(self):
        text = ("manufacturer: Acme\nmodel: SW-9\nu_height: 1\nrack_mount:\n  ears: true\n"
                "  positions: {front: 0, mid: 98, reversed: 0}\n  default: front\n"
                "  rails: none\n")
        rep = import_devicetype_yaml(self.tenant, text)
        self.assertTrue(rep["ok"], rep)
        self.assertFalse(any("reversed" in n for n in rep.get("skipped") or []), rep)
        dt = DeviceType.objects.get(tenant=self.tenant, name="SW-9")
        self.assertEqual(dt.rack_mount["positions"]["reversed"], 0)
        res = self.client.post("/api/devices/", {
            "name": "sw9", "device_type_id": str(dt.id), "site_id": str(self.site.id),
            "ear_position": "reversed"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertTrue(res.json()["rack_mount"]["reversed"])
        self.assertEqual(Device.objects.get(pk=res.json()["id"]).ear_position, "reversed")


# ── the Look ────────────────────────────────────────────────────────────────

class LookTests(_Base):
    def setUp(self):
        super().setUp()
        self.kit = RackKit.objects.create(tenant=self.tenant, vendor="Generic", name="CABINET")
        self.rt = RackType.objects.create(tenant=self.tenant, name="42U", front_door="glass",
                                          colour="grey", kit=self.kit, rail_depth_mm=740)

    def test_type_defaults(self):
        rt = RackType.objects.create(tenant=self.tenant, name="plain")
        self.assertEqual((rt.frame, rt.front_door, rt.rear_door, rt.hinge, rt.side_panels,
                          rt.top, rt.base, rt.colour, rt.blanking_fill),
                         ("cabinet", "perforated", "split-perforated", "left", True,
                          "vented", "plinth", "black", False))

    def test_rack_inherits_and_overrides(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="r1",
                                   rack_type=self.rt, rear_door="solid", side_panels=False)
        look = resolve(rack)
        self.assertEqual(look["front_door"], "glass")
        self.assertEqual(look["rear_door"], "solid")
        self.assertFalse(look["side_panels"])
        self.assertEqual(look["kit"], self.kit)
        self.assertEqual(look["rail_depth_mm"], 740)
        self.assertIn("front_door", look["inherited"])
        self.assertNotIn("rear_door", look["inherited"])
        bare = Rack.objects.create(tenant=self.tenant, site=self.site, name="r2")
        self.assertEqual(resolve(bare)["front_door"], "perforated")
        self.assertIsNone(resolve(bare)["kit"])

    def test_api_round_trip(self):
        res = self.client.post("/api/racks/", {
            "name": "r1", "site_id": str(self.site.id), "rack_type_id": str(self.rt.id),
            "frame": "4-post", "colour": "#AABBCC"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body["colour"], "#aabbcc")
        self.assertIsNone(body["front_door"])
        self.assertEqual(body["look"]["frame"], "4-post")
        self.assertEqual(body["look"]["front_door"], "glass")
        self.assertEqual(body["look"]["kit"]["name"], "CABINET")
        self.assertEqual(body["rack_type"]["kit"]["name"], "CABINET")
        # Back to the type's.
        res = self.client.patch(f"/api/racks/{body['id']}/", {"colour": None, "frame": None},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["look"]["colour"], "grey")
        self.assertEqual(res.json()["look"]["frame"], "cabinet")

    def test_validation(self):
        for field, value in (("colour", "purple"), ("colour", "#12345"), ("frame", "6-post"),
                             ("front_door", "curtain"), ("rail_depth_mm", 50)):
            with self.subTest(field=field):
                res = self.client.patch(f"/api/rack-types/{self.rt.id}/", {field: value},
                                        format="json")
                self.assertEqual(res.status_code, 400)
                self.assertIn(field, res.json())
        res = self.client.patch(f"/api/rack-types/{self.rt.id}/", {"colour": ""},
                                format="json")
        self.assertEqual(res.status_code, 400)

    def test_a_kit_of_another_tenant_is_refused(self):
        theirs = RackKit.objects.create(tenant=self.other, name="CABINET")
        res = self.client.patch(f"/api/rack-types/{self.rt.id}/", {"kit_id": str(theirs.id)},
                                format="json")
        self.assertEqual(res.status_code, 400)
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="r1")
        res = self.client.patch(f"/api/racks/{rack.id}/", {"kit_id": str(theirs.id)},
                                format="json")
        self.assertEqual(res.status_code, 400)

    def test_rack_list_queries_do_not_grow_with_looks(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                res = self.client.get("/api/racks/")
            self.assertEqual(res.status_code, 200)
            return len(ctx.captured_queries)

        Rack.objects.create(tenant=self.tenant, site=self.site, name="r0", rack_type=self.rt)
        one = count()
        other_kit = RackKit.objects.create(tenant=self.tenant, name="OPEN")
        for i in range(1, 4):
            Rack.objects.create(tenant=self.tenant, site=self.site, name=f"r{i}",
                                rack_type=self.rt, kit=other_kit)
        self.assertEqual(count(), one)

    def test_audited(self):
        self.client.patch(f"/api/rack-types/{self.rt.id}/", {"top": "fans"}, format="json")
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(self.rt.id)).exists())


class RackTypeYamlLookTests(_Base):
    def test_netbox_form_factor_and_mounting_depth(self):
        text = ("manufacturer: APC\nmodel: AR3100\nform_factor: 4-post-frame\nwidth: 19\n"
                "u_height: 42\nmounting_depth: 760\n")
        rep = import_racktype_yaml(self.tenant, text)
        self.assertTrue(rep["ok"], rep)
        rt = RackType.objects.get(name="AR3100")
        self.assertEqual((rt.frame, rt.rail_depth_mm), ("4-post", 760))

    def test_look_block(self):
        notes = []
        got = read_look({"look": {"kit": "CABINET", "hinge": "up", "colour": "white",
                                  "side_panels": "yes", "extra": 1}}, notes)
        self.assertEqual(got, {"kit_name": "CABINET", "colour": "white"})
        self.assertEqual(len(notes), 3)


# ── kits from a pack ────────────────────────────────────────────────────────

class KitScanTests(SimpleTestCase):
    def test_parts_and_notes(self):
        from .model_3d import validate_glb

        parts, notes = scan_parts(validate_glb(kit_glb()))
        self.assertEqual(parts["beam:width"], {"stretch": "x", "ref_mm": 1000.0,
                                               "hinge": False})
        self.assertTrue(parts["door:perforated"]["hinge"])
        self.assertEqual(parts["base:plinth"]["ref_mm"], 1000)
        self.assertTrue(any("danbyte_ref_mm" in n for n in notes))
        self.assertTrue(any("frame:mystery" in n for n in notes))
        _parts, notes = scan_parts(validate_glb(kit_glb(segment=False, hinge=False)))
        self.assertTrue(any("can't build" in n for n in notes))
        self.assertTrue(any("no hinge empty" in n for n in notes))

    def test_v1_15_parts_are_read_and_known_names_not_noted(self):
        from .model_3d import validate_glb

        parts, notes = scan_parts(validate_glb(kit_glb(v2=True)))
        for name in ("door:perforated:stile", "door:perforated:rail",
                     "door:perforated:infill", "side:panel:edge", "side:panel:infill",
                     "base:panel", "pdu:bracket"):
            self.assertIn(name, parts)
        self.assertEqual(parts["door:perforated:infill"]["stretch"], "xz")
        # The channel: where it is and the way its devices face (+x here).
        chan = parts["channel:0u:left:rear"]
        self.assertEqual(chan["at"], [-0.258, 0.165, -0.9308])
        self.assertAlmostEqual(chan["out"][0], 1.0, places=3)
        self.assertAlmostEqual(chan["out"][1], 0.0, places=3)
        self.assertEqual((chan["depth_mm"], chan["len_u"]), (830.8, 40))
        noted = " ".join(notes)
        for name in ("entry:", "brush:", "path:", "channel:", "pdu:", "base:panel"):
            self.assertNotIn(name, noted)
        self.assertIn("frame:mystery", noted)


class KitImportTests(_Base):
    def test_a_pack_brings_its_kit_rack_type_and_blanks(self):
        res = self.install()
        self.assertEqual(res.errors, 0, [(t.path, t.notes) for t in res.types])
        kinds = {t.kind: t for t in res.types}
        self.assertEqual(kinds["rack-kit"].action, "created")
        self.assertEqual(kinds["rack-type"].action, "created")
        kit = RackKit.objects.get(tenant=self.tenant, vendor="Generic", name="CABINET")
        self.assertTrue(kit.model_3d and kit.model_3d_far)
        self.assertEqual(kit.widths_mm, [600, 800])
        self.assertEqual(kit.colours["grey"], "#c9ccce")
        self.assertIn("post:segment", kit.parts)
        rt = RackType.objects.get(tenant=self.tenant, name="Generic 42U 600x1000 cabinet")
        self.assertEqual(rt.kit, kit)
        self.assertEqual((rt.hinge, rt.base, rt.colour, rt.rail_depth_mm, rt.outer_width_mm),
                         ("right", "casters", "grey", 740, 600))
        blank = AccessoryType.objects.get(tenant=self.tenant, name="BLANK-1U")
        self.assertEqual((blank.kind, blank.u_height, blank.fits), ("blanking", 1, []))
        # Again: matched, nothing doubled.
        res = self.install()
        self.assertEqual({t.action for t in res.types}, {"matched"})
        self.assertEqual(RackKit.objects.filter(tenant=self.tenant).count(), 1)

    def test_dry_run_stores_nothing(self):
        res = self.install(dry_run=True)
        self.assertEqual(res.errors, 0)
        self.assertFalse(RackKit.objects.exists())
        self.assertFalse(RackType.objects.exists())

    def test_a_kit_that_cannot_build_is_an_error(self):
        res = self.install(KitPack(glb=kit_glb(segment=False)))
        row = next(t for t in res.types if t.kind == "rack-kit")
        self.assertEqual(row.action, "error")
        # Its rack type still imports, drawn without a kit.
        rt = RackType.objects.get(name="Generic 42U 600x1000 cabinet")
        self.assertIsNone(rt.kit)

    def test_rack_part_needs_its_height(self):
        pack = KitPack()
        pack.write("accessory-types/Generic/BLANK-1U.yaml", BLANK.replace("u_height: 1\n", ""))
        res = self.install(pack)
        row = next(t for t in res.types if t.kind == "accessory-type")
        self.assertEqual(row.action, "error")
        self.assertIn("u_height", " ".join(row.notes))


class KitCheckTests(SimpleTestCase):
    def check(self, pack):
        files = pack.files()
        try:
            return check_pack(files)
        finally:
            files.close()
            pack.cleanup()

    def test_a_good_pack_has_rows_and_no_errors(self):
        rep = self.check(KitPack())
        self.assertTrue(rep.ok, [(f.path, f.message) for f in rep.findings
                                 if f.level == "error"])
        kinds = {p.kind: p for p in rep.parts}
        self.assertEqual(kinds["rack-kit"].part, "CABINET")
        self.assertGreater(kinds["rack-kit"].triangles, 0)
        self.assertIsNotNone(kinds["rack-kit"].far_triangles)
        self.assertIn("rack-type", kinds)
        self.assertEqual(kinds["accessory-type"].part, "BLANK-1U")

    def test_errors(self):
        rep = self.check(KitPack(glb=kit_glb(segment=False),
                                 rack_type=RACK_TYPE.replace("kit: CABINET", "kit: NOPE")))
        msgs = [f.message for f in rep.findings if f.level == "error"]
        self.assertTrue(any("can't build" in m for m in msgs), msgs)
        self.assertTrue(any("NOPE" in m for m in msgs), msgs)

    def test_pack_yaml_lists(self):
        rep = self.check(KitPack(pack=PACK_YAML.replace("[CABINET]", "[CABINET, OPEN]")
                                 .replace("  rack-type: [Generic 42U 600x1000 cabinet]\n", "")))
        msgs = [(f.level, f.message) for f in rep.findings if f.path == "pack.yaml"]
        self.assertIn(("error", "types.rack-kit lists OPEN, which has no YAML."), msgs)
        self.assertTrue(any(lv == "warning" and "rack-type" in m for lv, m in msgs), msgs)


# ── endpoints and the scene ─────────────────────────────────────────────────

class KitEndpointTests(_Base):
    def setUp(self):
        super().setUp()
        self.install()
        self.kit = RackKit.objects.get(tenant=self.tenant)
        self.rt = RackType.objects.get(tenant=self.tenant)
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="r1",
                                        rack_type=self.rt, blanking_fill=True)

    def test_list_and_model(self):
        res = self.client.get("/api/rack-kits/")
        self.assertEqual(res.status_code, 200)
        row = res.json()["results"][0]
        self.assertEqual((row["name"], row["rack_type_count"]), ("CABINET", 1))
        res = self.client.get(row["model_url"])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Content-Type"], "model/gltf-binary")
        self.assertEqual(self.client.get(row["far_url"]).status_code, 200)

    def test_scoped_to_the_tenant_and_the_rack_type_grant(self):
        self.login(self.admin, self.other)
        self.assertEqual(self.client.get("/api/rack-kits/").json()["count"], 0)
        self.assertEqual(self.client.get(f"/api/rack-kits/{self.kit.id}/").status_code, 404)
        racks_only = self.user_with(["rack", "site"])
        self.login(racks_only)
        self.assertEqual(self.client.get("/api/rack-kits/").status_code, 403)
        # Through the rack instead.
        res = self.client.get(f"/api/racks/{self.rack.id}/kit-model/")
        self.assertEqual(res.status_code, 200)
        scene = self.client.get(f"/api/racks/{self.rack.id}/scene/").json()
        self.assertTrue(scene["look"]["kit"]["model_url"].startswith(
            f"/api/racks/{self.rack.id}/kit-model/"))
        # No pluggables grant: the fill draws plain panels.
        self.assertEqual(scene["look"]["blanks"], [])
        self.assertEqual(self.client.delete(f"/api/rack-kits/{self.kit.id}/").status_code, 403)

    def test_scene_look(self):
        res = self.client.get(f"/api/racks/{self.rack.id}/scene/")
        self.assertEqual(res.status_code, 200, res.content)
        look = res.json()["look"]
        self.assertEqual(look["colour"], "#c9ccce")
        self.assertEqual(look["hinge"], "right")
        self.assertTrue(look["blanking_fill"])
        self.assertEqual(look["blanks"][0]["u_height"], 1)
        self.assertTrue(look["kit"]["model_url"].startswith(f"/api/rack-kits/{self.kit.id}/"))
        self.assertIn("post:segment", look["kit"]["parts"])

    def test_delete_leaves_types_drawn_without_it(self):
        res = self.client.delete(f"/api/rack-kits/{self.kit.id}/")
        self.assertEqual(res.status_code, 204)
        self.rt.refresh_from_db()
        self.assertIsNone(self.rt.kit)
        self.assertIsNone(self.client.get(f"/api/racks/{self.rack.id}/scene/").json()
                          ["look"]["kit"])
