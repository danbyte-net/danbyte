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
