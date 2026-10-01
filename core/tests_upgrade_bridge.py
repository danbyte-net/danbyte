"""The bridge for upgraders from before the upgrade stage.

A 0.16.x or 0.17.0-dev1 upgrader puts this release on disk and runs its
``manage.py migrate`` with every service up. The bridge must step in for
exactly that call, stop what runs (never the unit it runs inside), leave the
restart to a unit that outlives the old upgrader, and migrate all or
nothing. legacy-resume.sh, which that unit runs, is exercised for real with
a fake systemctl.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase, TestCase, override_settings

from core import upgrade_migrate
from core.upgrade_migrate import LegacyBridge
from danbyte import __version__

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


#: What 0.16.13's bundle upgrader and its request leave while it migrates.
OLD_STATUS = {"state": "running", "step": "migrate", "pct": 75, "version_to": "uploaded",
              "version_from": "0.16.13", "error": ""}
OLD_LOCK = {"owner": "x", "phase": "launched", "acquired_at": 1790833226.6,
            "status_started_at": 1790833226.7}


class HandOverTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.app = self.tmp / "danbyte"
        (self.app / "scripts" / "upgrade").mkdir(parents=True)
        shutil.copy2(Path(settings.BASE_DIR) / "scripts" / "upgrade" / "legacy-resume.sh",
                     self.app / "scripts" / "upgrade" / "legacy-resume.sh")
        self.root = self.tmp / ".danbyte-upgrade"
        # where an old bundle upgrader writes its rollback archive
        self.backups = self.tmp / "danbyte-backups"
        self.backups.mkdir()
        ctx = override_settings(DANBYTE_BACKUP_DIR=self.backups)
        ctx.enable()
        self.addCleanup(ctx.disable)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DANBYTE_BACKUP_DIR", None)

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

    def hand_over(self, suffix: str = upgrade_migrate.ADDED_SUFFIX) -> tuple[Path, str]:
        out = io.StringIO()
        b = LegacyBridge(stdout=out)
        with override_settings(BASE_DIR=self.app), \
                mock.patch("core.upgrade.UPGRADE_ROOTS", (self.root, self.app / ".danbyte-upgrade")), \
                mock.patch("subprocess.run", return_value=SimpleNamespace(returncode=0)):
            self.assertTrue(b.hand_over(["danbyte-web.service"]))
        return Path(f"{b.units_file}{suffix}"), out.getvalue()

    def recorded(self, *, asked=None, status=None, lock=None, git=False, **patches):
        """``(target, report, said)`` the hand-over left for the restart."""
        (self.app / ".upgrade-status.json").write_text(json.dumps(status or OLD_STATUS))
        (self.app / ".upgrade.lock").write_text(json.dumps(lock or OLD_LOCK))
        if git:
            (self.app / ".git").mkdir(exist_ok=True)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(upgrade_migrate, "asked_for", return_value=asked))
            stack.enter_context(mock.patch.object(upgrade_migrate, "pre_upgrade_backup",
                                                  return_value="b1"))
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(upgrade_migrate, name, value))
            target, said = self.hand_over(upgrade_migrate.TARGET_SUFFIX)
        report = Path(str(target).replace(upgrade_migrate.TARGET_SUFFIX,
                                          upgrade_migrate.REPORT_SUFFIX))
        return target.read_text(), json.loads(report.read_text()), said

    def test_an_auto_upgrade_names_the_tag_its_tick_asked_for(self):
        # 0.16's bundle upgrader says "uploaded"; its auto-upgrade retries a
        # failed release unless the failed status names that release's tag.
        target, report, said = self.recorded(asked="v0.17.0-dev92")
        self.assertEqual(target, "v0.17.0-dev92\n")
        self.assertEqual(report, {"trigger": "auto", "version_from": "0.16.13",
                                  "version_to": "v0.17.0-dev92", "kind": "bundle",
                                  "backup": "b1", "started_at": 1790833226.7})
        self.assertIn("an upgrade to v0.17.0-dev92, started by the auto-upgrade timer", said)

    def test_otherwise_a_bundle_is_this_release(self):
        target, report, said = self.recorded(lock={"acquired_at": 1790833226.6})
        self.assertEqual(target, f"v{__version__}\n")
        self.assertEqual((report["trigger"], report["version_to"], report["started_at"]),
                         ("button", f"v{__version__}", 1790833226.6))
        self.assertIn("started by a person", said)

    def test_a_git_upgrader_names_its_tag_and_commit(self):
        status = {**OLD_STATUS, "version_to": "v0.17.0-rc1", "version_from": "35d3ebe6"}
        seen = []
        target, report, _ = self.recorded(
            status=status, git=True,
            version_at=lambda base, rev: seen.append(rev) or "0.16.13")
        self.assertEqual(target, "v0.17.0-rc1\n")
        self.assertEqual((report["kind"], report["version_from"], report["version_to"]),
                         ("git", "0.16.13", "v0.17.0-rc1"))
        self.assertEqual(seen, ["35d3ebe6"])

    def test_a_database_that_cannot_say_is_not_a_failed_hand_over(self):
        def broken(_):
            raise RuntimeError("relation does not exist")

        target, report, said = self.recorded(asked_for=broken)
        self.assertEqual(target, f"v{__version__}\n")
        self.assertEqual((report["trigger"], report["backup"]), ("button", ""))
        self.assertIn("could not read who started this upgrade", said)

    def overlay(self, archive_age: float = 60) -> float:
        """The old bundle upgrader: archive the tree, then put the release on
        it with the release's own (older) timestamps. Returns the archive's
        time."""
        def put(rel: str, when: float) -> None:
            p = self.app / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("x\n")
            os.utime(p, (when, when))

        for rel in ("manage.py", "core/migrations/0054_old.py", "staticfiles/old.css", ".env"):
            put(rel, time.time() - 86400)
        archive = self.backups / "code-pre-0.17.0-1.tgz"
        subprocess.run(["tar", "-C", str(self.app), "--exclude=./.venv", "--exclude=./vendor",
                        "--exclude=./media", "-czf", str(archive), "."], check=True)
        when = time.time() - archive_age
        os.utime(archive, (when, when))
        built = when - 3600
        for rel in ("core/migrations/0055_new.py", "core/management/commands/migrate.py",
                    "staticfiles/new.abc123.css", "frontend/dist/assets/index.js",
                    "core/migrations/__pycache__/0055_new.cpython-313.pyc",
                    ".venv/lib/new.py", "vendor/wheels/new.whl", "media/documents/new.pdf",
                    "frontend/node_modules/x/index.js", ".upgrade-bundle.tar.gz",
                    ".upgrade-status.json", ".maintenance", ".danbyte-upgrade/x"):
            put(rel, built)
        put("core/migrations/0054_old.py", built)                # replaced, not added
        put("plugins_local/uploaded-meanwhile.py", when + 30)     # written since the archive
        (self.app / "core" / "linked.py").symlink_to(self.app / "manage.py")
        os.utime(self.app / "core" / "linked.py", (built, built), follow_symlinks=False)
        return when

    def test_the_files_this_release_added_are_listed_for_the_restart(self):
        self.overlay()
        added, said = self.hand_over()
        self.assertEqual(added.read_text().splitlines(), [
            "core/linked.py", "core/management/commands/migrate.py",
            "core/migrations/0055_new.py", "frontend/dist/assets/index.js",
            "staticfiles/new.abc123.css"])
        self.assertIn("5 file(s) are not in code-pre-0.17.0-1.tgz (1 newer than it left alone)",
                      said)

    def test_an_old_archive_is_not_this_upgrades(self):
        self.overlay(archive_age=upgrade_migrate.BRIDGE_ARCHIVE_AGE + 60)
        added, said = self.hand_over()
        self.assertFalse(added.exists())
        self.assertIn("no rollback archive from this upgrade", said)

    def test_a_git_checkout_is_rolled_back_by_git(self):
        self.overlay()
        (self.app / ".git").mkdir()
        added, said = self.hand_over()
        self.assertFalse(added.exists())
        self.assertIn("a git checkout", said)

    def test_a_restart_that_could_not_be_arranged_leaves_nothing(self):
        b = LegacyBridge(stdout=io.StringIO())
        failed = SimpleNamespace(returncode=1, stderr="no user bus", stdout="")
        with override_settings(BASE_DIR=self.app), \
                mock.patch("core.upgrade.UPGRADE_ROOTS", (self.root, self.app / ".danbyte-upgrade")), \
                mock.patch("subprocess.run", return_value=failed):
            self.assertFalse(b.hand_over(["danbyte-web.service"]))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_without_a_hand_over_nothing_is_stopped(self):
        b = LegacyBridge(stdout=io.StringIO())
        b.plan = lambda: (["t.timer"], ["w.service"], ["web.service"], ["web.service"])
        b.hand_over = lambda wanted: False
        b.stop = mock.Mock()
        with override_settings(STATIC_ROOT=self.tmp / "staticfiles"), \
                mock.patch.object(upgrade_migrate, "run_migrate",
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

    def run_bridge(self, code: int) -> Path:
        """A real hand-over (systemd-run faked), then a migration that ends
        with ``code``; returns the resume unit's list of units."""
        b = LegacyBridge(stdout=io.StringIO())
        b.plan = lambda: ([], [], [], ["danbyte-dispatch.timer"])
        b.stop = mock.Mock()
        result = upgrade_migrate.MigrateResult(code, "atomic", 2, error="boom")
        with override_settings(BASE_DIR=self.app), \
                mock.patch("core.upgrade.UPGRADE_ROOTS", (self.root, self.app / ".danbyte-upgrade")), \
                mock.patch("subprocess.run", return_value=SimpleNamespace(returncode=0)), \
                mock.patch.object(upgrade_migrate, "run_migrate", return_value=result), \
                mock.patch.dict(os.environ), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(b.run(), code)
        return b.units_file

    def test_a_migration_rolled_back_in_full_tells_the_restart(self):
        units = self.run_bridge(upgrade_migrate.EXIT_UNCHANGED)
        self.assertTrue(Path(f"{units}{upgrade_migrate.UNCHANGED_SUFFIX}").exists())

    def test_a_partial_migration_does_not(self):
        units = self.run_bridge(upgrade_migrate.EXIT_PARTIAL)
        self.assertTrue(units.exists())
        self.assertFalse(Path(f"{units}{upgrade_migrate.UNCHANGED_SUFFIX}").exists())

    def test_collected_static_files_are_opened_to_the_web_server(self):
        static = self.app / "staticfiles"
        (static / "admin" / "css").mkdir(parents=True)
        css = static / "admin" / "css" / "base.css"
        css.write_text("body {}\n")
        secret = self.tmp / "secret"
        secret.write_text("x\n")
        secret.chmod(0o600)
        (static / "link").symlink_to(secret)
        for d in (static, static / "admin", static / "admin" / "css"):
            d.chmod(0o750)
        css.chmod(0o640)
        b = LegacyBridge(stdout=io.StringIO())
        b.plan = lambda: ([], [], [], [])
        b.hand_over = lambda wanted: True
        b.stop = mock.Mock()
        with override_settings(STATIC_ROOT=static), \
                mock.patch.object(upgrade_migrate, "run_migrate",
                                  return_value=upgrade_migrate.MigrateResult(0, "atomic", 2)), \
                mock.patch.dict(os.environ), \
                mock.patch("django.core.management.call_command") as call:
            self.assertEqual(b.run(), 0)
        self.assertEqual(call.call_args.args[0], "collectstatic")
        for d in (static, static / "admin", static / "admin" / "css"):
            self.assertEqual(d.stat().st_mode & 0o777, 0o755, d)
        self.assertEqual(css.stat().st_mode & 0o777, 0o644)
        self.assertEqual(secret.stat().st_mode & 0o777, 0o600)   # links are not followed


class WhoAskedTests(TestCase):
    """The bridge reads, on the old schema, what started the upgrade."""

    def run_at(self, start, end, detail, status="ok"):
        from core.models import ScheduledRun

        return ScheduledRun.objects.create(name="auto-upgrade", label="Auto-upgrade check",
                                           status=status, started_at=start, finished_at=end,
                                           detail=detail)

    def test_the_tick_that_took_the_lock_names_the_tag(self):
        import datetime

        from django.utils import timezone

        now = timezone.now()
        s = datetime.timedelta(seconds=1)
        self.run_at(now - 2 * s, now + 2 * s, {"upgrading": "v0.17.0-dev92", "from": "0.16.13"})
        self.run_at(now - 3600 * s, now - 3597 * s, {"upgrading": "v0.17.0-dev90"})
        self.run_at(now - 600 * s, now - 599 * s, {}, status="skipped")
        lock = now.timestamp()
        self.assertEqual(upgrade_migrate.asked_for(lock), "v0.17.0-dev92")
        self.assertEqual(upgrade_migrate.asked_for(lock - 3598), "v0.17.0-dev90")
        self.assertIsNone(upgrade_migrate.asked_for(lock - 600))   # a person, between ticks
        self.assertIsNone(upgrade_migrate.asked_for(None))

    def test_a_tag_that_is_not_one_is_not_used(self):
        from django.utils import timezone

        now = timezone.now()
        self.run_at(now, now, {"upgrading": 'v1","x":"y'})
        self.assertIsNone(upgrade_migrate.asked_for(now.timestamp()))

    def test_the_pre_upgrade_backup_is_the_one_after_the_lock(self):
        import datetime

        from django.utils import timezone

        from backups.models import Backup, BackupTarget

        now = timezone.now()
        target = BackupTarget.objects.create(name="Local", kind="local", config={"path": "/tmp/x"})
        made = {}
        for name, kind, ago in (("earlier", "pre_upgrade", 3600), ("this", "pre_upgrade", 5),
                                ("scheduled", "scheduled", 1)):
            made[name] = Backup.objects.create(kind=kind, target=target)
            Backup.objects.filter(pk=made[name].pk).update(
                created_at=now - datetime.timedelta(seconds=ago))
        lock = (now - datetime.timedelta(seconds=60)).timestamp()
        self.assertEqual(upgrade_migrate.pre_upgrade_backup(lock), str(made["this"].pk))
        self.assertEqual(upgrade_migrate.pre_upgrade_backup(now.timestamp()), "")
        self.assertEqual(upgrade_migrate.pre_upgrade_backup(None), "")


SYSTEMCTL = """#!/bin/sh
echo "systemctl $*" >>"$FAKE_CALLS"
"""
PY = """#!/bin/sh
[ "$1" = -c ] && exec "$REAL_PY" "$@"
echo "py $*" >>"$FAKE_CALLS"
exit "${FAKE_CHECK_RC:-0}"
"""
FAILED = {"state": "failed", "step": "migrate", "pct": 0, "version_to": "0.17.0",
          "version_from": "0.16.13", "error": "database migration failed"}


class LegacyResumeScriptTests(SimpleTestCase):
    def run_resume(self, check_rc: str, pid: str = "", start: str = "", *,
                   status: dict | None = None, on_disk: str = "", unchanged: bool = False,
                   added: list[str] | None = None, target: str = "", report: dict | None = None,
                   setup=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.tmp = tmp
        (tmp / "bin").mkdir()
        (tmp / "bin" / "systemctl").write_text(SYSTEMCTL)
        (tmp / "bin" / "systemctl").chmod(0o755)
        app = self.app = tmp / "danbyte"
        (app / ".venv" / "bin").mkdir(parents=True)
        (app / ".venv" / "bin" / "python").write_text(PY)
        (app / ".venv" / "bin" / "python").chmod(0o755)
        if status is not None:
            (app / ".upgrade-status.json").write_text(json.dumps(status, separators=(",", ":")))
        if on_disk:
            (app / "danbyte").mkdir()
            (app / "danbyte" / "__init__.py").write_text(f'__version__ = "{on_disk}"\n')
        root = tmp / ".danbyte-upgrade"      # where the bridge puts both
        root.mkdir()
        units = root / "legacy-resume-T.units"
        units.write_text("danbyte-web.service\ndanbyte-dispatch.timer\n")
        if unchanged:
            Path(f"{units}{upgrade_migrate.UNCHANGED_SUFFIX}").write_text("")
        if added is not None:
            Path(f"{units}{upgrade_migrate.ADDED_SUFFIX}").write_text("".join(f"{p}\n" for p in added))
        if target:
            Path(f"{units}{upgrade_migrate.TARGET_SUFFIX}").write_text(f"{target}\n")
        if report is not None:
            Path(f"{units}{upgrade_migrate.REPORT_SUFFIX}").write_text(json.dumps(report))
        script = root / "legacy-resume-T.sh"
        shutil.copy2(Path(settings.BASE_DIR) / "scripts" / "upgrade" / "legacy-resume.sh", script)
        if setup:
            setup(app, units)
        calls = tmp / "calls"
        calls.write_text("")
        env = {**os.environ, "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}",
               "FAKE_CALLS": str(calls), "FAKE_CHECK_RC": check_rc, "REAL_PY": sys.executable}
        r = subprocess.run(["/bin/sh", str(script), str(app), str(units), pid or "999999999", start],
                           env=env, capture_output=True, text=True, timeout=60)
        return r, calls.read_text(), script, units

    def assertCleanedUp(self, script: Path, units: Path):
        for suffix in ("", upgrade_migrate.UNCHANGED_SUFFIX, upgrade_migrate.ADDED_SUFFIX,
                       upgrade_migrate.TARGET_SUFFIX, upgrade_migrate.REPORT_SUFFIX):
            p = Path(f"{units}{suffix}")
            self.assertFalse(p.exists(), p)
        self.assertFalse(script.exists())
        self.assertFalse(units.parent.exists(), "the empty upgrade folder was left behind")

    def test_starts_what_was_recorded_once_the_upgrader_is_gone(self):
        r, calls, script, units = self.run_resume("0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("py manage.py migrate --check", calls)
        self.assertIn("systemctl --user start danbyte-web.service danbyte-dispatch.timer", calls)
        self.assertCleanedUp(script, units)

    def test_failed_units_are_reset_before_they_start(self):
        # A timer that fired between the old upgrader's overlay and the bridge
        # ran the new code on the old schema; its service stays failed.
        r, calls, _, _ = self.run_resume("0")
        lines = calls.splitlines()
        reset = lines.index("systemctl --user reset-failed danbyte-web.service "
                            "danbyte-dispatch.timer danbyte-dispatch.service")
        self.assertLess(reset, lines.index("systemctl --user start danbyte-web.service "
                                           "danbyte-dispatch.timer"))

    def test_the_previous_release_back_on_an_unchanged_database_starts_again(self):
        # An old bundle upgrader's rollback leaves 0.17's files on disk, so
        # the check fails; the bridge said nothing changed in the database.
        r, calls, script, units = self.run_resume("1", status=FAILED, on_disk="0.16.13",
                                                  unchanged=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("migrate --check", calls)          # for the log only
        self.assertIn("starting anyway", r.stdout)
        self.assertIn("systemctl --user start danbyte-web.service danbyte-dispatch.timer", calls)
        self.assertIn("0.16.13 is back", r.stdout)
        self.assertCleanedUp(script, units)

    def test_then_the_files_the_failed_release_added_are_removed(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (outside / "sub").mkdir()
        for name in ("abs.txt", "sub/through.txt", "target.txt"):
            (outside / name).write_text("x\n")

        def setup(app, units):
            mig = app / "core" / "migrations"
            (mig / "__pycache__").mkdir(parents=True)
            (mig / "0058_note.py").write_text("x\n")
            (mig / "__pycache__" / "0058_note.cpython-313.pyc").write_text("x\n")
            (mig / "__pycache__" / "0057_old.cpython-313.pyc").write_text("x\n")
            (app / "frontend" / "dist").mkdir(parents=True)
            (app / "frontend" / "dist" / "new.js").write_text("x\n")
            (app / "keep").mkdir()
            (app.parent / "up.txt").write_text("x\n")
            (app / "link").symlink_to(outside / "sub")
            (app / "sym.txt").symlink_to(outside / "target.txt")

        added = ["core/migrations/0058_note.py", "frontend/dist/new.js", "sym.txt", "keep",
                 "gone.py", str(outside / "abs.txt"), "../up.txt", "core/../../up.txt",
                 "link/through.txt", ""]
        r, calls, script, units = self.run_resume("1", status=FAILED, on_disk="0.16.13",
                                                  unchanged=True, added=added, setup=setup)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        mig = self.app / "core" / "migrations"
        self.assertFalse((mig / "0058_note.py").exists())
        self.assertFalse((mig / "__pycache__" / "0058_note.cpython-313.pyc").exists())
        self.assertTrue((mig / "__pycache__" / "0057_old.cpython-313.pyc").exists())
        self.assertFalse((self.app / "frontend" / "dist" / "new.js").exists())
        self.assertFalse((self.app / "sym.txt").is_symlink())
        # never a folder, nothing outside the tree, not through a link
        self.assertTrue((self.app / "keep").is_dir())
        self.assertTrue((self.tmp / "up.txt").exists())
        for name in ("abs.txt", "sub/through.txt", "target.txt"):
            self.assertTrue((outside / name).exists(), name)
        self.assertIn("removed 3 file(s) the failed release had added", r.stdout)
        self.assertIn("systemctl --user start", calls)
        self.assertCleanedUp(script, units)

    def test_only_then_does_it_start_without_the_check(self):
        cases = {
            "no word from the bridge": dict(status=FAILED, on_disk="0.16.13"),
            "the new code is still on disk": dict(status=FAILED, on_disk="0.17.0", unchanged=True),
            "the upgrade finished": dict(status={**FAILED, "state": "done"}, on_disk="0.16.13",
                                         unchanged=True),
            "no status": dict(on_disk="0.16.13", unchanged=True),
        }
        for name, kw in cases.items():
            with self.subTest(name):
                r, calls, script, units = self.run_resume("1", added=["danbyte/__init__.py"], **kw)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn("migrate --check", calls)
                self.assertNotIn("systemctl", calls)
                self.assertTrue((self.app / "danbyte" / "__init__.py").exists())
                self.assertCleanedUp(script, units)

    def test_a_failed_upload_names_the_release_it_was_for(self):
        # 0.16's auto-upgrade answers "failed before" for a release only when
        # the failed status names its tag; its bundle upgrader says "uploaded".
        status = {**FAILED, "version_to": "uploaded"}
        r, calls, script, units = self.run_resume("1", status=status, on_disk="0.16.13",
                                                  unchanged=True, target="v0.17.0-dev92",
                                                  report={"trigger": "auto"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = json.loads((self.app / ".upgrade-status.json").read_text())
        self.assertEqual(st, {**status, "version_to": "v0.17.0-dev92"})
        self.assertIn("the status names v0.17.0-dev92", r.stdout)
        # a failed one is the restored release's to show; nothing to report
        self.assertNotIn("upgrade_report", calls)
        self.assertIn("systemctl --user start", calls)
        self.assertCleanedUp(script, units)

    def test_only_the_uploaded_placeholder_of_a_finished_upgrade_is_renamed(self):
        cases = {"a git upgrader's tag": {**FAILED, "version_to": "v0.17.0-rc1"},
                 "an upgrade still running": {**FAILED, "state": "running",
                                              "version_to": "uploaded"}}
        for name, status in cases.items():
            with self.subTest(name):
                self.run_resume("0", status=status, target="v0.17.0-dev92")
                self.assertEqual(json.loads((self.app / ".upgrade-status.json").read_text()),
                                 status)

    def test_a_finished_upgrade_is_recorded_for_its_report(self):
        done = {"state": "done", "step": "done", "pct": 100, "version_to": "uploaded",
                "version_from": "0.16.13", "error": ""}
        r, calls, script, units = self.run_resume("0", status=done, target="v0.17.0",
                                                  report={"trigger": "auto"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        lines = calls.splitlines()
        merge = lines.index(f"py manage.py upgrade_report --merge-legacy "
                            f"{units}{upgrade_migrate.REPORT_SUFFIX}")
        self.assertLess(lines.index("py manage.py migrate --check"), merge)
        self.assertLess(merge, lines.index("systemctl --user start danbyte-web.service "
                                           "danbyte-dispatch.timer"))
        self.assertEqual(json.loads((self.app / ".upgrade-status.json").read_text())["version_to"],
                         "v0.17.0")
        self.assertCleanedUp(script, units)
        # never while the database lacks a migration the code has
        r, calls, _, _ = self.run_resume("1", status=done, report={"trigger": "auto"})
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("upgrade_report", calls)

    def test_never_starts_new_code_on_an_old_schema(self):
        r, calls, script, units = self.run_resume("1")
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("systemctl", calls)
        self.assertIn("not starting anything", r.stdout)
        self.assertIn("systemctl --user start danbyte-web.service danbyte-dispatch.timer", r.stdout)
        self.assertCleanedUp(script, units)

    def test_a_refusal_is_written_where_the_upgrade_is_read(self):
        cases = {"failed": {**FAILED, "version_from": "0.16.12"},
                 "done": {"state": "done", "step": "done", "version_from": "0.16.13",
                          "warnings": ["earlier"]}}
        for state, status in cases.items():
            with self.subTest(state):
                r, _, _, _ = self.run_resume("1", status=status, on_disk="0.16.13")
                self.assertEqual(r.returncode, 1)
                st = json.loads((self.app / ".upgrade-status.json").read_text())
                self.assertEqual(st["state"], state)
                note = st["warnings"][-1]
                self.assertIn("nothing the upgrade stopped was started again (2 units", note)
                self.assertIn("journalctl --user -u danbyte-upgrade-resume-T", note)
                if state == "failed":
                    self.assertEqual(st["error"], f"database migration failed - {note}")
                else:
                    self.assertEqual(st["warnings"][0], "earlier")
                    self.assertNotIn("error", st)
        # a status another upgrade is writing is left alone
        running = {"state": "running", "step": "backup", "pct": 4}
        r, _, _, _ = self.run_resume("1", status=running)
        self.assertEqual(json.loads((self.app / ".upgrade-status.json").read_text()), running)

    def test_the_uploaded_bundle_goes_once_the_upgrader_is_done(self):
        def setup(app, units):
            bundle = app / ".upgrade-bundle.tar.gz"
            bundle.write_text("x")
            old = time.time() - 600
            os.utime(bundle, (old, old))

        for state, gone in (("failed", True), ("done", True), ("running", False)):
            with self.subTest(state):
                self.run_resume("0", status={**FAILED, "state": state}, setup=setup)
                self.assertEqual((self.app / ".upgrade-bundle.tar.gz").exists(), not gone)

    def test_a_newer_upload_is_not_the_finished_upgrades_bundle(self):
        def setup(app, units):
            old = time.time() - 600
            os.utime(units, (old, old))
            (app / ".upgrade-bundle.tar.gz").write_text("x")

        self.run_resume("0", status=FAILED, setup=setup)
        self.assertTrue((self.app / ".upgrade-bundle.tar.gz").exists())

    def test_what_earlier_resumes_left_is_removed(self):
        def setup(app, units):
            stale = time.time() - 3 * 3600
            for name in ("legacy-resume-A.sh", "legacy-resume-A.units"):
                (units.parent / name).write_text("")
                os.utime(units.parent / name, (stale, stale))
            (units.parent / "legacy-resume-B.units").write_text("")   # one still waiting

        r, _, _, units = self.run_resume("0", setup=setup)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(sorted(p.name for p in units.parent.iterdir()), ["legacy-resume-B.units"])

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
