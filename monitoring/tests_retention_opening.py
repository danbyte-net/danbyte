"""Transition retention keeps the status each check opens a window with (#356)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.test import TestCase

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import rollups
from .models import CheckKind, CheckRollupHourly, CheckState, CheckTemplate, StateTransition
from .retention import prune
from .uptime import check_uptime

NOW = datetime(2026, 9, 10, 12, 30, tzinfo=UTC)
H11 = datetime(2026, 9, 10, 11, tzinfo=UTC)


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.1", prefix=prefix)
        self.ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.2", prefix=prefix
        )
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.http = CheckTemplate.objects.create(
            tenant=self.tenant, name="HTTP", slug="http", kind=CheckKind.HTTP
        )

    def state(self, ip=None, template=None, status="up", since=None):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=template or self.ping,
            kind="icmp", status=status, since=since,
        )

    def tr(self, at, to, frm="unknown", ip=None, template=None):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=template or self.ping,
            kind="icmp", from_status=frm, to_status=to, at=at,
        )

    def hour(self):
        CheckRollupHourly.objects.all().delete()
        rollups.roll(self.tenant.id, rollups.HOUR, H11, H11 + rollups.HOUR, now=NOW)
        return CheckRollupHourly.objects.get(bucket=H11)


class PruneKeepsOpeningTests(_Base):
    def test_stable_check_still_counts_up_after_prune(self):
        at = NOW - timedelta(days=400)
        self.state(since=at)
        self.tr(at, "up")
        before = self.hour()
        self.assertEqual(before.up_s, 3600)

        out = prune(now=NOW)

        self.assertEqual(out["transitions_deleted"], 0)
        self.assertEqual(StateTransition.objects.count(), 1)
        after = self.hour()
        self.assertEqual(after.up_s, 3600)
        self.assertEqual(after.unknown_s, 0)
        st = CheckState.objects.get(target_ip=self.ip, template=self.ping)
        self.assertEqual(check_uptime(st, H11, H11 + timedelta(hours=1))["uptime_pct"], 100.0)

    def test_older_transitions_go_newest_before_cutoff_stays(self):
        oldest = self.tr(NOW - timedelta(days=500), "up")
        middle = self.tr(NOW - timedelta(days=450), "down", frm="up")
        newest_old = self.tr(NOW - timedelta(days=400), "up", frm="down")
        recent = self.tr(NOW - timedelta(days=10), "down", frm="up")

        out = prune(now=NOW)

        self.assertEqual(out["transitions_deleted"], 2)
        kept = set(StateTransition.objects.values_list("pk", flat=True))
        self.assertEqual(kept, {newest_old.pk, recent.pk})
        self.assertNotIn(oldest.pk, kept)
        self.assertNotIn(middle.pk, kept)

    def test_each_check_keeps_its_own_newest(self):
        a = self.tr(NOW - timedelta(days=400), "up")
        self.tr(NOW - timedelta(days=420), "down", ip=self.ip2)
        b = self.tr(NOW - timedelta(days=410), "up", frm="down", ip=self.ip2)
        c = self.tr(NOW - timedelta(days=700), "up", template=self.http)

        prune(now=NOW)

        self.assertEqual(
            set(StateTransition.objects.values_list("pk", flat=True)), {a.pk, b.pk, c.pk}
        )

    def test_check_with_recent_history_drops_all_old_rows(self):
        self.tr(NOW - timedelta(days=500), "up")
        self.tr(NOW - timedelta(days=400), "down", frm="up")
        recent = self.tr(NOW - timedelta(days=5), "up", frm="down")

        prune(now=NOW)

        # The newest row before the cutoff still opens the retained window.
        self.assertEqual(StateTransition.objects.count(), 2)
        self.assertTrue(StateTransition.objects.filter(pk=recent.pk).exists())

    def test_prune_is_idempotent(self):
        self.tr(NOW - timedelta(days=500), "up")
        self.tr(NOW - timedelta(days=400), "down", frm="up")
        self.assertEqual(prune(now=NOW)["transitions_deleted"], 1)
        self.assertEqual(prune(now=NOW)["transitions_deleted"], 0)
        self.assertEqual(StateTransition.objects.count(), 1)


class RestoreOpeningMigrationTests(_Base):
    """monitoring 0110 gives back the opening status an earlier prune deleted,
    and repairs the closed rollups written while it was missing (#356)."""

    def restore(self):
        import importlib

        from django.apps import apps
        from django.db import connection

        mod = importlib.import_module("monitoring.migrations.0110_restore_opening_transitions")
        with connection.schema_editor() as editor:
            mod.restore_openings(apps, editor, now=NOW)

    def closed_hour(self, bucket=H11):
        """A rollup row written by the timer, closed, as it is stored."""
        rollups.roll(self.tenant.id, rollups.HOUR, bucket, bucket + rollups.HOUR, now=NOW)
        return CheckRollupHourly.objects.get(bucket=bucket)

    def test_pruned_stable_check_counts_up_again(self):
        # Up since 400 days ago; the prune deleted the change that said so.
        st = self.state(since=NOW - timedelta(days=400))
        row = self.closed_hour()
        self.assertEqual((row.up_s, row.unknown_s), (0, 3600))
        day = datetime(2026, 9, 9, tzinfo=UTC)
        rollups.roll(self.tenant.id, rollups.DAY, day, day + rollups.DAY, now=NOW)
        self.assertEqual(rollups.CheckRollupDaily.objects.get(bucket=day).unknown_s, 86400)
        self.assertIsNone(check_uptime(st, H11, H11 + timedelta(hours=1))["uptime_pct"])

        self.restore()

        opening = StateTransition.objects.get()
        self.assertEqual((opening.from_status, opening.to_status), ("unknown", "up"))
        self.assertEqual(opening.at, NOW - timedelta(days=400))
        row.refresh_from_db()
        self.assertEqual((row.up_s, row.unknown_s, row.incidents), (3600, 0, 0))
        daily = rollups.CheckRollupDaily.objects.get(bucket=day)
        self.assertEqual((daily.up_s, daily.unknown_s), (86400, 0))
        self.assertEqual(check_uptime(st, H11, H11 + timedelta(hours=1))["uptime_pct"], 100.0)
        self.assertEqual(self.hour().up_s, 3600)

    def test_opening_comes_from_the_earliest_remaining_change(self):
        # Up for years, then down at 11:20 today; everything before is gone.
        self.state(status="down", since=H11 + timedelta(minutes=20))
        self.tr(H11 + timedelta(minutes=20), "down", frm="up")
        before = self.closed_hour(H11 - rollups.HOUR)
        edge = self.closed_hour()
        self.assertEqual(before.unknown_s, 3600)
        self.assertEqual((edge.unknown_s, edge.down_s), (1200, 2400))

        self.restore()

        opening = StateTransition.objects.order_by("at").first()
        self.assertEqual((opening.from_status, opening.to_status), ("unknown", "up"))
        self.assertEqual(opening.at, NOW - timedelta(days=365))
        before.refresh_from_db()
        edge.refresh_from_db()
        self.assertEqual((before.up_s, before.unknown_s), (3600, 0))
        self.assertEqual((edge.up_s, edge.down_s, edge.unknown_s), (1200, 2400, 0))
        self.assertEqual(edge.incidents, 1)

    def test_down_into_stale_is_not_a_new_blind_incident(self):
        self.state(status="stale", since=H11 + timedelta(minutes=30))
        self.tr(H11 + timedelta(minutes=30), "stale", frm="down")
        edge = self.closed_hour()
        self.assertEqual(edge.blind_incidents, 1)

        self.restore()

        edge.refresh_from_db()
        self.assertEqual((edge.down_s, edge.stale_s, edge.blind_incidents), (1800, 1800, 0))

    def test_checks_with_their_opening_are_left_alone(self):
        # Kept by the fixed prune: newest change before the cutoff.
        self.state(since=NOW - timedelta(days=400))
        self.tr(NOW - timedelta(days=400), "up", frm="down")
        # A young check: its history starts from unknown.
        self.state(ip=self.ip2, since=NOW - timedelta(days=3))
        self.tr(NOW - timedelta(days=3), "up", ip=self.ip2)
        # Never answered.
        self.state(template=self.http, status="unknown")
        rows = set(StateTransition.objects.values_list("pk", flat=True))

        self.restore()

        self.assertEqual(set(StateTransition.objects.values_list("pk", flat=True)), rows)

    def test_is_idempotent(self):
        self.state(since=NOW - timedelta(days=400))
        self.state(ip=self.ip2, status="down", since=NOW - timedelta(days=2))
        self.tr(NOW - timedelta(days=2), "down", frm="up", ip=self.ip2)
        self.restore()
        self.assertEqual(StateTransition.objects.count(), 3)
        self.restore()
        self.assertEqual(StateTransition.objects.count(), 3)

    def test_open_rows_and_rows_before_the_opening_are_untouched(self):
        self.state(since=H11 + timedelta(minutes=30))
        rollups.roll(self.tenant.id, rollups.HOUR, H11 - rollups.HOUR, NOW + rollups.HOUR,
                     now=NOW)
        open_row = CheckRollupHourly.objects.get(bucket=H11 + rollups.HOUR)
        self.assertFalse(open_row.closed)

        self.restore()

        earlier = CheckRollupHourly.objects.get(bucket=H11 - rollups.HOUR)
        self.assertEqual((earlier.up_s, earlier.unknown_s), (0, 3600))
        straddle = CheckRollupHourly.objects.get(bucket=H11)
        self.assertEqual((straddle.up_s, straddle.unknown_s), (1800, 1800))
        open_row.refresh_from_db()
        self.assertEqual(open_row.up_s, 0)

    def test_fresh_install_is_a_no_op(self):
        self.restore()
        self.assertFalse(StateTransition.objects.exists())
