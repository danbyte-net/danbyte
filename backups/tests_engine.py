"""The backup engine: steps, manifest, storage, retention, backup_now."""
from __future__ import annotations

import os
import tempfile
from datetime import timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from backups.archive import Reader
from backups.engine import create_backup, prune_schedule, run_backup
from backups.models import Backup, BackupSchedule, BackupTarget
from backups.seeds import default_target
from core.models import Organization, Tenant


def _fake_pg_dump(cmd, **kwargs):
    """Stand-in for pg_dump: writes a small file at the -f path."""
    dest = cmd[cmd.index("-f") + 1]
    with open(dest, "wb") as fh:
        fh.write(b"PGDMP fake dump " * 64)

    class R:
        returncode = 0
        stderr = ""

    return R()


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.media = os.path.join(self.tmp.name, "media")
        os.makedirs(os.path.join(self.media, "documents"))
        with open(os.path.join(self.media, "documents", "a.pdf"), "wb") as fh:
            fh.write(b"%PDF fake")
        with open(os.path.join(self.media, "documents", "upload.part"), "wb") as fh:
            fh.write(b"partial")
        self.backups = os.path.join(self.tmp.name, "backups")
        self.override = override_settings(
            MEDIA_ROOT=self.media, DANBYTE_BACKUP_DIR=self.backups,
            PLUGIN_UPLOAD_DIR=os.path.join(self.tmp.name, "plugins_local"),
            MONITORING_SECRET_KEY="engine-test-key",
        )
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        Tenant.objects.create(org=org, name="T", slug="t")
        self.pg = mock.patch("backups.engine.subprocess.run", side_effect=_fake_pg_dump)
        self.pg.start()
        self.addCleanup(self.pg.stop)
        self.which = mock.patch("backups.engine.shutil.which", return_value="/usr/bin/pg_dump")
        self.which.start()
        self.addCleanup(self.which.stop)


class BackupRunTests(_Base):
    def test_default_target_is_seeded_once(self):
        t = default_target()
        self.assertEqual((t.name, t.kind, t.config["path"]), ("Local", "local", self.backups))
        self.assertEqual(default_target().id, t.id)
        self.assertEqual(BackupTarget.objects.count(), 1)

    def test_full_backup_round_trip(self):
        b = create_backup(kind="manual", components=["db", "media", "config"])
        b = run_backup(str(b.id))
        self.assertEqual(b.status, "success", b.error)
        self.assertEqual([s["name"] for s in b.steps],
                         ["database", "media", "config", "archive", "upload", "verify"])
        self.assertTrue(all(s["status"] == "success" for s in b.steps))
        self.assertIn("-manual-", b.filename)
        self.assertTrue(b.filename.endswith(".dbk"))
        self.assertTrue(os.path.isfile(os.path.join(self.backups, b.filename)))
        self.assertEqual(b.size, os.path.getsize(b.location))
        m = b.manifest
        self.assertEqual(m["components"], ["db", "media", "config"])
        self.assertEqual(m["media_files"], 1)  # the .part upload is skipped
        self.assertIn("db.dump", m["files"])
        self.assertIn("api.0001_initial", " ".join(m["applied_migrations"]))
        self.assertEqual(m["counts"]["tenant"], 1)
        # the stored archive reads back with the same key
        r = Reader(lambda: b.target.backend().open(b.filename))
        self.assertEqual(r.read_manifest()["created_at"], m["created_at"])
        names = [x["name"] for x in r.members()]
        self.assertEqual(names, ["manifest.json", "db.dump", "media.tar", "config.json"])
        # the work dir is cleaned
        self.assertEqual(os.listdir(os.path.join(self.backups, ".work")), [])

    def test_config_holds_no_secrets(self):
        import json

        b = run_backup(str(create_backup(kind="manual", components=["config"]).id))
        r = Reader(lambda: b.target.backend().open(b.filename))
        out = os.path.join(self.tmp.name, "config.json")
        r.extract("config.json", out)
        with open(out) as fh:
            cfg = json.load(fh)
        text = json.dumps(cfg).lower()
        self.assertNotIn("engine-test-key", text)
        self.assertNotIn("password", " ".join(cfg["deployment_settings"].keys()))
        self.assertNotIn("MONITORING_SECRET_KEY", cfg["env"])
        self.assertNotIn("DB_PASSWORD", cfg["env"])

    def test_pg_dump_failure_lands_on_the_row(self):
        def boom(cmd, **kw):
            class R:
                returncode = 1
                stderr = "connection refused"
            return R()

        with mock.patch("backups.engine.subprocess.run", side_effect=boom):
            b = run_backup(str(create_backup(kind="manual", components=["db"]).id))
        self.assertEqual(b.status, "failed")
        self.assertIn("connection refused", b.error)
        self.assertEqual(b.steps[-1]["status"], "failed")
        self.assertEqual(b.filename, "")

    def test_backup_now_command(self):
        out = StringIO()
        call_command("backup_now", "--components", "db,config", "--kind", "pre_upgrade", stdout=out)
        bid, location = out.getvalue().split()
        b = Backup.objects.get(pk=bid)
        self.assertEqual((b.kind, b.status, b.components), ("pre_upgrade", "success", ["db", "config"]))
        self.assertTrue(os.path.isfile(location))


class RetentionTests(_Base):
    def _make(self, schedule, age_days, protected=False):
        b = run_backup(str(create_backup(kind="scheduled", components=["config"], schedule=schedule).id))
        Backup.objects.filter(pk=b.pk).update(
            finished_at=timezone.now() - timedelta(days=age_days), protected=protected
        )
        return Backup.objects.get(pk=b.pk)

    def test_prune_keeps_protected_and_other_schedules(self):
        target = default_target()
        # Retention is empty while the rows are made so the runs' own
        # pruning stays out of the way; then the rule is applied once.
        s1 = BackupSchedule.objects.create(name="daily", components=["config"], target=target,
                                           cadence={"frequency": "daily", "at": "02:00"})
        s2 = BackupSchedule.objects.create(name="weekly", components=["config"], target=target,
                                           cadence={"frequency": "weekly", "at": "02:00"})
        old = self._make(s1, 5)
        kept = self._make(s1, 4, protected=True)
        new = self._make(s1, 1)
        other = self._make(s2, 9)
        s1.retention = {"max_count": 1}
        s1.save()
        removed = prune_schedule(s1)
        self.assertEqual(removed, 1)
        self.assertFalse(Backup.objects.filter(pk=old.pk).exists())
        self.assertFalse(os.path.exists(old.location))
        self.assertTrue(Backup.objects.filter(pk__in=[kept.pk, new.pk, other.pk]).count() == 3)
        self.assertTrue(os.path.exists(new.location))
