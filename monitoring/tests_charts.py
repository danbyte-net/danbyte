"""The chart aggregations: weighted by what a row stands for, in the
viewer's calendar, over the same filtered set as the table."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .charts import (
    alerts_per_day,
    latency_percentiles,
    latency_series,
    per_day,
    transition_heatmap,
    transition_top,
)
from .models import Alert, CheckKind, CheckResult, CheckState, CheckTemplate, StateTransition

CPH = ZoneInfo("Europe/Copenhagen")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.8.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.8.0.1", prefix=self.prefix)
        self.ip2 = IPAddress.objects.create(tenant=self.tenant, ip_address="10.8.0.2", prefix=self.prefix)
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        # A fixed hour so buckets are predictable.
        self.t0 = datetime(2026, 9, 7, 10, 0, tzinfo=UTC)  # a Monday, 12:00 in Copenhagen
        self.admin = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")

    def result(self, at, status="up", latency=None, detail=None, ip=None):
        return CheckResult.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=self.t, kind="icmp",
            status=status, latency_ms=latency, detail=detail or {}, timestamp=at,
        )

    def transition(self, at, to, ip=None):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=self.t, kind="icmp",
            from_status="up", to_status=to, at=at,
        )


class LatencyTests(_Base):
    def test_buckets_weight_fast_lane_rows_by_their_samples(self):
        # One plain probe at 10 ms and one fast-lane window of 30 probes
        # averaging 2 ms: the bucket's average is (10 + 30*2) / 31.
        self.result(self.t0 + timedelta(minutes=1), latency=10.0)
        self.result(
            self.t0 + timedelta(minutes=2), latency=2.0,
            detail={"agg": {"samples": 30, "min_ms": 1.0, "max_ms": 5.0, "loss_pct": 10.0}},
        )
        [b] = latency_series(
            CheckResult.objects.filter(target_ip=self.ip), self.t0, self.t0 + timedelta(hours=1), 300
        )
        self.assertEqual(b["samples"], 31)
        self.assertAlmostEqual(b["avg"], 70 / 31, places=2)
        self.assertEqual(b["min"], 1.0)
        self.assertEqual(b["max"], 10.0)
        # Loss: the plain probe contributes 0, the window 10% × 30.
        self.assertAlmostEqual(b["loss"], round(300 / 31, 1), places=1)

    def test_a_down_probe_is_full_loss_with_no_latency(self):
        self.result(self.t0 + timedelta(minutes=1), status="down")
        self.result(self.t0 + timedelta(minutes=2), latency=4.0)
        [b] = latency_series(
            CheckResult.objects.filter(target_ip=self.ip), self.t0, self.t0 + timedelta(hours=1), 300
        )
        self.assertEqual(b["loss"], 50.0)
        self.assertEqual(b["avg"], 4.0)

    def test_percentiles_per_bucket(self):
        for i, lat in enumerate([1, 2, 3, 4, 100]):
            self.result(self.t0 + timedelta(minutes=i), latency=float(lat))
        [b] = latency_percentiles(
            CheckResult.objects.filter(tenant=self.tenant), self.t0, self.t0 + timedelta(hours=1), 3600
        )
        self.assertEqual(b["p50"], 3.0)
        self.assertGreater(b["p95"], 50)


class TransitionChartTests(_Base):
    def test_heatmap_is_in_the_viewers_week(self):
        # Monday 10:00 UTC is Monday 12:00 in Copenhagen (CEST).
        self.transition(self.t0, "down")
        self.transition(self.t0 + timedelta(minutes=10), "up")
        cells = transition_heatmap(StateTransition.objects.filter(tenant=self.tenant), CPH)
        self.assertEqual(cells, [{"dow": 0, "hour": 12, "n": 2}])
        # Sunday 23:30 UTC is Monday 01:30 in Copenhagen.
        self.transition(self.t0 - timedelta(hours=10, minutes=30), "down")
        cells = transition_heatmap(StateTransition.objects.filter(tenant=self.tenant), CPH)
        self.assertIn({"dow": 0, "hour": 1, "n": 1}, cells)

    def test_top_counts_changes_and_bad_ones(self):
        self.transition(self.t0, "down")
        self.transition(self.t0 + timedelta(minutes=1), "up")
        self.transition(self.t0 + timedelta(minutes=2), "down")
        self.transition(self.t0, "down", ip=self.ip2)
        [first, second] = transition_top(StateTransition.objects.filter(tenant=self.tenant))
        self.assertEqual((first["ip_address"], first["changes"], first["bad"]), ("10.8.0.1", 3, 2))
        self.assertEqual((second["ip_address"], second["changes"]), ("10.8.0.2", 1))


class DayTests(_Base):
    def test_per_day_cuts_segments_on_the_viewers_midnight(self):
        # Two days, Copenhagen: down for the last 6 hours of day one.
        since = datetime(2026, 9, 6, 22, 0, tzinfo=UTC)  # Sept 7 00:00 CEST
        until = since + timedelta(days=2)
        mid = since + timedelta(hours=18)
        segments = [
            {"start": since, "end": mid, "status": "up"},
            {"start": mid, "end": since + timedelta(days=1), "status": "down"},
            {"start": since + timedelta(days=1), "end": until, "status": "up"},
        ]
        days = per_day(segments, since, until, CPH)
        self.assertEqual([d["date"] for d in days], ["2026-09-07", "2026-09-08"])
        self.assertEqual(days[0]["uptime_pct"], 75.0)
        self.assertEqual(days[0]["incidents"], 1)
        self.assertEqual(days[1]["uptime_pct"], 100.0)

    def test_a_day_with_nothing_measured_is_none(self):
        since = datetime(2026, 9, 6, 22, 0, tzinfo=UTC)
        until = since + timedelta(days=1)
        days = per_day([{"start": since, "end": until, "status": "unknown"}], since, until, CPH)
        self.assertIsNone(days[0]["uptime_pct"])


class AlertsTests(_Base):
    def test_opened_and_resolved_per_day(self):
        Alert.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            dedup_key="a", severity="warning", status="resolved", check_status="up",
            opened_at=self.t0, last_status_at=self.t0,
            resolved_at=self.t0 + timedelta(days=1),
        )
        Alert.objects.create(
            tenant=self.tenant, target_ip=self.ip2, template=self.t, kind="icmp",
            dedup_key="b", severity="warning", status="firing", check_status="down",
            opened_at=self.t0 + timedelta(days=1), last_status_at=self.t0,
        )
        rows = alerts_per_day(self.tenant, self.t0 - timedelta(days=1), self.t0 + timedelta(days=2), CPH)
        self.assertEqual([(r["opened"], r["resolved"]) for r in rows], [(1, 0), (1, 1)])


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_latency_endpoint_and_window_buckets(self):
        now = timezone.now()
        self.result(now - timedelta(minutes=3), latency=2.0)
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/latency/?template={self.t.id}&hours=24")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["bucket_seconds"], 300)
        self.assertEqual(len(r.json()["points"]), 1)
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/latency/?hours=720")
        self.assertEqual(r.json()["bucket_seconds"], 6 * 3600)

    def test_transitions_carry_heatmap_top_and_the_flapping_filter(self):
        now = timezone.now()
        self.transition(now - timedelta(hours=1), "down")
        self.transition(now - timedelta(hours=1), "down", ip=self.ip2)
        r = self.client.get("/api/monitoring/transitions/?days=1").json()
        self.assertEqual(sum(c["n"] for c in r["heatmap"]), 2)
        self.assertEqual(len(r["top"]), 2)
        # Only ip2 is flagged: the filter keeps its change alone.
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip2, template=self.t, kind="icmp",
            status="down", flapping_since=now,
        )
        r = self.client.get("/api/monitoring/transitions/?days=1&flapping=1").json()
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["results"][0]["target_ip"]["ip_address"], "10.8.0.2")

    def test_a_heatmap_cell_filters_the_table_but_not_the_heatmap(self):
        from auth_api.models import UserProfile
        from auth_api.user_prefs import set_user

        UserProfile.objects.get_or_create(user=self.admin, defaults={"role": "admin"})
        set_user(self.admin, "timezone", "Europe/Copenhagen")
        # Monday 12:00 and Tuesday 12:00, Copenhagen.
        self.transition(self.t0, "down")
        self.transition(self.t0 + timedelta(days=1), "down", ip=self.ip2)
        r = self.client.get("/api/monitoring/transitions/?days=30&dow=0&hour=12").json()
        self.assertEqual(r["count"], 1)
        self.assertEqual(r["results"][0]["target_ip"]["ip_address"], "10.8.0.1")
        self.assertEqual(len(r["top"]), 1)
        # The picture stays whole so the next cell can be picked.
        self.assertEqual(sum(c["n"] for c in r["heatmap"]), 2)
        self.assertEqual(self.client.get("/api/monitoring/transitions/?days=30&dow=1").json()["count"], 1)
        self.assertEqual(self.client.get("/api/monitoring/transitions/?days=30&hour=12").json()["count"], 2)

    def test_stats_and_dashboard_carry_the_new_series(self):
        now = timezone.now()
        self.result(now - timedelta(minutes=5), latency=3.0)
        self.result(now - timedelta(minutes=4), status="down")
        b = self.client.get("/api/monitoring/stats/?hours=24").json()
        self.assertEqual(b["availability_pct"], 50.0)
        self.assertEqual(len(b["latency_series"]), 1)
        self.assertIn("alerts_series", b)
        d = self.client.get("/api/dashboard/").json()
        self.assertEqual(d["availability_7d"], 50.0)
        self.assertEqual(len(d["latency_series"]), 1)
        self.assertEqual(d["alerts_per_day"], [])
        t = self.client.get(f"/api/monitoring/ips/{self.ip.id}/timeline/?days=7").json()
        self.assertEqual(len(t["days"]), 8)
