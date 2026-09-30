"""The bridge for upgraders from before the upgrade stage.

A 0.16.x or 0.17.0-dev1 upgrader puts this release on disk and runs its
``manage.py migrate`` with every service up. The bridge must step in for
exactly that call, stop what runs (never the unit it runs inside), leave the
restart to a unit that outlives the old upgrader, and migrate all or
nothing. legacy-resume.sh, which that unit runs, is exercised for real with
a fake systemctl.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase, override_settings

from core import upgrade_migrate
from core.upgrade_migrate import LegacyBridge

ARGV = ["manage.py", "migrate", "--noinput"]
OPTS = {"app_label": None, "migration_name": None, "plan": False, "check_unapplied": False,
        "fake": False, "fake_initial": False, "prune": False, "database": "default"}


class DetectionTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.status = self.tmp / ".upgrade-status.json"
        self.status.write_text(json.dumps({"state": "running", "step": "migrate", "pct": 60}))
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DANBYTE_UPGRADE_STAGE", None)
        ctx = override_settings(BASE_DIR=self.tmp, TESTING=False)
        ctx.enable()
        self.addCleanup(ctx.disable)

    def test_an_old_upgrader_at_its_migrate_step_is_bridged(self):
        self.assertTrue(LegacyBridge.applies(OPTS, ARGV))

    def test_every_other_migrate_is_left_alone(self):
        def opt(**kw):
            return lambda o: o.update(kw)

        cases = {
            "the stage itself": lambda o: os.environ.__setitem__("DANBYTE_UPGRADE_STAGE", "1"),
            "a test run": lambda o: setattr(settings, "TESTING", True),
            "an app": opt(app_label="api"),
            "--plan": opt(plan=True),
            "--check": opt(check_unapplied=True),
            "--fake": opt(fake=True),
            "another database": opt(database="other"),
            "another directory": lambda o: os.chdir(tempfile.gettempdir()),
            "a finished upgrade": lambda o: self.status.write_text('{"state": "done", "step": "done"}'),
            "another step": lambda o: self.status.write_text('{"state": "running", "step": "deps"}'),
            "the new stage's status": lambda o: self.status.write_text(
                '{"state": "running", "step": "migrate", "stage_api": 1}'),
            "a stale status": lambda o: os.utime(self.status, (1, 1)),
            "no status": lambda o: self.status.unlink(),
        }
        for name, change in cases.items():
            with self.subTest(name), override_settings(TESTING=False):
                opts = dict(OPTS)
                os.chdir(self.tmp)
                self.status.write_text(json.dumps({"state": "running", "step": "migrate"}))
                os.environ.pop("DANBYTE_UPGRADE_STAGE", None)
                self.assertTrue(LegacyBridge.applies(opts, ARGV))
                change(opts)
                self.assertFalse(LegacyBridge.applies(opts, ARGV))
        with self.subTest("call_command inside another command"):
            self.assertFalse(LegacyBridge.applies(OPTS, ["manage.py", "test"]))


def _props(load="loaded", active="active", enabled="enabled", cgroup=""):
    return {"LoadState": load, "ActiveState": active, "UnitFileState": enabled,
            "ControlGroup": cgroup}


class PlanTests(SimpleTestCase):
    def bridge(self, units: dict, mine: str = "/user.slice/session-3.scope"):
        b = LegacyBridge(stdout=io.StringIO())
        b.unit_info = lambda u: units.get(u, {"LoadState": "not-found"})
        b.own_cgroup = lambda: mine
        b.timers = lambda: ["danbyte-dispatch.timer", "danbyte-digest.timer"]
        return b

    def test_groups_what_runs_and_remembers_what_to_start(self):
        base = "/user.slice/user-1000.slice/user@1000.service/app.slice"
        units = {
            "danbyte-dispatch.timer": _props(),
            "danbyte-digest.timer": _props(active="inactive", enabled="disabled"),
            "danbyte-workers.service": _props(),
            "danbyte-fastlane.service": _props(),
            "danbyte-web.service": _props(cgroup=f"{base}/danbyte-web.service"),
            "danbyte-ws.service": _props(),
            "danbyte-docs.service": _props(active="failed"),   # enabled, crashed before
            "danbyte-backend.service": _props(),               # a stray dev server
        }
        timers, work, web, wanted = self.bridge(units).plan()
        self.assertEqual(timers, ["danbyte-dispatch.timer", "danbyte-digest.timer"])
        self.assertEqual(work, ["danbyte-workers.service", "danbyte-fastlane.service"])
        self.assertEqual(web, ["danbyte-web.service", "danbyte-ws.service",
                               "danbyte-backend.service", "danbyte-docs.service"])
        self.assertIn("danbyte-docs.service", wanted)
        self.assertNotIn("danbyte-digest.timer", wanted)       # the admin's choice
        self.assertNotIn("danbyte-backend.service", wanted)    # never beside gunicorn

    def test_never_stops_the_unit_it_runs_inside(self):
        base = "/user.slice/user-1000.slice/user@1000.service/app.slice"
        units = {"danbyte-web.service": _props(cgroup=f"{base}/danbyte-web.service"),
                 "danbyte-workers.service": _props(cgroup=f"{base}/danbyte-workers.service")}
        b = self.bridge(units, mine=f"{base}/danbyte-web.service")
        timers, work, web, wanted = b.plan()
        self.assertEqual(web, [])
        self.assertEqual(work, ["danbyte-workers.service"])
        self.assertIn("leaving danbyte-web.service running", b.stdout.getvalue())

    def test_stops_timers_then_workers_then_web(self):
        b = self.bridge({})
        calls = []
        b.systemctl = lambda *a, **k: calls.append(a) or SimpleNamespace(stdout="", returncode=0)
        b.unit_info = lambda u: {"ActiveState": "inactive"}
        b.stop(["danbyte-dispatch.timer"], ["danbyte-workers.service"], ["danbyte-web.service"])
        self.assertEqual(calls, [("stop", "danbyte-dispatch.timer"),
                                 ("stop", "danbyte-workers.service"),
                                 ("stop", "danbyte-web.service")])


class HandOverTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.app = self.tmp / "danbyte"
        (self.app / "scripts" / "upgrade").mkdir(parents=True)
        shutil.copy2(Path(settings.BASE_DIR) / "scripts" / "upgrade" / "legacy-resume.sh",
                     self.app / "scripts" / "upgrade" / "legacy-resume.sh")
        self.root = self.tmp / ".danbyte-upgrade"

    def test_the_restart_runs_from_a_copy_outside_the_tree_as_its_own_unit(self):
        b = LegacyBridge(stdout=io.StringIO())
        with override_settings(BASE_DIR=self.app), \
                mock.patch("core.upgrade.UPGRADE_ROOTS", (self.root, self.app / ".danbyte-upgrade")), \
                mock.patch("subprocess.run", return_value=SimpleNamespace(returncode=0)) as run:
            self.assertTrue(b.hand_over(["danbyte-web.service", "danbyte-dispatch.timer"]))
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ["systemd-run", "--user", "--collect", "--unit"])
        self.assertTrue(argv[4].startswith("danbyte-upgrade-resume-"))
        script, app, units, pid = Path(argv[6]), argv[7], Path(argv[8]), argv[9]
        self.assertEqual(script.parent, self.root)
        self.assertTrue(script.exists())
        self.assertEqual(app, str(self.app))
        self.assertEqual(units.read_text(), "danbyte-web.service\ndanbyte-dispatch.timer\n")
        self.assertEqual(pid, str(os.getppid()))

    def test_without_a_hand_over_nothing_is_stopped(self):
        b = LegacyBridge(stdout=io.StringIO())
        b.plan = lambda: (["t.timer"], ["w.service"], ["web.service"], ["web.service"])
        b.hand_over = lambda wanted: False
        b.stop = mock.Mock()
        with mock.patch.object(upgrade_migrate, "run_migrate",
                               return_value=upgrade_migrate.MigrateResult(0, "atomic", 2)), \
                mock.patch.dict(os.environ), \
                mock.patch("django.core.management.call_command"):
            self.assertEqual(b.run(), 0)
        b.stop.assert_not_called()

    def test_a_failed_migration_reports_its_exit_code(self):
        b = LegacyBridge(stdout=io.StringIO())
        b.plan = lambda: ([], [], [], [])
        b.hand_over = lambda wanted: True
        b.stop = mock.Mock()
        failed = upgrade_migrate.MigrateResult(3, "atomic", 2, error="boom")
        with mock.patch.object(upgrade_migrate, "run_migrate", return_value=failed), \
                mock.patch.dict(os.environ), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(b.run(), 3)
            # the nested migrate is never bridged again
            self.assertEqual(os.environ["DANBYTE_UPGRADE_STAGE"], "bridge")
        b.stop.assert_called_once()


SYSTEMCTL = """#!/bin/sh
echo "systemctl $*" >>"$FAKE_CALLS"
"""
PY = """#!/bin/sh
echo "py $*" >>"$FAKE_CALLS"
exit "${FAKE_CHECK_RC:-0}"
"""


class LegacyResumeScriptTests(SimpleTestCase):
    def run_resume(self, check_rc: str, pid: str = "", start: str = ""):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "bin").mkdir()
        (tmp / "bin" / "systemctl").write_text(SYSTEMCTL)
        (tmp / "bin" / "systemctl").chmod(0o755)
        app = tmp / "danbyte"
        (app / ".venv" / "bin").mkdir(parents=True)
        (app / ".venv" / "bin" / "python").write_text(PY)
        (app / ".venv" / "bin" / "python").chmod(0o755)
        units = tmp / "resume.units"
        units.write_text("danbyte-web.service\ndanbyte-dispatch.timer\n")
        script = tmp / "legacy-resume.sh"
        shutil.copy2(Path(settings.BASE_DIR) / "scripts" / "upgrade" / "legacy-resume.sh", script)
        calls = tmp / "calls"
        calls.write_text("")
        env = {**os.environ, "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}",
               "FAKE_CALLS": str(calls), "FAKE_CHECK_RC": check_rc}
        r = subprocess.run(["/bin/sh", str(script), str(app), str(units), pid or "999999999", start],
                           env=env, capture_output=True, text=True, timeout=60)
        return r, calls.read_text(), script, units

    def test_starts_what_was_recorded_once_the_upgrader_is_gone(self):
        r, calls, script, units = self.run_resume("0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("py manage.py migrate --check", calls)
        self.assertIn("systemctl --user start danbyte-web.service danbyte-dispatch.timer", calls)
        self.assertFalse(script.exists())
        self.assertFalse(units.exists())

    def test_never_starts_new_code_on_an_old_schema(self):
        r, calls, _, units = self.run_resume("1")
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("systemctl", calls)
        self.assertIn("not starting anything", r.stdout)
        self.assertTrue(units.exists())

    def test_waits_for_a_live_upgrader(self):
        # Not our child, so its exit is reaped by someone else, like the
        # upgrader's is by systemd.
        pid = subprocess.run(["/bin/sh", "-c", "sleep 3 >/dev/null 2>&1 & echo $!"],
                             capture_output=True, text=True).stdout.strip()
        start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        t0 = time.monotonic()
        r, calls, _, _ = self.run_resume("0", pid, start)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertGreaterEqual(time.monotonic() - t0, 2.5, "it did not wait for the upgrader")
        self.assertIn("systemctl --user start", calls)
