"""Schedule due-ness and the tick command."""
from __future__ import annotations

from datetime import datetime, timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from backups.models import Backup, BackupSchedule, BackupTarget
from backups.schedules import due_schedules, fire_schedule, is_due


class ScheduleTests(TestCase):
    def setUp(self):
        self.target = BackupTarget.objects.create(name="Local", kind="local", config={"path": "/tmp/x"},
                                                  is_default=True)
        self.s = BackupSchedule.objects.create(
            name="nightly", components=["db"], target=self.target,
            cadence={"frequency": "daily", "at": "02:00"},
        )

    def _at(self, y, m, d, hh, mm):
        return timezone.make_aware(datetime(y, m, d, hh, mm))

    def test_never_run_waits_for_the_first_occurrence_after_creation(self):
        BackupSchedule.objects.filter(pk=self.s.pk).update(created_at=self._at(2026, 9, 8, 10, 0))
        self.s.refresh_from_db()
        self.assertFalse(is_due(self.s, self._at(2026, 9, 8, 12, 0)))
        self.assertTrue(is_due(self.s, self._at(2026, 9, 9, 2, 5)))

    def test_fires_once_per_occurrence(self):
        BackupSchedule.objects.filter(pk=self.s.pk).update(created_at=self._at(2026, 9, 8, 10, 0))
        self.s.refresh_from_db()
        now = self._at(2026, 9, 9, 2, 5)
        with mock.patch("backups.schedules.enqueue_backup") as enq:
            b = fire_schedule(self.s, now)
        enq.assert_called_once()
        self.s.refresh_from_db()
        self.assertEqual(self.s.last_run_at, now)
        self.assertEqual((b.kind, b.schedule_id, b.components), ("scheduled", self.s.id, ["db"]))
        self.assertFalse(is_due(self.s, now + timedelta(minutes=5)))
        self.assertTrue(is_due(self.s, now + timedelta(days=1)))

    def test_disabled_and_bad_cadence_never_due(self):
        BackupSchedule.objects.filter(pk=self.s.pk).update(
            created_at=self._at(2026, 9, 1, 0, 0), enabled=False)
        self.assertEqual(due_schedules(self._at(2026, 9, 9, 3, 0)), [])
        BackupSchedule.objects.filter(pk=self.s.pk).update(enabled=True, cadence={"frequency": "yearly"})
        self.assertEqual(due_schedules(self._at(2026, 9, 9, 3, 0)), [])

    def test_tick_command(self):
        BackupSchedule.objects.filter(pk=self.s.pk).update(created_at=timezone.now() - timedelta(days=3))
        out = StringIO()
        with mock.patch("backups.schedules.enqueue_backup"):
            call_command("run_backups", stdout=out)
        self.assertIn("started 1", out.getvalue())
        self.assertEqual(Backup.objects.filter(schedule=self.s).count(), 1)
        out = StringIO()
        with mock.patch("backups.schedules.enqueue_backup"):
            call_command("run_backups", stdout=out)
        self.assertIn("nothing due", out.getvalue())


class ReapTests(TestCase):
    def test_stalled_rows_are_marked_failed(self):
        from datetime import timedelta

        from django.utils import timezone

        from backups.engine import in_progress, reap_stale

        target = BackupTarget.objects.create(name="L", kind="local", config={"path": "/tmp/x"})
        fresh = Backup.objects.create(kind="manual", target=target, components=["db"], status="running")
        stuck = Backup.objects.create(kind="manual", target=target, components=["db"], status="running",
                                      steps=[{"name": "database", "status": "running"}])
        Backup.objects.filter(pk=stuck.pk).update(updated_at=timezone.now() - timedelta(hours=2))
        self.assertEqual(list(in_progress()), [fresh])
        self.assertEqual(reap_stale(), 1)
        stuck.refresh_from_db()
        self.assertEqual(stuck.status, "failed")
        self.assertEqual(stuck.steps[-1]["status"], "failed")
        fresh.refresh_from_db()
        self.assertEqual(fresh.status, "running")
