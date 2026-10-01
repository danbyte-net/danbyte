"""The auto-upgrade tick: which release it picks, when it tries again, and
how the admins hear about an upgrade nobody watched."""
from __future__ import annotations

import time
from unittest.mock import patch

from django.core import mail
from django.test import TestCase, override_settings

from core.auto_upgrade import RETRY_DELAYS, check_and_upgrade
from core.models import DeploymentSettings, ScheduledRun


def _rel(tag: str, prerelease: bool = False) -> dict:
    return {"tag": tag, "name": tag, "body": "", "published_at": None,
            "prerelease": prerelease, "has_binary": False}


class TickTestCase(TestCase):
    def setUp(self):
        s = DeploymentSettings.load()
        s.auto_update_enabled = True
        s.update_window_days = s.update_window_start = s.update_window_end = ""
        s.update_channel = "any"
        s.save()
        self.status: dict = {"state": "idle"}
        for target, kw in (
            ("core.upgrade._read_status", {"side_effect": lambda: dict(self.status)}),
            ("core.upgrade._acquire_upgrade_lock", {"return_value": "owner"}),
            ("core.upgrade._upgrade_running", {"return_value": False}),
            ("core.version.system_version", {"return_value": {"version": "0.17.0-dev1"}}),
        ):
            p = patch(target, **kw)
            p.start()
            self.addCleanup(p.stop)
        self.start = patch("core.upgrade.start_upgrade").start()
        self.addCleanup(patch.stopall)

    def tick(self, releases: list[dict]) -> dict:
        with patch("core.github.list_releases", return_value=releases):
            return check_and_upgrade()


class TargetTests(TickTestCase):
    def test_the_newest_release_wins_whatever_order_the_repo_lists(self):
        r = self.tick([_rel("v0.17.0-dev2", True), _rel("v0.17.0"), _rel("v0.17.0-dev3", True)])
        self.assertEqual(r["upgrading"], "v0.17.0")
        self.start.assert_called_once_with("v0.17.0", "owner", trigger="auto", attempt=1)

    def test_a_dev_install_moves_to_the_next_pre_release_on_the_any_channel(self):
        self.assertEqual(self.tick([_rel("v0.17.0-dev2", True)])["upgrading"], "v0.17.0-dev2")

    def test_the_stable_channel_takes_finals_only(self):
        s = DeploymentSettings.load()
        s.update_channel = "stable"
        s.save()
        # a tag that is a pre-release by its name, even if the repo forgot to say so
        r = self.tick([_rel("v0.17.0-dev2", True), _rel("v0.17.0-rc1")])
        self.assertEqual(r["skipped"], "up_to_date")
        self.assertEqual(self.tick([_rel("v0.17.0"), _rel("v0.18.0-dev1", True)])["upgrading"],
                         "v0.17.0")

    def test_never_a_downgrade(self):
        self.assertEqual(self.tick([_rel("v0.16.13"), _rel("v0.17.0-dev1", True)])["skipped"],
                         "up_to_date")


class RetryTests(TickTestCase):
    def failed(self, *, retryable: bool, attempt: int = 1, ago: float = 0.0) -> None:
        self.status = {"state": "failed", "step": "prepare", "version_to": "0.17.0-dev2",
                       "error": "npm ci failed", "stage_api": 1, "trigger": "auto",
                       "retryable": retryable, "attempt": attempt,
                       "finished_at": time.time() - ago, "reported": True}

    def test_a_rolled_back_upgrade_waits_for_a_person(self):
        self.failed(retryable=False, ago=10 * 24 * 3600)
        r = self.tick([_rel("v0.17.0-dev2", True)])
        self.assertEqual(r["skipped"], "failed_before")
        self.start.assert_not_called()

    def test_a_failure_before_the_downtime_is_retried_after_a_pause(self):
        self.failed(retryable=True, ago=RETRY_DELAYS[0] - 60)
        self.assertEqual(self.tick([_rel("v0.17.0-dev2", True)])["skipped"], "retry_later")
        self.failed(retryable=True, ago=RETRY_DELAYS[0] + 60)
        r = self.tick([_rel("v0.17.0-dev2", True)])
        self.assertEqual((r["upgrading"], r["attempt"]), ("v0.17.0-dev2", 2))
        self.start.assert_called_once_with("v0.17.0-dev2", "owner", trigger="auto", attempt=2)

    def test_the_pause_grows_and_the_retries_stop(self):
        self.failed(retryable=True, attempt=2, ago=RETRY_DELAYS[0] + 60)
        self.assertEqual(self.tick([_rel("v0.17.0-dev2", True)])["skipped"], "retry_later")
        self.failed(retryable=True, attempt=len(RETRY_DELAYS) + 1, ago=30 * 24 * 3600)
        self.assertEqual(self.tick([_rel("v0.17.0-dev2", True)])["skipped"], "failed_before")
        self.start.assert_not_called()

    def test_a_newer_release_moves_on_from_a_failed_one(self):
        self.failed(retryable=False)
        self.assertEqual(self.tick([_rel("v0.17.0-dev3", True)])["upgrading"], "v0.17.0-dev3")


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class ReportTests(TickTestCase):
    def setUp(self):
        super().setUp()
        s = DeploymentSettings.load()
        s.digest_recipients = "ops@example.test"
        s.auto_update_enabled = False
        s.save()
        self.written: list[dict] = []
        p = patch("core.upgrade._write_status_fields",
                  side_effect=lambda **kw: (self.written.append(kw), self.status.update(kw)))
        p.start()

    def finished(self, **kw) -> None:
        self.status = {"state": "done", "step": "done", "version_to": "0.17.0-dev2",
                       "version_from": "0.17.0-dev1", "stage_api": 1, "trigger": "auto",
                       "started_at": 1790000000, "finished_at": 1790000300,
                       "outcome": {"code": "new", "database": "migrated", "services": "running",
                                   "backup": "abc"}, "warnings": [], **kw}

    def test_an_unattended_upgrade_is_reported_once_even_with_auto_update_off(self):
        self.finished()
        self.assertEqual(self.tick([])["skipped"], "disabled")
        run = ScheduledRun.objects.get(name="upgrade")
        self.assertEqual(run.status, ScheduledRun.OK)
        self.assertIn("0.17.0-dev2", run.summary)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Automatic upgrade to 0.17.0-dev2 finished", mail.outbox[0].subject)
        self.assertEqual(self.written, [{"reported": True}])
        self.tick([])
        self.assertEqual(ScheduledRun.objects.filter(name="upgrade").count(), 1)
        self.assertEqual(len(mail.outbox), 1)

    def test_the_record_keeps_it_from_repeating_when_the_flag_could_not_be_written(self):
        self.finished()
        self.tick([])
        self.status.pop("reported")
        self.tick([])
        self.assertEqual(ScheduledRun.objects.filter(name="upgrade").count(), 1)

    def test_any_failed_upgrade_is_reported_with_what_happened(self):
        self.finished(state="failed", step="verify", trigger="button",
                      error="the new release does not run on this database - rolled back",
                      outcome={"code": "restored", "database": "restored",
                               "services": "running", "backup": "abc"})
        self.tick([])
        run = ScheduledRun.objects.get(name="upgrade")
        self.assertEqual(run.status, ScheduledRun.FAILED)
        self.assertIn("Upgrade to 0.17.0-dev2 failed", mail.outbox[0].subject)
        self.assertIn("Step verify", mail.outbox[0].body)

    def test_a_watched_upgrade_that_worked_is_not_mailed(self):
        self.finished(trigger="button")
        self.tick([])
        self.assertFalse(ScheduledRun.objects.filter(name="upgrade").exists())
        self.assertEqual(mail.outbox, [])

    def test_an_old_upgraders_status_is_not_reported(self):
        self.finished()
        del self.status["stage_api"]
        self.tick([])
        self.assertFalse(ScheduledRun.objects.filter(name="upgrade").exists())


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class LegacyReportTests(TestCase):
    """The first upgrade off 0.16 is run by 0.16's upgrader, whose status says
    neither who started it nor how it ended. The bridge records that and its
    restart merges it in (``upgrade_report --merge-legacy``); the next tick
    then reports it like one the stage ran."""

    #: What 0.16.13's bundle upgrader leaves, and the bridge's record.
    OLD_DONE = ('{"state":"done","step":"done","pct":100,"version_to":"uploaded",'
                '"version_from":"0.16.13","error":""}\n')
    RECORD = {"trigger": "auto", "version_from": "0.16.13", "version_to": "v0.17.0",
              "kind": "bundle", "backup": "b1", "started_at": 1790833226.7}

    def setUp(self):
        import json
        import shutil
        import tempfile
        from pathlib import Path

        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.status_file = tmp / ".upgrade-status.json"
        self.status_file.write_text(self.OLD_DONE)
        self.record = tmp / "legacy-resume-T.units.report.json"
        self.record.write_text(json.dumps(self.RECORD))
        for name, value in (("STATUS_FILE", self.status_file),
                            ("LOCK_GUARD_FILE", tmp / ".upgrade.lock.guard")):
            p = patch(f"core.upgrade.{name}", value)
            p.start()
            self.addCleanup(p.stop)
        s = DeploymentSettings.load()
        s.digest_recipients = "ops@example.test"
        s.auto_update_enabled = False
        s.save()

    def status(self) -> dict:
        import json

        return json.loads(self.status_file.read_text())

    def merge(self) -> str:
        from io import StringIO

        from django.core.management import call_command

        out = StringIO()
        call_command("upgrade_report", "--merge-legacy", str(self.record), stdout=out)
        return out.getvalue()

    def test_a_finished_legacy_upgrade_is_reported_once(self):
        import os

        os.utime(self.status_file, (1790833370, 1790833370))
        self.assertIn("0.16.13 -> v0.17.0 (auto)", self.merge())
        st = self.status()
        self.assertEqual(st, {"state": "done", "step": "done", "pct": 100, "error": "",
                              "version_to": "v0.17.0", "version_from": "0.16.13",
                              "legacy": True, "trigger": "auto", "kind": "bundle",
                              "started_at": 1790833226.7, "finished_at": 1790833370.0,
                              "outcome": {"code": "new", "database": "migrated",
                                          "services": "running", "backup": "b1"}})
        with patch("core.github.list_releases", return_value=[]):
            self.assertEqual(check_and_upgrade()["skipped"], "disabled")
            check_and_upgrade()
        run = ScheduledRun.objects.get(name="upgrade")
        self.assertEqual(run.status, ScheduledRun.OK)
        self.assertEqual(run.detail["version_to"], "v0.17.0")
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Automatic upgrade to v0.17.0 finished", mail.outbox[0].subject)
        self.assertIn("Danbyte now runs v0.17.0.", mail.outbox[0].body)
        self.assertTrue(self.status()["reported"])

    def test_a_watched_one_shows_but_is_not_mailed(self):
        import json

        self.record.write_text(json.dumps({**self.RECORD, "trigger": "button"}))
        self.merge()
        self.assertEqual(self.status()["trigger"], "button")
        with patch("core.github.list_releases", return_value=[]):
            check_and_upgrade()
        self.assertFalse(ScheduledRun.objects.filter(name="upgrade").exists())
        self.assertEqual(mail.outbox, [])

    def test_only_a_finished_old_status_takes_it(self):
        import json

        cases = {
            "failed (the older release is back and reports nothing)":
                self.OLD_DONE.replace('"done","step":"done"', '"failed","step":"migrate"'),
            "the stage's own": json.dumps({"state": "done", "stage_api": 1, "trigger": "button"}),
            "merged before": json.dumps({"state": "done", "legacy": True, "trigger": "button"}),
            "unreadable": "{",
        }
        for name, text in cases.items():
            with self.subTest(name):
                self.status_file.write_text(text)
                self.assertIn("nothing to merge", self.merge())
                self.assertEqual(self.status_file.read_text(), text)
        with self.subTest("no record"):
            self.status_file.write_text(self.OLD_DONE)
            self.record.unlink()
            self.assertIn("nothing to merge", self.merge())
            self.assertEqual(self.status_file.read_text(), self.OLD_DONE)

    def test_a_record_with_odd_values_keeps_the_old_ones(self):
        import json

        self.record.write_text(json.dumps({"trigger": "shell", "version_to": " ",
                                           "started_at": "soon", "kind": "rpm", "backup": 3}))
        self.merge()
        st = self.status()
        self.assertEqual((st["version_to"], st["outcome"]["backup"]), ("uploaded", ""))
        for key in ("trigger", "started_at", "kind"):
            self.assertNotIn(key, st)
