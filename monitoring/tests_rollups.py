"""Hourly and daily rollups of check history, and the counting rules."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from django.test import TestCase, override_settings

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import rollups
from .models import (
    CheckKind,
    CheckResult,
    CheckRollupDaily,
    CheckRollupHourly,
    CheckState,
    CheckTemplate,
    MonitoringSettings,
    Silence,
    StateTransition,
)

#: A fixed clock: 2026-09-10 12:30 UTC. Buckets are UTC.
NOW = datetime(2026, 9, 10, 12, 30, tzinfo=UTC)
H11 = datetime(2026, 9, 10, 11, tzinfo=UTC)
DAY = datetime(2026, 9, 10, tzinfo=UTC)


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=self.prefix
        )
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp", status="up"
        )

    def tr(self, at, to, frm="up"):
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            from_status=frm, to_status=to, at=at,
        )

    def result(self, at, ms, **detail):
        CheckResult.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            status="up", latency_ms=ms, timestamp=at, detail=detail,
        )

    def hour(self, bucket=H11):
        rollups.roll(self.tenant.id, rollups.HOUR, bucket, bucket + rollups.HOUR, now=NOW)
        return CheckRollupHourly.objects.get(bucket=bucket)


class SecondsTests(_Base):
    def test_seconds_per_status_add_up_to_the_bucket(self):
        self.tr(H11 - timedelta(hours=2), "up")
        self.tr(H11 + timedelta(minutes=10), "down")
        self.tr(H11 + timedelta(minutes=25), "degraded", frm="down")
        self.tr(H11 + timedelta(minutes=40), "up", frm="degraded")
        row = self.hour()
        self.assertEqual(row.up_s, 30 * 60)
        self.assertEqual(row.down_s, 15 * 60)
        self.assertEqual(row.degraded_s, 15 * 60)
        self.assertEqual(row.incidents, 1)
        self.assertTrue(row.closed)
        self.assertEqual(row.kind, "icmp")

    def test_going_down_on_the_edge_is_this_buckets_incident(self):
        self.tr(H11 - timedelta(hours=2), "up")
        self.tr(H11, "down")
        self.assertEqual(self.hour().incidents, 1)

    def test_already_down_is_not_a_new_incident(self):
        self.tr(H11 - timedelta(hours=2), "down")
        row = self.hour()
        self.assertEqual(row.incidents, 0)
        self.assertEqual(row.down_s, 3600)

    def test_no_history_is_unknown(self):
        self.assertEqual(self.hour().unknown_s, 3600)

    def test_the_open_hour_stops_at_now_and_stays_open(self):
        self.tr(H11 - timedelta(hours=2), "up")
        row = self.hour(H11 + rollups.HOUR)
        self.assertEqual(row.up_s, 30 * 60)
        self.assertFalse(row.closed)

    def test_rerunning_updates_in_place(self):
        self.tr(H11 - timedelta(hours=2), "up")
        self.hour()
        self.tr(H11 + timedelta(minutes=30), "down")
        row = self.hour()
        self.assertEqual(CheckRollupHourly.objects.count(), 1)
        self.assertEqual(row.down_s, 30 * 60)

    def test_daily_bucket(self):
        self.tr(DAY - timedelta(days=1), "up")
        self.tr(DAY + timedelta(hours=6), "down")
        rollups.roll(self.tenant.id, rollups.DAY, DAY, DAY + rollups.DAY, now=NOW)
        row = CheckRollupDaily.objects.get(bucket=DAY)
        self.assertEqual(row.up_s, 6 * 3600)
        self.assertEqual(row.down_s, 6.5 * 3600)
        self.assertFalse(row.closed)


class LatencyTests(_Base):
    def test_percentiles_and_samples(self):
        for i, ms in enumerate([1, 2, 3, 4, 100]):
            self.result(H11 + timedelta(minutes=i), ms)
        row = self.hour()
        self.assertEqual(row.samples, 5)
        self.assertEqual((row.lat_min, row.lat_p50, row.lat_max), (1, 3, 100))
        self.assertAlmostEqual(row.lat_avg, 22.0)

    def test_fast_lane_rows_count_their_samples_and_extremes(self):
        self.result(H11, 5.0, agg={"samples": 60, "min_ms": 1.0, "max_ms": 40.0})
        row = self.hour()
        self.assertEqual(row.samples, 60)
        self.assertEqual((row.lat_min, row.lat_max), (1.0, 40.0))

    def test_spikes_against_the_checks_own_baseline(self):
        # A week of 2 ms hours is this check's normal.
        CheckRollupHourly.objects.bulk_create([
            CheckRollupHourly(
                tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
                bucket=H11 - timedelta(hours=h), lat_p50=2.0, closed=True,
            )
            for h in range(1, 25)
        ])
        # 3x baseline is 6 ms but the icmp floor is +5 ms, so 7 ms is the bar.
        for i, ms in enumerate([2, 6.5, 7.5, 50]):
            self.result(H11 + timedelta(minutes=i), ms)
        self.assertEqual(self.hour().spikes, 2)

    def test_spike_floor_is_a_setting(self):
        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"spike_floor_ms": {"icmp": 100}}
        )
        CheckRollupHourly.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=H11 - rollups.HOUR, lat_p50=2.0, closed=True,
        )
        self.result(H11, 50)
        self.assertEqual(self.hour().spikes, 0)

    def test_no_baseline_no_spikes(self):
        self.result(H11, 500)
        self.assertEqual(self.hour().spikes, 0)


class CountingRuleTests(TestCase):
    ROW = {"up_s": 80, "down_s": 10, "degraded_s": 10, "stale_s": 50, "unknown_s": 50}

    def test_defaults_degraded_is_up_stale_is_unmeasured(self):
        c = rollups.classify(self.ROW)
        self.assertEqual((c["up_s"], c["down_s"], c["unmeasured_s"]), (90, 10, 100))
        self.assertAlmostEqual(c["availability"], 0.9)
        self.assertAlmostEqual(c["coverage"], 0.5)

    def test_strict_rules(self):
        c = rollups.classify(self.ROW, rollups.CountingRules(degraded="down", stale="down"))
        self.assertAlmostEqual(c["availability"], 80 / 150)
        self.assertAlmostEqual(c["coverage"], 150 / 200)

    def test_nothing_measured_is_none_not_100(self):
        c = rollups.classify({"unknown_s": 3600})
        self.assertIsNone(c["availability"])
        self.assertEqual(c["coverage"], 0)


class RefreshAndPruneTests(_Base):
    def test_refresh_closes_the_last_hour_and_opens_this_one(self):
        self.tr(H11 - timedelta(days=5), "up")
        out = rollups.refresh(now=NOW)
        self.assertEqual(out["hourly"], 2)
        self.assertEqual(
            list(CheckRollupHourly.objects.order_by("bucket").values_list("bucket", "closed")),
            [(H11, True), (H11 + rollups.HOUR, False)],
        )
        # Ended days only, each written once; today is left to the hours.
        self.assertEqual(
            list(CheckRollupDaily.objects.order_by("bucket").values_list("bucket", "closed")),
            [(DAY - 2 * rollups.DAY, True), (DAY - rollups.DAY, True)],
        )
        self.assertEqual(rollups.refresh(now=NOW)["daily"], 0)

    def test_refresh_catches_up_a_missed_open_hour(self):
        self.tr(H11 - timedelta(days=2), "up")
        CheckRollupHourly.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
            bucket=H11 - 3 * rollups.HOUR, closed=False,
        )
        rollups.refresh(now=NOW)
        self.assertEqual(
            CheckRollupHourly.objects.get(bucket=H11 - 3 * rollups.HOUR).up_s, 3600
        )
        self.assertFalse(CheckRollupHourly.objects.filter(closed=False, bucket__lt=H11).exists())
        self.assertEqual(CheckRollupHourly.objects.filter(bucket__lte=H11).count(), 4)

    @override_settings(MONITORING_ROLLUP_HOURLY_RETENTION_DAYS=30)
    def test_prune_drops_old_hours_and_keeps_every_day(self):
        old = NOW - timedelta(days=40)
        common = dict(tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp")
        CheckRollupHourly.objects.create(bucket=old, **common)
        CheckRollupHourly.objects.create(bucket=H11, **common)
        CheckRollupDaily.objects.create(bucket=old, **common)
        self.assertEqual(rollups.prune(now=NOW), 1)
        self.assertEqual(CheckRollupHourly.objects.get().bucket, H11)
        self.assertEqual(CheckRollupDaily.objects.count(), 1)

    def test_tenants_stay_apart(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.tr(H11 - timedelta(days=2), "up")
        rollups.roll(other.id, rollups.HOUR, H11, H11 + rollups.HOUR, now=NOW)
        self.assertFalse(CheckRollupHourly.objects.exists())


class SilencedFlagTests(_Base):
    """The alert list's "silenced" flag uses the same matchers as delivery,
    device matchers included - a maintenance window's silence names devices."""

    def test_a_device_silence_flags_only_that_devices_alerts(self):
        from django.utils import timezone

        from .views import _annotate_silenced

        site = Site.objects.create(tenant=self.tenant, name="HQ")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        dev = Device.objects.create(
            tenant=self.tenant, site=site, name="sw1", device_type=dtype, role=role,
            status=status_for(self.tenant),
        )
        self.ip.assigned_device = dev
        self.ip.save()
        other = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.2", prefix=self.prefix
        )
        now = timezone.now()
        s = Silence.objects.create(
            tenant=self.tenant, reason="Window", starts_at=now - timedelta(hours=1),
            ends_at=now + timedelta(hours=1),
        )
        s.match_devices.add(dev)

        def alert(ip):
            return SimpleNamespace(
                status="firing", kind="icmp", check_status="down",
                target_ip=ip, target_ip_id=ip.id,
            )

        covered, uncovered = alert(self.ip), alert(other)
        _annotate_silenced(self.tenant, [covered, uncovered])
        self.assertTrue(getattr(covered, "_silenced", False))
        self.assertFalse(getattr(uncovered, "_silenced", False))


class SpikeSettingsTests(TestCase):
    def test_floors_are_validated(self):
        from rest_framework.exceptions import ValidationError

        from .serializers import MonitoringSettingsSerializer

        s = MonitoringSettingsSerializer()
        self.assertEqual(s.validate_spike_floor_ms({"icmp": "7"}), {"icmp": 7.0})
        for bad in ({"nope": 5}, {"icmp": -1}, {"icmp": "x"}, [5]):
            with self.assertRaises(ValidationError):
                s.validate_spike_floor_ms(bad)
        with self.assertRaises(ValidationError):
            s.validate_spike_factor(1.0)
