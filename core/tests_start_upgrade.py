"""manage.py start_upgrade - an upgrade from the host through the app's own
lock and launcher (what danbyte-admin runs)."""
from __future__ import annotations

import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from core import upgrade


class StartUpgradeCommandTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for name, path in {
            "LOCK_FILE": root / ".upgrade.lock",
            "LOCK_GUARD_FILE": root / ".upgrade.lock.guard",
            "STATUS_FILE": root / ".upgrade-status.json",
            "UPGRADE_ROOTS": (root / ".danbyte-upgrade",),
        }.items():
            p = patch.object(upgrade, name, path)
            p.start()
            self.addCleanup(p.stop)
        self.root = root
        for target, value in (("core.upgrade._is_git_install", True),
                              ("core.version.self_upgrade_supported", True)):
            p = patch(target, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def run_cmd(self, *args: str) -> str:
        out = io.StringIO()
        call_command("start_upgrade", *args, stdout=out)
        return out.getvalue()

    def test_a_tag_launches_the_git_launcher_under_the_lock_without_asking_the_repo(self):
        with patch("core.upgrade._launch", return_value="systemd-run") as launch, \
                patch("core.upgrade._valid_target") as valid:
            out = self.run_cmd("--tag", "v0.17.0-dev2", "--skip-backup", "--json")
        valid.assert_not_called()
        version, owner, env = launch.call_args.args
        self.assertEqual(version, "v0.17.0-dev2")
        self.assertEqual(json.loads(upgrade.LOCK_FILE.read_text())["owner"], owner)
        self.assertEqual(env["DANBYTE_UPGRADE_TRIGGER"], "admin")
        self.assertEqual(env["DANBYTE_SKIP_BACKUP"], "1")
        self.assertNotIn("DANBYTE_UPGRADE_FAULT", env)
        self.assertEqual(json.loads(out)["via"], "systemd-run")
        status = json.loads(upgrade.STATUS_FILE.read_text())
        self.assertEqual((status["trigger"], status["stage_api"]), ("admin", 1))

    def test_a_bundle_goes_to_the_bundle_launcher(self):
        bundle = self.root / "danbyte-0.17.0-dev2-linux-x86_64.tar.gz"
        bundle.write_bytes(b"x")
        with patch("core.upgrade._launch_bundle", return_value="systemd-run") as launch:
            self.run_cmd("--bundle", str(bundle), "--fault", "verify")
        self.assertEqual(launch.call_args.args[0], str(bundle))
        env = launch.call_args.kwargs["extra_env"]
        self.assertEqual((env["DANBYTE_UPGRADE_TEST"], env["DANBYTE_UPGRADE_FAULT"]), ("1", "verify"))

    def test_a_running_upgrade_is_not_joined(self):
        owner = upgrade._acquire_upgrade_lock()
        self.assertIsNotNone(owner)
        with patch("core.upgrade._launch") as launch, \
                patch("core.upgrade._systemd_unit_active", return_value=True):
            with self.assertRaises(CommandError) as ctx:
                self.run_cmd("--tag", "v0.17.0-dev2")
        self.assertIn("already running", str(ctx.exception))
        launch.assert_not_called()

    def test_an_unrecovered_upgrade_is_named(self):
        (self.root / ".danbyte-upgrade").mkdir()
        (self.root / ".danbyte-upgrade" / "active").write_text("WORK=/x\n")
        with self.assertRaises(CommandError) as ctx:
            self.run_cmd("--tag", "v0.17.0-dev2")
        self.assertIn("danbyte-admin upgrade recover", str(ctx.exception))

    def test_a_launch_that_started_nothing_frees_the_slot(self):
        with patch("core.upgrade._launch", side_effect=RuntimeError("systemd-run is not available")):
            with self.assertRaises(CommandError):
                self.run_cmd("--tag", "v0.17.0-dev2")
        self.assertFalse(upgrade.LOCK_FILE.exists())
        status = json.loads(upgrade.STATUS_FILE.read_text())
        self.assertEqual(status["state"], "failed")
        self.assertIs(status["launch_attempted"], False)

    def test_a_bundle_install_needs_a_bundle(self):
        with patch("core.upgrade._is_git_install", return_value=False):
            with self.assertRaises(CommandError):
                self.run_cmd("--tag", "v0.17.0-dev2")
