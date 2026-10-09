"""Schedule due-ness and the tick command."""
from __future__ import annotations

from datetime import datetime, timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
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


class QueueDownTests(TestCase):
    """A schedule whose backup cannot be queued stays due (#360)."""

    def setUp(self):
        self.target = BackupTarget.objects.create(name="Local", kind="local", config={"path": "/tmp/x"},
                                                  is_default=True)
        self.created = timezone.make_aware(datetime(2026, 9, 8, 10, 0))
        self.a = self._schedule("a-nightly")
        self.b = self._schedule("b-nightly")

    def _schedule(self, name):
        s = BackupSchedule.objects.create(
            name=name, components=["db"], target=self.target,
            cadence={"frequency": "daily", "at": "02:00"},
        )
        BackupSchedule.objects.filter(pk=s.pk).update(created_at=self.created)
        s.refresh_from_db()
        return s

    def _at(self, hh, mm, day=9):
        return timezone.make_aware(datetime(2026, 9, day, hh, mm))

    def _clock(self, now):
        return mock.patch("backups.management.commands.run_backups.timezone",
                          mock.Mock(localtime=mock.Mock(return_value=now)))

    def _redis_down(self):
        return mock.patch("django_rq.get_queue", side_effect=ConnectionError("redis down"))

    def test_queue_down_leaves_the_schedule_due_and_unstamped(self):
        from api.devicetype_import_tasks import QueueUnavailable

        with self._redis_down(), self.assertRaises(QueueUnavailable):
            fire_schedule(self.a, self._at(2, 5))
        self.a.refresh_from_db()
        self.assertIsNone(self.a.last_run_at)
        self.assertFalse(Backup.objects.filter(schedule=self.a).exists())
        self.assertTrue(is_due(self.a, self._at(2, 10)))

    def test_next_tick_retries_once_the_queue_is_back(self):
        from api.devicetype_import_tasks import QueueUnavailable

        with self._redis_down(), self.assertRaises(QueueUnavailable):
            fire_schedule(self.a, self._at(2, 5))
        with mock.patch("backups.schedules.enqueue_backup") as enq:
            fire_schedule(self.a, self._at(2, 10))
        enq.assert_called_once()
        self.a.refresh_from_db()
        self.assertEqual(self.a.last_run_at, self._at(2, 10))
        self.assertFalse(is_due(self.a, self._at(2, 15)))
        self.assertEqual(Backup.objects.filter(schedule=self.a).count(), 1)

    def test_manual_run_never_stamps(self):
        with mock.patch("backups.schedules.enqueue_backup"):
            fire_schedule(self.a, self._at(2, 5), kind="manual")
        self.a.refresh_from_db()
        self.assertIsNone(self.a.last_run_at)

    def test_tick_isolates_a_failing_schedule(self):
        from api.devicetype_import_tasks import QueueUnavailable

        def enqueue(backup):
            if backup.schedule_id == self.a.id:
                backup.delete()
                raise QueueUnavailable("redis down")
            return None

        now = self._at(2, 5)
        out, err = StringIO(), StringIO()
        with mock.patch("backups.schedules.enqueue_backup", side_effect=enqueue), \
                self._clock(now), \
                self.assertRaises(CommandError):
            call_command("run_backups", stdout=out, stderr=err)
        self.a.refresh_from_db()
        self.b.refresh_from_db()
        self.assertIsNone(self.a.last_run_at)
        self.assertEqual(self.b.last_run_at, now)
        self.assertEqual(Backup.objects.filter(schedule=self.b).count(), 1)
        self.assertIn("a-nightly", err.getvalue())

        from core.models import ScheduledRun

        run = ScheduledRun.objects.filter(name="backups").latest("started_at")
        self.assertEqual(run.status, ScheduledRun.FAILED)
        self.assertIn("a-nightly", run.summary)

        # Queue back: the next tick starts only the one that was missed.
        with mock.patch("backups.schedules.enqueue_backup"), \
                self._clock(self._at(2, 10)):
            call_command("run_backups", stdout=StringIO())
        self.a.refresh_from_db()
        self.assertEqual(self.a.last_run_at, self._at(2, 10))
        self.assertEqual(Backup.objects.filter(schedule=self.a).count(), 1)
        self.assertEqual(Backup.objects.filter(schedule=self.b).count(), 1)


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
