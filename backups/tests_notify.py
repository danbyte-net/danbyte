"""Who hears about a backup: the schedule's channels, and admins on failure."""
from __future__ import annotations

from unittest import mock

from django.core import mail
from django.test import TestCase, override_settings

from backups.models import Backup, BackupSchedule, BackupTarget, RestoreRun
from backups.notify import notify_backup, notify_restore
from core.models import DeploymentSettings, Organization, Tenant
from monitoring.models import NotificationChannel


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class NotifyTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.target = BackupTarget.objects.create(name="Local", kind="local", config={"path": "/tmp/x"})
        self.slack = NotificationChannel.objects.create(
            tenant=self.tenant, name="ops", kind="slack", config={"url": "https://hooks.example/x"}
        )
        self.schedule = BackupSchedule.objects.create(
            name="Nightly", components=["db"], target=self.target, cadence={"frequency": "daily"}
        )
        self.schedule.notify_channels.add(self.slack)
        DeploymentSettings.objects.update_or_create(
            pk=DeploymentSettings.load().pk, defaults={"digest_recipients": "a@e.com, b@e.com"}
        )

    def _backup(self, **kw):
        base = dict(kind="scheduled", schedule=self.schedule, target=self.target, components=["db"],
                    status="success", filename="x.dbk", size=3 * 2**20)
        base.update(kw)
        return Backup.objects.create(**base)

    def test_success_reaches_the_schedule_channels_only(self):
        with mock.patch("monitoring.notify.safe_post") as post:
            notify_backup(self._backup())
        post.assert_called_once()
        self.assertIn("Backup completed: x.dbk", post.call_args.kwargs["json"]["text"])
        self.assertEqual(len(mail.outbox), 0)

    def test_failure_also_mails_the_digest_recipients(self):
        b = self._backup(status="failed", error="pg_dump: boom",
                         steps=[{"name": "database", "status": "failed"}])
        with mock.patch("monitoring.notify.safe_post") as post:
            notify_backup(b)
        self.assertIn("Step database: pg_dump: boom", post.call_args.kwargs["json"]["text"])
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(sorted(mail.outbox[0].to), ["a@e.com", "b@e.com"])
        self.assertIn("Backup failed", mail.outbox[0].subject)

    def test_manual_success_is_silent(self):
        with mock.patch("monitoring.notify.safe_post") as post:
            notify_backup(self._backup(kind="manual", schedule=None))
        post.assert_not_called()

    def test_restore_failure_names_the_safety_backup(self):
        b = self._backup()
        safety = self._backup(kind="pre_restore", schedule=None)
        run = RestoreRun.objects.create(backup=b, components=["db"], status="failed",
                                        error="boom", safety_backup=safety)
        with mock.patch("monitoring.notify.safe_post") as post:
            notify_restore(run)
        text = post.call_args.kwargs["json"]["text"]
        self.assertIn("Restore failed: x.dbk", text)
        self.assertIn("protected backup", text)
        self.assertEqual(len(mail.outbox), 1)

    def test_channel_kinds(self):
        b = self._backup(status="failed", error="e")
        for kind, cfg, key in (
            ("webhook", {"url": "https://h/x"}, "event"),
            ("discord", {"url": "https://h/x"}, "content"),
            ("pagerduty", {"routing_key": "rk"}, "routing_key"),
        ):
            self.slack.kind, self.slack.config = kind, cfg
            self.slack.save()
            with mock.patch("monitoring.notify.safe_post") as post:
                notify_backup(b)
            self.assertIn(key, post.call_args.kwargs["json"], kind)
