"""Status over time as segments - the same arithmetic behind the strip and
the uptime figure."""
from __future__ import annotations

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .models import CheckKind, CheckTemplate, StateTransition
from .timeline import integrate, merge_worst, segments_for_pairs


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.1", prefix=prefix)
        self.ip2 = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.2", prefix=prefix)
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.https = CheckTemplate.objects.create(
            tenant=self.tenant, name="HTTPS", slug="https", kind=CheckKind.HTTP
        )
        self.now = timezone.now()
        self.since = self.now - timedelta(days=1)

    def tr(self, at, to, *, ip=None, template=None, frm="up"):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=template or self.ping,
            kind=(template or self.ping).kind, from_status=frm, to_status=to, at=at,
        )

    def key(self, ip=None, template=None):
        return (str((ip or self.ip).id), str((template or self.ping).id))


class SegmentTests(_Base):
    def test_no_history_is_one_unknown_segment(self):
        segs = segments_for_pairs(self.tenant.id, [self.key()], self.since, self.now)[self.key()]
        self.assertEqual(
            segs, [{"start": self.since, "end": self.now, "status": "unknown"}]
        )

    def test_the_opening_status_comes_from_before_the_window(self):
        self.tr(self.since - timedelta(hours=5), "down")
        self.tr(self.now - timedelta(hours=6), "up", frm="down")
        segs = segments_for_pairs(self.tenant.id, [self.key()], self.since, self.now)[self.key()]
        self.assertEqual([s["status"] for s in segs], ["down", "up"])
        self.assertEqual(segs[0]["start"], self.since)
        self.assertEqual(segs[0]["end"], self.now - timedelta(hours=6))
        self.assertEqual(segs[1]["end"], self.now)

    def test_the_latest_pre_window_change_wins(self):
        """DISTINCT ON keeps the newest row per pair - the status the window
        actually opened in, not an older one."""
        self.tr(self.since - timedelta(hours=9), "down")
        self.tr(self.since - timedelta(hours=1), "up", frm="down")
        segs = segments_for_pairs(self.tenant.id, [self.key()], self.since, self.now)[self.key()]
        self.assertEqual([s["status"] for s in segs], ["up"])

    def test_many_pairs_in_two_queries(self):
        for ip in (self.ip, self.ip2):
            for t in (self.ping, self.https):
                self.tr(self.since - timedelta(hours=1), "up", ip=ip, template=t)
                self.tr(self.now - timedelta(hours=2), "down", ip=ip, template=t)
        pairs = [self.key(ip, t) for ip in (self.ip, self.ip2) for t in (self.ping, self.https)]
        with self.assertNumQueries(2):
            out = segments_for_pairs(self.tenant.id, pairs, self.since, self.now)
        self.assertEqual(len(out), 4)
        for segs in out.values():
            self.assertEqual([s["status"] for s in segs], ["up", "down"])

    def test_another_tenants_rows_are_not_read(self):
        org2 = Organization.objects.create(name="B", slug="b")
        other = Tenant.objects.create(org=org2, name="B", slug="b")
        self.tr(self.since - timedelta(hours=1), "down")
        out = segments_for_pairs(other.id, [self.key()], self.since, self.now)
        self.assertEqual(out[self.key()][0]["status"], "unknown")


class MergeTests(_Base):
    def test_worst_wins_per_interval_and_equal_runs_join(self):
        t0 = self.since
        a = [
            {"start": t0, "end": t0 + timedelta(hours=12), "status": "up"},
            {"start": t0 + timedelta(hours=12), "end": self.now, "status": "up"},
        ]
        b = [
            {"start": t0, "end": t0 + timedelta(hours=6), "status": "up"},
            {"start": t0 + timedelta(hours=6), "end": t0 + timedelta(hours=8), "status": "down"},
            {"start": t0 + timedelta(hours=8), "end": self.now, "status": "degraded"},
        ]
        merged = merge_worst([a, b])
        self.assertEqual(
            [(s["status"]) for s in merged], ["up", "down", "degraded"]
        )
        # The two "up" halves of ``a`` did not split the merged run.
        self.assertEqual(merged[0]["end"], t0 + timedelta(hours=6))
        self.assertEqual(merged[-1]["end"], self.now)

    def test_empty_inputs(self):
        self.assertEqual(merge_worst([]), [])
        self.assertEqual(merge_worst([[], []]), [])


class IntegrateTests(_Base):
    def test_seconds_per_class_and_incidents(self):
        t0 = self.since
        segs = [
            {"start": t0, "end": t0 + timedelta(hours=10), "status": "up"},
            {"start": t0 + timedelta(hours=10), "end": t0 + timedelta(hours=11), "status": "down"},
            {"start": t0 + timedelta(hours=11), "end": t0 + timedelta(hours=12), "status": "stale"},
            {"start": t0 + timedelta(hours=12), "end": t0 + timedelta(hours=13), "status": "unknown"},
            {"start": t0 + timedelta(hours=13), "end": self.now, "status": "degraded"},
        ]
        r = integrate(segs, up={"up", "degraded"}, down={"down", "stale"})
        self.assertEqual(r["up"], 21 * 3600)
        self.assertEqual(r["down"], 2 * 3600)
        self.assertEqual(r["excluded"], 3600)
        # down → stale is one outage, not two.
        self.assertEqual(r["incidents"], 1)
