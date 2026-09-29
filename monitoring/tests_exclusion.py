"""Excluding an address from monitoring: every check parks, nothing runs or
writes while it is excluded, it is left out of every count, and including it
again resumes - with who, when and why on the record."""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix, Site
from api.test_utils import status_for
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .checkers import CheckOutcome
from .exclusion import describe, excluded_ids, monitored, repark, set_excluded
from .models import (
    Alert,
    CheckAssignment,
    CheckResult,
    CheckState,
    CheckTemplate,
    MonitoringEngine,
    MonitoringSettings,
    StateTransition,
)


class _Base(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", status=status_for(self.tenant, "container"),
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5", prefix=self.prefix, site=self.site_a,
            assigned_device=self.device,
        )
        self.other = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.6", prefix=self.prefix, site=self.site_a,
            assigned_device=self.device,
        )
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp", rise=1, fall=1,
        )
        self.tcp = CheckTemplate.objects.create(
            tenant=self.tenant, name="ssh", slug="ssh", kind="tcp", params={"port": 22},
            rise=1, fall=1,
        )
        self.now = timezone.now()
        self.s1 = self.state(self.ip, self.ping, "down")
        self.s2 = self.state(self.ip, self.tcp, "up")
        self.s3 = self.state(self.other, self.ping, "up")
        self.user = User.objects.create_superuser("alice", "a@b.c", "pw")

    def state(self, ip, template, status, **kw):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=template, kind=template.kind,
            status=status, since=self.now - timedelta(hours=2),
            next_run=self.now - timedelta(seconds=5), **kw,
        )

    def exclude(self, ip=None, on=True, reason="", user="default"):
        with self.captureOnCommitCallbacks(execute=True):
            return set_excluded(
                ip or self.ip, on, self.user if user == "default" else user,
                reason=reason, now=self.now,
            )

    def fire(self, state):
        return Alert.objects.create(
            tenant=self.tenant, dedup_key=f"{state.target_ip_id}:{state.template_id}",
            target_ip=state.target_ip, template=state.template, kind=state.kind,
            severity="critical", check_status="down", opened_at=self.now,
            last_status_at=self.now,
        )


class ParkingTests(_Base):
    def test_every_check_parks_with_one_transition_and_the_alert_closes(self):
        alert = self.fire(self.s1)
        with mock.patch("monitoring.notify.notify_alert") as notify:
            self.assertTrue(self.exclude(reason="Host decommissioned"))
        for s in (self.s1, self.s2):
            s.refresh_from_db()
            self.assertEqual(s.status, "skipped")
            self.assertIsNone(s.next_run)
            self.assertFalse(s.in_flight)
        trs = StateTransition.objects.filter(target_ip=self.ip, to_status="skipped")
        self.assertEqual(trs.count(), 2)
        self.assertEqual(trs.first().detail["reason"], "excluded from monitoring")
        self.assertEqual(trs.first().detail["by"], "alice")
        self.assertEqual(trs.first().detail["note"], "Host decommissioned")
        alert.refresh_from_db()
        self.assertEqual(alert.status, "resolved")
        self.assertEqual(alert.detail["closed_by"], {"reason": "excluded", "by": "alice"})
        # Announced once, after the commit, as a close.
        notify.assert_called_once()
        self.assertEqual(notify.call_args[0][1], "resolved")
        # The other address is untouched.
        self.s3.refresh_from_db()
        self.assertEqual(self.s3.status, "up")
        self.assertIsNotNone(self.s3.next_run)

    def test_the_record_says_who_when_and_why(self):
        self.exclude(reason="Host decommissioned")
        self.ip.refresh_from_db()
        self.assertTrue(self.ip.monitoring_excluded)
        self.assertEqual(self.ip.monitoring_excluded_by, "alice")
        self.assertEqual(self.ip.monitoring_excluded_reason, "Host decommissioned")
        entry = ChangeLogEntry.objects.get(
            object_id=str(self.ip.id), changes__has_key="monitoring_excluded")
        self.assertEqual(entry.user_name, "alice")
        self.assertEqual(entry.changes["monitoring_excluded"], {"old": False, "new": True})
        note = JournalEntry.objects.get(object_id=str(self.ip.id))
        self.assertEqual(note.comments, "Excluded from monitoring. Reason: Host decommissioned")
        self.assertEqual(note.author_name, "alice")
        d = describe(self.ip)
        self.assertTrue(d["excluded"])
        self.assertEqual(d["excluded_by"], "alice")
        self.assertEqual(d["excluded_reason"], "Host decommissioned")

    def test_a_second_call_changes_nothing(self):
        self.exclude()
        self.assertFalse(self.exclude())
        self.assertEqual(StateTransition.objects.filter(to_status="skipped").count(), 2)
        self.assertEqual(ChangeLogEntry.objects.filter(
            object_id=str(self.ip.id), changes__has_key="monitoring_excluded").count(), 1)

    def test_parking_clears_a_flapping_flag_at_once(self):
        CheckState.objects.filter(pk=self.s1.pk).update(flapping_since=self.now, flap_count=5)
        self.exclude()
        self.s1.refresh_from_db()
        self.assertIsNone(self.s1.flapping_since)
        self.assertEqual(self.s1.flap_cleared_at, self.now)

    def test_the_closing_notice_names_who(self):
        from .notify import _alert_lead, _alert_summary

        alert = self.fire(self.s1)
        with mock.patch("monitoring.notify.notify_alert"):
            self.exclude()
        alert.refresh_from_db()
        text = _alert_summary(alert, "resolved", "10.9.0.5")
        self.assertTrue(text.startswith("[CLOSED]"), text)
        self.assertIn("excluded from monitoring by alice", text)
        self.assertIn("excluded from monitoring by alice", _alert_lead(alert, "resolved"))

    def test_status_change_channels_leave_parking_out(self):
        from .notify import _pending_rows

        self.exclude()
        ch = mock.Mock(tenant_id=self.tenant.id, on_statuses=[])
        with mock.patch("monitoring.notify._scope_allows", return_value=True):
            rows = _pending_rows(ch, self.now - timedelta(minutes=1), self.now + timedelta(1))
        self.assertEqual(rows, [])


class NothingRunsTests(_Base):
    def test_dispatch_runs_nothing(self):
        from .scheduler import dispatch

        CheckState.objects.filter(target_ip=self.other).update(next_run=None)
        self.exclude()
        with mock.patch("monitoring.scheduler.run_icmp_sweep") as icmp, \
                mock.patch("monitoring.scheduler.run_generic") as generic:
            out = dispatch(sync=True)
        self.assertEqual(out["due"], 0)
        icmp.assert_not_called()
        generic.assert_not_called()

    def test_a_row_selected_before_the_switch_is_not_claimed(self):
        from .scheduler import claim_states

        due = list(CheckState.objects.filter(target_ip=self.ip))
        self.exclude()
        self.assertEqual(claim_states(due, self.now), [])

    def test_the_reaper_does_not_revive_a_parked_row(self):
        from .scheduler import reap_stale_in_flight

        self.exclude()
        reap_stale_in_flight(self.now + timedelta(hours=1))
        self.s1.refresh_from_db()
        self.assertIsNone(self.s1.next_run)

    def test_a_new_check_on_an_excluded_address_starts_parked(self):
        from .scheduler import materialise_ip

        self.exclude()
        extra = CheckTemplate.objects.create(
            tenant=self.tenant, name="http", slug="http", kind="http",
        )
        CheckAssignment.objects.create(tenant=self.tenant, template=extra, ip_address=self.ip)
        with self.captureOnCommitCallbacks(execute=True):
            materialise_ip(IPAddress.objects.get(pk=self.ip.pk), now=self.now)
        st = CheckState.objects.get(target_ip=self.ip, template=extra)
        self.assertEqual(st.status, "skipped")
        self.assertIsNone(st.next_run)

    def test_a_job_that_sat_in_the_queue_does_not_dial(self):
        """Dispatched, then excluded before a worker picked the job up."""
        from .worker import run_generic

        ids = [str(self.s2.id)]
        CheckState.objects.filter(pk=self.s2.pk).update(in_flight=True, in_flight_since=self.now)
        IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=True)
        with mock.patch("monitoring.worker._run_generic_batch") as run:
            out = run_generic(ids)
        run.assert_not_called()
        self.assertEqual(out["checked"], 0)
        self.s2.refresh_from_db()
        self.assertEqual(self.s2.status, "skipped")
        self.assertIsNone(self.s2.next_run)

    def test_skip_listed_and_excluded_is_not_rescheduled(self):
        """The skip-list path writes next_run itself and never passes
        _persist; an excluded address must still end up parked."""
        from .worker import _mark_skipped

        IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=True)
        states = list(CheckState.objects.filter(target_ip=self.ip).select_related(
            "target_ip", "template", "assignment"))
        _mark_skipped(states, {})
        for s in CheckState.objects.filter(target_ip=self.ip):
            self.assertIsNone(s.next_run)
            self.assertEqual(s.status, "skipped")


class LateWritesTests(_Base):
    def test_a_result_claimed_before_the_switch_is_dropped(self):
        from .worker import ingest_results

        CheckState.objects.filter(target_ip=self.ip).update(
            in_flight=True, in_flight_since=self.now)
        self.exclude()
        n = ingest_results({str(self.s1.id): CheckOutcome("up", 1.0, {})})
        self.assertEqual(n, 0)
        self.assertFalse(CheckResult.objects.filter(target_ip=self.ip).exists())
        self.s1.refresh_from_db()
        self.assertEqual(self.s1.status, "skipped")

    def test_a_claim_that_raced_the_switch_is_parked_again(self):
        """A driver claim wrote in_flight over a parked row: the write guard
        sees the exclusion, drops the result and parks the row again."""
        from .worker import ingest_results

        self.exclude()
        CheckState.objects.filter(pk=self.s1.pk).update(
            in_flight=True, in_flight_since=self.now, next_run=self.now + timedelta(minutes=5))
        with self.captureOnCommitCallbacks(execute=True):
            ingest_results({str(self.s1.id): CheckOutcome("down", None, {})})
        self.s1.refresh_from_db()
        self.assertIsNone(self.s1.next_run)
        self.assertFalse(self.s1.in_flight)
        self.assertEqual(self.s1.status, "skipped")
        self.assertFalse(CheckResult.objects.filter(target_ip=self.ip).exists())

    def test_a_fast_lane_flush_writes_nothing_and_no_second_transition(self):
        from .worker import _persist

        self.exclude()
        before = StateTransition.objects.count()
        # The lane's in-memory copy still thinks it is up.
        stale = CheckState.objects.select_related("target_ip").get(pk=self.s2.pk)
        stale.status = "down"
        stale.next_run = self.now + timedelta(minutes=1)
        res = CheckResult(tenant=self.tenant, target_ip=self.ip, template=self.tcp,
                          kind="tcp", status="down", timestamp=self.now)
        tr = StateTransition(tenant=self.tenant, target_ip=self.ip, template=self.tcp,
                             kind="tcp", from_status="up", to_status="down", at=self.now)
        kept = _persist([res], [tr], [stale], self.now)
        self.assertEqual(kept, set())
        self.assertEqual(StateTransition.objects.count(), before)
        self.assertFalse(CheckResult.objects.filter(target_ip=self.ip).exists())
        self.s2.refresh_from_db()
        self.assertEqual(self.s2.status, "skipped")
        self.assertIsNone(self.s2.next_run)

    def test_dns_names_stay_on_their_own_address(self):
        """A dropped state must not shift the outcomes after it onto the
        wrong address (the pairs are filtered together)."""
        from .worker import _finalise

        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.dns_sync_enabled = True
        ms.save()
        third = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.7", prefix=self.prefix)
        s4 = self.state(third, self.ping, "up")
        CheckState.objects.filter(pk__in=[self.s1.pk, s4.pk, self.s3.pk]).update(
            in_flight=True, in_flight_since=self.now)
        states = list(CheckState.objects.filter(pk__in=[self.s1.pk, self.s3.pk, s4.pk])
                      .select_related("target_ip", "template", "assignment")
                      .order_by("target_ip__ip_address"))
        IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=True)
        outcomes = [
            CheckOutcome("up", 1.0, {"ptr": f"host-{s.target_ip.ip_address}.example"})
            for s in states
        ]
        from .worker import _load_settings

        _finalise(states, outcomes, _load_settings({self.tenant.id}))
        self.other.refresh_from_db()
        third.refresh_from_db()
        self.assertEqual(self.other.dns_name, "host-10.9.0.6.example")
        self.assertEqual(third.dns_name, "host-10.9.0.7.example")
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "")

    def test_check_now_that_raced_the_switch_is_discarded(self):
        """The switch landed while the checks ran: nothing is written."""
        from . import runner

        def fake(resolved, target):
            # The switch is thrown while the checks are out (the database
            # write happens before the event loop starts, as it would in
            # another request).
            IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=True)

            async def outcomes():
                return [runner.RunItem(rc, CheckOutcome("down", None, {})) for rc in resolved]

            return outcomes()

        CheckAssignment.objects.create(tenant=self.tenant, template=self.ping, ip_address=self.ip)
        with mock.patch.object(runner, "_run_all", fake):
            out = runner.check_now(IPAddress.objects.get(pk=self.ip.pk))
        self.assertEqual(out, [])
        self.assertFalse(CheckResult.objects.filter(target_ip=self.ip).exists())
        self.assertFalse(Alert.objects.filter(target_ip=self.ip).exists())

    def test_repark_reads_the_status_from_the_database(self):
        self.exclude()
        n = StateTransition.objects.count()
        self.assertEqual(repark([self.s1.id, self.s2.id]), 0)
        self.assertEqual(StateTransition.objects.count(), n)


class IncludeTests(_Base):
    def test_including_arms_the_checks_and_writes_no_transition(self):
        self.exclude()
        n = StateTransition.objects.count()
        a = CheckAssignment.objects.create(
            tenant=self.tenant, template=self.tcp, ip_address=self.ip, schedule_mode="custom_off")
        CheckState.objects.filter(pk=self.s2.pk).update(assignment=a)
        later = self.now + timedelta(minutes=5)
        with self.captureOnCommitCallbacks(execute=True):
            set_excluded(self.ip, False, self.user, now=later)
        self.s1.refresh_from_db()
        self.s2.refresh_from_db()
        self.assertEqual(self.s1.next_run, later)
        self.assertIsNone(self.s2.next_run)  # its own schedule has it off
        self.assertEqual(self.s1.status, "skipped")
        self.assertEqual(StateTransition.objects.count(), n)
        self.ip.refresh_from_db()
        self.assertFalse(self.ip.monitoring_excluded)
        self.assertIsNone(self.ip.monitoring_excluded_at)
        self.assertEqual(
            JournalEntry.objects.filter(object_id=str(self.ip.id)).first().comments,
            "Included in monitoring.",
        )

    def test_the_first_verdict_leaves_skipped(self):
        from .state import apply_outcome

        self.exclude()
        set_excluded(self.ip, False, self.user)
        self.s1.refresh_from_db()
        tr = apply_outcome(self.s1, rise=1, fall=1, outcome=CheckOutcome("up", 1, {}),
                           now=timezone.now())
        self.assertEqual(tr.from_status, "skipped")
        self.assertEqual(tr.to_status, "up")

    def test_an_unknown_answer_leaves_skipped_for_unknown(self):
        from .state import apply_outcome

        self.s1.status = "skipped"
        tr = apply_outcome(self.s1, rise=1, fall=1, outcome=CheckOutcome.unknown("x"),
                           now=timezone.now())
        self.assertEqual(tr.to_status, "unknown")

    def test_a_stale_full_save_is_healed(self):
        """Something wrote the switch back off without including properly:
        materialisation re-arms the parked checks."""
        from .exclusion import heal_orphans

        self.exclude()
        IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=False)
        self.assertEqual(heal_orphans(self.tenant, self.now), 2)
        self.s1.refresh_from_db()
        self.assertEqual(self.s1.next_run, self.now)


class FiguresTests(_Base):
    def test_uptime_counts_the_excluded_window_as_excluded(self):
        from .uptime import check_uptime

        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.tcp, kind="tcp",
            from_status="unknown", to_status="up", at=self.now - timedelta(hours=3))
        self.exclude()
        s = CheckState.objects.select_related("template").get(pk=self.s2.pk)
        out = check_uptime(s, self.now - timedelta(hours=4), self.now + timedelta(hours=1))
        self.assertEqual(out["up_seconds"], 3 * 3600)
        self.assertEqual(out["excluded_seconds"], 2 * 3600)
        self.assertEqual(out["uptime_pct"], 100.0)

    def test_segments_say_excluded_even_without_the_transition(self):
        """Retention prunes transitions after a year; the window still reads
        excluded from the exclusion on."""
        from .timeline import segments_for_pairs

        self.exclude()
        StateTransition.objects.all().delete()
        key = (str(self.ip.id), str(self.ping.id))
        segs = segments_for_pairs(self.tenant.id, [key], self.now - timedelta(hours=1),
                                  self.now + timedelta(hours=1))[key]
        self.assertEqual(segs[-1]["status"], "skipped")
        self.assertEqual(segs[-1]["note"], "excluded")
        self.assertEqual(segs[-1]["start"], self.now)

    def test_the_flapping_sweep_clears_it(self):
        from .flapping import sweep_flapping

        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.flap_threshold = 2
        ms.save()
        CheckState.objects.filter(pk=self.s1.pk).update(flapping_since=self.now, flap_count=3)
        IPAddress.objects.filter(pk=self.ip.pk).update(monitoring_excluded=True)
        out = sweep_flapping(self.now)
        self.assertEqual(out["cleared"], 1)

    def test_counts_leave_it_out(self):
        from api.dashboard_views import _monitoring_block

        from .digest import build_digest

        self.exclude()
        block = _monitoring_block(self.tenant)
        self.assertEqual({r["key"]: r["count"] for r in block["check_by_status"]}, {"up": 1})
        self.assertEqual(block["reachable_pct"], 100)
        digest = build_digest(self.tenant, self.now - timedelta(days=1))
        self.assertEqual(digest["total"], 1)
        self.assertEqual(
            monitored(CheckState.objects.filter(tenant=self.tenant), self.tenant.id).count(), 1)
        self.assertEqual(excluded_ids([self.ip.id, self.other.id]), {self.ip.id})

    def test_an_engine_whose_checks_are_all_excluded_is_not_stale(self):
        from .scheduler import check_engine_health

        eng = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "t"},
        )
        CheckState.objects.filter(target_ip=self.ip).update(engine=eng)
        self.exclude()
        with mock.patch("monitoring.notify.notify_event") as notify:
            out = check_engine_health(self.now + timedelta(days=1))
        self.assertEqual(out["flagged"], 0)
        notify.assert_not_called()

    def test_discovery_cleanup_keeps_an_excluded_address(self):
        from .discovery import cleanup_stale_ips

        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.cleanup_enabled = True
        ms.cleanup_after_days = 1
        ms.save()
        old = self.now - timedelta(days=10)
        IPAddress.objects.filter(pk__in=[self.ip.pk, self.other.pk]).update(
            discovered=True, last_seen=old)
        self.exclude()
        cleanup_stale_ips(self.now)
        self.assertTrue(IPAddress.objects.filter(pk=self.ip.pk).exists())
        self.assertFalse(IPAddress.objects.filter(pk=self.other.pk).exists())


class OutpostTests(_Base):
    def setUp(self):
        super().setUp()
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "t"},
        )
        self.fast = CheckTemplate.objects.create(
            tenant=self.tenant, name="fast", slug="fast", kind="icmp", interval_ms=1000,
        )
        self.fast_state = self.state(self.ip, self.fast, "up", interval_ms=1000,
                                     engine=self.engine)
        CheckState.objects.filter(target_ip__in=[self.ip, self.other]).update(engine=self.engine)

    def test_work_and_fast_work_leave_it_out(self):
        from .outpost_views import build_fast_work, claim_and_build_work

        self.exclude()
        work = claim_and_build_work(self.engine, self.now)
        self.assertEqual({c["target"] for c in work}, {"10.9.0.6"})
        self.assertEqual(build_fast_work(self.engine), [])

    def test_samples_for_it_are_dropped(self):
        from .fastlane import ingest_samples

        self.exclude()
        t0 = int(self.now.timestamp() * 1000)
        n = ingest_samples(self.engine, {"results": [{
            "state_id": str(self.fast_state.id),
            "samples": [{"t": t0 + i, "status": "down"} for i in range(5)],
        }]})
        self.assertEqual(n, 0)
        self.fast_state.refresh_from_db()
        self.assertEqual(self.fast_state.status, "skipped")


class ApiTests(APITestCase, _Base):
    def setUp(self):
        _Base.setUp(self)

    def login(self, user=None):
        self.client.force_login(user or self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _member(self, name, actions, sites):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"ip-{name}", object_types=["ipaddress"], actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        perm.sites.add(*sites)
        return user

    def post(self, ip, body):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(
                f"/api/monitoring/ips/{ip.id}/exclude/", body, format="json")

    def test_exclude_and_include(self):
        self.login()
        r = self.post(self.ip, {"excluded": True, "reason": "Spare"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["monitoring"]["excluded"])
        self.assertEqual(r.json()["monitoring"]["excluded_reason"], "Spare")
        b = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").json()
        self.assertTrue(b["monitoring"]["excluded"])
        self.assertEqual(b["monitoring"]["excluded_by"], "alice")
        r = self.post(self.ip, {"excluded": False})
        self.assertFalse(r.json()["monitoring"]["excluded"])

    def test_the_body_is_validated(self):
        self.login()
        self.assertEqual(self.post(self.ip, {}).status_code, 400)
        r = self.post(self.ip, {"excluded": True, "reason": "x" * 201})
        self.assertEqual(r.status_code, 400)
        self.assertIn("reason", r.json())

    def test_check_now_is_refused(self):
        self.login()
        self.post(self.ip, {"excluded": True})
        r = self.client.post(f"/api/monitoring/ips/{self.ip.id}/check-now/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "Excluded from monitoring.")

    def test_bulk_check_now_leaves_it_out(self):
        self.login()
        self.post(self.ip, {"excluded": True})
        with mock.patch("monitoring.scheduler.dispatch", return_value={"jobs": 0}):
            r = self.client.post("/api/monitoring/bulk-check-now/",
                                 {"ip_ids": [str(self.ip.id)]}, format="json")
        self.assertEqual(r.json()["excluded"], 1)
        self.assertEqual(r.json()["targets"], 0)
        self.s1.refresh_from_db()
        self.assertIsNone(self.s1.next_run)

    def test_status_columns_and_lists(self):
        self.login()
        self.post(self.ip, {"excluded": True})
        b = self.client.get(f"/api/monitoring/status/?ips={self.ip.id},{self.other.id}").json()
        self.assertTrue(b["statuses"][str(self.ip.id)]["excluded"])
        self.assertNotIn("excluded", b["statuses"][str(self.other.id)])
        b = self.client.get(f"/api/monitoring/status/?devices={self.device.id}").json()
        self.assertEqual(b["statuses"][str(self.device.id)]["monitored_ips"], 1)
        self.assertEqual(b["statuses"][str(self.device.id)]["status"], "up")
        b = self.client.get(f"/api/monitoring/status/?prefixes={self.prefix.id}").json()
        self.assertEqual(b["statuses"][str(self.prefix.id)]["counts"], {"up": 1})
        b = self.client.get("/api/monitoring/checks/?excluded=1").json()
        self.assertEqual(b["count"], 2)
        self.assertTrue(all(r["excluded"] for r in b["results"]))
        self.assertEqual(b["facets"]["excluded"][0]["count"], 2)
        b = self.client.get("/api/monitoring/stats/").json()
        self.assertEqual(b["total_checks"], 1)
        self.assertEqual(b["monitored_ips"], 1)
        b = self.client.get(f"/api/monitoring/devices/{self.device.id}/checks/").json()
        self.assertEqual(b["rollup"]["monitored_ips"], 1)
        self.assertTrue(next(g for g in b["ips"] if g["id"] == str(self.ip.id))["excluded"])
        b = self.client.get("/api/ips/?monitoring_excluded=true").json()
        self.assertEqual([r["ip_address"] for r in b["results"]], ["10.9.0.5"])

    def test_an_excluded_address_without_checks_still_says_so(self):
        self.login()
        bare = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.9", prefix=self.prefix)
        self.post(bare, {"excluded": True})
        b = self.client.get(f"/api/monitoring/status/?ips={bare.id}").json()
        self.assertEqual(b["statuses"][str(bare.id)]["excluded"], True)

    def test_a_field_write_is_refused(self):
        self.login()
        r = self.client.patch(f"/api/ips/{self.ip.id}/", {"monitoring_excluded": True},
                              format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("monitoring_excluded", r.json())
        # A form echoing the record back unchanged still saves.
        r = self.client.patch(
            f"/api/ips/{self.ip.id}/",
            {"monitoring_excluded": False, "availability_since": None, "description": "x"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_viewer_is_refused_and_other_sites_are_not_found(self):
        viewer = self._member("viewer", ["view"], [self.site_a])
        self.login(viewer)
        self.assertEqual(self.post(self.ip, {"excluded": True}).status_code, 403)
        editor = self._member("editor", ["view", "change"], [self.site_b])
        self.login(editor)
        self.assertEqual(self.post(self.ip, {"excluded": True}).status_code, 404)
        self.ip.refresh_from_db()
        self.assertFalse(self.ip.monitoring_excluded)

    def test_another_tenants_address_is_not_found(self):
        org2 = Organization.objects.create(name="B", slug="b")
        t2 = Tenant.objects.create(org=org2, name="B", slug="b")
        p2 = Prefix.objects.create(tenant=t2, cidr="10.9.0.0/24",
                                   status=status_for(t2, "container"))
        ip2 = IPAddress.objects.create(tenant=t2, ip_address="10.9.0.5", prefix=p2)
        self.login()
        self.assertEqual(self.post(ip2, {"excluded": True}).status_code, 404)
        ip2.refresh_from_db()
        self.assertFalse(ip2.monitoring_excluded)
