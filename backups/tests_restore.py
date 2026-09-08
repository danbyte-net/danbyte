"""Restore: preview checks, the run's step ladder, media swap, the
maintenance flag and the lock. The database replacement itself is
mocked - it would drop the test schema."""
from __future__ import annotations

import os
import tempfile
from unittest import mock

from django.test import TestCase, override_settings

from backups import maintenance
from backups.engine import create_backup, run_backup
from backups.models import Backup, RestoreRun
from backups.restore import RestoreError, create_restore, preview, run_restore
from backups.tests_engine import _fake_pg_dump
from core.models import Organization, Tenant


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.media = os.path.join(self.tmp.name, "media")
        os.makedirs(os.path.join(self.media, "documents"))
        with open(os.path.join(self.media, "documents", "a.pdf"), "wb") as fh:
            fh.write(b"%PDF one")
        self.plugins = os.path.join(self.tmp.name, "plugins_local")
        self.backups = os.path.join(self.tmp.name, "backups")
        self.override = override_settings(
            MEDIA_ROOT=self.media, DANBYTE_BACKUP_DIR=self.backups, PLUGIN_UPLOAD_DIR=self.plugins,
            MONITORING_SECRET_KEY="restore-test-key",
        )
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        Tenant.objects.create(org=org, name="T", slug="t")
        for target, value in (
            ("backups.engine.subprocess.run", _fake_pg_dump),
            ("backups.engine.shutil.which", lambda name: "/usr/bin/" + name),
        ):
            p = mock.patch(target, side_effect=value) if target.endswith("run") else mock.patch(target, new=value)
            p.start()
            self.addCleanup(p.stop)
        # Never touch the real (test) database schema.
        self.replace = mock.patch("backups.restore.replace_database")
        self.replace.start()
        self.addCleanup(self.replace.stop)
        p = mock.patch("backups.restore.call_command")
        self.cmd = p.start()
        self.addCleanup(p.stop)
        p = mock.patch("backups.restore.flush_queues")
        self.flush = p.start()
        self.addCleanup(p.stop)
        self.addCleanup(maintenance.leave)

    def _backup(self, components=("db", "media", "config")):
        b = run_backup(str(create_backup(kind="manual", components=list(components)).id))
        self.assertEqual(b.status, "success", b.error)
        return b


class PreviewTests(_Base):
    def test_preview_passes_for_a_fresh_archive(self):
        pv = preview(self._backup())
        self.assertTrue(pv["can_restore"], pv["checks"])
        self.assertEqual(pv["components"], ["db", "media", "config"])
        self.assertEqual(pv["media_files"], 1)
        self.assertIn("tenant", pv["counts"])

    def test_wrong_key_and_newer_archive_are_refused(self):
        b = self._backup()
        with override_settings(MONITORING_SECRET_KEY="another-host"):
            pv = preview(b)
        self.assertFalse(pv["can_restore"])
        self.assertIn("different MONITORING_SECRET_KEY", next(c["detail"] for c in pv["checks"] if c["name"] == "key"))
        b.manifest = {**b.manifest, "applied_migrations": [*b.manifest["applied_migrations"], "api.9999_future"]}
        b.save()
        with mock.patch("backups.restore._reader") as rd:
            rd.return_value.read_manifest.return_value = b.manifest
            pv = preview(b)
        self.assertFalse(pv["can_restore"])
        self.assertIn("newer Danbyte", next(c["detail"] for c in pv["checks"] if c["name"] == "migrations"))

    def test_create_restore_validates_components(self):
        b = self._backup(("db",))
        with self.assertRaises(RestoreError):
            create_restore(b, ["media"])
        run = create_restore(b, ["db"])
        self.assertEqual(run.components, ["db"])


class RunTests(_Base):
    def test_full_run_replaces_media_and_keeps_the_site_behind_503(self):
        b = self._backup()
        # change the live media after the backup, then restore
        os.remove(os.path.join(self.media, "documents", "a.pdf"))
        with open(os.path.join(self.media, "documents", "b.pdf"), "wb") as fh:
            fh.write(b"%PDF two")
        seen = {}

        def replace(dump):
            seen["dump"] = os.path.getsize(dump)
            seen["maintenance"] = maintenance.active()

        self.replace.stop()
        with mock.patch("backups.restore.replace_database", side_effect=replace):
            run = run_restore(str(create_restore(b, ["db", "media", "config"]).id))
        self.replace.start()
        self.assertEqual(run.status, "success", run.error)
        self.assertEqual([s["name"] for s in run.steps],
                         ["preview", "safety-backup", "download", "database", "reconcile", "media", "config", "finish"])
        self.assertGreater(seen["dump"], 0)
        self.assertIsNotNone(seen["maintenance"])  # the flag was up during the replacement
        self.assertIsNone(maintenance.active())     # and is down now
        # media is back to the archived state; the old tree is gone
        self.assertEqual(sorted(os.listdir(os.path.join(self.media, "documents"))), ["a.pdf"])
        self.assertFalse(any(n.startswith("media.pre-restore") for n in os.listdir(self.tmp.name)))
        # the safety backup exists and is protected
        self.assertIsNotNone(run.safety_backup)
        self.assertTrue(Backup.objects.get(pk=run.safety_backup_id).protected)
        self.assertEqual(run.safety_backup.kind, "pre_restore")
        # migrate + reindex ran, queues flushed
        names = [c.args[0] for c in self.cmd.call_args_list]
        self.assertEqual(names, ["migrate", "rebuild_search_index"])
        self.flush.assert_called_once()

    def test_rows_lost_with_the_database_come_back_and_orphans_are_adopted(self):
        """A restored database predates the run: the target, the archive, the
        safety backup and the run itself are reinstated, and an archive with
        no row (made after the archive's point in time) is adopted."""
        b = self._backup(("db",))
        later = self._backup(("db",))  # exists on disk; its row will be "lost"
        self.replace.stop()

        def wipe(dump):
            RestoreRun.objects.all().delete()
            Backup.objects.all().delete()
            b.target.__class__.objects.all().delete()

        with mock.patch("backups.restore.replace_database", side_effect=wipe):
            run = run_restore(str(create_restore(b, ["db"]).id))
        self.replace.start()
        self.assertEqual(run.status, "success", run.error)
        again = RestoreRun.objects.get(pk=run.pk)
        self.assertEqual(again.status, "success")
        self.assertEqual(again.safety_backup.kind, "pre_restore")
        self.assertTrue(again.safety_backup.protected)
        self.assertEqual(Backup.objects.get(pk=b.pk).status, "success")
        adopted = Backup.objects.get(filename=later.filename)
        self.assertNotEqual(adopted.pk, later.pk)
        self.assertEqual(adopted.kind, "manual")
        self.assertEqual(adopted.status, "success")
        self.assertEqual(next(s["detail"] for s in again.steps if s["name"] == "reconcile"), "1 archive(s) adopted")
        # progress mirror carries the final state for the dialog
        self.assertEqual(maintenance.progress(str(run.pk))["status"], "success")

    def test_failure_after_safety_backup_clears_the_flag(self):
        b = self._backup(("db",))
        self.replace.stop()
        with mock.patch("backups.restore.replace_database", side_effect=RuntimeError("pg_restore failed: boom")):
            run = run_restore(str(create_restore(b, ["db"]).id))
        self.replace.start()
        self.assertEqual(run.status, "failed")
        self.assertIn("boom", run.error)
        self.assertEqual(run.steps[-1]["name"], "database")
        self.assertEqual(run.steps[-1]["status"], "failed")
        self.assertIsNotNone(run.safety_backup)
        self.assertIsNone(maintenance.active())

    def test_refused_when_an_upgrade_holds_the_lock(self):
        b = self._backup(("db",))
        with mock.patch("backups.restore._acquire_upgrade_lock", return_value=None):
            run = run_restore(str(create_restore(b, ["db"]).id))
        self.assertEqual(run.status, "failed")
        self.assertIn("upgrade", run.error)
        self.assertEqual(RestoreRun.objects.get(pk=run.pk).steps, [])

    def test_lock_is_released_either_way(self):
        b = self._backup(("db",))
        with mock.patch("backups.restore._acquire_upgrade_lock", return_value="tok") as acq, \
             mock.patch("backups.restore._release_upgrade_lock") as rel:
            run_restore(str(create_restore(b, ["db"]).id))
        acq.assert_called_once()
        rel.assert_called_once_with("tok")
