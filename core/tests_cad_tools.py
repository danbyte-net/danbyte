"""The DWG converter ships with every install.

LibreDWG's dwg2dxf is built static from the pinned release by one recipe
(deploy/cad/build-dwg2dxf.sh), which the image's ``cad-tools`` stage runs and
the release bundle exports into ``vendor/cad``. The installer and the upgrade
stage carry ``vendor/`` over whole, and settings fall back to
``vendor/cad/bin/dwg2dxf`` while DANBYTE_CAD_CONVERTER is unset, so DWG
floor-plan drawings work after a fresh install or an upgrade with no .env
edit, and an explicit setting keeps winning.
"""
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

import yaml
from django.conf import settings
from django.test import SimpleTestCase, override_settings

from api import cad_render
from core.tests_upgrade_scripts import Host, StageTestCase
from danbyte.settings import CAD_CONVERTER_BUNDLED, resolve_cad_converter

ROOT = Path(settings.BASE_DIR)
SCRIPT = ROOT / "deploy" / "cad" / "build-dwg2dxf.sh"
SCRIPTS = ROOT / "scripts"


def _put_converter(top: Path, body: str = "#!/bin/sh\necho dwg2dxf 0.14\n") -> Path:
    """A stand-in for the bundle's vendor/cad: dwg2dxf, licence, NOTICE."""
    cad = top / "vendor" / "cad"
    (cad / "bin").mkdir(parents=True, exist_ok=True)
    exe = cad / "bin" / "dwg2dxf"
    exe.write_text(body)
    exe.chmod(0o755)
    (cad / "LICENSE.libredwg").write_text("GPLv3\n")
    (cad / "NOTICE").write_text("LibreDWG\n")
    return exe


class BuildRecipeTests(SimpleTestCase):
    """deploy/cad/build-dwg2dxf.sh: the pin, the checksum, a static link."""

    def setUp(self):
        self.text = SCRIPT.read_text()

    def test_version_and_hash_are_pinned_once(self):
        self.assertRegex(self.text, r"(?m)^LIBREDWG_VERSION=\d+\.\d+(\.\d+)?$")
        self.assertRegex(self.text, r"(?m)^LIBREDWG_SHA256=[0-9a-f]{64}$")
        r = subprocess.run(["sh", str(SCRIPT), "--version"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stdout.strip(), r"^\d+\.\d+")
        r = subprocess.run(["sh", str(SCRIPT), "--sha256"], capture_output=True, text=True)
        self.assertRegex(r.stdout.strip(), r"^[0-9a-f]{64}$")

    def test_the_tarball_is_verified_before_it_is_unpacked(self):
        check = self.text.index("sha256sum -c")
        self.assertLess(check, self.text.index("tar -xf"))
        self.assertIn("checksum mismatch", self.text)

    def test_dwg2dxf_is_linked_fully_static_and_checked(self):
        self.assertIn("--disable-shared", self.text)
        self.assertIn("--enable-static", self.text)
        self.assertIn("--disable-bindings", self.text)
        self.assertIn("make -C programs dwg2dxf LDFLAGS=-all-static", self.text)
        self.assertIn('file -b "$BIN"', self.text)
        self.assertIn('*"statically linked"*', self.text)
        self.assertIn("not statically linked", self.text)

    def test_output_carries_licence_notice_and_source(self):
        for path in ('"$OUT/bin/dwg2dxf"', '"$OUT/LICENSE.libredwg"', '"$OUT/NOTICE"',
                     '"$OUT/src/$TARBALL"'):
            self.assertIn(path, self.text)
        self.assertIn("chmod 0755", self.text)
        self.assertIn("cp COPYING", self.text)

    def test_needs_an_output_folder(self):
        r = subprocess.run(["sh", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage", r.stderr)

    def test_shell_syntax(self):
        for path in (SCRIPT, SCRIPTS / "build-release.sh", SCRIPTS / "install.sh"):
            shell = "sh" if path == SCRIPT else "bash"
            r = subprocess.run([shell, "-n", str(path)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{path}: {r.stderr}")

    def test_make_cad_tools_builds_into_vendor_cad(self):
        makefile = (ROOT / "Makefile").read_text()
        self.assertRegex(makefile, r"(?m)^cad-tools:\n\t@sh deploy/cad/build-dwg2dxf\.sh vendor/cad$")
        # What it builds is never committed.
        self.assertIn("/vendor/", (ROOT / ".gitignore").read_text().split())


class ReleaseBundleTests(SimpleTestCase):
    """The release job builds the converter and the bundle carries it."""

    def test_build_release_puts_it_in_vendor_cad_and_checks_it(self):
        text = (SCRIPTS / "build-release.sh").read_text()
        self.assertIn('CAD="$STAGE/vendor/cad"', text)
        self.assertIn('cp -a "$CAD_TOOLS_DIR/." "$CAD/"', text)
        self.assertIn("--target cad-dist", text)
        # The source offer is exactly the pinned tarball.
        self.assertIn('build-dwg2dxf.sh" --sha256', text)
        self.assertIn('libredwg-${LIBREDWG_VERSION}.tar.xz" | sha256sum -c -', text)
        # Static, or the build fails.
        self.assertIn("statically linked|static-pie linked", text)
        self.assertIn('-x "$CAD/bin/dwg2dxf"', text)
        self.assertIn('"$CAD/LICENSE.libredwg"', text)
        self.assertIn('"$CAD/NOTICE"', text)
        self.assertIn("dwg2dxf: LibreDWG $LIBREDWG_VERSION (static)", text)
        # Before the tarball is packed.
        self.assertLess(text.index('CAD="$STAGE/vendor/cad"'), text.index('tar -czf "$OUT/'))

    def test_release_workflow_builds_and_smoke_tests_it(self):
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "release.yml").read_text())
        steps = wf["jobs"]["bundle"]["steps"]
        names = [s.get("name", "") for s in steps]
        cad = next(s for s in steps if "DWG converter" in s.get("name", ""))
        self.assertIn("--target cad-dist", cad["run"])
        self.assertIn("--output type=local,dest=build/cad", cad["run"])
        # CI pulls base images from the mirror, not ECR Public's anonymous quota.
        self.assertIn("BASE_IMAGE_REGISTRY=mirror.gcr.io/library", cad["run"])
        build = next(s for s in steps if s.get("name") == "Build release bundle")
        self.assertLess(names.index(cad["name"]), names.index("Build release bundle"))
        self.assertTrue(build["env"]["CAD_TOOLS_DIR"].endswith("/build/cad"))
        smoke = "\n".join(s.get("run", "") for s in wf["jobs"]["smoke"]["steps"])
        self.assertIn("vendor/cad/bin/dwg2dxf --version", smoke)
        self.assertIn("converter_status", smoke)


class InstallerTests(SimpleTestCase):
    """A fresh install deploys the whole bundle, vendor/cad included, as the
    service user with its modes, then checks the converter runs."""

    def setUp(self):
        self.text = (SCRIPTS / "install.sh").read_text()

    def test_fresh_install_copies_vendor_with_its_modes(self):
        self.assertIn('tar -C "$BUNDLE" --exclude=./install.sh -cf - . | as_user tar -C "$APP" -xpf -',
                      self.text)

    def test_fresh_install_checks_the_converter_as_the_service_user(self):
        self.assertIn('as_user "$APP/vendor/cad/bin/dwg2dxf" --version', self.text)
        # A missing converter warns; the install goes on (DXF still works).
        block = self.text[self.text.index("5b. DWG converter"):self.text.index("6. Secrets")]
        self.assertIn("warn ", block)
        self.assertNotIn("die ", block)

    def test_bubblewrap_is_installed_by_default(self):
        # DWG converts only inside bubblewrap (#424), so the installer brings
        # it unless told not to; the old opt-in flag still parses.
        self.assertIn("SCRIPT_SANDBOX=1\n", self.text)
        self.assertIn("--without-bubblewrap) SCRIPT_SANDBOX=0", self.text)
        self.assertIn("--with-script-sandbox) SCRIPT_SANDBOX=1", self.text)
        self.assertIn("apt-get -o DPkg::Lock::Timeout=900 install -y bubblewrap", self.text)

    def test_an_upgrade_that_gains_bubblewrap_keeps_scripts_on_landlock(self):
        # Scripts on auto would lose device access once bwrap appears; an
        # existing install keeps Landlock unless .env already chose.
        block = self.text[self.text.index('step "Sandbox (bubblewrap)"'):]
        block = block[:block.index("\nfi\n")]
        self.assertIn('[ "$EXISTING" -eq 1 ]', block)
        self.assertIn("! env_get DANBYTE_SCRIPT_SANDBOX", block)
        self.assertIn("env_backfill DANBYTE_SCRIPT_SANDBOX landlock", block)
        # Only when this run installed it: the check sits inside the
        # "bwrap missing" branch.
        self.assertLess(block.index("if ! command -v bwrap"),
                        block.index("env_backfill DANBYTE_SCRIPT_SANDBOX landlock"))

    def test_the_bundle_layout_untars_to_the_install_path(self):
        """What install.sh's tar pipe does, run for real: the converter lands
        at <app>/vendor/cad/bin/dwg2dxf, executable, not world-writable."""
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        bundle, app = tmp / "bundle", tmp / "app"
        bundle.mkdir()
        app.mkdir()
        _put_converter(bundle)
        (bundle / "install.sh").write_text("#!/bin/sh\n")
        subprocess.run(["bash", "-c", 'tar -C "$1" --exclude=./install.sh -cf - . | tar -C "$2" -xpf -',
                        "_", str(bundle), str(app)], check=True)
        exe = app / "vendor" / "cad" / "bin" / "dwg2dxf"
        self.assertEqual(stat.S_IMODE(exe.stat().st_mode), 0o755)
        self.assertFalse((app / "install.sh").exists())
        self.assertEqual(resolve_cad_converter(None, exe), str(exe))


class UpgradeTests(StageTestCase):
    """The bundle upgrade stage moves vendor/ in whole: an install from
    before the converter gets it, and a rollback takes it away again."""

    def test_an_upgrade_brings_the_converter(self):
        h = self.host()
        self.assertFalse((h.app / "vendor" / "cad").exists())
        r = h.upgrade(str(h.bundle(extra=_put_converter)))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        exe = h.app / "vendor" / "cad" / "bin" / "dwg2dxf"
        self.assertEqual(stat.S_IMODE(exe.stat().st_mode), 0o755)
        self.assertTrue((h.app / "vendor" / "cad" / "LICENSE.libredwg").exists())
        self.assertEqual(resolve_cad_converter(None, exe), str(exe))
        # The .env was left alone: the default does the work.
        self.assertNotIn("DANBYTE_CAD_CONVERTER", (h.app / ".env").read_text())

    def test_an_upgrade_replaces_an_older_converter(self):
        h = self.host()
        _put_converter(h.app, "#!/bin/sh\necho old\n")
        h.before = h.snapshot()
        r = h.upgrade(str(h.bundle(extra=_put_converter)))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("0.14", (h.app / "vendor" / "cad" / "bin" / "dwg2dxf").read_text())

    def test_a_failed_upgrade_takes_it_back_out(self):
        h = self.host()
        r = h.upgrade(str(h.bundle(extra=_put_converter)),
                      env={"DANBYTE_UPGRADE_TEST": "1", "DANBYTE_UPGRADE_FAULT": "deps"})
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertRolledBack(h, restored_db=False)
        self.assertFalse((h.app / "vendor" / "cad").exists())

    def test_an_explicit_setting_survives_the_upgrade(self):
        h = self.host()
        with open(h.app / ".env", "a") as f:
            f.write("DANBYTE_CAD_CONVERTER=/opt/oda/ODAFileConverter\n")
        h.before = h.snapshot()
        r = h.upgrade(str(h.bundle(extra=_put_converter)))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("DANBYTE_CAD_CONVERTER=/opt/oda/ODAFileConverter", (h.app / ".env").read_text())


class GitCheckoutTests(StageTestCase):
    """A source checkout keeps what `make cad-tools` built across upgrades:
    vendor/ is ignored, so checkout and status leave it be."""

    kind = "git"

    def test_a_built_converter_survives_a_git_upgrade(self):
        h = self.host()
        exe = _put_converter(h.app)
        r = h.upgrade()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.access(exe, os.X_OK))


class SettingsResolutionTests(SimpleTestCase):
    """DANBYTE_CAD_CONVERTER: explicit wins, then the bundled dwg2dxf when it
    is there and executable, else empty (DWG refused)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bundled = self.tmp / "vendor" / "cad" / "bin" / "dwg2dxf"

    def test_the_default_location_is_vendor_cad_in_the_install(self):
        self.assertEqual(CAD_CONVERTER_BUNDLED, ROOT / "vendor" / "cad" / "bin" / "dwg2dxf")

    def test_unset_uses_the_bundled_converter(self):
        exe = _put_converter(self.tmp)
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.assertEqual(resolve_cad_converter(value, exe), str(exe))

    def test_unset_without_a_bundled_converter_is_empty(self):
        self.assertEqual(resolve_cad_converter(None, self.bundled), "")

    def test_a_bundled_file_that_is_not_executable_is_ignored(self):
        exe = _put_converter(self.tmp)
        exe.chmod(0o644)
        self.assertEqual(resolve_cad_converter(None, exe), "")

    def test_an_explicit_setting_wins(self):
        exe = _put_converter(self.tmp)
        for value in ("/usr/local/bin/dwg2dxf", "/opt/oda/ODAFileConverter"):
            with self.subTest(value=value):
                self.assertEqual(resolve_cad_converter(f" {value} ", exe), value)

    def test_off_refuses_dwg_even_with_the_bundled_one(self):
        exe = _put_converter(self.tmp)
        for value in ("off", "OFF"):
            with self.subTest(value=value):
                self.assertEqual(resolve_cad_converter(value, exe), "")

    def test_the_bundled_path_passes_the_converter_checks(self):
        exe = _put_converter(self.tmp)
        with override_settings(DANBYTE_CAD_CONVERTER=resolve_cad_converter(None, exe),
                               CAD_SANDBOX="off"):
            path, flavour = cad_render.converter()
            self.assertEqual((path, flavour), (str(exe), "libredwg"))
            self.assertTrue(cad_render.converter_status()["dwg"])

    def test_settings_use_the_resolver(self):
        text = (ROOT / "danbyte" / "settings.py").read_text()
        self.assertRegex(text, re.compile(
            r'DANBYTE_CAD_CONVERTER = resolve_cad_converter\(\s*os\.getenv\("DANBYTE_CAD_CONVERTER"\), '
            r"CAD_CONVERTER_BUNDLED\s*\)"))
