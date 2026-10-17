"""The DWG converter runs in a bubblewrap sandbox (#424).

LibreDWG is a C parser fed files from anyone who may change a floor plan, so
the converter gets no network, a read-only root with nothing but itself (or
the system libraries, for a dynamic program), the staged DWG read-only and
one writable output directory. A host where bwrap cannot build that refuses
DWG unless DANBYTE_CAD_SANDBOX=off says otherwise.

The unit tests mock the probe; the ``Live`` tests start real sandboxes and
are skipped where bwrap does not work.
"""
from __future__ import annotations

import os
import shutil
import socket
import stat
import struct
import tarfile
import tempfile
import time
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from scripting import sandbox

from . import cad_render
from . import tests_cad_fixtures as fx
from .models import FloorPlanDrawing
from .tests_cad import DWG, LOCMEM, _Base

USABLE = sandbox.BwrapProbe(path="/usr/bin/bwrap", usable=True)
BROKEN = sandbox.BwrapProbe(path="/usr/bin/bwrap",
                            reason="No permissions to create a new namespace")


def _elf(*segment_types: int) -> bytes:
    """A minimal ELF64 header with one program header per type."""
    head = bytearray(64)
    head[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", head, 16, 2, 62, 1)
    struct.pack_into("<Q", head, 32, 64)
    struct.pack_into("<HHH", head, 52, 64, 56, len(segment_types))
    return bytes(head) + b"".join(struct.pack("<I", t) + b"\x00" * 52 for t in segment_types)


def _script(directory: str, body: str, name: str = "dwg2dxf") -> str:
    path = os.path.join(directory, name)
    with open(path, "w") as fh:
        fh.write("#!/bin/bash\n" + body + "\n")
    os.chmod(path, 0o755)
    return path


class _Dirs(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="danbyte-cad-sbx-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.in_dir = os.path.join(self.tmp, "dwg-in")
        self.out_dir = os.path.join(self.tmp, "dwg-out")
        os.makedirs(self.in_dir)
        os.makedirs(self.out_dir)


@override_settings(CACHES=LOCMEM)
class ModeTests(SimpleTestCase):
    def test_only_an_explicit_off_turns_it_off(self):
        for value in ("off", "OFF", " none ", "0", "false", "no"):
            with self.subTest(value=value), self.settings(CAD_SANDBOX=value):
                self.assertEqual(cad_render.sandbox_mode(), "off")
        for value in ("bwrap", "on", "", None, "landlock", "bogus"):
            with self.subTest(value=value), self.settings(CAD_SANDBOX=value):
                self.assertEqual(cad_render.sandbox_mode(), "bwrap")

    def test_the_default_is_on(self):
        self.assertEqual(settings.CAD_SANDBOX, os.getenv("DANBYTE_CAD_SANDBOX", "bwrap"))
        text = (Path(settings.BASE_DIR) / "danbyte" / "settings.py").read_text()
        self.assertIn('CAD_SANDBOX = os.getenv("DANBYTE_CAD_SANDBOX", "bwrap")', text)


@override_settings(CACHES=LOCMEM, CAD_SANDBOX="bwrap")
class FailClosedTests(_Dirs):
    """No working bwrap: the converter is not used, and the upload form says
    why. An explicit off runs it with limits only."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.marker = os.path.join(self.tmp, "ran")
        self.exe = _script(self.tmp, f'touch "{self.marker}"')

    def test_without_bwrap_dwg_is_refused_and_status_says_why(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe), \
                mock.patch.object(sandbox, "find_bwrap", return_value=""):
            with self.assertRaisesMessage(cad_render.ConverterUnavailable,
                                          "bubblewrap is not installed"):
                cad_render.converter()
            status = cad_render.converter_status()
        self.assertFalse(status["dwg"])
        self.assertIn("sandbox", status["message"])
        self.assertIn("DXF", status["message"])

    def test_the_bundled_converter_is_not_run_without_a_sandbox(self):
        src = os.path.join(self.tmp, "source")
        Path(src).write_bytes(DWG)
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe), \
                mock.patch.object(sandbox, "bwrap_probe", return_value=BROKEN):
            with self.assertRaisesMessage(cad_render.ConverterUnavailable,
                                          "No permissions to create a new namespace"):
                cad_render.convert_dwg(src, os.path.join(self.tmp, "job"))
        self.assertFalse(os.path.exists(self.marker))

    def test_a_workers_failed_probe_reaches_the_upload_form(self):
        os.makedirs(os.path.join(self.tmp, "job"))
        src = os.path.join(self.tmp, "source")
        Path(src).write_bytes(DWG)
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe):
            with mock.patch.object(sandbox, "bwrap_probe", return_value=BROKEN), \
                    self.assertRaises(cad_render.ConverterUnavailable):
                cad_render.convert_dwg(src, os.path.join(self.tmp, "job"))
            with mock.patch.object(sandbox, "find_bwrap", return_value="/usr/bin/bwrap"):
                status = cad_render.converter_status()
                self.assertFalse(status["dwg"])
                self.assertIn("No permissions to create a new namespace", status["message"])
                # A later probe that works clears it.
                with mock.patch.object(sandbox, "bwrap_probe", return_value=USABLE):
                    cad_render._sandbox_probe()
                self.assertTrue(cad_render.converter_status()["dwg"])

    def test_explicit_off_runs_the_converter_without_bwrap(self):
        src = os.path.join(self.tmp, "source")
        Path(src).write_bytes(DWG)
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe, CAD_SANDBOX="off"), \
                mock.patch.object(sandbox, "find_bwrap", return_value=""), \
                mock.patch.object(sandbox, "bwrap_probe", side_effect=AssertionError):
            self.assertTrue(cad_render.converter_status()["dwg"])
            argv, restrict = cad_render.sandboxed(["/x/dwg2dxf", "a"], "libredwg",
                                                  in_dir=self.in_dir, out_dir=self.out_dir)
            self.assertEqual((argv, restrict), (["/x/dwg2dxf", "a"], None))
            with self.assertRaises(ValueError):  # the fake writes no DXF
                cad_render.convert_dwg(src, os.path.join(self.tmp, "job"))
        self.assertTrue(os.path.exists(self.marker))


@override_settings(CACHES=LOCMEM, CAD_SANDBOX="bwrap")
class ArgvTests(_Dirs):
    def test_static_program_sees_only_itself_and_its_dirs(self):
        exe = os.path.join(self.tmp, "dwg2dxf")
        Path(exe).write_bytes(_elf(1, 1))
        os.chmod(exe, 0o755)
        with mock.patch.object(sandbox, "bwrap_probe", return_value=USABLE):
            argv, restrict = cad_render.sandboxed(
                [exe, "-y", "-o", "out.dxf", "in.dwg"], "libredwg",
                in_dir=self.in_dir, out_dir=self.out_dir,
            )
        self.assertIsNotNone(restrict)
        sep = argv.index("--")
        wrap, cmd = argv[:sep], argv[sep + 1:]
        self.assertEqual(wrap[0], "/usr/bin/bwrap")
        self.assertEqual(cmd, [exe, "-y", "-o", "out.dxf", "in.dwg"])
        for flag in ("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                     "--unshare-net", "--die-with-parent", "--new-session"):
            self.assertIn(flag, wrap)
        self.assertEqual(wrap[wrap.index("--cap-drop") + 1], "ALL")
        self.assertEqual(wrap[wrap.index("--uid") + 1], str(sandbox.SANDBOX_ID))
        binds = [(wrap[i], wrap[i + 1], wrap[i + 2]) for i, a in enumerate(wrap)
                 if a in ("--ro-bind", "--bind")]
        self.assertEqual(binds, [("--ro-bind", exe, exe),
                                 ("--ro-bind", self.in_dir, self.in_dir),
                                 ("--bind", self.out_dir, self.out_dir)])
        self.assertNotIn("/usr", wrap)
        self.assertNotIn("--proc", wrap)
        self.assertEqual(wrap[wrap.index("--chdir") + 1], self.out_dir)
        self.assertIn("--remount-ro", wrap)
        base = os.path.realpath(settings.BASE_DIR)
        self.assertFalse([a for a in wrap if a == base or a.startswith(base + "/")])

    def test_oda_gets_libraries_proc_and_tmp(self):
        exe = _script(self.tmp, "true", name="ODAFileConverter")
        with mock.patch.object(sandbox, "bwrap_probe", return_value=USABLE):
            argv, _ = cad_render.sandboxed([exe], "oda", in_dir=self.in_dir,
                                           out_dir=self.out_dir)
        wrap = argv[:argv.index("--")]
        self.assertIn("--unshare-net", wrap)
        self.assertEqual(wrap[wrap.index("--proc") + 1], "/proc")
        self.assertEqual(wrap[wrap.index("--tmpfs") + 1], "/tmp")
        self.assertIn(os.path.realpath("/usr"), wrap)
        self.assertIn(os.path.realpath(self.tmp), wrap)  # its install dir

    def test_a_dynamic_program_beside_the_app_is_refused(self):
        exe = os.path.join(settings.BASE_DIR, "dwg2dxf")
        with mock.patch.object(sandbox, "bwrap_probe", return_value=USABLE), \
                self.assertRaisesMessage(cad_render.ConverterUnavailable, "Danbyte directory"):
            cad_render.sandboxed([exe], "libredwg", in_dir=self.in_dir, out_dir=self.out_dir)

    def test_static_detection(self):
        static = os.path.join(self.tmp, "static")
        dynamic = os.path.join(self.tmp, "dynamic")
        Path(static).write_bytes(_elf(1, 1, 4))
        Path(dynamic).write_bytes(_elf(6, 3, 1))
        self.assertTrue(sandbox.is_static_elf(static))
        self.assertFalse(sandbox.is_static_elf(dynamic))
        self.assertFalse(sandbox.is_static_elf(_script(self.tmp, "true")))
        self.assertFalse(sandbox.is_static_elf(os.path.join(self.tmp, "missing")))
        Path(static).write_bytes(_elf(1)[:70])  # truncated program headers
        self.assertFalse(sandbox.is_static_elf(static))

    def test_the_script_sandbox_argv_is_unchanged(self):
        """The shared helpers build the same command scripts had before."""
        argv = sandbox.bwrap_argv(USABLE, self.out_dir, ["/usr"])
        self.assertEqual(argv[:6], ["/usr/bin/bwrap", "--unshare-user", "--uid", "65534",
                                    "--gid", "65534"])
        self.assertEqual(argv[argv.index("--hostname") + 1], sandbox.SANDBOX_HOSTNAME)
        self.assertEqual(argv[-4:], ["/", "--chdir", self.out_dir, "--"])


_LIVE = None


def _live() -> bool:
    global _LIVE
    if _LIVE is None:
        try:
            _LIVE = sandbox.bwrap_probe().usable
        except Exception:  # noqa: BLE001
            _LIVE = False
    return _LIVE


REPORT = r"""
out="$3"; src="$4"; r="$(dirname "$out")/report.txt"
{
  echo "uid=$(id -u)"
  echo "host=$HOSTNAME"
  [ -r "$src" ] && echo "src=readable"
  ( : > "$src.x" ) 2>/dev/null && echo "src-dir=writable" || echo "src-dir=read-only"
  ( : > /danbyte-x ) 2>/dev/null && echo "root=writable" || echo "root=read-only"
  ( : > "$(dirname "$out")/w" ) 2>/dev/null && echo "out=writable"
  for p in "@APP@/manage.py" "@APP@/.env" "@APP@" "@MEDIA@" "@HOME@" /proc/1 /sys/class/net \
           /etc/passwd "@WORK@/source"; do
    [ -e "$p" ] && echo "seen=$p"
  done
  ( exec 3<>/dev/tcp/127.0.0.1/@DBPORT@ ) 2>/dev/null && echo "db=open" || echo "db=closed"
  ( exec 3<>/dev/tcp/1.1.1.1/53 ) 2>/dev/null && echo "net=open" || echo "net=closed"
  echo "env=$(env | cut -d= -f1 | sort | tr '\n' ' ')"
} > "$r"
cp "$(dirname "$0")/fixture.dxf" "$out"
"""


@override_settings(CACHES=LOCMEM, CAD_SANDBOX="bwrap")
class LiveSandboxTests(_Dirs):
    """Real sandboxes: what a converter inside one can and cannot do."""

    def setUp(self):
        if not _live():
            self.skipTest("bubblewrap cannot build a sandbox on this host")
        super().setUp()
        self.bin = tempfile.mkdtemp(prefix="danbyte-cad-bin-")
        self.addCleanup(shutil.rmtree, self.bin, True)
        Path(self.bin, "fixture.dxf").write_bytes(fx.floor_dxf(units=6))
        self.job = os.path.join(self.tmp, "job")
        os.makedirs(self.job)
        self.src = os.path.join(self.job, "source")
        Path(self.src).write_bytes(DWG)

    def test_the_converter_sees_no_network_and_no_app(self):
        db = settings.DATABASES["default"]
        port = int(db.get("PORT") or 5432)
        body = (REPORT.replace("@APP@", os.path.realpath(settings.BASE_DIR))
                .replace("@MEDIA@", str(settings.MEDIA_ROOT))
                .replace("@HOME@", os.path.expanduser("~"))
                .replace("@WORK@", self.job)
                .replace("@DBPORT@", str(port)))
        exe = _script(self.bin, body)
        with self.settings(DANBYTE_CAD_CONVERTER=exe):
            out = cad_render.convert_dwg(self.src, self.job)
        report = Path(self.job, "dwg-out", "report.txt").read_text()
        lines = set(report.splitlines())
        self.assertIn(f"uid={sandbox.SANDBOX_ID}", lines)
        self.assertIn("host=" + sandbox.PROGRAM_HOSTNAME, lines)
        self.assertIn("src=readable", lines)
        self.assertIn("src-dir=read-only", lines)
        self.assertIn("root=read-only", lines)
        self.assertIn("out=writable", lines)
        self.assertIn("db=closed", lines)
        self.assertIn("net=closed", lines)
        seen = {line[5:] for line in lines if line.startswith("seen=")}
        self.assertEqual(seen, {"/etc/passwd"}, report)  # a dynamic program's name lookup
        env = next(line for line in lines if line.startswith("env=")).split()
        self.assertNotIn("DJANGO_SETTINGS_MODULE", env)
        self.assertNotIn("DB_PASSWORD", env)
        self.assertTrue(os.path.getsize(out) > 0)
        # The same port is reachable from outside, so "closed" means the sandbox.
        if db.get("HOST") in ("127.0.0.1", "localhost"):
            socket.create_connection(("127.0.0.1", port), timeout=5).close()

    def test_a_hung_converter_is_killed_with_its_sandbox(self):
        exe = _script(self.bin, "exec sleep 31.75")
        with self.settings(DANBYTE_CAD_CONVERTER=exe), \
                mock.patch.object(cad_render, "CONVERT_TIMEOUT", 1), \
                self.assertRaisesMessage(ValueError, "too long"):
            cad_render.convert_dwg(self.src, self.job)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and _running("31.75"):
            time.sleep(0.1)
        self.assertFalse(_running("31.75"))

    def test_the_bundled_converter_converts_a_real_dwg(self):
        exe = Path(settings.CAD_CONVERTER_BUNDLED)
        tarballs = sorted((exe.parent.parent / "src").glob("libredwg-*.tar.xz"))
        if not (exe.is_file() and os.access(exe, os.X_OK) and tarballs):
            self.skipTest("no bundled dwg2dxf here (make cad-tools)")
        with tarfile.open(tarballs[-1]) as tar:
            member = next(m for m in tar.getmembers()
                          if m.name.endswith("test/test-data/example_2004.dwg"))
            Path(self.src).write_bytes(tar.extractfile(member).read())
        seen = {}
        real = cad_render._run

        def spy(argv, **kw):
            seen["argv"] = argv
            return real(argv, **kw)

        with self.settings(DANBYTE_CAD_CONVERTER=str(exe)), \
                mock.patch.object(cad_render, "_run", side_effect=spy):
            out = cad_render.convert_dwg(self.src, self.job)
        self.assertGreater(os.path.getsize(out), 1000)
        wrap = seen["argv"][:seen["argv"].index("--")]
        self.assertIn("--unshare-net", wrap)
        self.assertNotIn("/usr", wrap)  # static: nothing but itself
        with open(out, encoding="utf-8", errors="replace") as fh:
            self.assertIn("SECTION", fh.read(4096))


def _running(token: str) -> bool:
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                if token.encode() in fh.read():
                    return True
        except OSError:
            continue
    return False


@override_settings(CACHES=LOCMEM, CAD_SANDBOX="bwrap")
class UploadTests(_Base):
    """The endpoints and the job, with the sandbox unavailable."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.bin = tempfile.mkdtemp(prefix="danbyte-cad-bin-")
        self.addCleanup(shutil.rmtree, self.bin, True)
        self.exe = _script(self.bin, "true")
        os.chmod(self.exe, stat.S_IRWXU)

    def test_without_bwrap_a_dwg_upload_is_refused(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe), \
                mock.patch.object(sandbox, "find_bwrap", return_value=""):
            r = self.upload(DWG, name="plan.dwg")
            s = self.client.get("/api/floor-plans/drawing-support/").data
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data["code"], "converter_missing")
        self.assertIn("bubblewrap is not installed", r.data["file"][0])
        self.assertFalse(FloorPlanDrawing.objects.exists())
        self.assertFalse(s["dwg"])
        self.assertIn("bubblewrap is not installed", s["message"])

    def test_a_worker_without_a_sandbox_fails_the_drawing(self):
        with self.settings(DANBYTE_CAD_CONVERTER=self.exe), \
                mock.patch.object(sandbox, "find_bwrap", return_value="/usr/bin/bwrap"), \
                mock.patch.object(sandbox, "bwrap_probe", return_value=BROKEN):
            r = self.upload(DWG, name="plan.dwg")
            self.assertEqual(r.status_code, 202)
            d = FloorPlanDrawing.objects.get(floor_plan=self.plan)
            self.assertEqual(d.status, "failed")
            self.assertIn("No permissions to create a new namespace", d.error)
            # The next upload is refused up front, saying the same.
            s = self.client.get("/api/floor-plans/drawing-support/").data
            self.assertFalse(s["dwg"])
            self.assertIn("No permissions", s["message"])

    def test_dxf_needs_no_sandbox(self):
        with mock.patch.object(sandbox, "find_bwrap", return_value=""):
            d = self.ready()
        self.assertEqual(d.source_kind, "dxf")
