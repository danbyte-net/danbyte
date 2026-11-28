"""Blender-rendered faces in model packs (api.model_pack.apply_renders,
api.model_projection): the checks on the files, provenance and the
never-overwrite rule, the pending rules for pack photos, ports and LEDs
placed on the server, and the projection cases shared with the SPA's
tests (frontend/src/lib/studio-projection.cases.json)."""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
from pathlib import Path

from django.conf import settings
from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase
from PIL import Image

from auth_api.models import ObjectPermission, UserProfile

from . import model_projection as mp
from . import model_studio
from .models import DeviceType, Manufacturer, ModuleType
from .tests_model_anchors import _Base, chassis, module_glb
from .tests_model_studio import _file

CASES = Path(settings.BASE_DIR) / "frontend/src/lib/studio-projection.cases.json"


def _close(test, actual, expected, path="$"):
    if isinstance(expected, float) or (isinstance(expected, int)
                                       and not isinstance(expected, bool)):
        test.assertIsInstance(actual, (int, float), path)
        test.assertLess(abs(actual - expected), 2e-5, path)
    elif isinstance(expected, list):
        test.assertEqual(len(actual), len(expected), path)
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            _close(test, a, e, f"{path}[{i}]")
    elif isinstance(expected, dict):
        test.assertEqual(sorted(actual), sorted(expected), path)
        for k, v in expected.items():
            _close(test, actual[k], v, f"{path}.{k}")
    else:
        test.assertEqual(actual, expected, path)


class ProjectionParityTests(SimpleTestCase):
    """The SPA's lib/model-studio.test-side twin: studio-projection.test.ts
    runs these cases through the TypeScript."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.cases = json.loads(CASES.read_text())

    def test_ports(self):
        for c in self.cases["ports"]:
            _close(self, mp.image_ports_from_anchors(c["anchors"], c["index"], c["frame"]),
                   c["expected"])

    def test_leds(self):
        for c in self.cases["leds"]:
            src = {k.replace("|", "\u0000"): v for k, v in c["sources"].items()}
            _close(self, mp.image_leds_from_boxes(c["boxes"], src, c["frame"], c["depth"]),
                   c["expected"])

    def test_port_box_kind(self):
        for kind, type_, want in self.cases["port_box_kind"]:
            self.assertEqual(mp.port_box_kind(kind, type_), want, f"{kind} {type_}")

    def test_fit(self):
        for c in self.cases["fit"]:
            f = mp.Fit(c["box"], c["up"], c["front"], c["fit"], c["target"])
            _close(self, [f.point(p) for p in c["points"]], c["expected_points"])
            _close(self, [f.direction(d) for d in c["dirs"]], c["expected_dirs"])

    def test_round5_is_half_up_like_javascript(self):
        self.assertEqual(mp.round5(0.000025), 0.00003)
        self.assertEqual(mp.round5(-0.000025), -0.00002)


def _img(size, fmt="WEBP") -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (30, 30, 30, 0)).save(buf, fmt)
    return buf.getvalue()


FACE = (2000, 184)   # 1U, 19 inch: round(2000 * 44.45 / 482.6)
ISO = (1600, 1200)


class _Pack(_Base):
    DEVICE = """
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
  leds:
    SYS: { source: device.status }
    "port:*": { source: interface.oper_status }
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
  leds:
    STATUS: { source: module.status }
"""

    def setUp(self):
        super().setUp()
        self.pack = tempfile.mkdtemp()
        self.glb = chassis()
        self._write("models/Acme/X1.glb", self.glb)
        self._write("models/Acme/NM-9.glb", module_glb())
        self._write("pack.yaml", b"name: Acme test\nversion: 1.1.0\n")
        self._write("module-types/Acme/NM-9.yaml", self.MODULE.encode())
        self._write("models/Acme/X1.front.webp", _img(FACE))
        self._write("models/Acme/X1.rear.webp", _img(FACE))
        self._write("models/Acme/X1.iso.webp", _img(ISO))
        self.renders()

    def tearDown(self):
        shutil.rmtree(self.pack, ignore_errors=True)
        super().tearDown()

    def _write(self, rel, data: bytes):
        path = os.path.join(self.pack, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)

    def renders(self, sha=None, modules=None, **paths):
        sha = hashlib.sha256(self.glb).hexdigest() if sha is None else sha
        lines = ["  renders:"]
        for face in ("front", "rear", "iso"):
            p = paths.get(face, f"models/Acme/X1.{face}.webp")
            if p:
                lines.append(f"    {face}: {p}")
        if sha:
            lines.append(f"    model_sha256: {sha}")
        mods = {"FAN 1": "NM-9"} if modules is None else modules
        if mods:
            lines.append("    modules:")
            lines += [f"      {b}: {pn}" for b, pn in mods.items()]
        self._write("device-types/Acme/X1.yaml",
                    (self.DEVICE + "\n".join(lines) + "\n").encode())

    def run_import(self, *extra) -> str:
        out = io.StringIO()
        call_command("import_model_pack", self.pack, "--tenant", "t", *extra, stdout=out)
        return out.getvalue()

    def dt_x1(self) -> DeviceType:
        return DeviceType.objects.get(tenant=self.tenant, part_number="X1")


class RenderImportTests(_Pack):
    def test_renders_become_the_faces_with_ports_and_leds(self):
        out = self.run_import("--apply")
        self.assertIn("renders: front, rear, iso imported.", out)
        self.assertIn("reference modules: 1 set from the pack.", out)
        dt = self.dt_x1()
        nm = ModuleType.objects.get(tenant=self.tenant, part_number="NM-9")
        self.assertEqual(dt.model_reference, {"FAN 1": str(nm.id)})
        self.assertEqual({k: dt.images_generated[k] for k in model_studio.FACES},
                         dict.fromkeys(model_studio.FACES, "pack"))
        self.assertEqual(dt.images_generated["image_ports"], "pack")
        self.assertEqual(dt.images_generated["image_leds"], "pack")
        self.assertEqual(dt.pack_import["pack"], {"name": "Acme test", "version": "1.1.0"})
        meta = dt.pack_import["images"]
        self.assertEqual(meta["model_sha256"], hashlib.sha256(self.glb).hexdigest())
        self.assertEqual(meta["modules"], {"FAN 1": "NM-9"})
        self.assertFalse(meta["stale"])
        with dt.front_image.open("rb") as fh:
            self.assertEqual(Image.open(fh).size, FACE)
        # Ports: the chassis' two on the front, the module's (named for
        # FAN 1, position 1) on the rear, where its bay turns it.
        front = {m["name"]: m for m in dt.image_ports["front"]}
        rear = {m["name"]: m for m in dt.image_ports["rear"]}
        self.assertEqual(set(front), {"Te1/0/1", "Te1/0/2"})
        self.assertEqual(set(rear), {"Te1/1/1"})
        # Room +X is on the left of the front: glTF x = -0.2 turns to +0.2.
        self.assertAlmostEqual(front["Te1/0/1"]["x"], (0.2413 - 0.2) / 0.4826, places=4)
        self.assertAlmostEqual(front["Te1/0/1"]["y"], (0.04445 - 0.03) / 0.04445, places=4)
        self.assertEqual(dt.image_ports["view"]["front"]["cal"]["span_mm"], 482.6)
        leds = {(m.get("bay"), m["name"]): m for s in ("front", "rear")
                for m in dt.image_leds[s]}
        self.assertEqual(leds[(None, "SYS")]["source"], "device.status")
        self.assertEqual(leds[(None, "port:Te1/0/1")]["source"], "interface.oper_status")
        self.assertIn(leds[("FAN 1", "STATUS")], dt.image_leds["rear"])
        self.assertEqual(leds[("FAN 1", "STATUS")]["source"], "module.status")
        self.assertFalse(model_studio.pending(dt))
        src = model_studio.images_source(dt)
        self.assertEqual(src["front"], "pack")
        self.assertEqual(src["pack"]["name"], "Acme test")
        self.assertTrue(src["pack"]["current"])

    def test_dry_run_stores_nothing(self):
        out = self.run_import()
        self.assertIn("renders: front, rear, iso imported.", out)
        self.assertFalse(DeviceType.objects.filter(part_number="X1").exists())
        stored = [f for _r, _d, fs in os.walk(self.media) for f in fs]
        self.assertEqual(stored, [])

    def test_wrong_size_is_skipped(self):
        self._write("models/Acme/X1.rear.webp", _img((2000, 200)))
        out = self.run_import("--apply")
        self.assertIn("renders.rear: models/Acme/X1.rear.webp is 2000 × 200 px; the type's "
                      "face frame needs 2000 × 184 - skipped.", out)
        dt = self.dt_x1()
        self.assertTrue(dt.front_image and dt.iso_image)
        self.assertFalse(dt.rear_image)
        # No rear face: the type still offers to generate one.
        self.assertTrue(model_studio.pending(dt))

    def test_png_is_accepted_and_jpeg_refused(self):
        self._write("models/Acme/X1.front.png", _img(FACE, "PNG"))
        self._write("models/Acme/X1.iso.jpg", self._jpeg())
        self.renders(front="models/Acme/X1.front.png", iso="models/Acme/X1.iso.jpg")
        out = self.run_import("--apply")
        self.assertIn("renders.iso: models/Acme/X1.iso.jpg is not a WebP or PNG - skipped.",
                      out)
        dt = self.dt_x1()
        self.assertTrue(dt.front_image.name.endswith(".png"))
        self.assertFalse(dt.iso_image)

    def _jpeg(self):
        buf = io.BytesIO()
        Image.new("RGB", ISO).save(buf, "JPEG")
        return buf.getvalue()

    def test_missing_file_is_noted(self):
        self.renders(iso="models/Acme/nope.webp")
        out = self.run_import("--apply")
        self.assertIn("renders.iso: models/Acme/nope.webp is not in the pack - skipped.", out)
        self.assertTrue(self.dt_x1().front_image)

    def test_sha_mismatch_imports_them_out_of_date(self):
        self.renders(sha="ab" * 32)
        out = self.run_import("--apply")
        self.assertIn("another model file than the pack ships. Imported, marked out of date.",
                      out)
        dt = self.dt_x1()
        self.assertTrue(dt.front_image)
        self.assertTrue(dt.pack_import["images"]["stale"])
        self.assertTrue(model_studio.pending(dt))
        self.assertFalse(model_studio.images_source(dt)["pack"]["current"])
        self.assertIn("another model file", model_studio.images_source(dt)["pack"]["note"])

    def test_sha_read_as_a_yaml_number_is_out_of_date(self):
        self.renders(sha="1" * 64)
        out = self.run_import("--apply")
        self.assertIn("marked out of date", out)
        self.assertTrue(self.dt_x1().pack_import["images"]["stale"])

    def test_a_module_may_be_named_by_its_model(self):
        # A module type without a part number is named by its model.
        self._write("module-types/Acme/NM-9.yaml", self.MODULE.replace(
            "part_number: NM-9\n", "").replace("model: NM-9", "model: Fan Nine").encode())
        self.renders(modules={"FAN 1": "Fan Nine"})
        out = self.run_import("--apply")
        self.assertNotIn("renders.modules.FAN 1", out)
        self.assertEqual(list(self.dt_x1().model_reference), ["FAN 1"])

    def test_unknown_module_is_noted_and_the_photos_kept(self):
        self.renders(modules={"FAN 1": "NM-9", "PS-0": "PWR-C4-950WAC-R"})
        out = self.run_import("--apply")
        self.assertIn("renders.modules.PS-0: no module type PWR-C4-950WAC-R.", out)
        dt = self.dt_x1()
        self.assertTrue(dt.front_image and dt.rear_image)
        self.assertEqual(list(dt.model_reference), ["FAN 1"])
        # The renders show a module Danbyte can't draw: out of date.
        self.assertTrue(model_studio.pending(dt))


class ProvenanceTests(_Pack):
    def _existing(self):
        """X1 already in the tenant, its front photo uploaded by hand."""
        self.run_import("--apply")
        dt = self.dt_x1()
        r = self.client.post(f"/api/device-types/{dt.id}/images/",
                             {"front_image": _file("hand", "PNG")}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        dt.refresh_from_db()
        self.assertEqual(model_studio.sources(dt)["front"], "uploaded")
        return dt

    def test_hand_made_face_is_kept_without_the_flag(self):
        dt = self._existing()
        hand = dt.front_image.name
        markers = dt.image_ports
        out = self.run_import("--apply")
        self.assertIn("renders: kept the front photo uploaded by hand (--replace-photos "
                      "replaces them).", out)
        dt.refresh_from_db()
        self.assertEqual(dt.front_image.name, hand)
        self.assertEqual(model_studio.sources(dt),
                         {"front": "uploaded", "rear": "pack", "iso": "pack"})
        # Markers aren't placed again while the front is hand-made.
        self.assertNotIn("ports: ", out)
        self.assertEqual([dt.image_ports["front"], dt.image_ports["rear"]],
                         [markers["front"], markers["rear"]])

    def test_replace_photos_replaces_it(self):
        dt = self._existing()
        hand = dt.front_image.name
        self.run_import("--apply", "--replace-photos")
        dt.refresh_from_db()
        self.assertNotEqual(dt.front_image.name, hand)
        self.assertEqual(model_studio.sources(dt)["front"], "pack")
        self.assertEqual(dt.images_generated["image_ports"], "pack")

    def test_pack_replaces_browser_renders_and_browser_replaces_pack(self):
        self.run_import("--apply")
        dt = self.dt_x1()
        url = f"/api/device-types/{dt.id}/studio/"
        payload = self.client.get(url).json()
        self.assertEqual(payload["hand_made"], [])
        self.assertEqual(payload["sources"]["front"], "pack")
        files = {f"{f}_image": _file(f) for f in model_studio.FACES}
        r = self.client.post(url, {"token": payload["token"], "overwrite": "", **files},
                             format="multipart")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["kept"], [])
        dt.refresh_from_db()
        self.assertEqual(model_studio.sources(dt)["front"], "generated")
        self.assertEqual(r.json()["device_type"]["images_source"]["front"], "generated")
        self.run_import("--apply")
        dt.refresh_from_db()
        self.assertEqual(set(model_studio.sources(dt).values()), {"pack"})

    def test_reference_set_by_hand_is_kept(self):
        self.run_import("--apply")
        dt = self.dt_x1()
        r = self.client.patch(f"/api/device-types/{dt.id}/", {"model_reference": None},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        dt.refresh_from_db()
        self.assertTrue(model_studio.pending(dt))  # the renders show a module
        # Set by hand to "covers": a later import leaves it.
        mine = {"PS-0": str(ModuleType.objects.get(part_number="NM-9").id)}
        r = self.client.patch(f"/api/device-types/{dt.id}/", {"model_reference": mine},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        out = self.run_import("--apply")
        self.assertIn("reference modules: set by hand - kept", out)
        dt.refresh_from_db()
        self.assertEqual(dt.model_reference, mine)
        self.assertTrue(model_studio.pending(dt))

    def test_reference_the_pack_set_follows_the_pack(self):
        self.run_import("--apply")
        self.renders(modules={})
        self.renders(modules={"PS-0": "NM-9"})
        self.run_import("--apply")
        dt = self.dt_x1()
        self.assertEqual(list(dt.model_reference), ["PS-0"])
        self.assertFalse(model_studio.pending(dt))

    def test_new_model_makes_pack_photos_pending(self):
        self.run_import("--apply")
        dt = self.dt_x1()
        self.assertFalse(model_studio.pending(dt))
        r = self._upload(f"/api/device-types/{dt.id}/model/", chassis())
        self.assertEqual(r.status_code, 200)
        dt.refresh_from_db()
        self.assertTrue(model_studio.pending(dt))
        self.assertFalse(model_studio.images_source(dt)["pack"]["current"])

    def test_detail_read_shows_the_source(self):
        self.run_import("--apply")
        dt = self.dt_x1()
        d = self.client.get(f"/api/device-types/{dt.id}/").json()
        self.assertEqual(d["images_source"]["front"], "pack")
        self.assertEqual(d["images_source"]["pack"]["version"], "1.1.0")
        self.assertFalse(d["images_pending"])
        rows = self.client.get("/api/device-types/").json()
        rows = rows.get("results", rows)
        self.assertIsNone(next(x for x in rows if x["id"] == str(dt.id))["images_source"])

    def test_studio_read_still_needs_view(self):
        self.run_import("--apply")
        dt = self.dt_x1()
        user = User.objects.create_user("v", "v@x", "x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="v", object_types=["devicetype"],
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        r = self.client.get(f"/api/device-types/{dt.id}/studio/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["sources"]["front"], "pack")
        r = self.client.post(f"/api/device-types/{dt.id}/studio/", {}, format="multipart")
        self.assertEqual(r.status_code, 403)

    def test_other_tenant_module_types_are_not_used(self):
        self.renders(modules={"FAN 1": "NM-X"})
        other_mfr = Manufacturer.objects.create(tenant=self.other, name="Acme", slug="acme")
        ModuleType.objects.create(tenant=self.other, name="NM-X", part_number="NM-X",
                                  manufacturer=other_mfr)
        out = self.run_import("--apply")
        self.assertIn("renders.modules.FAN 1: no module type NM-X.", out)
        self.assertIsNone(self.dt_x1().model_reference)


class MatchHandMadeTypeTests(TestCase):
    """A pack matches a type made by hand without a part number, rather than
    creating a second one and hitting the name clash."""

    def setUp(self):
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="O", slug="o-match")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t-match")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")

    def test_blank_part_number_type_named_after_the_model_matches(self):
        from api.model_pack import _match

        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr,
                                       name="Catalyst 9300-48P", model="C9300-48P")
        hit, why = _match(DeviceType, self.tenant, {
            "manufacturer": "Cisco", "model": "Catalyst 9300-48P", "part_number": "C9300-48P"})
        self.assertEqual(hit, dt)
        self.assertIsNone(why)

    def test_a_typed_part_number_still_wins(self):
        from api.model_pack import _match

        DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr,
                                  name="Catalyst 9300-48P", model="C9300-48P")
        real = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr,
                                         name="C9300-48P (library)", model="C9300-48P-lib",
                                         part_number="C9300-48P")
        hit, _ = _match(DeviceType, self.tenant, {
            "manufacturer": "Cisco", "model": "Catalyst 9300-48P", "part_number": "C9300-48P"})
        self.assertEqual(hit, real)
