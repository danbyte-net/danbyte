"""The fast lane: sub-minute checks folded in memory, written when it
matters.

What is worth proving: a status change is recorded at once with everything
it sets off; plain probes downsample to one row per recording window; the
tenant cap and the switches leave the beat to run the rest; the beat takes
the checks back when the lane's heartbeat goes stale; an Outpost's buffered
probes fold the same way through the same seam, and an older agent is not
handed anything it cannot run.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import fastlane
from .engines import set_binding
from .fastlane import Sample, Window, claim_within_caps, fold, ingest_samples
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
from .scheduler import dispatch, materialise_ip

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.5.0.0/24", status=status_for(self.tenant, "container"),
            site=self.site,
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.5.0.1", prefix=self.prefix, site=self.site
        )
        self.fast = CheckTemplate.objects.create(
            tenant=self.tenant, name="Fast ping", slug="fast-ping", kind="icmp",
            interval_seconds=60, interval_ms=1000, record_every_seconds=30, rise=1, fall=3,
        )
        self.slow = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp", interval_seconds=300,
        )
        self.now = timezone.now()
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")

    def state(self, template=None, ip=None, engine=None, status="up"):
        template = template or self.fast
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=template, engine=engine,
            kind=template.kind, status=status, interval_ms=template.interval_ms,
            next_run=self.now, consecutive_success=1, since=self.now - timedelta(hours=1),
        )

    def samples(self, statuses, *, start=None, step_ms=1000, latency=1.0):
        start = start or self.now
        return [
            Sample(start + timedelta(milliseconds=i * step_ms), st,
                   latency if st in ("up", "degraded") else None)
            for i, st in enumerate(statuses)
        ]

    def cfg(self):
        return {"stale_after_scans": 0, "stale_after_days": 0}

    def login(self):
        self.client.force_login(self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class FoldTests(_Base):
    def test_a_transition_is_recorded_at_once_with_its_probe(self):
        st = self.state()
        window = Window()
        results, transitions = fold(
            st, self.samples(["up", "down", "down", "down"]), rise=1, fall=3, cfg=self.cfg(),
            engine_id=None, window=window, record_every=30,
        )
        self.assertEqual(len(transitions), 1)
        self.assertEqual((transitions[0].from_status, transitions[0].to_status), ("up", "down"))
        self.assertEqual(st.status, "down")
        # The probe behind the change, and nothing else: the window has not
        # elapsed and the change restarted it.
        self.assertEqual([r.status for r in results], ["down"])
        self.assertEqual(results[0].timestamp, self.now + timedelta(seconds=3))
        self.assertEqual(window.count, 0)

    def test_plain_probes_downsample_to_one_row_per_window(self):
        st = self.state()
        window = Window()
        # The clock starts with the first probe; 45 one-second probes over a
        # 30 s window is exactly one aggregated row.
        st.last_recorded_at = self.now
        results, transitions = fold(
            st, self.samples(["up"] * 45, latency=2.0), rise=1, fall=3, cfg=self.cfg(),
            engine_id=None, window=window, record_every=30,
        )
        self.assertEqual(transitions, [])
        self.assertEqual(len(results), 1)
        agg = results[0].detail["agg"]
        self.assertEqual(agg["samples"], 45)
        self.assertEqual(agg["loss_pct"], 0)
        self.assertEqual(agg["avg_ms"], 2.0)
        self.assertEqual(results[0].status, "up")
        self.assertIsNotNone(st.last_recorded_at)
        # Nothing more until the next window elapses.
        more, _ = fold(
            st, self.samples(["up"] * 5, start=st.last_recorded_at + timedelta(seconds=1)),
            rise=1, fall=3, cfg=self.cfg(), engine_id=None, window=window, record_every=30,
        )
        self.assertEqual(more, [])
        self.assertEqual(window.count, 5)

    def test_the_first_probe_starts_the_clock_rather_than_writing(self):
        st = self.state()
        results, _ = fold(
            st, self.samples(["up"]), rise=1, fall=3, cfg=self.cfg(), engine_id=None,
            window=Window(), record_every=30,
        )
        self.assertEqual(results, [])
        self.assertEqual(st.last_recorded_at, self.now)

    def test_loss_is_counted_without_flipping_the_status(self):
        st = self.state()
        st.last_recorded_at = self.now
        window = Window()
        results, transitions = fold(
            st, self.samples(["up", "down", "up", "up", "down", "up"] * 6), rise=1, fall=3,
            cfg=self.cfg(), engine_id=None, window=window, record_every=30,
        )
        self.assertEqual(transitions, [])
        self.assertEqual(results[0].detail["agg"]["loss_pct"], 33.3)
        self.assertEqual(st.status, "up")


class StaleScalingTests(_Base):
    def test_stale_after_scans_counts_at_the_normal_cadence(self):
        """Ten failed scans is ten scans at the fallback cadence - the
        tenant default of five minutes for a policy check - not ten seconds
        of one-second probes."""
        st = self.state()
        cfg = fastlane.lane_cfg(st, {"stale_after_scans": 10, "stale_after_days": 0})
        self.assertEqual(cfg["stale_after_scans"], 3000)
        # An assignment on its own schedule falls back to its template's minute.
        st.assignment = CheckAssignment.objects.create(
            tenant=self.tenant, template=self.fast, ip_address=self.ip,
            schedule_mode="custom_on",
        )
        self.assertEqual(
            fastlane.lane_cfg(st, {"stale_after_scans": 10})["stale_after_scans"], 600
        )
        st.interval_ms = None
        self.assertEqual(
            fastlane.lane_cfg(st, {"stale_after_scans": 10})["stale_after_scans"], 10
        )


class CapTests(_Base):
    def test_over_cap_states_are_released_to_the_beat(self):
        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.fast_lane_max_checks = 2
        ms.save()
        ips = [
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.5.0.{i}", prefix=self.prefix
            )
            for i in (2, 3, 4)
        ]
        states = [self.state(ip=ip) for ip in ips]
        owned, over = claim_within_caps(states)
        self.assertEqual(len(owned), 2)
        self.assertEqual(over, [states[2]])

    def test_zero_turns_the_lane_off_for_the_tenant(self):
        ms = MonitoringSettings.for_tenant(self.tenant)
        ms.fast_lane_max_checks = 0
        ms.save()
        owned, over = claim_within_caps([self.state()])
        self.assertEqual(owned, [])
        self.assertEqual(len(over), 1)


class BeatTests(_Base):
    """The minute beat and the lane never both run a check."""

    def test_the_beat_skips_owned_fast_states_while_the_lane_is_alive(self):
        st = self.state()
        st.fast_owned = True
        st.save(update_fields=["fast_owned"])
        slow = self.state(template=self.slow)
        with mock.patch.object(fastlane, "lane_alive", return_value=True), \
             mock.patch("monitoring.scheduler.run_icmp_sweep") as sweep:
            out = dispatch(sync=True)
        self.assertEqual(out["due"], 1)
        self.assertEqual(sweep.call_args.args[0], [str(slow.id)])
        st.refresh_from_db()
        self.assertFalse(st.in_flight)

    def test_the_beat_takes_fast_states_back_when_the_heartbeat_is_stale(self):
        st = self.state()
        st.fast_owned = True
        st.save(update_fields=["fast_owned"])
        with mock.patch.object(fastlane, "lane_alive", return_value=False), \
             mock.patch("monitoring.scheduler.run_icmp_sweep") as sweep:
            out = dispatch(sync=True)
        self.assertEqual(out["due"], 1)
        self.assertEqual(sweep.call_args.args[0], [str(st.id)])

    def test_heartbeat_round_trip(self):
        fastlane.heartbeat({"checks": 3, "probes_per_s": 4.5})
        self.assertTrue(fastlane.lane_alive())
        stats = fastlane.lane_stats()
        self.assertEqual(stats["checks"], 3)
        fastlane.FastLane.release_all()
        self.assertFalse(fastlane.lane_alive())

    def test_materialise_resolves_the_fast_interval(self):
        CheckAssignment.objects.create(tenant=self.tenant, template=self.fast, ip_address=self.ip)
        materialise_ip(self.ip)
        st = CheckState.objects.get(target_ip=self.ip, template=self.fast)
        self.assertEqual(st.interval_ms, 1000)
        # An assignment can clear it with 0, or set its own.
        a = CheckAssignment.objects.get(template=self.fast)
        a.overrides = {"interval_ms": 0}
        a.save()
        materialise_ip(self.ip)
        st.refresh_from_db()
        self.assertIsNone(st.interval_ms)


class LaneTests(_Base):
    """The process itself, one tick at a time, with the pinger stubbed."""

    def test_reload_owns_runnable_states_and_a_tick_probes_them(self):
        import asyncio

        st = self.state()
        lane = fastlane.FastLane()
        lane.reload()
        self.assertEqual(list(lane.entries), [str(st.id)])
        st.refresh_from_db()
        self.assertTrue(st.fast_owned)

        class Host:
            packets_sent = 1
            packets_received = 0
            packet_loss = 1.0
            avg_rtt = 0.0
            is_alive = False

        async def ping(addresses, count, timeout_ms):
            return [Host() for _ in addresses]

        async def drive(n):
            for _ in range(n):
                for e in lane.entries.values():
                    e.due = 0
                await lane.tick()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        with mock.patch("monitoring.worker._multiping", side_effect=ping):
            asyncio.run(drive(3))
        # Three failed probes against fall=3: down, at once.
        self.assertEqual(lane.entries[str(st.id)].state.status, "down")
        self.assertEqual(len(lane.pending_transitions), 1)
        lane.flush()
        st.refresh_from_db()
        self.assertEqual(st.status, "down")
        self.assertEqual(StateTransition.objects.filter(target_ip=self.ip).count(), 1)
        self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 1)
        self.assertIsNotNone(st.next_run)
        self.assertGreater(st.next_run, timezone.now())

    def test_reload_drops_a_state_that_left_the_lane(self):
        st = self.state()
        lane = fastlane.FastLane()
        lane.reload()
        self.assertIn(str(st.id), lane.entries)
        st.interval_ms = None
        st.save(update_fields=["interval_ms"])
        lane.reload()
        self.assertEqual(lane.entries, {})


class OutpostSeamTests(_Base):
    def setUp(self):
        super().setUp()
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "tkn-fast"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.st = self.state(engine=self.engine)
        self.slow_st = self.state(template=self.slow, engine=self.engine)

    def auth(self):
        return {"HTTP_AUTHORIZATION": "Bearer tkn-fast"}

    def hello(self, fast):
        body = {"version": "0.8.0", "hostname": "h"}
        if fast:
            body["fast"] = True
        return self.client.post("/api/outpost/hello/", body, format="json", **self.auth()).json()

    def test_an_old_agent_gets_fast_checks_on_the_beat(self):
        self.hello(fast=False)
        r = self.client.get("/api/outpost/work/", **self.auth())
        ids = {c["state_id"] for c in r.json()["checks"]}
        self.assertEqual(ids, {str(self.st.id), str(self.slow_st.id)})

    def test_a_fast_agent_gets_them_from_fast_work_only(self):
        self.assertTrue(self.hello(fast=True)["fast"])
        self.engine.refresh_from_db()
        self.assertTrue(self.engine.agent_fast)
        r = self.client.get("/api/outpost/work/", **self.auth())
        self.assertEqual([c["state_id"] for c in r.json()["checks"]], [str(self.slow_st.id)])
        r = self.client.get("/api/outpost/fast-work/", **self.auth())
        self.assertEqual(r.status_code, 200, r.content)
        [check] = r.json()["checks"]
        self.assertEqual(check["state_id"], str(self.st.id))
        self.assertEqual(check["interval_ms"], 1000)
        self.assertEqual(r.json()["flush_seconds"], self.engine.poll_interval_seconds)
        self.st.refresh_from_db()
        self.assertTrue(self.st.fast_owned)

    def test_buffered_probes_fold_like_the_lanes_own(self):
        t0 = int(self.now.timestamp() * 1000)
        samples = [{"t": t0 + i * 1000, "status": "up", "latency_ms": 1.5} for i in range(10)]
        samples += [{"t": t0 + (10 + i) * 1000, "status": "down"} for i in range(3)]
        r = self.client.post(
            "/api/outpost/fast-results/",
            {"results": [{"state_id": str(self.st.id), "samples": samples}]},
            format="json", **self.auth(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["ingested"], 13)
        self.st.refresh_from_db()
        self.assertEqual(self.st.status, "down")
        tr = StateTransition.objects.get(target_ip=self.ip)
        self.assertEqual(tr.engine_id, self.engine.id)
        self.assertLess(abs((tr.at - (self.now + timedelta(seconds=12))).total_seconds()), 0.01)
        # The probe behind the change; the window clock only started with
        # this batch, so no aggregate yet.
        [row] = CheckResult.objects.filter(target_ip=self.ip)
        self.assertEqual(row.status, "down")
        self.assertEqual(row.engine_id, self.engine.id)
        # Everything a change sets off, set off: the alert opened.
        self.assertEqual(Alert.objects.filter(target_ip=self.ip, status="firing").count(), 1)
        # A second batch a window later carries the aggregate.
        t1 = t0 + 13_000
        r = self.client.post(
            "/api/outpost/fast-results/",
            {"results": [{"state_id": str(self.st.id), "samples": [
                {"t": t1 + i * 1000, "status": "down"} for i in range(31)
            ]}]},
            format="json", **self.auth(),
        )
        self.assertEqual(r.json()["ingested"], 31)
        rows = CheckResult.objects.filter(target_ip=self.ip).order_by("timestamp")
        self.assertEqual(rows.count(), 2)
        self.assertEqual(rows.last().detail["agg"]["loss_pct"], 100.0)

    def test_out_of_order_and_junk_samples_are_handled(self):
        t0 = int(self.now.timestamp() * 1000)
        samples = [
            {"t": t0 + 2000, "status": "down"},
            {"t": "nope", "status": "down"},
            {"t": t0 + 1000, "status": "weird"},
            {"t": t0, "status": "down"},
            {"t": t0 + 3000, "status": "down"},
        ]
        r = self.client.post(
            "/api/outpost/fast-results/",
            {"results": [{"state_id": str(self.st.id), "samples": samples},
                         {"state_id": "not-a-state", "samples": samples}]},
            format="json", **self.auth(),
        )
        self.assertEqual(r.json()["ingested"], 3)
        self.st.refresh_from_db()
        self.assertEqual(self.st.status, "down")

    def test_another_engines_state_is_not_folded(self):
        other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="other", slug="other", kind="remote",
            transport="pull", token={"secret": "tkn-other"},
        )
        t0 = int(self.now.timestamp() * 1000)
        r = self.client.post(
            "/api/outpost/fast-results/",
            {"results": [{"state_id": str(self.st.id),
                          "samples": [{"t": t0, "status": "down"}] * 5}]},
            format="json", HTTP_AUTHORIZATION="Bearer tkn-other",
        )
        self.assertEqual(r.json()["ingested"], 0)
        self.st.refresh_from_db()
        self.assertEqual(self.st.status, "up")
        self.assertEqual(other.pk, other.pk)


class TemplateApiTests(_Base):
    def test_floors_and_the_timeout_ceiling(self):
        self.login()
        r = self.client.post(
            "/api/monitoring/templates/",
            {"name": "too fast", "kind": "tcp", "params": {"port": 22},
             "interval_ms": 500}, format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("interval_ms", r.json())
        r = self.client.post(
            "/api/monitoring/templates/",
            {"name": "fast tcp", "kind": "tcp", "params": {"port": 22},
             "interval_ms": 2000, "timeout_ms": 5000, "record_every_seconds": 15},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["timeout_ms"], 2000)
        self.assertEqual(r.json()["record_every_seconds"], 15)
        r = self.client.post(
            "/api/monitoring/templates/",
            {"name": "fast icmp", "kind": "icmp", "interval_ms": 200}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post(
            "/api/monitoring/templates/",
            {"name": "bad record", "kind": "icmp", "interval_ms": 1000,
             "record_every_seconds": 1}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_settings_carry_the_cap(self):
        self.login()
        self.assertEqual(
            self.client.get("/api/monitoring/settings/").json()["fast_lane_max_checks"], 500
        )
