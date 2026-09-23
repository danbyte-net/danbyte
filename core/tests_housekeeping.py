"""Housekeeping removes what an install leaves behind, and nothing else."""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from core import housekeeping
from core.models import DeploymentSettings

User = get_user_model()


def _touch(path: Path, size: int = 10, age_days: float = 0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    if age_days:
        t = time.time() - age_days * 86400
        os.utime(path, (t, t))
    return path


class HousekeepingTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.backups = root / "backups"
        self.base = root / "app"
        self.logs = root / "logs"
        self.logs.mkdir()
        self.backups.mkdir()
        self.base.mkdir()
        self.settings_ctx = override_settings(
            DANBYTE_BACKUP_DIR=self.backups, BASE_DIR=self.base
        )
        self.settings_ctx.enable()
        self.ctx = [
            mock.patch.dict(os.environ, {"DANBYTE_LOG_DIR": str(self.logs)}),
            mock.patch("core.upgrade.BUNDLE_UPLOAD", self.base / ".upgrade-bundle.tar.gz"),
            mock.patch("core.upgrade._upgrade_running", return_value=False),
        ]
        for c in self.ctx:
            c.start()
        cfg = DeploymentSettings.load()
        cfg.upgrade_backups_keep = 2
        cfg.log_retention_days = 30
        cfg.save()

    def tearDown(self):
        for c in reversed(self.ctx):
            c.stop()
        self.settings_ctx.disable()
        self.tmp.cleanup()

    def test_rollback_archives_beyond_the_setting_are_removed_newest_kept(self):
        for i, age in enumerate((5, 4, 3, 2, 1)):
            _touch(self.backups / f"code-pre-0.16.{i}-1.tgz", 1000, age_days=age)
        out = housekeeping.run()
        left = sorted(p.name for p in self.backups.glob("code-pre-*.tgz"))
        self.assertEqual(left, ["code-pre-0.16.3-1.tgz", "code-pre-0.16.4-1.tgz"])
        self.assertEqual(out["freed_bytes"], 3000)

    def test_only_old_rotated_logs_go(self):
        live = _touch(self.logs / "danbyte.log", age_days=90)
        old = _touch(self.logs / "danbyte.log.3.gz", age_days=40)
        recent = _touch(self.logs / "gunicorn-access.log.1", age_days=5)
        housekeeping.run()
        self.assertTrue(live.exists(), "the live log is logrotate's, not ours")
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_zero_log_retention_keeps_everything(self):
        cfg = DeploymentSettings.load()
        cfg.log_retention_days = 0
        cfg.save()
        old = _touch(self.logs / "danbyte.log.3.gz", age_days=400)
        housekeeping.run()
        self.assertTrue(old.exists())

    def test_abandoned_work_folders_go_and_a_running_one_stays(self):
        stale = self.backups / ".work" / "backup-abc"
        _touch(stale / "upload.dbk", 500)
        t = time.time() - 2 * 86400
        os.utime(stale, (t, t))
        live = self.backups / ".work" / "backup-now"
        _touch(live / "upload.dbk", 500)
        housekeeping.run()
        self.assertFalse(stale.exists())
        self.assertTrue(live.exists())

    def test_the_downloaded_bundle_goes_only_when_no_upgrade_runs(self):
        bundle = _touch(self.base / ".upgrade-bundle.tar.gz", 100, age_days=1)
        with mock.patch("core.upgrade._upgrade_running", return_value=True):
            housekeeping.run()
        self.assertTrue(bundle.exists())
        housekeeping.run()
        self.assertFalse(bundle.exists())

    def test_wheels_no_installed_package_came_from_are_removed(self):
        from importlib import metadata

        django_version = metadata.version("Django")
        keep = _touch(self.base / "vendor/wheels" / f"Django-{django_version}-py3-none-any.whl")
        stale = _touch(self.base / "vendor/wheels" / "Django-1.0.0-py3-none-any.whl")
        housekeeping.run()
        self.assertTrue(keep.exists())
        self.assertFalse(stale.exists())

    def test_a_dry_report_removes_nothing(self):
        a = _touch(self.backups / "code-pre-a-1.tgz", age_days=3)
        _touch(self.backups / "code-pre-b-1.tgz", age_days=2)
        _touch(self.backups / "code-pre-c-1.tgz", age_days=1)
        rep = housekeeping.report()
        row = next(r for r in rep["stale"] if r["label"].startswith("Code rollback"))
        self.assertEqual(row["count"], 1)
        self.assertTrue(a.exists())

    def test_the_endpoint_is_for_deployment_admins(self):
        user = User.objects.create_user("plain", password="x")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/api/backups/housekeeping/").status_code, 403)
        admin = User.objects.create_superuser("admin", "a@x.y", "x")
        self.client.force_login(admin)
        _touch(self.backups / "code-pre-a-1.tgz", age_days=3)
        _touch(self.backups / "code-pre-b-1.tgz", age_days=2)
        _touch(self.backups / "code-pre-c-1.tgz", age_days=1)
        r = self.client.post("/api/backups/housekeeping/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(list(self.backups.glob("code-pre-*.tgz"))), 2)

    def test_keeping_zero_upgrade_backups_is_refused(self):
        from core.deployment import DeploymentSettingsSerializer

        ser = DeploymentSettingsSerializer(
            DeploymentSettings.load(), data={"upgrade_backups_keep": 0}, partial=True
        )
        self.assertFalse(ser.is_valid())
        self.assertIn("upgrade_backups_keep", ser.errors)
