"""3D model anchors and packs (api.model_anchors, api.model_pack): the node
scan, the checks against a type's templates, the far model, module type
models and their scope, ``model3d:`` YAML and ``manage.py
import_model_pack``. Assembly in the room: tests_model_assembly."""
from __future__ import annotations

import io
import json
import math
import os
import shutil
import tempfile
import zipfile

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .model_anchors import mismatches, scan, summary
from .models import (
    Device,
    DeviceType,
    InterfaceTemplate,
    Manufacturer,
    ModuleBay,
    ModuleBayTemplate,
    ModuleInterfaceTemplate,
    ModuleType,
    Site,
)
from .tests_model_3d import glb

S = math.sqrt(0.5)
#: A quarter turn about +X: local +Y (a port's arrow) points along +Z.
OUT_FRONT = [S, 0, 0, S]
#: A half turn about +Y: a rear bay takes its module the other way round.
HALF_TURN = [0, 1, 0, 0]


def model(nodes: list[dict], *, roots=None, materials=("Metal", "LED")) -> bytes:
    """A GLB whose JSON names ``nodes``. A node with ``"mesh": "<material>"``
    gets a one-primitive mesh (a unit box from -0.5 to 0.5) in that
    material; everything else passes through as glTF node fields."""
    mats = list(materials)
    meshes, accessors, out = [], [], []
    for n in nodes:
        n = dict(n)
        mat = n.pop("mesh", None)
        if mat is not None:
            accessors.append({"componentType": 5126, "count": 3, "type": "VEC3",
                              "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]})
            meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors) - 1},
                                           "material": mats.index(mat)}]})
            n["mesh"] = len(meshes) - 1
        out.append(n)
    children = {c for n in out for c in n.get("children", [])}
    doc = {
        "asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
        "scene": 0,
        "scenes": [{"nodes": roots if roots is not None else
                    [i for i in range(len(out)) if i not in children]}],
        "nodes": out, "meshes": meshes, "accessors": accessors,
        "materials": [{"name": m} for m in mats],
    }
    return glb(doc)


def chassis() -> bytes:
    """A 1U chassis: a body box, two rear bays with covers (gltfpack -kn
    style: the cover's mesh on a child), two front ports, two LEDs."""
    return model([
        {"name": "Shell", "mesh": "Metal", "scale": [0.44, 0.044, 0.45],
         "translation": [0, 0.022, -0.225]},                                       # 0
        {"name": "bay:PS-0", "translation": [0.17, 0.0015, -0.45], "rotation": HALF_TURN},
        {"name": "bay:FAN 1", "translation": [0.1, 0.0017, -0.45], "rotation": HALF_TURN},
        {"name": "empty:PS-0", "children": [4],
         "translation": [0.17, 0.022, -0.449]},                                    # 3
        {"mesh": "Metal", "scale": [0.07, 0.04, 0.001]},                           # 4
        {"name": "empty:FAN 1", "children": [6],
         "translation": [0.1, 0.022, -0.449]},                                     # 5
        {"mesh": "Metal", "scale": [0.04, 0.04, 0.001]},                           # 6
        {"name": "port:Te1/0/1", "translation": [-0.2, 0.03, 0], "rotation": OUT_FRONT},
        {"name": "port:Te1/0/2", "translation": [-0.18, 0.03, 0], "rotation": OUT_FRONT},
        {"name": "led:SYS", "children": [10], "translation": [-0.21, 0.03, -0.001]},
        {"mesh": "LED", "scale": [0.002, 0.002, 0.001]},                           # 10
        {"name": "led:port:Te1/0/1", "mesh": "Metal", "scale": [0.002, 0.002, 0.001],
         "translation": [-0.2, 0.035, -0.001]},
    ])


def module_glb() -> bytes:
    """A network module: origin at its front's bottom centre, one port with
    the ``{module}`` token, depth toward -Z."""
    return model([
        {"name": "Body", "mesh": "Metal", "scale": [0.06, 0.04, 0.3],
         "translation": [0, 0.02, -0.15]},
        {"name": "port:Te1/{module}/1", "translation": [0.01, 0.02, 0], "rotation": OUT_FRONT},
        {"name": "led:STATUS", "children": [3]},
        {"mesh": "LED", "scale": [0.002, 0.002, 0.001]},
    ])


class ScanTests(SimpleTestCase):
    def _scan(self, data):
        from .model_3d import validate_glb

        return scan(validate_glb(data))

    def test_names_come_from_the_gltf_json(self):
        anchors, warnings = self._scan(chassis())
        # Exact glTF names: three.js would call these bayFAN_1 / portTe101.
        self.assertEqual(set(anchors["bays"]), {"PS-0", "FAN 1"})
        self.assertNotIn("FAN_1", anchors["bays"])
        self.assertEqual(set(anchors["empties"]), {"PS-0", "FAN 1"})
        self.assertEqual(set(anchors["ports"]), {"Te1/0/1", "Te1/0/2"})
        self.assertEqual(set(anchors["leds"]), {"SYS", "port:Te1/0/1"})
        self.assertEqual(anchors["bays"]["FAN 1"]["node"], 2)
        self.assertEqual(summary(anchors), "2 bays, 2 ports, 2 LEDs")

    def test_led_material_on_a_kn_child_mesh(self):
        anchors, warnings = self._scan(chassis())
        # led:SYS keeps its mesh on a child (gltfpack -kn): still the LED.
        self.assertTrue(anchors["leds"]["SYS"]["led_material"])
        self.assertFalse(anchors["leds"]["port:Te1/0/1"]["led_material"])
        self.assertEqual(warnings, ["“led:port:Te1/0/1” does not use the material “LED”."])

    def test_port_points_along_local_y(self):
        anchors, _ = self._scan(chassis())
        port = anchors["ports"]["Te1/0/1"]
        self.assertEqual(port["p"], [-0.2, 0.03, 0.0])
        self.assertEqual([round(x, 4) for x in port["n"]], [0.0, 0.0, 1.0])

    def test_box_covers_every_mesh_through_its_transforms(self):
        anchors, _ = self._scan(chassis())
        lo, hi = anchors["box"]
        self.assertAlmostEqual(lo[0], -0.22)
        self.assertAlmostEqual(hi[0], 0.22)
        self.assertAlmostEqual(lo[1], 0.0)
        self.assertAlmostEqual(hi[1], 0.044)
        self.assertAlmostEqual(lo[2], -0.45)

    def test_bay_pose_is_its_world_matrix(self):
        anchors, _ = self._scan(model([
            {"name": "Root", "translation": [1, 0, 0], "children": [1]},
            {"name": "bay:A", "translation": [0, 2, 0], "rotation": HALF_TURN},
        ]))
        m = anchors["bays"]["A"]["m"]
        self.assertEqual((m[3], m[7], m[11]), (1.0, 2.0, 0.0))
        self.assertEqual((m[0], m[10]), (-1.0, -1.0))

    def test_duplicates_and_nodes_outside_the_scene(self):
        anchors, warnings = self._scan(model(
            [{"name": "bay:A"}, {"name": "bay:A"}, {"name": "bay:B"}], roots=[0, 1],
        ))
        self.assertEqual(set(anchors["bays"]), {"A"})
        self.assertIn("“bay:A” is in the model twice; the first one counts.", warnings)

    def test_no_anchors(self):
        anchors, warnings = self._scan(glb())
        self.assertEqual((anchors["bays"], anchors["ports"], warnings), ({}, {}, []))
        self.assertIsNone(anchors["box"])


class MismatchTests(SimpleTestCase):
    anchors = {"bays": {"PS-0": {}, "FAN 1": {}}, "empties": {"PS-0": 1, "PS-9": 2},
               "ports": {"Te1/0/1": {}, "Te1/0/99": {}}, "leds": {"port:Gi0/0": {}}}

    def test_device_type(self):
        warnings = mismatches(self.anchors, ["PS-0", "PS-1"], ["Te1/0/1", "Te1/0/2"])
        self.assertIn("bay:FAN 1 matches no module bay.", warnings)
        self.assertIn("Module bay “PS-1” has no bay:PS-1 anchor.", warnings)
        self.assertIn("empty:PS-9 has no bay:PS-9 beside it.", warnings)
        self.assertIn("port:Te1/0/99 matches no interface.", warnings)
        self.assertIn("1 interface without a port: anchor (first: Te1/0/2).", warnings)
        self.assertIn("led:port:Gi0/0 matches no interface.", warnings)

    def test_module_type_keeps_the_token(self):
        warnings = mismatches({"ports": {"Te1/{module}/1": {}}}, None, ["Te1/{module}/1"])
        self.assertEqual(warnings, [])
        warnings = mismatches({"bays": {"X": {}}}, None, [])
        self.assertEqual(warnings, ["bay:X - a module's model holds no bays; it is ignored."])


class _Base(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="C9500", u_height=1,
                                            manufacturer=self.mfr, part_number="C9500-48Y4C")
        for name, pos in (("PS-0", "0"), ("PS-1", "1"), ("FAN 1", "1")):
            ModuleBayTemplate.objects.create(device_type=self.dt, name=name, position=pos)
        for name in ("Te1/0/1", "Te1/0/2", "Te1/0/3"):
            InterfaceTemplate.objects.create(device_type=self.dt, name=name)
        self.mt = ModuleType.objects.create(tenant=self.tenant, name="NM-1",
                                            manufacturer=self.mfr, part_number="NM-1")
        ModuleInterfaceTemplate.objects.create(module_type=self.mt, name="Te1/{module}/1")
        self.admin = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.admin, role="admin").tenants.add(
            self.tenant, self.other
        )
        self._login(self.admin)

    def tearDown(self):
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)

    def _login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def _upload(self, path, data, **extra):
        f = SimpleUploadedFile("m.glb", data, content_type="model/gltf-binary")
        return self.client.post(path, {"file": f, **extra}, format="multipart")

    def _device(self, name="sw1"):
        dev = Device.objects.create(tenant=self.tenant, name=name, device_type=self.dt,
                                    site=self.site)
        bays = {}
        for b in ("PS-0", "PS-1", "FAN 1"):
            bays[b] = ModuleBay.objects.get_or_create(
                device=dev, name=b, defaults={"position": "0" if b == "PS-0" else "1"})[0]
        return dev, bays


class UploadScanTests(_Base):
    def test_upload_reports_and_stores_the_anchors(self):
        res = self._upload(f"/api/device-types/{self.dt.id}/model/", chassis())
        self.assertEqual(res.status_code, 200, res.content)
        scan_ = res.json()["model_scan"]
        self.assertEqual(scan_["summary"], "2 bays, 2 ports, 2 LEDs")
        self.assertIn("Module bay “PS-1” has no bay:PS-1 anchor.", scan_["warnings"])
        self.assertIn("1 interface without a port: anchor (first: Te1/0/3).",
                      scan_["warnings"])
        self.dt.refresh_from_db()
        self.assertEqual(set(self.dt.model_anchors["bays"]), {"PS-0", "FAN 1"})
        # The Overview reads the same report back.
        body = self.client.get(f"/api/device-types/{self.dt.id}/").json()
        self.assertEqual(body["model_3d_scan"]["summary"], "2 bays, 2 ports, 2 LEDs")
        # Listed rows don't pay for it.
        row = self.client.get("/api/device-types/").json()["results"][0]
        self.assertIsNone(row["model_3d_scan"])

    def test_change_log_summarises_the_anchors(self):
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        self._upload(f"/api/device-types/{self.dt.id}/model/", chassis())
        entry = ChangeLogEntry.objects.exclude(id__in=before).get(action="update")
        anchors = entry.changes["model_anchors"]
        self.assertIn("ports", anchors["changed_keys"])
        # A summary, not every port's position.
        self.assertEqual(set(anchors["new"]), {"keys", "bytes"})
        self.assertNotIn("Te1/0/1", json.dumps(anchors))

    def test_far_model(self):
        url = f"/api/device-types/{self.dt.id}/model-far/"
        res = self._upload(url, chassis())
        self.assertEqual(res.status_code, 400)  # the full model first
        self._upload(f"/api/device-types/{self.dt.id}/model/", chassis())
        far = model([{"name": "bay:PS-0"}, {"name": "Shell", "mesh": "Metal"}])
        res = self._upload(url, far)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertIn("The far model has no bay:FAN 1.", body["model_scan"]["warnings"])
        self.assertIn("The far model has no led:SYS.", body["model_scan"]["warnings"])
        self.assertTrue(body["model_3d_far"].startswith(url))
        got = self.client.get(url)
        self.assertEqual(b"".join(got.streaming_content), far)
        # Removing the full model takes the far one with it.
        self.assertEqual(self.client.delete(f"/api/device-types/{self.dt.id}/model/")
                         .status_code, 204)
        self.dt.refresh_from_db()
        self.assertFalse(self.dt.model_3d_far)
        self.assertIsNone(self.dt.model_anchors)
        self.assertEqual(self.client.get(url).status_code, 404)


class ModuleTypeModelTests(_Base):
    def test_upload_download_delete(self):
        url = f"/api/module-types/{self.mt.id}/model/"
        res = self._upload(url, module_glb())
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["model_3d"].startswith(url))
        self.assertEqual(body["model_scan"]["summary"], "0 bays, 1 port, 1 LED")
        self.assertEqual(body["model_scan"]["warnings"], [])
        got = self.client.get(url)
        self.assertEqual(got["Content-Type"], "model/gltf-binary")
        self.assertEqual(b"".join(got.streaming_content), module_glb())
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_scope(self):
        url = f"/api/module-types/{self.mt.id}/model/"
        self._upload(url, module_glb())
        viewer = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="ro", object_types=["moduletype"],
                                                actions=["view"])
        grant.users.add(viewer)
        grant.tenants.add(self.tenant)
        self._login(viewer)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self._upload(url, module_glb()).status_code, 403)
        self.assertEqual(self.client.delete(url).status_code, 403)
        nobody = User.objects.create_user("n", password="x")
        UserProfile.objects.create(user=nobody).tenants.add(self.tenant)
        self._login(nobody)
        self.assertEqual(self.client.get(url).status_code, 403)
        self._login(self.admin, self.other)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self._upload(url, module_glb()).status_code, 404)


class YamlImportTests(_Base):
    def setUp(self):
        super().setUp()
        self.pack = tempfile.mkdtemp()
        self._write("models/Acme/X1.glb", chassis())
        self._write("models/Acme/X1.far.glb", chassis())
        self._write("models/Acme/NM-9.glb", module_glb())
        self._write("models/Acme/Unused.glb", module_glb())
        self._write("pack.yaml", b"name: Acme test\nversion: 0.1.0\n")
        self._write("device-types/Acme/X1.yaml", self.DEVICE.encode())
        self._write("module-types/Acme/NM-9.yaml", self.MODULE.encode())

    def tearDown(self):
        shutil.rmtree(self.pack, ignore_errors=True)
        super().tearDown()

    DEVICE = """
manufacturer: Acme
model: Acme X1
slug: acme-x1
part_number: X1
u_height: 1
module-bays:
  - name: PS-0
    position: '0'
  - name: FAN 1
    position: '1'
interfaces:
  - name: Te1/0/1
    type: 10gbase-x-sfpp
  - name: Te1/0/2
    type: 10gbase-x-sfpp
model3d:
  file: models/Acme/X1.glb
  far: models/Acme/X1.far.glb
  empty: hole
  leds:
    SYS: { source: device.status }
    BEACON: { source: blink.everything }
"""
    MODULE = """
manufacturer: Acme
model: NM-9
part_number: NM-9
interfaces:
  - name: Te1/{module}/1
    type: 10gbase-x-sfpp
model3d:
  file: models/Acme/NM-9.glb
"""

    def _write(self, rel, data: bytes):
        path = os.path.join(self.pack, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)

    def test_lone_yaml_skips_the_model_with_a_note(self):
        from .devicetype_import import import_devicetype_yaml

        rep = import_devicetype_yaml(self.tenant, self.DEVICE)
        self.assertTrue(rep["ok"], rep)
        self.assertTrue(any(n.startswith("model3d: models/Acme/X1.glb, models/Acme/X1.far.glb"
                                         " not imported") for n in rep["skipped"]),
                        rep["skipped"])
        self.assertFalse(DeviceType.objects.get(pk=rep["id"]).model_3d)

    def test_yaml_with_pack_files(self):
        from .devicetype_import import import_devicetype_yaml, import_moduletype_yaml
        from .model_pack import PackFiles

        files = PackFiles(self.pack)
        rep = import_devicetype_yaml(self.tenant, self.DEVICE, files=files)
        dt = DeviceType.objects.get(pk=rep["id"])
        self.assertTrue(dt.model_3d and dt.model_3d_far)
        self.assertEqual(dt.model_anchors["empty_mode"], "hole")
        self.assertEqual(dt.model_leds, {"SYS": {"source": "device.status"}})
        self.assertIn("model: 2 bays, 2 ports, 2 LEDs", rep["skipped"])
        self.assertIn("model3d.leds.BEACON: unknown source 'blink.everything' - dropped.",
                      rep["skipped"])
        rep = import_moduletype_yaml(self.tenant, self.MODULE, files=files)
        mt = ModuleType.objects.get(pk=rep["id"])
        self.assertEqual(set(mt.model_anchors["ports"]), {"Te1/{module}/1"})

    def test_paths_stay_inside_the_pack(self):
        from .model_pack import PackFiles

        files = PackFiles(self.pack)
        for bad in ("../x.glb", "/etc/passwd", "models/../../x", "C:/x.glb", "a\\b.glb"):
            self.assertIsNone(files.read(bad, 1 << 20), bad)

    def _command(self, *args):
        out = io.StringIO()
        call_command("import_model_pack", *args, "--tenant", "t", stdout=out)
        return out.getvalue()

    def test_command_dry_run_keeps_nothing(self):
        out = self._command(self.pack)
        self.assertIn("(dry run)", out)
        self.assertIn("device type Acme X1: created", out)
        self.assertIn("2 bays, 2 ports, 2 LEDs", out)
        self.assertIn("models/Acme/Unused.glb", out)
        self.assertFalse(DeviceType.objects.filter(name="Acme X1").exists())
        self.assertFalse(ModuleType.objects.filter(name="NM-9").exists())
        self.assertEqual(os.listdir(self.media) if os.path.isdir(self.media) else [], [])

    def test_command_apply_flags_images_pending(self):
        from .model_studio import pending

        out = self._command(self.pack, "--apply")
        self.assertIn("images: pending", out)
        self.assertTrue(pending(DeviceType.objects.get(name="Acme X1")))
        self.assertNotIn("images: pending", self._command(self.pack))

    def test_command_apply_creates_and_matches(self):
        # An existing module type, matched by manufacturer + part number.
        acme = Manufacturer.objects.create(tenant=self.tenant, name="Acme", slug="acme")
        mine = ModuleType.objects.create(tenant=self.tenant, name="My NM", part_number="NM-9",
                                         manufacturer=acme)
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        out = self._command(self.pack, "--apply")
        self.assertIn("module type My NM: matched", out)
        self.assertIn("1 matched, 1 created, 0 skipped", out)
        mine.refresh_from_db()
        self.assertTrue(mine.model_3d)
        dt = DeviceType.objects.get(name="Acme X1")
        self.assertTrue(dt.model_3d_far)
        self.assertEqual(dt.module_bay_templates.count(), 2)
        entries = ChangeLogEntry.objects.exclude(id__in=before)
        self.assertTrue(entries.filter(object_id=str(mine.id)).exists())
        self.assertTrue(all(e.cause.startswith("manage.py import_model_pack Acme test 0.1.0")
                            for e in entries.filter(object_id__in=[str(mine.id), str(dt.id)])))

    def test_command_reads_a_zip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for root, _dirs, names in os.walk(self.pack):
                for n in names:
                    full = os.path.join(root, n)
                    zf.write(full, "acme-pack/" + os.path.relpath(full, self.pack))
        path = os.path.join(self.pack, "..", "acme-pack-test.zip")
        with open(path, "wb") as fh:
            fh.write(buf.getvalue())
        try:
            out = self._command(path, "--apply")
        finally:
            os.remove(path)
        self.assertIn("0 matched, 2 created, 0 skipped", out)
        self.assertTrue(ModuleType.objects.get(name="NM-9").model_3d)
