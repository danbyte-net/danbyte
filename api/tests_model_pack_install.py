"""3D model packs in the app (api.model_pack_install, api.model_pack_views)
and the pack checker (api.model_pack_check, manage.py check_model_pack):
the ModelPack record, the check and install jobs, the endpoints and their
rights, the archive refusals, and the checker's cases on small synthetic
packs."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import shutil
import tempfile
import warnings
import zipfile
from unittest import mock

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings
from PIL import Image
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from . import model_pack, model_pack_check
from .model_pack import PackFiles, PackRefused, zip_refusals
from .model_pack_check import check_pack, check_source
from .models import DeviceType, ModelPack, ModuleType, Site
from .tests_model_anchors import OUT_FRONT, SFP_EXTRAS, _chassis_nodes, model

FACE = (2000, 184)
ISO = (1600, 1200)

DEVICE = """\
manufacturer: Acme
model: Acme X1
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
  empty: filler
  leds:
    SYS: { source: device.status }
    "port:*": { source: interface.oper_status }
"""
MODULE = """\
manufacturer: Acme
model: NM-9
part_number: NM-9
interfaces:
  - name: Te1/{module}/1
    type: 10gbase-x-sfpp
model3d:
  file: models/Acme/NM-9.glb
  leds:
    STATUS: { source: module.status }
"""
PACK = """\
name: Acme test
id: acme-test
version: {version}
license: CC-BY-4.0
author: Tester
spec: 1.4
types:
  device: [X1]
  module: [NM-9]
"""


def chassis_nodes() -> list[dict]:
    """The anchors test chassis, cleaned up to pass every check: sized
    ports and the port LED on the LED material."""
    nodes = copy.deepcopy(_chassis_nodes())
    for n in nodes:
        if n.get("name", "").startswith("port:"):
            n["extras"] = dict(SFP_EXTRAS)
        if n.get("name") == "led:port:Te1/0/1":
            n["mesh"] = "LED"
    return nodes


def module_nodes() -> list[dict]:
    return [
        {"name": "Body", "mesh": "Metal", "scale": [0.06, 0.04, 0.3],
         "translation": [0, 0.02, -0.15]},
        {"name": "port:Te1/{module}/1", "translation": [0.01, 0.02, 0], "rotation": OUT_FRONT,
         "extras": {"danbyte_w": 0.0142, "danbyte_h": 0.0095}},
        {"name": "led:STATUS", "children": [3]},
        {"mesh": "LED", "scale": [0.002, 0.002, 0.001]},
    ]


def img(size, fmt="WEBP", alpha=0) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (30, 30, 30, alpha)).save(buf, fmt)
    return buf.getvalue()


class PackDir:
    """A synthetic pack folder that passes every check, to break one way
    per test."""

    def __init__(self, version="1.1.0"):
        self.root = tempfile.mkdtemp()
        self.glb = model(chassis_nodes())
        self.write("pack.yaml", PACK.format(version=version))
        self.write("models/Acme/X1.glb", self.glb)
        self.write("models/Acme/X1.far.glb", self.glb)
        self.write("models/Acme/NM-9.glb", model(module_nodes()))
        self.write("models/Acme/X1.front.webp", img(FACE))
        self.write("models/Acme/X1.rear.webp", img(FACE))
        self.write("models/Acme/X1.iso.webp", img(ISO))
        self.write("module-types/Acme/NM-9.yaml", MODULE)
        self.device()

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data.encode() if isinstance(data, str) else data)

    def device(self, yaml_text=DEVICE, sha=None, modules=None):
        sha = hashlib.sha256(self.glb).hexdigest() if sha is None else sha
        mods = {"FAN 1": "NM-9"} if modules is None else modules
        lines = ["  renders:"]
        lines += [f"    {f}: models/Acme/X1.{f}.webp" for f in ("front", "rear", "iso")]
        if sha:
            lines.append(f"    model_sha256: {sha}")
        if mods:
            lines.append("    modules:")
            lines += [f"      {b}: {pn}" for b, pn in mods.items()]
        self.write("device-types/Acme/X1.yaml", yaml_text + "\n".join(lines) + "\n")

    def zip(self, dest, top="acme-test") -> str:
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, _dirs, files in os.walk(self.root):
                for f in files:
                    full = os.path.join(dirpath, f)
                    rel = os.path.relpath(full, self.root).replace(os.sep, "/")
                    zf.write(full, f"{top}/{rel}" if top else rel)
        return dest

    def zip_bytes(self) -> bytes:
        path = os.path.join(tempfile.mkdtemp(), "p.zip")
        self.zip(path)
        with open(path, "rb") as fh:
            data = fh.read()
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)
        return data

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def _zip(entries) -> bytes:
    """A zip from ``[(ZipInfo or name, data)]``."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for info, data in entries:
            zf.writestr(info, data)
    return buf.getvalue()


# ── the checker ─────────────────────────────────────────────────────────────

class CheckerTests(SimpleTestCase):
    def setUp(self):
        self.p = PackDir()

    def tearDown(self):
        self.p.cleanup()

    def check(self):
        files = PackFiles(self.p.root)
        try:
            return check_pack(files)
        finally:
            files.close()

    def messages(self, rep, level="error"):
        return [f"{f.path}: {f.message}" for f in rep.findings if f.level == level]

    def assertError(self, rep, text):
        self.assertTrue(any(text in m for m in self.messages(rep)),
                        f"{text!r} not in {self.messages(rep)}")

    def test_a_good_pack_passes_clean(self):
        rep = self.check()
        self.assertTrue(rep.ok, self.messages(rep))
        self.assertEqual(rep.warnings, 0, self.messages(rep, "warning"))
        self.assertEqual(rep.pack["id"], "acme-test")
        parts = {p.part: p for p in rep.parts}
        self.assertEqual(parts["X1"].bays, 2)
        self.assertEqual(parts["X1"].ports, 2)
        self.assertEqual(parts["X1"].leds, 2)
        self.assertGreater(parts["X1"].triangles, 0)
        self.assertEqual(parts["X1"].far_triangles, parts["X1"].triangles)

    def test_the_same_pack_zipped_passes(self):
        path = self.p.zip(os.path.join(self.p.root, "..", "acme.zip"))
        try:
            self.assertTrue(check_source(path).ok)
        finally:
            os.unlink(path)

    def test_triangles_count_each_node_and_mode(self):
        doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1, 2]}],
               "nodes": [{"mesh": 0}, {"mesh": 0}, {"mesh": 1}],
               "meshes": [{"primitives": [{"indices": 0, "attributes": {"POSITION": 1}}]},
                          {"primitives": [{"mode": 5, "attributes": {"POSITION": 1}},
                                          {"mode": 1, "attributes": {"POSITION": 1}}]}],
               "accessors": [{"count": 36}, {"count": 8}]}
        self.assertEqual(model_pack_check.triangles(doc), 12 + 12 + 6)

    def test_bay_and_port_names_must_match_the_yaml(self):
        self.p.device(DEVICE.replace("name: PS-0", "name: PS-A").replace(
            "name: Te1/0/2", "name: Te1/0/9"))
        rep = self.check()
        self.assertError(rep, "bay:PS-0 matches no module bay")
        self.assertError(rep, "port:Te1/0/2 matches no interface")
        self.assertTrue(any("Module bay “PS-A” has no bay:PS-A" in m
                            for m in self.messages(rep, "warning")))

    def test_module_port_names_keep_the_module_token(self):
        self.p.write("module-types/Acme/NM-9.yaml",
                     MODULE.replace("Te1/{module}/1", "Te1/1/1"))
        self.assertError(self.check(), "port:Te1/{module}/1 matches no interface")

    def test_an_led_needs_the_led_material(self):
        nodes = chassis_nodes()
        next(n for n in nodes if n.get("name") == "led:port:Te1/0/1")["mesh"] = "Metal"
        self.p.glb = model(nodes)
        self.p.write("models/Acme/X1.glb", self.p.glb)
        self.p.write("models/Acme/X1.far.glb", self.p.glb)
        self.p.device()
        self.assertError(self.check(), "does not use the material “LED”")

    def test_module_leds_must_equal_its_led_nodes(self):
        self.p.write("module-types/Acme/NM-9.yaml", MODULE.replace(
            "STATUS: { source: module.status }", "FAIL: { source: module.status }"))
        rep = self.check()
        self.assertError(rep, "model3d.leds.FAIL: the model has no led:FAIL")
        self.assertError(rep, "led:STATUS has no model3d.leds entry")

    def test_an_unbound_chassis_led_is_only_a_warning(self):
        self.p.device(DEVICE.replace('    "port:*": { source: interface.oper_status }\n', ""))
        rep = self.check()
        self.assertTrue(rep.ok, self.messages(rep))
        self.assertTrue(any("led:port:Te1/0/1 has no model3d.leds entry" in m
                            for m in self.messages(rep, "warning")))

    def test_missing_port_sizes_warn(self):
        nodes = chassis_nodes()
        for n in nodes:
            n.pop("extras", None)
        self.p.glb = model(nodes)
        self.p.write("models/Acme/X1.glb", self.p.glb)
        self.p.write("models/Acme/X1.far.glb", self.p.glb)
        self.p.device()
        rep = self.check()
        self.assertTrue(rep.ok)
        self.assertTrue(any("2 ports without danbyte_w" in m
                            for m in self.messages(rep, "warning")))

    def _module(self, type_, w, h):
        nodes = module_nodes()
        nodes[1]["extras"] = {"danbyte_w": w, "danbyte_h": h}
        self.p.write("models/Acme/NM-9.glb", model(nodes))
        self.p.write("module-types/Acme/NM-9.yaml",
                     MODULE.replace("type: 10gbase-x-sfpp", f"type: {type_}"))
        rep = self.check()
        self.assertTrue(rep.ok, self.messages(rep))
        return [m for m in self.messages(rep, "warning") if "-sized opening" in m]

    def test_a_copper_type_on_an_sfp_cage_warns(self):
        self.assertEqual(self._module("10gbase-t", 0.014, 0.0086), [
            "module-types/Acme/NM-9.yaml: 1 port typed 10gbase-t (RJ45) has an "
            "SFP-sized opening (first: Te1/{module}/1, 14.0 x 8.6 mm)."
        ])

    def test_cage_mismatches_warn(self):
        for type_, w, h, label in [
            ("100gbase-x-qsfp28", 0.0142, 0.0095, "(QSFP) has an SFP-sized"),
            ("10gbase-x-sfpp", 0.019, 0.0095, "(SFP) has a QSFP-sized"),
            ("25gbase-x-sfp28", 0.0117, 0.0081, "(SFP) has an RJ45-sized"),
            ("400gbase-x-osfp", 0.0195, 0.009, "(OSFP) has a QSFP-sized"),
        ]:
            with self.subTest(type=type_):
                got = self._module(type_, w, h)
                self.assertEqual(len(got), 1, got)
                self.assertIn(label, got[0])

    def test_matching_and_unclear_openings_stay_quiet(self):
        for type_, w, h in [
            ("1000base-t", 0.0117, 0.0081),     # an RJ45 mouth
            ("1000base-t", 0.014, 0.012),       # an RJ45 housing
            ("10gbase-t", 0.0081, 0.0117),      # turned on its side
            ("10gbase-x-sfpp", 0.0138, 0.0083),
            ("25gbase-x-sfp28", 0.014, 0.0086),
            ("40gbase-x-qsfpp", 0.0195, 0.0089),
            ("100gbase-x-qsfp28", 0.0209, 0.0092),
            ("400gbase-x-osfp", 0.023, 0.013),
            ("10gbase-x-xfp", 0.0184, 0.0085),  # XFP is QSFP-wide
            ("10gbase-t", 0.013, 0.009),        # between RJ45 and SFP
            ("cisco-stackwise-480", 0.014, 0.0086),
            ("virtual", 0.014, 0.0086),
        ]:
            with self.subTest(type=type_, w=w, h=h):
                self.assertEqual(self._module(type_, w, h), [])

    def test_the_far_lod_needs_the_same_names(self):
        nodes = chassis_nodes()
        next(n for n in nodes if n.get("name") == "led:SYS")["name"] = "SYS light"
        far = model(nodes)
        self.p.write("models/Acme/X1.far.glb", far)
        self.assertError(self.check(), "The far model has no led:SYS")

    def test_budgets(self):
        with mock.patch.dict(model_pack_check.BUDGETS,
                             {"device-type": {"triangles": (1, 1)}}):
            rep = self.check()
        self.assertError(rep, "the budget is 1")
        self.assertError(rep, "the far budget is 1")
        with mock.patch.object(model_pack_check, "FILE_BUDGET", (10, 10)):
            self.assertError(self.check(), "bytes; the budget is 10")

    def test_a_bad_glb_is_an_error(self):
        self.p.write("models/Acme/NM-9.glb", b"not a model")
        self.assertError(self.check(), "models/Acme/NM-9.glb: Not a binary glTF")

    def test_render_size_must_be_the_face_frame(self):
        self.p.write("models/Acme/X1.front.webp", img((2000, 200)))
        self.assertError(self.check(), "2000 × 200 px; the type's face frame")

    def test_render_needs_a_transparent_background(self):
        self.p.write("models/Acme/X1.rear.webp", img(FACE, alpha=255))
        self.assertError(self.check(), "X1.rear.webp: No transparent background")

    def test_render_must_be_an_image(self):
        self.p.write("models/Acme/X1.iso.webp", b"RIFF....WEBPjunk")
        self.assertError(self.check(), "X1.iso.webp: Not an image")

    def test_model_sha256_must_be_the_glb(self):
        self.p.device(sha="ab" * 32)
        self.assertError(self.check(), "Re-render from the shipped model")
        self.p.device(sha="")
        self.assertError(self.check(), "renders.model_sha256: none")

    def test_render_modules_must_exist(self):
        self.p.device(modules={"FAN 1": "NM-404", "FAN 9": "NM-9"})
        rep = self.check()
        self.assertError(rep, "module type NM-404 is not in the pack")
        self.assertError(rep, "renders.modules.FAN 9: no module bay")

    def test_pack_yaml(self):
        os.unlink(os.path.join(self.p.root, "pack.yaml"))
        self.assertError(self.check(), "The pack has no pack.yaml")
        self.p.write("pack.yaml", "name: X\ntypes:\n  device: [X1, X2]\n  module: [NM-9]\n")
        rep = self.check()
        self.assertError(rep, "No id.")
        self.assertError(rep, "No license.")
        self.assertError(rep, "lists X2, which has no YAML")

    def test_files_a_pack_doesnt_hold(self):
        self.p.write("tools/run.py", b"print(1)")
        os.symlink("/etc/passwd", os.path.join(self.p.root, "models/Acme/link.yaml"))
        rep = self.check()
        self.assertError(rep, "tools/run.py: not a file a pack holds")
        self.assertError(rep, "models/Acme/link.yaml: a symbolic link")

    def test_hidden_files_are_ignored(self):
        self.p.write(".git/config", b"x")
        self.p.write(".DS_Store", b"x")
        self.assertTrue(self.check().ok)

    def test_a_type_may_be_listed_by_model_or_file_name(self):
        # The manifest names GS728TPv2; its part number is GS728TP-200.
        self.p.write("pack.yaml", PACK.format(version="1.1.0").replace(
            "device: [X1]", "device: [X1, X2v2, X3]"))
        self.p.write("device-types/Acme/X2.yaml", (
            b"manufacturer: Acme\nmodel: X2v2\npart_number: X2-200\nslug: acme-x2v2\n"
            b"u_height: 1\n"))
        self.p.write("device-types/Acme/X3.yaml", (
            b"manufacturer: Acme\nmodel: Ex Three\npart_number: X3-EU\nslug: acme-x3\n"
            b"u_height: 1\n"))
        found = str(self.check().findings)
        self.assertNotIn("which has no YAML", found)
        self.assertNotIn("doesn't list", found)

    def test_the_working_folders_extras_are_ignored(self):
        self.p.write("release/sources/Acme/X.blend", b"x")
        self.p.write("release/models/Acme/X.hq.glb", b"x")
        self.p.write("report/overview.png", b"x")
        rep = self.check()
        self.assertTrue(rep.ok)
        self.assertNotIn("release/", str(rep.findings))
        self.assertNotIn("report/", str(rep.findings))


class CheckCommandTests(SimpleTestCase):
    def setUp(self):
        self.p = PackDir()

    def tearDown(self):
        self.p.cleanup()

    def test_exit_0_and_a_table(self):
        out = io.StringIO()
        call_command("check_model_pack", self.p.root, stdout=out)
        text = out.getvalue()
        self.assertIn("Acme test 1.1.0", text)
        self.assertIn("triangles", text)
        self.assertIn("OK: 0 errors, 0 warnings.", text)

    def test_exit_1_on_an_error_and_json(self):
        self.p.device(sha="ab" * 32)
        out = io.StringIO()
        with self.assertRaises(SystemExit) as cm:
            call_command("check_model_pack", self.p.root, "--json", stdout=out)
        self.assertEqual(cm.exception.code, 1)
        doc = json.loads(out.getvalue())
        self.assertFalse(doc["ok"])
        self.assertEqual(doc["errors"], 1)
        self.assertEqual({p["part"] for p in doc["parts"]}, {"X1", "NM-9"})


# ── archive refusals ────────────────────────────────────────────────────────

class ZipRefusalTests(SimpleTestCase):
    def refusals(self, entries):
        return zip_refusals(zipfile.ZipFile(io.BytesIO(_zip(entries))))

    def assertRefused(self, entries, text):
        got = self.refusals(entries)
        self.assertTrue(any(text in r for r in got), f"{text!r} not in {got}")

    def test_a_clean_zip(self):
        self.assertEqual(self.refusals([("p/pack.yaml", "name: x"), ("p/README.md", "#")]), [])

    def test_absolute_and_parent_paths(self):
        self.assertRefused([("/etc/pack.yaml", "x")], "the path leaves the pack")
        self.assertRefused([("p/../../evil.yaml", "x")], "the path leaves the pack")
        self.assertRefused([("p\\..\\evil.yaml", "x")], "the path leaves the pack")
        self.assertRefused([("C:/evil.yaml", "x")], "the path leaves the pack")

    def test_symlinks_and_special_files(self):
        link = zipfile.ZipInfo("p/models/a.glb")
        link.external_attr = (0o120777 << 16)
        self.assertRefused([(link, "/etc/passwd")], "a symbolic link")
        fifo = zipfile.ZipInfo("p/models/b.glb")
        fifo.external_attr = (0o010644 << 16)
        self.assertRefused([(fifo, "x")], "not a regular file")

    def test_file_types(self):
        self.assertRefused([("p/run.py", "x")], "not a file a pack holds")
        self.assertRefused([("p/models/inner.zip", "x")], "not a file a pack holds")
        self.assertEqual(self.refusals([("__MACOSX/._x.glb", "x"), ("p/.DS_Store", "x")]), [])
        self.assertEqual(self.refusals([("p/release/sources/x.blend", "x"),
                                        ("release/sources/x.blend", "x"),
                                        ("p/report/notes.txt", "x")]), [])

    def test_duplicates_and_encryption(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            self.assertRefused([("p/a.yaml", "1"), ("p/a.yaml", "2")], "in the archive twice")
        # zipfile writes no encrypted entries: set the flag in the headers.
        raw = bytearray(_zip([("p/b.yaml", "x")]))
        for sig, off in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            i = raw.index(sig) + off
            raw[i] |= 0x1
        got = zip_refusals(zipfile.ZipFile(io.BytesIO(bytes(raw))))
        self.assertTrue(any("encrypted" in r for r in got), got)

    @override_settings(DEVICE_MODEL_MAX_BYTES=100)
    def test_member_size_cap(self):
        self.assertRefused([("p/m.glb", b"x" * 200)], "over the 100")

    def test_zip_bomb_ratio(self):
        self.assertRefused([("p/m.glb", b"\0" * (2 * 1024 * 1024))], "inflates more than")

    def test_count_and_unpacked_total(self):
        with mock.patch.object(model_pack, "MAX_PACK_FILES", 2):
            self.assertRefused([(f"p/{i}.yaml", "x") for i in range(3)], "holds 3 entries")
        with mock.patch.object(model_pack, "MAX_UNPACKED_BYTES", 10):
            self.assertRefused([("p/a.yaml", "x" * 8), ("p/b.yaml", "x" * 8)], "unpacks to 16")

    def test_packfiles_refuses_and_reads_nothing(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "p.zip")
            with open(path, "wb") as fh:
                fh.write(_zip([("p/pack.yaml", "x"), ("p/../x.yaml", "x")]))
            with self.assertRaises(PackRefused):
                PackFiles(path)
            rep = check_source(path)
            self.assertFalse(rep.ok)
        finally:
            shutil.rmtree(d, ignore_errors=True)


# ── the app ─────────────────────────────────────────────────────────────────

def _inline():
    """Run queued jobs inline: the queue is "down"."""
    return mock.patch("django_rq.get_queue", side_effect=RuntimeError("no redis"))


class _AppBase(APITestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self._media = override_settings(MEDIA_ROOT=self.media)
        self._media.enable()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.root = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.root, role="admin").tenants.add(
            self.tenant, self.other)
        self.login(self.root)
        self.p = PackDir()

    def tearDown(self):
        self.p.cleanup()
        self._media.disable()
        shutil.rmtree(self.media, ignore_errors=True)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def user(self, name, types, actions, *, sites=None):
        u = User.objects.create_user(name, f"{name}@x", "x")
        UserProfile.objects.create(user=u, role="operator").tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name=name, object_types=types,
                                                actions=actions)
        grant.users.add(u)
        grant.tenants.add(self.tenant)
        if sites:
            grant.sites.add(*sites)
        return u

    def admin_user(self, name="tadmin", **kw):
        return self.user(name, ["devicetype", "moduletype", "manufacturer", "user",
                                "modulebaytemplate", "interfacetemplate"],
                         ["view", "add", "change", "delete"], **kw)

    def upload(self, data=None, name="acme.zip"):
        data = self.p.zip_bytes() if data is None else data
        f = SimpleUploadedFile(name, data, content_type="application/zip")
        with _inline():
            return self.client.post("/api/model-packs/", {"file": f}, format="multipart")

    def install(self, pack_id, **body):
        with _inline():
            return self.client.post(f"/api/model-packs/{pack_id}/install/", body,
                                    format="json")

    def checked(self, **kw):
        r = self.upload(**kw)
        self.assertEqual(r.status_code, 202, r.content)
        return ModelPack.objects.get(pk=r.json()["id"])


class InstallFlowTests(_AppBase):
    def test_upload_checks_and_dry_runs_without_changing_anything(self):
        pack = self.checked()
        self.assertEqual(pack.status, "checked", pack.error)
        self.assertEqual((pack.slug, pack.name, pack.version, pack.license, pack.author),
                         ("acme-test", "Acme test", "1.1.0", "CC-BY-4.0", "Tester"))
        self.assertEqual(len(pack.sha256), 64)
        self.assertIn({"path": "pack.yaml", "size": len(PACK.format(version="1.1.0"))},
                      pack.files)
        self.assertTrue(pack.report["check"]["ok"])
        dry = pack.report["import"]
        self.assertEqual((dry["created"], dry["matched"], dry["errors"]), (2, 0, 0))
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())
        self.assertFalse(ModuleType.objects.filter(tenant=self.tenant).exists())
        self.assertTrue(os.path.isfile(os.path.join(self.media, "model-packs",
                                                    f"{pack.pk}.zip")))
        r = self.client.get(f"/api/model-packs/{pack.pk}/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["installable"])

    def test_install_applies_audited_with_the_pack_as_cause(self):
        pack = self.checked()
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        r = self.install(pack.pk, replace_photos=True)
        self.assertEqual(r.status_code, 202, r.content)
        pack.refresh_from_db()
        self.assertEqual(pack.status, "installed", pack.error)
        self.assertEqual(pack.installed_by, self.root)
        self.assertIsNotNone(pack.installed_at)
        self.assertTrue(pack.replace_photos)
        dt = DeviceType.objects.get(tenant=self.tenant, part_number="X1")
        self.assertTrue(dt.model_3d)
        self.assertTrue(dt.front_image)
        self.assertEqual(pack.result["created"], 2)
        self.assertIn(str(dt.pk), {t["id"] for t in pack.result["types"]})
        new = ChangeLogEntry.objects.exclude(id__in=before)
        dt_entries = new.filter(object_type="api.devicetype", object_id=str(dt.pk))
        self.assertTrue(dt_entries.exists())
        self.assertEqual({e.cause for e in dt_entries}, {"Pack import: Acme test 1.1.0"})
        self.assertEqual({e.user_id for e in dt_entries}, {self.root.pk})
        self.assertTrue(new.filter(object_type="api.modelpack", object_id=str(pack.pk)).exists())
        # The archive goes once installed.
        self.assertFalse(os.path.exists(os.path.join(self.media, "model-packs",
                                                     f"{pack.pk}.zip")))
        r = self.client.get("/api/model-packs/?status=installed")
        self.assertEqual([row["id"] for row in r.json()["results"]], [str(pack.pk)])
        self.assertEqual(r.json()["results"][0]["types"], 2)

    def test_a_newer_version_updates_and_replaces_the_old_record(self):
        first = self.checked()
        self.install(first.pk)
        self.p.write("pack.yaml", PACK.format(version="1.2.0"))
        second = self.checked()
        self.assertEqual(second.report["installed"]["version"], "1.1.0")
        self.assertEqual(second.report["import"]["matched"], 2)
        self.install(second.pk)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.status, second.status), ("replaced", "installed"))
        self.assertEqual(DeviceType.objects.filter(tenant=self.tenant).count(), 1)
        hist = self.client.get(f"/api/model-packs/{second.pk}/").json()["history"]
        self.assertEqual([(h["version"], h["status"]) for h in hist], [("1.1.0", "replaced")])

    def test_update_from_pack_replaces_an_edit(self):
        from .models import InterfaceTemplate

        first = self.checked()
        self.install(first.pk)
        dt = DeviceType.objects.get(tenant=self.tenant, part_number="X1")
        InterfaceTemplate.objects.filter(device_type=dt, name="Te1/0/1").update(
            type="25gbase-x-sfp28")
        self.p.write("pack.yaml", PACK.format(version="1.2.0"))
        second = self.checked()
        row = next(t for t in second.report["import"]["types"] if t["kind"] == "device-type")
        self.assertEqual(row["changes"]["kept"], 1)
        self.assertIn("kept your edit on 1 interface, type 25gbase-x-sfp28 (the pack has "
                      "10gbase-x-sfpp): Te1/0/1", row["notes"])
        self.assertEqual(self.install(second.pk, overwrite="yes").status_code, 400)
        r = self.install(second.pk, overwrite=True)
        self.assertEqual(r.status_code, 202, r.content)
        second.refresh_from_db()
        self.assertEqual(second.status, "installed", second.error)
        self.assertTrue(second.overwrite)
        self.assertTrue(self.client.get(f"/api/model-packs/{second.pk}/").json()["overwrite"])
        self.assertEqual(dt.interface_templates.get(name="Te1/0/1").type, "10gbase-x-sfpp")

    def test_a_pack_with_check_errors_is_not_installed(self):
        self.p.device(sha="ab" * 32)
        pack = self.checked()
        self.assertEqual(pack.status, "checked")
        self.assertFalse(pack.report["check"]["ok"])
        r = self.install(pack.pk)
        self.assertEqual(r.status_code, 409)
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())

    def test_install_twice_or_before_check_is_refused(self):
        pack = self.checked()
        self.install(pack.pk)
        self.assertEqual(self.install(pack.pk).status_code, 409)

    def test_a_changed_archive_fails_the_install(self):
        pack = self.checked()
        with open(os.path.join(self.media, "model-packs", f"{pack.pk}.zip"), "ab") as fh:
            fh.write(b"x")
        self.install(pack.pk)
        pack.refresh_from_db()
        self.assertEqual(pack.status, "failed")
        self.assertIn("changed since it was checked", pack.error)
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())

    def test_refused_archive(self):
        pack = self.checked(data=_zip([("p/pack.yaml", "x"), ("p/../evil.yaml", "x")]))
        self.assertEqual(pack.status, "refused")
        self.assertTrue(any("leaves the pack" in m for m in pack.report["refusals"]))
        self.assertFalse(os.path.exists(os.path.join(self.media, "model-packs",
                                                     f"{pack.pk}.zip")))
        pack = self.checked(data=b"not a zip at all")
        self.assertEqual((pack.status, pack.error), ("refused", "Not a zip file."))

    def test_upload_limits(self):
        r = self.upload(name="acme.tar")
        self.assertEqual(r.status_code, 400)
        with override_settings(MODEL_PACK_MAX_BYTES=100):
            r = self.upload()
        self.assertEqual(r.status_code, 413)
        self.assertFalse(ModelPack.objects.exists())
        self.assertEqual(self.client.post("/api/model-packs/", {}, format="json").status_code,
                         400)

    def test_forget_keeps_the_types(self):
        pack = self.checked()
        self.install(pack.pk)
        r = self.client.delete(f"/api/model-packs/{pack.pk}/")
        self.assertEqual(r.status_code, 204)
        self.assertFalse(ModelPack.objects.filter(pk=pack.pk).exists())
        self.assertTrue(DeviceType.objects.filter(tenant=self.tenant, part_number="X1").exists())

    def test_the_job_rechecks_the_rights(self):
        u = self.admin_user()
        self.login(u)
        with mock.patch("api.model_pack_install._enqueue"):
            r = self.client.post("/api/model-packs/", {"file": SimpleUploadedFile(
                "a.zip", self.p.zip_bytes())}, format="multipart")
        self.assertEqual(r.status_code, 202, r.content)
        ObjectPermission.objects.filter(name="tadmin").delete()
        from .model_pack_install import run_check

        run_check(r.json()["id"])
        pack = ModelPack.objects.get(pk=r.json()["id"])
        self.assertEqual(pack.status, "failed")
        self.assertIn("no longer", pack.error)

    def test_limits_and_strict_params(self):
        r = self.client.get("/api/model-packs/limits/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["can_install"])
        self.assertEqual(r.json()["max_bytes"], 200 * 1024 * 1024)
        self.assertEqual(self.client.get("/api/model-packs/?status=bogus").status_code, 400)
        self.assertEqual(self.client.get("/api/model-packs/?foo=1").status_code, 400)


class InstallRightsTests(_AppBase):
    def test_tenant_isolation(self):
        pack = self.checked()
        self.login(self.root, self.other)
        self.assertEqual(self.client.get("/api/model-packs/").json()["count"], 0)
        self.assertEqual(self.client.get(f"/api/model-packs/{pack.pk}/").status_code, 404)
        self.assertEqual(self.install(pack.pk).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/model-packs/{pack.pk}/").status_code, 404)

    def test_a_viewer_reads_but_does_not_install(self):
        pack = self.checked()
        viewer = self.user("viewer", ["devicetype"], ["view"])
        self.login(viewer)
        self.assertEqual(self.client.get("/api/model-packs/").status_code, 200)
        self.assertEqual(self.client.get(f"/api/model-packs/{pack.pk}/").status_code, 200)
        self.assertFalse(self.client.get("/api/model-packs/limits/").json()["can_install"])
        self.assertEqual(self.upload().status_code, 403)
        self.assertEqual(self.install(pack.pk).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/model-packs/{pack.pk}/").status_code, 403)

    def test_no_view_no_list(self):
        nobody = self.user("nobody", ["site"], ["view"])
        self.login(nobody)
        self.assertEqual(self.client.get("/api/model-packs/").status_code, 403)

    def test_a_tenant_admin_with_type_rights_installs(self):
        self.login(self.admin_user())
        pack = self.checked()
        self.assertEqual(pack.status, "checked", pack.error)
        self.assertEqual(self.install(pack.pk).status_code, 202)
        pack.refresh_from_db()
        self.assertEqual(pack.status, "installed", pack.error)

    def test_type_rights_without_tenant_admin_are_not_enough(self):
        u = self.user("editor", ["devicetype", "moduletype"], ["view", "add", "change"])
        self.login(u)
        self.assertEqual(self.upload().status_code, 403)

    def test_a_site_scoped_admin_is_refused(self):
        self.login(self.admin_user("siteadmin", sites=[self.site]))
        self.assertEqual(self.upload().status_code, 403)

    def test_add_without_change_is_refused(self):
        u = self.user("adder", ["devicetype", "moduletype", "user"], ["view", "add"])
        self.login(u)
        self.assertEqual(self.upload().status_code, 403)


class _Resp:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code = status
        self.body = body
        self.headers = headers or {}

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]

    def close(self):
        pass


@override_settings(MODEL_PACK_SOURCE_URL="https://packs.example.com/releases/",
                   MODEL_PACK_ALLOWED_HOSTS=["mirror.example.org"],
                   MODEL_PACK_REDIRECT_HOSTS=["cdn.example.net"])
class UrlInstallTests(_AppBase):
    def post(self, url, responses=None):
        get = mock.patch("core.ssrf.safe_get", side_effect=list(responses or []))
        with _inline(), get as g:
            r = self.client.post("/api/model-packs/", {"url": url}, format="json")
        return r, g

    def test_refused_urls(self):
        for url in ("http://packs.example.com/releases/a.zip",
                    "https://evil.example.com/a.zip",
                    "https://packs.example.com/other/a.zip",
                    "https://user:pw@packs.example.com/releases/a.zip",
                    "https://cdn.example.net/a.zip"):
            r, g = self.post(url)
            self.assertEqual(r.status_code, 400, url)
            self.assertIn("url", r.json())
            g.assert_not_called()

    def test_downloads_follow_allowed_redirects(self):
        body = self.p.zip_bytes()
        r, g = self.post("https://packs.example.com/releases/v1/acme.zip", [
            _Resp(302, headers={"Location": "https://cdn.example.net/x?sig=1"}),
            _Resp(200, body, {"Content-Length": str(len(body))}),
        ])
        self.assertEqual(r.status_code, 202, r.content)
        pack = ModelPack.objects.get(pk=r.json()["id"])
        self.assertEqual(pack.status, "checked", pack.error)
        self.assertEqual(pack.source, "url")
        self.assertEqual(pack.sha256, hashlib.sha256(body).hexdigest())
        self.assertEqual(g.call_args_list[1].args[0], "https://cdn.example.net/x?sig=1")

    def test_an_allowed_host(self):
        r, _ = self.post("https://mirror.example.org/any/acme.zip",
                         [_Resp(200, self.p.zip_bytes())])
        self.assertEqual(ModelPack.objects.get(pk=r.json()["id"]).status, "checked")

    def test_a_redirect_elsewhere_is_refused(self):
        r, g = self.post("https://packs.example.com/releases/a.zip", [
            _Resp(302, headers={"Location": "https://169.254.169.254/latest/"})])
        pack = ModelPack.objects.get(pk=r.json()["id"])
        self.assertEqual(pack.status, "refused")
        self.assertEqual(g.call_count, 1)

    def test_too_large_a_download(self):
        with override_settings(MODEL_PACK_MAX_BYTES=10):
            r, _ = self.post("https://packs.example.com/releases/a.zip",
                             [_Resp(200, b"x" * 100)])
        pack = ModelPack.objects.get(pk=r.json()["id"])
        self.assertEqual(pack.status, "refused")
        self.assertIn("larger than", pack.error)

    def test_airgapped(self):
        ds = DeploymentSettings.load()
        ds.disable_update_check = True
        ds.save()
        r, g = self.post("https://packs.example.com/releases/a.zip")
        self.assertEqual(r.status_code, 400)
        self.assertIn("airgapped", r.json()["url"])
        self.assertFalse(self.client.get("/api/model-packs/limits/").json()["downloads"])


class ModelPackRecordTests(_AppBase):
    def test_str_and_defaults(self):
        pack = ModelPack.objects.create(tenant=self.tenant, name="Acme", version="1.0")
        self.assertEqual(str(pack), "Acme 1.0")
        self.assertEqual((pack.status, pack.source, pack.files, pack.report),
                         ("checking", "upload", [], {}))
