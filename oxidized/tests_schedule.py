"""Automatic node sync per Oxidized connection (#385).

``oxidized_sync`` runs every minute and enqueues one job per connection whose
own interval has elapsed. The job is the manual Sync nodes pass, re-checked
at run time, and a failure is recorded and backs off to the interval.
"""
from __future__ import annotations

import importlib
from datetime import timedelta
from unittest import mock

from django.core.management import call_command
from django.utils import timezone

from api.models import Device
from core.models import DeploymentSettings, ScheduledRun
from integrations.models import IntegrationSettings
from monitoring.tests_snmp_schedule import FakeQueue, FakeRedis

from . import schedule
from .models import OxidizedConnection, OxidizedNodeLink
from .sync import sync_nodes
from .tests import FAKE, _Base, node


class _SchedBase(_Base):
    def setUp(self):
        super().setUp()
        self.conn.auto_sync = True
        self.conn.sync_interval_minutes = 30
        self.conn.save()
        self.redis, self.queue = FakeRedis(), FakeQueue()
        for p in (
            mock.patch("oxidized.schedule._conn", return_value=self.redis),
            mock.patch("oxidized.schedule._queue", return_value=self.queue),
        ):
            p.start()
            self.addCleanup(p.stop)

    def stamp(self, minutes_ago):
        self.conn.last_sync_attempt_at = timezone.now() - timedelta(minutes=minutes_ago)
        self.conn.save()

    def run_jobs(self):
        out = [fn(*args) for fn, args in self.queue.jobs]
        self.queue.jobs.clear()
        return out


class DefaultsTests(_SchedBase):
    def test_a_new_connection_syncs_every_30_minutes(self):
        self.login()
        r = self.client.post("/api/oxidized/connections/", {
            "name": "new", "url": "https://ox.example.com",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["auto_sync"])
        self.assertEqual(r.json()["sync_interval_minutes"], 30)

    def test_the_migration_leaves_existing_connections_off(self):
        mig = importlib.import_module("oxidized.migrations.0003_auto_sync").Migration
        add = next(op for op in mig.operations
                   if getattr(op, "name", "") == "auto_sync" and op.__class__.__name__ == "AddField")
        self.assertFalse(add.field.default)

    def test_the_interval_is_one_of_the_offered_values(self):
        self.login()
        url = f"/api/oxidized/connections/{self.conn.id}/"
        for good in (5, 10, 15, 30, 60):
            r = self.client.patch(url, {"sync_interval_minutes": good}, format="json")
            self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(url, {"sync_interval_minutes": 7}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_the_card_shows_last_and_next(self):
        self.stamp(10)
        self.login()
        row = self.client.get(f"/api/oxidized/connections/{self.conn.id}/").json()
        attempt = self.conn.last_sync_attempt_at
        self.assertEqual(
            row["next_sync_at"], (attempt + timedelta(minutes=30)).isoformat()
        )
        self.client.patch(
            f"/api/oxidized/connections/{self.conn.id}/", {"auto_sync": False}, format="json"
        )
        row = self.client.get(f"/api/oxidized/connections/{self.conn.id}/").json()
        self.assertIsNone(row["next_sync_at"])


class DueTests(_SchedBase):
    def test_never_synced_is_due(self):
        self.assertTrue(schedule.is_due(self.conn))

    def test_due_once_the_interval_has_passed(self):
        self.stamp(20)
        self.assertFalse(schedule.is_due(self.conn))
        self.stamp(30)
        self.assertTrue(schedule.is_due(self.conn))

    def test_a_shorter_interval(self):
        self.conn.sync_interval_minutes = 5
        self.stamp(6)
        self.assertTrue(schedule.is_due(self.conn))

    def test_off_or_disabled_is_never_due(self):
        self.conn.auto_sync = False
        self.assertFalse(schedule.is_due(self.conn))
        self.assertIsNone(schedule.next_sync_at(self.conn))
        self.conn.auto_sync, self.conn.enabled = True, False
        self.assertFalse(schedule.is_due(self.conn))


class DispatchTests(_SchedBase):
    def test_a_due_connection_is_enqueued_once(self):
        r = schedule.dispatch()
        self.assertEqual((r["due"], r["enqueued"]), (1, 1))
        self.assertEqual(self.queue.jobs[0][1], (str(self.conn.id), str(self.tenant.id)))
        # The next tick, the job still queued: claimed, not enqueued again.
        r = schedule.dispatch()
        self.assertEqual((r["due"], r["enqueued"], r["claimed"]), (1, 0, 1))
        self.assertEqual(len(self.queue.jobs), 1)

    def test_not_due_is_not_enqueued(self):
        self.stamp(5)
        r = schedule.dispatch()
        self.assertEqual((r["connections"], r["due"], r["enqueued"]), (1, 0, 0))

    def test_switched_off_connections_are_left_alone(self):
        self.conn.auto_sync = False
        self.conn.save()
        self.assertEqual(schedule.dispatch().get("enabled"), False)
        self.conn.auto_sync, self.conn.enabled = True, False
        self.conn.save()
        self.assertEqual(schedule.dispatch().get("enabled"), False)
        self.assertEqual(self.queue.jobs, [])

    def test_an_inactive_tenant_or_integration_off_is_left_alone(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=False)
        self.assertEqual(schedule.dispatch()["enqueued"], 0)
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=True)
        self.tenant.is_active = False
        self.tenant.save()
        self.assertEqual(schedule.dispatch()["enqueued"], 0)
        self.assertEqual(self.queue.jobs, [])

    def test_the_command_records_its_run(self):
        call_command("oxidized_sync", stdout=mock.MagicMock())
        run = ScheduledRun.objects.filter(name="oxidized-sync").latest("started_at")
        self.assertIn("enqueued 1 of 1", run.summary)


class JobTests(_SchedBase):
    def test_the_job_syncs_keeps_pins_and_drops_gone_nodes(self):
        pinned_dev = Device.objects.create(tenant=self.tenant, name="p", site=self.site_a)
        self.link(full="gone")  # matched to sw1, node no longer in Oxidized
        self.link(device=pinned_dev, full="grp/pinned", how=OxidizedNodeLink.HOW_MANUAL)
        FAKE["nodes"] = [node("pinned", group="grp"), node("new", ip="10.9.0.10")]
        schedule.dispatch()
        self.assertEqual(self.run_jobs(), ["synced"])
        got = dict(OxidizedNodeLink.objects.values_list("full_name", "matched_by"))
        self.assertEqual(got, {"grp/pinned": "manual", "new": "address"})
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_sync_at)
        self.assertEqual(self.conn.last_sync_at, self.conn.last_sync_attempt_at)
        self.assertEqual(self.conn.last_sync_summary["linked"], 1)
        # The claim is released, and the connection is not due again yet.
        self.assertFalse(self.redis.exists(schedule.claim_key(self.conn.id)))
        self.assertEqual(schedule.dispatch()["enqueued"], 0)

    def test_a_pinned_link_whose_node_is_gone_stays(self):
        self.link(full="vanished", how=OxidizedNodeLink.HOW_MANUAL)
        FAKE["nodes"] = []
        schedule.dispatch()
        self.run_jobs()
        self.assertEqual(OxidizedNodeLink.objects.get().full_name, "vanished")
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_summary["missing_pinned"], 1)

    def test_the_job_rechecks_everything(self):
        cases = [
            ("off", lambda c: setattr(c, "auto_sync", False)),
            ("off", lambda c: setattr(c, "enabled", False)),
        ]
        for want, change in cases:
            self.conn.refresh_from_db()
            self.conn.auto_sync, self.conn.enabled = True, True
            self.conn.save()
            schedule.dispatch()
            change(self.conn)
            self.conn.save()
            self.assertEqual(self.run_jobs(), [want])
            self.assertFalse(self.redis.exists(schedule.claim_key(self.conn.id)))
        self.assertEqual(FAKE["requests"], [])

    def test_the_job_rechecks_the_tenant_and_the_switch(self):
        self.conn.refresh_from_db()
        schedule.dispatch()
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=False)
        self.assertEqual(self.run_jobs(), ["skipped"])
        IntegrationSettings.objects.filter(tenant=self.tenant).update(oxidized_enabled=True)
        schedule.dispatch()
        self.tenant.is_active = False
        self.tenant.save()
        self.assertEqual(self.run_jobs(), ["skipped"])
        self.assertEqual(FAKE["requests"], [])

    def test_a_deleted_connection_or_a_foreign_tenant_id_is_gone(self):
        self.assertEqual(
            schedule.run_scheduled_sync(str(self.conn.id), str(self.other_tenant.id)), "gone"
        )
        schedule.dispatch()
        self.conn.delete()
        self.assertEqual(self.run_jobs(), ["gone"])

    def test_a_manual_sync_since_the_enqueue_wins(self):
        schedule.dispatch()
        sync_nodes(self.conn)
        self.assertEqual(self.run_jobs(), ["not due"])

    def test_a_failure_is_recorded_and_backs_off(self):
        FAKE["nodes"] = [node("sw1")]
        sync_nodes(self.conn)  # one good sync first
        self.conn.refresh_from_db()
        good_at = self.conn.last_sync_at
        self.stamp(31)
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = []  # Oxidized now unreachable
        ds.save()
        schedule.dispatch()
        self.assertEqual(self.run_jobs(), ["error"])
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_at, good_at)  # last *successful*
        self.assertGreater(self.conn.last_sync_attempt_at, good_at)
        self.assertIn("non-public", self.conn.last_error)
        self.assertIn("non-public", self.conn.last_sync_summary["error"])
        self.assertEqual(self.conn.last_sync_summary["linked"], 1)  # counts kept
        self.assertEqual(OxidizedNodeLink.objects.count(), 1)  # links untouched
        self.assertFalse(self.redis.exists(schedule.claim_key(self.conn.id)))
        # Not retried on the next tick: once per interval.
        self.assertEqual(schedule.dispatch()["enqueued"], 0)
        self.login()
        row = self.client.get(f"/api/oxidized/connections/{self.conn.id}/").json()
        self.assertIn("non-public", row["sync"]["error"])

    def test_an_unexpected_exception_is_recorded(self):
        schedule.dispatch()
        with mock.patch("oxidized.sync.sync_nodes", side_effect=RuntimeError("boom")):
            self.assertEqual(self.run_jobs(), ["error"])
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_error, "boom")
        self.assertIsNotNone(self.conn.last_sync_attempt_at)
        self.assertIsNone(self.conn.last_sync_at)
        self.assertFalse(self.redis.exists(schedule.claim_key(self.conn.id)))

    def test_success_clears_the_error(self):
        self.conn.last_error = "old"
        self.conn.last_sync_summary = {"error": "old"}
        self.conn.save()
        schedule.dispatch()
        self.assertEqual(self.run_jobs(), ["synced"])
        self.conn.refresh_from_db()
        self.assertEqual((self.conn.last_error, self.conn.last_sync_summary["error"]), ("", ""))
