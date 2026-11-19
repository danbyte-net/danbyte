"""Model pack bundles and requires (api.model_pack_bundle, the bundle and
requires paths of api.model_pack_install, the management commands): bundle
detection and refusals, per-pack check sections, partial installs, per-pack
records with their bundle, re-installs, a tenant with a pack from before the
library was split, required packs and their fetch from the pack catalog."""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
import zipfile
from unittest import mock

import yaml
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import SimpleTestCase, override_settings

from audit.models import ChangeLogEntry

from . import model_pack
from .model_pack import PackFiles, PackRefused
from .model_pack_bundle import check_sections, read_bundle
from .models import DeviceType, ModelPack, ModuleType
from .tests_model_anchors import model
from .tests_model_pack_install import (
    MODULE,
    PackDir,
    _AppBase,
    _inline,
    _Resp,
    module_nodes,
)

MODS = """\
name: Acme modules
id: acme-mods
version: {version}
license: CC-BY-4.0
author: Tester
requires: {requires}
types:
  module: [NM-7]
"""


class ModPack:
    """A module-only pack (NM-7), checked clean."""

    def __init__(self, version="1.1.0", requires=(), pid="acme-mods"):
        self.root = tempfile.mkdtemp()
        self.write("pack.yaml", MODS.format(version=version, requires=json.dumps(list(requires)))
                   .replace("id: acme-mods", f"id: {pid}"))
        self.write("module-types/Acme/NM-7.yaml", MODULE.replace("NM-9", "NM-7"))
        self.write("models/Acme/NM-7.glb", model(module_nodes()))

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data.encode() if isinstance(data, str) else data)

    def zip_bytes(self, top="acme-mods-1.1.0") -> bytes:
        return _zip_dir(self.root, top)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def _zip_dir(root, top) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _dirs, files in os.walk(root):
            for f in sorted(files):
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                zf.write(full, f"{top}/{rel}")
    return buf.getvalue()


def bundle_zip(packs: dict, *, listed=None, top="acme-bundle-1.0.0", version="1.0.0",
               extra=()) -> bytes:
    """A bundle zip: ``packs`` maps pack id → pack folder; ``listed`` the
    bundle.yaml packs (default: all, in order, at 1.1.0)."""
    rows = listed if listed is not None else [
        {"id": pid, "name": pid, "version": "1.1.0"} for pid in packs]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{top}/bundle.yaml", yaml.safe_dump(
            {"id": "acme-bundle", "name": "Acme bundle", "version": version,
             "description": "Both.", "packs": rows}, sort_keys=False))
        for pid, root in packs.items():
            for dirpath, _dirs, files in os.walk(root):
                for f in sorted(files):
                    full = os.path.join(dirpath, f)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    zf.write(full, f"{top}/packs/{pid}/{rel}")
        for name, data in extra:
            zf.writestr(name, data)
    return buf.getvalue()


def _open(data: bytes) -> tuple[PackFiles, str]:
    d = tempfile.mkdtemp()
    path = os.path.join(d, "b.zip")
    with open(path, "wb") as fh:
        fh.write(data)
    return PackFiles(path), d


# ── reading a bundle ────────────────────────────────────────────────────────

class BundleReadTests(SimpleTestCase):
    def setUp(self):
        self.a = PackDir()
        self.m = ModPack(requires=["acme-test"])

    def tearDown(self):
        self.a.cleanup()
        self.m.cleanup()

    def sections(self, data):
        files, d = _open(data)
        try:
            self.assertTrue(files.is_bundle)
            bundle = read_bundle(files)
            return bundle, check_sections(files, bundle)
        finally:
            files.close()
            shutil.rmtree(d, ignore_errors=True)

    def test_a_bundle_is_detected_and_checked_pack_by_pack(self):
        bundle, secs = self.sections(bundle_zip({"acme-test": self.a.root,
                                                 "acme-mods": self.m.root}))
        self.assertEqual(bundle.meta["id"], "acme-bundle")
        self.assertEqual(bundle.problems, [])
        self.assertEqual([s.id for s in secs], ["acme-test", "acme-mods"])
        self.assertTrue(all(s.report.ok for s in secs), [s.report.findings for s in secs])
        self.assertEqual(secs[1].report.pack["requires"], ["acme-test"])
        self.assertEqual(secs[0].name, "Acme test")

    def test_a_pack_is_not_a_bundle(self):
        files, d = _open(self.a.zip_bytes())
        try:
            self.assertFalse(files.is_bundle)
        finally:
            files.close()
            shutil.rmtree(d, ignore_errors=True)

    def test_a_bundle_folder(self):
        root = tempfile.mkdtemp()
        try:
            with zipfile.ZipFile(io.BytesIO(bundle_zip({"acme-mods": self.m.root}))) as zf:
                zf.extractall(root)
            files = PackFiles(os.path.join(root, "acme-bundle-1.0.0"))
            self.assertTrue(files.is_bundle)
            secs = check_sections(files, read_bundle(files))
            self.assertTrue(secs[0].report.ok, secs[0].report.findings)
            with self.assertRaises(FileNotFoundError):
                PackFiles.nested(files, "packs/../..")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_listed_but_missing_unlisted_and_mismatched(self):
        data = bundle_zip({"acme-test": self.a.root, "acme-mods": self.m.root}, listed=[
            {"id": "acme-test", "version": "9.9.9"},
            {"id": "ghost", "version": "1.1.0"},
            {"id": "../evil"},
        ])
        bundle, secs = self.sections(data)
        msgs = [p["message"] for p in bundle.problems]
        self.assertIn("bundle.yaml lists ghost; the bundle has no packs/ghost/.", msgs)
        self.assertIn("packs/acme-mods/ is not in bundle.yaml - not installed.", msgs)
        self.assertTrue(any("'../evil' is not a pack id" in m for m in msgs))
        self.assertTrue(any("version is 1.1.0; bundle.yaml says 9.9.9" in m for m in msgs))
        self.assertEqual([s.id for s in secs], ["acme-test", "ghost"])
        self.assertFalse(secs[0].report.ok)
        self.assertFalse(secs[1].report.ok)
        self.assertIsNone(secs[1].files)

    def test_an_id_mismatch(self):
        _, secs = self.sections(bundle_zip({"other-id": self.m.root}))
        self.assertTrue(any("pack.yaml id is acme-mods" in f.message
                            for f in secs[0].report.findings))

    def test_traversal_inside_a_nested_pack_refuses_the_whole_bundle(self):
        data = bundle_zip({"acme-mods": self.m.root}, extra=[
            ("acme-bundle-1.0.0/packs/acme-mods/../../../evil.yaml", "x")])
        with self.assertRaises(PackRefused) as cm:
            _open(data)
        self.assertTrue(any("leaves the pack" in m for m in cm.exception.messages))

    def test_the_ceilings_are_the_whole_bundles(self):
        data = bundle_zip({"acme-test": self.a.root, "acme-mods": self.m.root})
        with mock.patch.object(model_pack, "MAX_PACK_FILES", 5):
            with self.assertRaises(PackRefused) as cm:
                _open(data)
        self.assertIn("a pack may hold 5", cm.exception.messages[0])
        with mock.patch.object(model_pack, "MAX_UNPACKED_BYTES", 1000):
            with self.assertRaises(PackRefused) as cm:
                _open(data)
        self.assertTrue(any("unpacks to" in m for m in cm.exception.messages))

    def test_a_bad_requires_list_warns(self):
        self.m.write("pack.yaml", MODS.format(version="1.1.0", requires='["UPPER", "ok-1"]'))
        _, secs = self.sections(bundle_zip({"acme-mods": self.m.root}))
        self.assertEqual(secs[0].report.pack["requires"], ["ok-1"])
        self.assertTrue(secs[0].report.ok)
        self.assertTrue(any("UPPER not a pack id" in f.message for f in secs[0].report.findings))


# ── the app ─────────────────────────────────────────────────────────────────

class _BundleBase(_AppBase):
    def setUp(self):
        super().setUp()
        self.m = ModPack(requires=["acme-test"])

    def tearDown(self):
        self.m.cleanup()
        super().tearDown()

    def bundle(self, **kw):
        packs = kw.pop("packs", None) or {"acme-test": self.p.root, "acme-mods": self.m.root}
        return self.checked(data=bundle_zip(packs, **kw), name="acme-bundle-1.0.0.zip")


class BundleInstallTests(_BundleBase):
    def test_the_check_has_a_section_per_pack(self):
        run = self.bundle()
        self.assertEqual(run.status, "checked", run.error)
        self.assertEqual((run.kind, run.slug, run.name, run.version),
                         ("bundle", "acme-bundle", "Acme bundle", "1.0.0"))
        secs = run.report["packs"]
        self.assertEqual([s["id"] for s in secs], ["acme-test", "acme-mods"])
        self.assertEqual([s["status"] for s in secs], ["ready", "ready"])
        self.assertEqual(secs[0]["import"]["created"], 2)
        self.assertEqual(secs[1]["needs"], [{"id": "acme-test", "state": "bundle",
                                             "installed": None}])
        self.assertEqual(secs[1]["description"], "")
        self.assertIn({"path": "pack.yaml", "size": mock.ANY}, secs[1]["files"])
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())
        r = self.client.get(f"/api/model-packs/{run.pk}/").json()
        self.assertTrue(r["installable"])
        self.assertEqual((r["kind"], r["types"], r["check_errors"]), ("bundle", 3, 0))

    def test_install_records_each_pack_with_its_bundle_and_cause(self):
        run = self.bundle()
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        r = self.install(run.pk)
        self.assertEqual(r.status_code, 202, r.content)
        run.refresh_from_db()
        self.assertEqual(run.status, "installed", run.error)
        self.assertEqual([(o["id"], o["status"]) for o in run.result["packs"]],
                         [("acme-test", "installed"), ("acme-mods", "installed")])
        recs = ModelPack.objects.filter(tenant=self.tenant, kind="pack", status="installed")
        self.assertEqual(sorted(recs.values_list("slug", flat=True)), ["acme-mods", "acme-test"])
        mods = recs.get(slug="acme-mods")
        self.assertEqual((mods.bundle_id, mods.bundle_slug, mods.bundle_name,
                          mods.bundle_version), (run.pk, "acme-bundle", "Acme bundle", "1.0.0"))
        self.assertEqual((mods.name, mods.version, mods.requires),
                         ("Acme modules", "1.1.0", ["acme-test"]))
        self.assertEqual(mods.result["created"], 1)
        new = ChangeLogEntry.objects.exclude(id__in=before)
        nm7 = ModuleType.objects.get(tenant=self.tenant, part_number="NM-7")
        x1 = DeviceType.objects.get(tenant=self.tenant, part_number="X1")
        self.assertEqual({e.cause for e in new.filter(object_id=str(nm7.pk))},
                         {"Pack import: Acme modules 1.1.0"})
        self.assertEqual({e.cause for e in new.filter(object_id=str(x1.pk))},
                         {"Pack import: Acme test 1.1.0"})
        self.assertEqual(nm7.pack_state["pack"],
                         {"id": "acme-mods", "name": "Acme modules", "version": "1.1.0"})
        self.assertFalse(os.path.exists(os.path.join(self.media, "model-packs",
                                                     f"{run.pk}.zip")))
        rows = self.client.get("/api/model-packs/?status=installed&kind=pack").json()["results"]
        self.assertEqual({r["bundle"]["name"] for r in rows}, {"Acme bundle"})
        self.assertEqual({r["bundle"]["id"] for r in rows}, {str(run.pk)})
        self.assertEqual(self.client.get("/api/model-packs/?kind=nope").status_code, 400)

    def test_a_pack_with_check_errors_is_skipped_the_others_install(self):
        self.p.device(sha="ab" * 32)
        run = self.bundle()
        secs = {s["id"]: s for s in run.report["packs"]}
        self.assertEqual(secs["acme-test"]["status"], "errors")
        self.assertTrue(run.report and self.client.get(
            f"/api/model-packs/{run.pk}/").json()["installable"])
        self.install(run.pk)
        run.refresh_from_db()
        self.assertEqual(run.status, "installed", run.error)
        out = {o["id"]: o for o in run.result["packs"]}
        self.assertEqual(out["acme-test"]["status"], "skipped")
        self.assertIn("check error", out["acme-test"]["reason"])
        self.assertEqual(out["acme-mods"]["status"], "installed")
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())
        self.assertTrue(ModuleType.objects.filter(tenant=self.tenant, part_number="NM-7")
                        .exists())

    def test_picking_packs(self):
        run = self.bundle()
        self.assertEqual(self.install(run.pk, packs=["nope"]).status_code, 400)
        self.assertEqual(self.install(run.pk, packs="acme-mods").status_code, 400)
        self.assertEqual(self.install(run.pk, packs=[]).status_code, 409)
        self.install(run.pk, packs=["acme-mods"])
        run.refresh_from_db()
        self.assertEqual([(o["id"], o["status"]) for o in run.result["packs"]],
                         [("acme-test", "skipped"), ("acme-mods", "installed")])
        self.assertFalse(ModelPack.objects.filter(slug="acme-test", kind="pack").exists())

    def test_a_failing_pack_does_not_undo_the_others(self):
        run = self.bundle()
        real = model_pack.import_pack

        def boom(tenant, files, **kw):
            if "Acme modules" in kw.get("label", ""):
                raise RuntimeError("disk full")
            return real(tenant, files, **kw)

        with mock.patch("api.model_pack.import_pack", side_effect=boom):
            self.install(run.pk)
        run.refresh_from_db()
        out = {o["id"]: o for o in run.result["packs"]}
        self.assertEqual((out["acme-test"]["status"], out["acme-mods"]["status"]),
                         ("installed", "failed"))
        self.assertTrue(DeviceType.objects.filter(tenant=self.tenant).exists())
        self.assertFalse(ModuleType.objects.filter(part_number="NM-7").exists())

    def test_reinstalling_the_bundle_updates_the_same_records(self):
        first = self.bundle()
        self.install(first.pk)
        ids = dict(ModelPack.objects.filter(kind="pack").values_list("slug", "pk"))
        second = self.bundle()
        secs = {s["id"]: s for s in second.report["packs"]}
        self.assertEqual(secs["acme-mods"]["status"], "installed")
        self.assertEqual(second.report["installed"]["version"], "1.0.0")
        self.install(second.pk)
        second.refresh_from_db()
        self.assertEqual(second.status, "installed", second.error)
        self.assertEqual(dict(ModelPack.objects.filter(kind="pack").values_list("slug", "pk")),
                         ids)
        self.assertEqual(set(ModelPack.objects.filter(kind="pack").values_list(
            "bundle_id", flat=True)), {second.pk})
        first.refresh_from_db()
        self.assertEqual(first.status, "replaced")
        self.assertEqual(DeviceType.objects.filter(tenant=self.tenant).count(), 1)
        self.assertEqual(ModuleType.objects.filter(tenant=self.tenant).count(), 2)

    def test_a_new_version_in_a_bundle_replaces_the_old_record(self):
        self.install(self.bundle().pk)
        old = ModelPack.objects.get(kind="pack", slug="acme-mods")
        self.m.write("pack.yaml", MODS.format(version="1.2.0", requires="[acme-test]"))
        run = self.bundle(listed=[{"id": "acme-test", "version": "1.1.0"},
                                  {"id": "acme-mods", "version": "1.2.0"}])
        self.assertEqual({s["id"]: s["status"] for s in run.report["packs"]},
                         {"acme-test": "installed", "acme-mods": "update"})
        self.install(run.pk)
        old.refresh_from_db()
        self.assertEqual(old.status, "replaced")
        new = ModelPack.objects.get(kind="pack", slug="acme-mods", status="installed")
        self.assertEqual(new.version, "1.2.0")

    def test_forgetting_the_bundle_keeps_its_packs(self):
        run = self.bundle()
        self.install(run.pk)
        self.assertEqual(self.client.delete(f"/api/model-packs/{run.pk}/").status_code, 204)
        rec = ModelPack.objects.get(kind="pack", slug="acme-mods")
        self.assertIsNone(rec.bundle_id)
        self.assertEqual(rec.bundle_name, "Acme bundle")
        r = self.client.get(f"/api/model-packs/{rec.pk}/").json()
        self.assertEqual(r["bundle"], {"id": None, "slug": "acme-bundle", "name": "Acme bundle",
                                       "version": "1.0.0"})

    def test_a_bundle_with_problems_still_checks(self):
        run = self.bundle(listed=[{"id": "acme-mods", "version": "1.1.0"},
                                  {"id": "ghost", "version": "1.0"}])
        self.assertEqual(run.status, "checked", run.error)
        self.assertEqual([s["status"] for s in run.report["packs"]], ["ready", "errors"])
        self.assertTrue(any("ghost" in p["message"] for p in run.report["problems"]))
        r = self.client.get(f"/api/model-packs/{run.pk}/").json()
        self.assertGreaterEqual(r["check_errors"], 2)


class LegacyPackTests(_BundleBase):
    """A tenant that installed one pack holding everything, before the
    library was split into packs and bundles."""

    def test_the_split_packs_take_over_and_the_old_record_is_replaced(self):
        legacy = PackDir()
        try:
            legacy.write("module-types/Acme/NM-7.yaml", MODULE.replace("NM-9", "NM-7"))
            legacy.write("models/Acme/NM-7.glb", model(module_nodes()))
            legacy.write("pack.yaml", """\
name: Acme everything
id: acme-all
version: 1.0.0
license: CC-BY-4.0
author: Tester
types:
  device: [X1]
  module: [NM-9, NM-7]
""")
            old = self.checked(data=legacy.zip_bytes())
            self.assertTrue(old.report["check"]["ok"], old.report["check"]["findings"])
            self.install(old.pk)
            old.refresh_from_db()
            self.assertEqual(old.status, "installed", old.error)
        finally:
            legacy.cleanup()
        # Types imported before the pack link carried the pack's id.
        for t in [*DeviceType.objects.all(), *ModuleType.objects.all()]:
            t.pack_state["pack"].pop("id")
            t.save(update_fields=["pack_state"])
        types_before = set(DeviceType.objects.values_list("pk", flat=True)) | set(
            ModuleType.objects.values_list("pk", flat=True))
        run = self.bundle()
        secs = {s["id"]: s for s in run.report["packs"]}
        self.assertEqual(secs["acme-test"]["import"]["matched"], 2)
        self.assertEqual(secs["acme-mods"]["import"]["matched"], 1)
        self.install(run.pk, packs=["acme-mods"])
        old.refresh_from_db()
        # Only part of what it holds is carried elsewhere: it stays.
        self.assertEqual(old.status, "installed")
        nm7 = ModuleType.objects.get(part_number="NM-7")
        self.assertEqual(nm7.pack_state["pack"]["id"], "acme-mods")
        run = self.bundle()
        self.install(run.pk)
        run.refresh_from_db()
        old.refresh_from_db()
        self.assertEqual(old.status, "replaced")
        out = {o["id"]: o for o in run.result["packs"]}
        self.assertEqual(out["acme-test"]["superseded"], ["Acme everything 1.0.0"])
        types_after = set(DeviceType.objects.values_list("pk", flat=True)) | set(
            ModuleType.objects.values_list("pk", flat=True))
        self.assertEqual(types_before, types_after)
        x1 = DeviceType.objects.get(part_number="X1")
        self.assertEqual(x1.pack_state["pack"]["id"], "acme-test")


# ── requires ────────────────────────────────────────────────────────────────

CATALOG = "https://packs.example.com/releases/packs.json"


def _catalog(rows) -> bytes:
    return json.dumps({"format": "danbyte-library/catalog/v1", "generated": "2026-11-19",
                       "packs": rows}).encode()


def _row(pid, file, sha="", version="1.1.0"):
    return {"id": pid, "name": pid, "version": version, "license": "x", "author": "x",
            "counts": {}, "file": file, "size": 1, "sha256": sha, "description": "",
            "requires": [], "kind": "pack", "includes": []}


@override_settings(MODEL_PACK_SOURCE_URL="https://packs.example.com/releases/",
                   MODEL_PACK_ALLOWED_HOSTS=[], MODEL_PACK_REDIRECT_HOSTS=[])
class RequiresTests(_BundleBase):
    def upload_mods(self, responses=()):
        f = SimpleUploadedFile("acme-mods.zip", self.m.zip_bytes())
        with _inline(), mock.patch("core.ssrf.safe_get", side_effect=list(responses)) as g:
            r = self.client.post("/api/model-packs/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, 202, r.content)
        return ModelPack.objects.get(pk=r.json()["id"]), g

    def test_missing_is_a_warning_naming_the_zip(self):
        run, g = self.upload_mods()
        g.assert_not_called()
        self.assertTrue(run.report["check"]["ok"])
        self.assertEqual(run.report["needs"], [{"id": "acme-test", "state": "missing",
                                                "installed": None,
                                                "zip": "acme-test-1.1.0.zip"}])
        self.assertTrue(any("Needs acme-test" in f["message"]
                            for f in run.report["check"]["findings"]))
        self.assertEqual(self.install(run.pk).status_code, 202)
        run.refresh_from_db()
        self.assertEqual(run.status, "installed", run.error)

    def test_installed(self):
        self.install(self.checked().pk)
        run, _ = self.upload_mods()
        self.assertEqual(run.report["needs"], [{"id": "acme-test", "state": "installed",
                                                "installed": "1.1.0"}])
        self.assertEqual(run.report["check"]["warnings"], 0)

    @override_settings(MODEL_PACK_CATALOG_URL=CATALOG)
    def test_install_with_it_fetches_checks_and_installs_it_first(self):
        body = self.p.zip_bytes()
        sha = hashlib.sha256(body).hexdigest()
        run, _ = self.upload_mods([_Resp(200, _catalog([_row("acme-test",
                                                             "packs/acme-test-1.1.0.zip",
                                                             sha)]))])
        need = run.report["needs"][0]
        self.assertEqual(need["available"]["url"],
                         "https://packs.example.com/releases/packs/acme-test-1.1.0.zip")
        self.assertIn("the pack catalog offers it",
                      run.report["check"]["findings"][-1]["message"])
        self.assertEqual(self.install(run.pk, **{"with": ["other"]}).status_code, 400)
        with mock.patch("core.ssrf.safe_get", side_effect=[_Resp(200, body)]) as g:
            r = self.install(run.pk, **{"with": ["acme-test"]})
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(g.call_args_list[0].args[0], need["available"]["url"])
        run.refresh_from_db()
        self.assertEqual(run.status, "installed", run.error)
        self.assertEqual(run.result["requires"][0]["status"], "installed",
                         run.result["requires"])
        req = ModelPack.objects.get(kind="pack", slug="acme-test", status="installed")
        self.assertEqual((req.source, req.sha256), ("url", sha))
        self.assertTrue(DeviceType.objects.filter(tenant=self.tenant, part_number="X1").exists())
        self.assertEqual(ModelPack.objects.filter(status="installed").count(), 2)

    @override_settings(MODEL_PACK_CATALOG_URL=CATALOG)
    def test_a_checksum_mismatch_is_refused_and_the_pack_still_installs(self):
        run, _ = self.upload_mods([_Resp(200, _catalog([_row(
            "acme-test", "packs/acme-test-1.1.0.zip", "0" * 64)]))])
        with mock.patch("core.ssrf.safe_get", side_effect=[_Resp(200, self.p.zip_bytes())]):
            self.install(run.pk, **{"with": ["acme-test"]})
        run.refresh_from_db()
        self.assertEqual(run.status, "installed", run.error)
        self.assertEqual(run.result["requires"][0]["status"], "refused")
        self.assertIn("SHA-256", run.result["requires"][0]["reason"])
        self.assertFalse(DeviceType.objects.filter(tenant=self.tenant).exists())

    @override_settings(MODEL_PACK_CATALOG_URL=CATALOG)
    def test_a_zip_on_a_host_not_allowed_is_not_offered(self):
        run, g = self.upload_mods([_Resp(200, _catalog([_row(
            "acme-test", "https://evil.example.com/acme-test.zip")]))])
        self.assertEqual(g.call_count, 1)
        self.assertNotIn("available", run.report["needs"][0])
        self.assertEqual(self.install(run.pk, **{"with": ["acme-test"]}).status_code, 400)

    @override_settings(MODEL_PACK_CATALOG_URL="https://evil.example.com/packs.json")
    def test_a_catalog_on_a_host_not_allowed_is_not_read(self):
        run, g = self.upload_mods()
        g.assert_not_called()
        self.assertIn("Packs download only from", run.report["catalog_error"])
        self.assertEqual(run.report["needs"][0]["state"], "missing")

    @override_settings(MODEL_PACK_CATALOG_URL=CATALOG)
    def test_a_catalog_redirect_elsewhere_is_refused(self):
        run, g = self.upload_mods([_Resp(302, headers={"Location": "https://169.254.169.254/"})])
        self.assertEqual(g.call_count, 1)
        self.assertIn("catalog_error", run.report)

    @override_settings(MODEL_PACK_CATALOG_URL=CATALOG)
    def test_a_required_pack_redirected_elsewhere_is_refused(self):
        run, _ = self.upload_mods([_Resp(200, _catalog([_row(
            "acme-test", "packs/acme-test-1.1.0.zip")]))])
        with mock.patch("core.ssrf.safe_get", side_effect=[
                _Resp(302, headers={"Location": "https://evil.example.com/x.zip"})]) as g:
            self.install(run.pk, **{"with": ["acme-test"]})
        self.assertEqual(g.call_count, 1)
        run.refresh_from_db()
        self.assertEqual(run.result["requires"][0]["status"], "refused")
        self.assertEqual(run.status, "installed", run.error)


# ── rights and tenants ──────────────────────────────────────────────────────

class BundleRightsTests(_BundleBase):
    def test_a_viewer_cannot_install_a_bundle(self):
        run = self.bundle()
        self.login(self.user("viewer", ["devicetype"], ["view"]))
        self.assertEqual(self.client.get(f"/api/model-packs/{run.pk}/").status_code, 200)
        self.assertEqual(self.install(run.pk).status_code, 403)
        f = SimpleUploadedFile("b.zip", bundle_zip({"acme-mods": self.m.root}))
        with _inline():
            r = self.client.post("/api/model-packs/", {"file": f}, format="multipart")
        self.assertEqual(r.status_code, 403)

    def test_another_tenant_sees_nothing(self):
        run = self.bundle()
        self.install(run.pk)
        self.login(self.root, self.other)
        self.assertEqual(self.client.get("/api/model-packs/").json()["count"], 0)
        self.assertEqual(self.client.get(f"/api/model-packs/{run.pk}/").status_code, 404)
        rec = ModelPack.objects.get(kind="pack", slug="acme-mods")
        self.assertEqual(self.client.get(f"/api/model-packs/{rec.pk}/").status_code, 404)
        # Installing the same bundle there makes that tenant's own records.
        run2 = self.bundle()
        self.install(run2.pk)
        self.assertEqual(ModelPack.objects.filter(kind="pack", slug="acme-mods").count(), 2)
        self.assertEqual(ModuleType.objects.filter(part_number="NM-7").count(), 2)

    def test_the_job_rechecks_the_rights_per_pack(self):
        run = self.bundle()
        with mock.patch("api.model_pack_install.may_install", side_effect=[True, True, True, False]):
            self.install(run.pk)
        run.refresh_from_db()
        self.assertEqual([(o["id"], o["status"]) for o in run.result["packs"]],
                         [("acme-test", "installed"), ("acme-mods", "failed")])


# ── the commands ────────────────────────────────────────────────────────────

class BundleCommandTests(_BundleBase):
    def path(self, data):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "bundle.zip")
        with open(p, "wb") as fh:
            fh.write(data)
        return p

    def test_check_prints_a_section_per_pack(self):
        out = io.StringIO()
        call_command("check_model_pack", self.path(bundle_zip(
            {"acme-test": self.p.root, "acme-mods": self.m.root})), stdout=out)
        text = out.getvalue()
        self.assertIn("Acme bundle 1.0.0 (bundle of 2 packs)", text)
        self.assertIn("== acme-test", text)
        self.assertIn("== acme-mods", text)
        self.assertIn("Bundle: OK.", text)

    def test_check_fails_on_one_pack(self):
        self.p.device(sha="ab" * 32)
        out = io.StringIO()
        with self.assertRaises(SystemExit) as cm:
            call_command("check_model_pack", self.path(bundle_zip(
                {"acme-test": self.p.root, "acme-mods": self.m.root})), "--json", stdout=out)
        self.assertEqual(cm.exception.code, 1)
        doc = json.loads(out.getvalue())
        self.assertFalse(doc["ok"])
        self.assertEqual([(p["id"], p["report"]["ok"]) for p in doc["packs"]],
                         [("acme-test", False), ("acme-mods", True)])

    def test_import_dry_run_only_and_apply(self):
        path = self.path(bundle_zip({"acme-test": self.p.root, "acme-mods": self.m.root}))
        out = io.StringIO()
        call_command("import_model_pack", path, "--tenant", "t", stdout=out)
        self.assertIn("Acme bundle 1.0.0 (bundle)", out.getvalue())
        self.assertIn("needs acme-test: in this bundle", out.getvalue())
        self.assertFalse(DeviceType.objects.exists())
        out = io.StringIO()
        call_command("import_model_pack", path, "--tenant", "t", "--only", "acme-mods",
                     "--apply", stdout=out)
        self.assertIn("not picked - skipped.", out.getvalue())
        self.assertTrue(ModuleType.objects.filter(part_number="NM-7").exists())
        self.assertFalse(DeviceType.objects.exists())
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("import_model_pack", path, "--tenant", "t", "--only", "ghost")
        nm7 = ChangeLogEntry.objects.filter(
            object_id=str(ModuleType.objects.get(part_number="NM-7").pk))
        self.assertEqual({e.cause for e in nm7}, {"Pack import: Acme modules 1.1.0"})
