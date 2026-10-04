"""danbyte-admin's upgrade commands: they start the app's own launch
(manage.py start_upgrade) and follow the stage; recover runs the stage's
recovery. The script is loaded as a module with its host calls mocked."""
from __future__ import annotations

import argparse
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase, override_settings


def _load():
    path = str(Path(settings.BASE_DIR) / "scripts" / "danbyte-admin")
    loader = importlib.machinery.SourceFileLoader("danbyte_admin_under_test", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = mod     # its dataclasses look themselves up
    loader.exec_module(mod)
    return mod


ADMIN = _load()


def _run(ok=True, out="", err="", code=0):
    return SimpleNamespace(ok=ok, out=out, err=err, code=code)


class AdminUpgradeTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.app = self.tmp / "danbyte"
        (self.app / ".git").mkdir(parents=True)
        self.ctx = ADMIN.Ctx(app=self.app, shape="systemd")

    def args(self, **kw):
        base = {"action": "online", "tag": "v0.17.0-dev2", "bundle": None, "skip_backup": False,
                "force": False, "no_follow": False}
        return argparse.Namespace(**{**base, **kw})

    def test_an_online_upgrade_goes_through_start_upgrade_and_is_followed(self):
        with mock.patch.object(ADMIN, "_upgrade_busy", return_value=""), \
                mock.patch.object(ADMIN, "manage", return_value=_run()) as manage, \
                mock.patch.object(ADMIN, "_follow_upgrade", return_value=0) as follow:
            self.assertEqual(ADMIN.cmd_upgrade(self.ctx, self.args(skip_backup=True)), 0)
        manage.assert_called_once_with(
            self.ctx, ["start_upgrade", "--tag", "v0.17.0-dev2", "--skip-backup"])
        follow.assert_called_once()

    def test_a_bundle_is_copied_before_the_upgrade_consumes_it(self):
        bundle = self.tmp / "danbyte-0.17.0-dev2-linux-x86_64.tar.gz"
        bundle.write_bytes(b"x")
        scratch = self.tmp / ".danbyte-bundle-x.tar.gz"
        with mock.patch.object(ADMIN, "_upgrade_busy", return_value=""), \
                mock.patch.object(ADMIN, "stage_bundle", return_value=scratch), \
                mock.patch.object(ADMIN, "manage", return_value=_run()) as manage:
            ADMIN.cmd_upgrade(self.ctx, self.args(action="bundle", tag=None, bundle=str(bundle),
                                                  no_follow=True))
        manage.assert_called_once_with(self.ctx, ["start_upgrade", "--bundle", str(scratch)])

    def test_a_held_lock_stops_it_without_force(self):
        with mock.patch.object(ADMIN, "_upgrade_busy", return_value="an upgrade lock is held"), \
                mock.patch.object(ADMIN, "manage") as manage:
            with self.assertRaises(SystemExit):
                ADMIN.cmd_upgrade(self.ctx, self.args())
        manage.assert_not_called()

    def test_following_reports_how_it_ended(self):
        status = self.app / ".upgrade-status.json"
        status.write_text(json.dumps({"state": "failed", "step": "verify",
                                      "error": "rolled back", "log": "/x/upgrade.log"}))
        with mock.patch.object(ADMIN, "systemctl", return_value=_run(out="inactive")), \
                mock.patch.object(ADMIN.time, "sleep"):
            self.assertEqual(ADMIN._follow_upgrade(self.ctx), 1)
        status.write_text(json.dumps({"state": "done", "step": "done", "version_to": "0.17.0-dev2"}))
        with mock.patch.object(ADMIN, "systemctl", return_value=_run(out="inactive")), \
                mock.patch.object(ADMIN.time, "sleep"):
            self.assertEqual(ADMIN._follow_upgrade(self.ctx), 0)

    def test_recover_runs_the_stages_recovery_with_retry(self):
        self.assertEqual(ADMIN.cmd_upgrade_recover(self.ctx, None), 0)   # nothing to do
        root = self.tmp / ".danbyte-upgrade"
        (root / "recover").mkdir(parents=True)
        (root / "active").write_text("WORK=x\n")

        def finish(argv, **kw):
            (root / "active").unlink()
            return _run()

        with mock.patch.object(ADMIN, "sh", side_effect=finish) as sh:
            self.assertEqual(ADMIN.cmd_upgrade_recover(self.ctx, None), 0)
        argv = sh.call_args.args[0]
        self.assertEqual(argv, ["/bin/sh", str(root / "recover" / "recover.sh"), "--retry"])

    def test_docker_gets_the_host_sequence(self):
        ctx = ADMIN.Ctx(app=self.app, shape="docker")
        with mock.patch.object(ADMIN, "die", side_effect=SystemExit) as die:
            with self.assertRaises(SystemExit):
                ADMIN.cmd_upgrade(ctx, self.args())
        self.assertIn("docker compose stop scheduler workers fastlane ws", die.call_args.args[0])


class AdminStatusTests(SimpleTestCase):
    def test_migrations_that_do_not_load_are_not_up_to_date(self):
        # A stray migration a rolled-back release left behind: the system
        # info says so, and status must not tick "migrations up to date".
        ctx = ADMIN.Ctx(app=Path(settings.BASE_DIR), shape="systemd")
        info = {"version": "0.16.13", "migration_drift": [],
                "pending_migrations": ["(migration files cannot be loaded: AttributeError: x)"]}
        lines = []
        emit = mock.patch.object(ADMIN, "_emit", side_effect=lambda kind, msg: lines.append((kind, msg)))
        with emit, mock.patch.object(ADMIN, "shell_json", return_value=(info, "")), \
                mock.patch.object(ADMIN, "health", return_value=({"status": "degraded"}, "x")), \
                mock.patch.object(ADMIN, "_print_units"):
            ADMIN.cmd_status(ctx, None)
        self.assertNotIn(("ok", "migrations up to date"), lines)
        self.assertTrue(any(k == "warn" and "cannot be loaded" in m for k, m in lines), lines)


class AdminStaticTests(SimpleTestCase):
    """rebuild and maintenance collectstatic open what collectstatic left, as
    the upgrade does: it skips files that did not change, so copies an
    earlier release wrote readable only by the service user stay closed to
    nginx."""

    def setUp(self):
        self.ctx = ADMIN.Ctx(app=Path(settings.BASE_DIR), shape="systemd", units=["danbyte-web"])
        self.lines = []
        emit = mock.patch.object(ADMIN, "_emit",
                                 side_effect=lambda kind, msg: self.lines.append((kind, msg)))
        emit.start()
        self.addCleanup(emit.stop)

    def admin(self, fn, *, failed="0") -> list[list[str]]:
        """The manage.py calls ``fn`` makes; the open reports ``failed``."""
        calls = []

        def manage(ctx, args, **kw):
            calls.append(args)
            return _run(out=f"{failed}\n" if args[0] == "shell" else "")

        with mock.patch.object(ADMIN, "manage", side_effect=manage), \
                mock.patch.object(ADMIN, "_upgrade_busy", return_value=""), \
                mock.patch.object(ADMIN, "active_units", return_value=[]):
            self.assertEqual(fn(), 0)
        return calls

    def test_rebuild_opens_them_after_collecting(self):
        calls = self.admin(lambda: ADMIN.cmd_rebuild(self.ctx, argparse.Namespace(
            skip_deps=True, skip_frontend=True, force=False)))
        self.assertEqual([c[0] for c in calls], ["migrate", "collectstatic", "shell"])
        self.assertEqual(calls[-1], ["shell", "--no-imports", "-c", ADMIN.OPEN_STATIC])
        self.assertIn(("ok", "static     readable for the web server"), self.lines)

    def test_maintenance_collectstatic_does_too(self):
        def job(action):
            return lambda: ADMIN.cmd_maintenance(self.ctx, argparse.Namespace(action=action))

        self.assertEqual([c[0] for c in self.admin(job("collectstatic"))], ["collectstatic", "shell"])
        self.assertEqual([c[0] for c in self.admin(job("reindex"))], ["rebuild_search_index"])
        self.admin(job("collectstatic"), failed="2")
        self.assertIn(("warn", "some files could not be made readable for the web server: "
                               "2 could not be changed"), self.lines)

    def test_the_app_opens_its_static_root(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        css = root / "admin" / "css" / "base.css"
        css.parent.mkdir(parents=True)
        css.write_text("body {}\n")
        css.chmod(0o640)
        for d in (root, root / "admin", css.parent):
            d.chmod(0o750)
        printed = io.StringIO()
        with override_settings(STATIC_ROOT=root), contextlib.redirect_stdout(printed):
            exec(ADMIN.OPEN_STATIC, {})
        self.assertEqual(json.loads(printed.getvalue()), 0)
        self.assertEqual(css.stat().st_mode & 0o777, 0o644)
        for d in (root, root / "admin", css.parent):
            self.assertEqual(d.stat().st_mode & 0o777, 0o755, d)
