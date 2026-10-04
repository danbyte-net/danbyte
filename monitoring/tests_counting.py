"""Resetting an address's availability: every figure counts from the reset,
the history before it is kept but not counted, and a reset needs a reason
and is on the record."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix, Site
from api.test_utils import status_for
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import sla
from .counting import NOT_COUNTED, Cut, clip, cuts, reset
from .figures import sums, window
from .models import (
    CheckResult,
    CheckRollupDaily,
    CheckRollupHourly,
    CheckState,
    CheckTemplate,
    SlaAgreement,
    SlaCheckGroup,
    SlaCheckItem,
    SlaMember,
    SlaPeriodResult,
    StateTransition,
)
from .timeline import integrate, segments_for_pairs

T0 = datetime(2026, 9, 10, tzinfo=UTC)


def seg(a, b, status, **kw):
    return {"start": T0 + timedelta(hours=a), "end": T0 + timedelta(hours=b),
            "status": status, **kw}


class ClipTests(TestCase):
    since, until = T0, T0 + timedelta(hours=10)

    def test_a_cut_inside_the_window(self):
        out = clip([seg(0, 4, "up"), seg(4, 10, "down")], self.since, self.until,
                   Cut(counts_from=T0 + timedelta(hours=6)))
        self.assertEqual(out, [
            seg(0, 6, "skipped", note=NOT_COUNTED),
            seg(6, 10, "down"),  # the status in effect at the cut opens it
        ])

    def test_a_cut_after_the_window_counts_nothing(self):
        out = clip([seg(0, 10, "up")], self.since, self.until,
                   Cut(counts_from=T0 + timedelta(hours=12)))
        self.assertEqual(out, [seg(0, 10, "skipped", note=NOT_COUNTED)])

    def test_a_cut_before_the_window_changes_nothing(self):
        segs = [seg(0, 10, "up")]
        self.assertEqual(clip(segs, self.since, self.until,
                              Cut(counts_from=T0 - timedelta(hours=2))), segs)

    def test_excluded_after_a_reset(self):
        out = clip([seg(0, 10, "up")], self.since, self.until,
                   Cut(counts_from=T0 + timedelta(hours=2),
                       excluded_at=T0 + timedelta(hours=8)))
        self.assertEqual(out, [
            seg(0, 2, "skipped", note=NOT_COUNTED), seg(2, 8, "up"),
            seg(8, 10, "skipped", note="excluded"),
        ])

    def test_excluded_before_the_reset_leaves_the_reset_first(self):
        out = clip([seg(0, 10, "up")], self.since, self.until,
                   Cut(counts_from=T0 + timedelta(hours=5),
                       excluded_at=T0 + timedelta(hours=1)))
        self.assertEqual(out, [
            seg(0, 5, "skipped", note=NOT_COUNTED),
            seg(5, 10, "skipped", note="excluded"),
        ])

    def test_no_fake_incident_at_the_cut(self):
        """Down across the reset is one outage for the new host, not a new
        incident opened by the cut."""
        segs = clip([seg(0, 3, "up"), seg(3, 10, "down")], self.since, self.until,
                    Cut(counts_from=T0 + timedelta(hours=5)))
        t = integrate(segs, up={"up"}, down={"down"})
        self.assertEqual(t["incidents"], 0)
        self.assertEqual(t["down"], 5 * 3600)
        self.assertEqual(t["up"], 0)


class _Base(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.7.0.0/24", status=status_for(self.tenant, "container"),
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.7.0.5", prefix=self.prefix, site=self.site)
        self.ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.7.0.6", prefix=self.prefix, site=self.site)
        IPAddress.objects.filter(pk__in=[self.ip.pk, self.ip2.pk]).update(
            created_at=T0 - timedelta(days=90))
        self.ip.refresh_from_db()
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp")
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp", status="up")
        self.state2 = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip2, template=self.ping, kind="icmp", status="up")
        self.user = User.objects.create_superuser("bob", "b@b.c", "pw")

    def tr(self, ip, at, to, frm="up"):
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.ping, kind="icmp",
            from_status=frm, to_status=to, at=at)

    def cut_at(self, ip, when):
        IPAddress.objects.filter(pk=ip.pk).update(availability_since=when)

    def key(self, ip=None):
        return (str((ip or self.ip).id), str(self.ping.id))


class SegmentTests(_Base):
    def test_segments_count_from_the_reset(self):
        self.tr(self.ip, T0 - timedelta(days=1), "up", frm="unknown")
        self.tr(self.ip, T0 + timedelta(hours=2), "down")
        self.tr(self.ip, T0 + timedelta(hours=4), "up", frm="down")
        self.cut_at(self.ip, T0 + timedelta(hours=3))
        out = segments_for_pairs(self.tenant.id, [self.key(), self.key(self.ip2)],
                                 T0, T0 + timedelta(hours=10))
        self.assertEqual(
            [(s["status"], s.get("note")) for s in out[self.key()]],
            [("skipped", NOT_COUNTED), ("down", None), ("up", None)],
        )
        self.assertEqual(out[self.key()][1]["start"], T0 + timedelta(hours=3))
        # The other address is untouched.
        self.assertNotIn("note", out[self.key(self.ip2)][0])

    def test_three_queries_with_and_without_cuts(self):
        pairs = [self.key(), self.key(self.ip2)]
        with self.assertNumQueries(3):
            segments_for_pairs(self.tenant.id, pairs, T0, T0 + timedelta(hours=10))
        self.cut_at(self.ip, T0 + timedelta(hours=3))
        self.cut_at(self.ip2, T0 + timedelta(hours=4))
        with self.assertNumQueries(3):
            segments_for_pairs(self.tenant.id, pairs, T0, T0 + timedelta(hours=10))

    def test_uncounted_is_what_happened(self):
        self.tr(self.ip, T0 - timedelta(days=1), "down", frm="unknown")
        self.cut_at(self.ip, T0 + timedelta(hours=3))
        out = segments_for_pairs(self.tenant.id, [self.key()], T0, T0 + timedelta(hours=10),
                                 counted=False)
        self.assertEqual([s["status"] for s in out[self.key()]], ["down"])

    def test_cuts_never_cross_tenants(self):
        org2 = Organization.objects.create(name="B", slug="b")
        t2 = Tenant.objects.create(org=org2, name="B", slug="b")
        p2 = Prefix.objects.create(tenant=t2, cidr="10.7.0.0/24",
                                   status=status_for(t2, "container"))
        ip_b = IPAddress.objects.create(tenant=t2, ip_address="10.7.0.5", prefix=p2)
        self.cut_at(ip_b, T0 + timedelta(hours=3))
        self.assertEqual(cuts(self.tenant.id, T0), {})
        self.assertIn(str(ip_b.id), cuts(t2.id, T0))

    def test_uptime_drops_the_downtime_before_the_reset(self):
        from .uptime import check_uptime

        self.tr(self.ip, T0 - timedelta(days=1), "up", frm="unknown")
        self.tr(self.ip, T0 + timedelta(hours=1), "down")
        self.tr(self.ip, T0 + timedelta(hours=2), "up", frm="down")
        self.cut_at(self.ip, T0 + timedelta(hours=3))
        state = CheckState.objects.select_related("template").get(pk=self.state.pk)
        out = check_uptime(state, T0, T0 + timedelta(hours=10))
        self.assertEqual(out["uptime_pct"], 100.0)
        self.assertEqual(out["down_seconds"], 0)
        self.assertEqual(out["incidents"], 0)
        self.assertEqual(out["up_seconds"], 7 * 3600)


class SlaTests(_Base):
    """September 2026, ten days in; the address was down on the 2nd, then
    reset on the 5th for a new host."""

    SEP = datetime(2026, 9, 1, tzinfo=UTC)

    def setUp(self):
        super().setUp()
        self.agreement = SlaAgreement.objects.create(
            tenant=self.tenant, name="Gold", target_pct=Decimal("99.000"), timezone="UTC",
        )
        group = SlaCheckGroup.objects.create(
            tenant=self.tenant, agreement=self.agreement, name="Hosts")
        SlaCheckItem.objects.create(group=group, template=self.ping)
        SlaMember.objects.create(
            tenant=self.tenant, agreement=self.agreement, group=group,
            object_type="api.ipaddress", object_id=self.ip.id,
            joined_at=self.SEP - timedelta(days=30),
        )
        self.tr(self.ip, self.SEP - timedelta(days=1), "up", frm="unknown")
        self.tr(self.ip, self.SEP + timedelta(days=1), "down")
        self.tr(self.ip, self.SEP + timedelta(days=2), "up", frm="down")

    def compute(self, **kw):
        now = self.SEP + timedelta(days=10)
        _k, start, end = sla.period_for(self.agreement, now)
        return sla.compute(self.agreement, start, end, now=now, **kw)["figures"]

    def test_the_outage_before_the_reset_is_not_charged(self):
        before = self.compute()
        self.assertLess(before["availability"], 100)
        self.cut_at(self.ip, self.SEP + timedelta(days=5))
        after = self.compute()
        self.assertEqual(after["availability"], 100.0)
        self.assertEqual(after["incidents"], 0)

    def test_coverage_stays_whole_after_a_reset(self):
        """The member joins at the reset, so the time before it is not
        unmeasured service time dragging coverage down."""
        self.cut_at(self.ip, self.SEP + timedelta(days=5))
        self.assertEqual(self.compute()["coverage"], 100.0)

    def test_a_period_that_ended_before_the_reset_keeps_its_figures(self):
        """August closed before the reset on 3 September: recomputing it
        (closed, not yet frozen) gives what it closed with."""
        aug = datetime(2026, 8, 1, tzinfo=UTC)
        now = self.SEP + timedelta(days=10)

        def august():
            return sla.compute(self.agreement, aug, self.SEP, now=now)["figures"]

        before = august()
        self.assertIsNotNone(before["availability"])
        self.cut_at(self.ip, self.SEP + timedelta(days=2))
        after = august()
        self.assertEqual(
            (after["availability"], after["coverage"]),
            (before["availability"], before["coverage"]),
        )
        # A reset exactly at the period's end is not inside it either.
        self.cut_at(self.ip, self.SEP)
        self.assertEqual(august()["coverage"], before["coverage"])

    def test_unknown_as_down_does_not_charge_the_time_before(self):
        SlaAgreement.objects.filter(pk=self.agreement.pk).update(count_unknown_as="down")
        self.agreement.refresh_from_db()
        self.cut_at(self.ip, self.SEP + timedelta(days=5))
        self.assertEqual(self.compute()["availability"], 100.0)


class RollupFigureTests(_Base):
    """Rollups keep what happened; the figures read them from the reset."""

    NOW = datetime(2026, 9, 10, 12, 30, tzinfo=UTC)

    def row(self, model, bucket, up=0, down=0, ip=None):
        model.objects.create(
            tenant=self.tenant, target_ip=ip or self.ip, template=self.ping, kind="icmp",
            bucket=bucket, up_s=up, down_s=down,
        )

    def setUp(self):
        super().setUp()
        day = timedelta(days=1)
        today = datetime(2026, 9, 10, tzinfo=UTC)
        for ip in (self.ip, self.ip2):
            # Two closed days, all down; today's hours up.
            for d in (2, 1):
                self.row(CheckRollupDaily, today - d * day, down=86400, ip=ip)
            for h in range(12):
                self.row(CheckRollupHourly, today + timedelta(hours=h), up=3600, ip=ip)
        # The reset day's own hours (the hourly rows behind the daily one).
        for h in range(24):
            self.row(CheckRollupHourly, today - day + timedelta(hours=h), down=3600)

    def figures(self, win, ip=None):
        got = sums(win, lambda qs: qs.filter(tenant=self.tenant,
                                             target_ip=ip or self.ip), ())
        return got.get((), {})

    def test_hours_count_from_the_next_whole_hour(self):
        self.cut_at(self.ip, datetime(2026, 9, 10, 5, 20, tzinfo=UTC))
        row = self.figures(window(hours=24, now=self.NOW))
        # 06:00 .. 11:00 - six whole hours after the cut.
        self.assertEqual(row["up_s"], 6 * 3600)

    def test_the_reset_day_comes_from_its_hours(self):
        """Reset at 14:10 UTC on the 9th: the 9th counts 15:00-24:00 from the
        hourly rows, never the daily row - and nothing twice."""
        self.cut_at(self.ip, datetime(2026, 9, 9, 14, 10, tzinfo=UTC))
        row = self.figures(window(days=3, now=self.NOW))
        self.assertEqual(row["down_s"], 9 * 3600)
        self.assertEqual(row["up_s"], 12 * 3600)
        # Another address is untouched: both closed days, and today.
        other = self.figures(window(days=3, now=self.NOW), ip=self.ip2)
        self.assertEqual(other["down_s"], 2 * 86400)

    def test_a_reset_on_utc_midnight_counts_its_day_once(self):
        """Reset at 00:00 UTC on the 9th: the 9th's daily row counts, and its
        hourly rows do not come in on top of it."""
        self.cut_at(self.ip, datetime(2026, 9, 9, tzinfo=UTC))
        row = self.figures(window(days=3, now=self.NOW))
        self.assertEqual(row["down_s"], 86400)
        self.assertEqual(row["up_s"], 12 * 3600)

    def test_many_resets_join_and_count_the_same(self):
        """Past the inline limit the cut joins the address table - with the
        same answers, midnight included."""
        with mock.patch("monitoring.counting._INLINE_MAX", 0):
            self.cut_at(self.ip, datetime(2026, 9, 9, 14, 10, tzinfo=UTC))
            row = self.figures(window(days=3, now=self.NOW))
            self.assertEqual((row["down_s"], row["up_s"]), (9 * 3600, 12 * 3600))
            self.cut_at(self.ip, datetime(2026, 9, 9, tzinfo=UTC))
            row = self.figures(window(days=3, now=self.NOW))
            self.assertEqual((row["down_s"], row["up_s"]), (86400, 12 * 3600))

    def test_a_viewer_ahead_of_utc_counts_nothing_twice(self):
        """Month to date for a viewer in UTC+2: the reset day is still bounded
        by the daily rows' own (UTC) midnight."""
        from .figures import frame_window

        self.cut_at(self.ip, datetime(2026, 9, 9, 22, 30, tzinfo=UTC))
        win = frame_window("mtd", "Europe/Copenhagen", now=self.NOW)
        row = self.figures(win)
        self.assertEqual(row["down_s"], 1 * 3600)  # 23:00 on the 9th
        self.assertEqual(row["up_s"], 12 * 3600)

    def test_the_query_count_does_not_grow_with_resets(self):
        """One look-up for the resets, one query per slice - and one for the
        reset day's hours when a reset falls on a daily slice, however many."""
        win = window(days=3, now=self.NOW)
        narrow = lambda qs: qs.filter(tenant=self.tenant)  # noqa: E731
        with self.assertNumQueries(1 + len(win.parts)) as ctx:
            sums(win, narrow, ())
        # No reset: the figure queries are what they were, with no join.
        for q in ctx.captured_queries[1:]:
            self.assertNotIn("api_ipaddress", q["sql"])
        self.cut_at(self.ip, datetime(2026, 9, 9, 14, 10, tzinfo=UTC))
        with self.assertNumQueries(2 + len(win.parts)) as ctx:
            sums(win, narrow, ())
        for q in ctx.captured_queries[1:]:
            self.assertNotIn("api_ipaddress", q["sql"])
        self.cut_at(self.ip2, datetime(2026, 9, 9, 16, 10, tzinfo=UTC))
        with self.assertNumQueries(2 + len(win.parts)):
            sums(win, narrow, ())

    def test_a_reset_after_a_span_does_not_cut_it(self):
        """An SLA period's rollups (a span window) keep what they said
        when it ended."""
        from .figures import span_window

        span = span_window(datetime(2026, 9, 8, tzinfo=UTC), datetime(2026, 9, 10, tzinfo=UTC))
        self.cut_at(self.ip, datetime(2026, 9, 10, 5, tzinfo=UTC))
        self.assertEqual(self.figures(span)["down_s"], 2 * 86400)

    def test_rerolling_after_a_reset_changes_no_rollup(self):
        from .rollups import HOUR, roll

        start = datetime(2026, 9, 10, 3, tzinfo=UTC)
        self.tr(self.ip, start - timedelta(days=1), "down", frm="unknown")
        roll(self.tenant.id, HOUR, start, start + HOUR, now=self.NOW)
        before = CheckRollupHourly.objects.get(target_ip=self.ip, bucket=start).down_s
        self.cut_at(self.ip, start + timedelta(minutes=30))
        roll(self.tenant.id, HOUR, start, start + HOUR, now=self.NOW)
        after = CheckRollupHourly.objects.get(target_ip=self.ip, bucket=start).down_s
        self.assertEqual(before, after)
        self.assertEqual(after, 3600)

    def test_the_dashboard_availability_is_trimmed(self):
        from api.dashboard_views import _monitoring_charts

        now = timezone.now()
        for ago, status in ((5, "down"), (4, "down"), (1, "up")):
            CheckResult.objects.create(
                tenant=self.tenant, target_ip=self.ip, template=self.ping, kind="icmp",
                status=status, timestamp=now - timedelta(hours=ago))
        req = mock.Mock(user=self.user)
        self.assertEqual(
            _monitoring_charts(req, self.user, self.tenant)["availability_7d"], 33.33)
        self.cut_at(self.ip, now - timedelta(hours=2))
        self.assertEqual(
            _monitoring_charts(req, self.user, self.tenant)["availability_7d"], 100.0)


class ToDateFrameTests(_Base):
    """Month to date counts from local midnight on the 1st, each hour once,
    whatever the UTC date is (#270)."""

    def setUp(self):
        super().setUp()
        # 1 Sep and 30 Sep - 2 Oct (UTC), up throughout: the daily row and
        # its hours, as the timer writes them.
        for day in (datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 30, tzinfo=UTC),
                    datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 10, 2, tzinfo=UTC)):
            self.row(CheckRollupDaily, day, 86400)
            for h in range(24):
                self.row(CheckRollupHourly, day + timedelta(hours=h), 3600)

    def row(self, model, bucket, up):
        model.objects.create(tenant=self.tenant, target_ip=self.ip, template=self.ping,
                             kind="icmp", bucket=bucket, up_s=up)

    def hours_up(self, tz, *utc):
        from .figures import frame_window

        now = datetime(*utc, tzinfo=UTC)
        got = sums(frame_window("mtd", tz, now=now),
                   lambda qs: qs.filter(tenant=self.tenant, target_ip=self.ip), ())
        return got[()]["up_s"] / 3600

    def test_new_york(self):
        # 1 Oct 21:00 local: October's 21 hours, not the last one.
        self.assertEqual(self.hours_up("America/New_York", 2026, 10, 2, 1), 21)
        # 30 Sep 21:00 local: 1 Sep from 04:00 UTC (20 h), 30 Sep whole from
        # its daily row (24 h) and 1 Oct's first UTC hour (1 h).
        self.assertEqual(self.hours_up("America/New_York", 2026, 10, 1, 1), 45)

    def test_amsterdam(self):
        # 1 Oct 01:00 local: one hour of October, none of 30 September.
        self.assertEqual(self.hours_up("Europe/Amsterdam", 2026, 9, 30, 23), 1)


class ResetApiTests(APITestCase, _Base):
    def setUp(self):
        _Base.setUp(self)

    def login(self, user=None):
        self.client.force_login(user or self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def post(self, body, ip=None):
        # The SLA refresh job is queued after the commit; recorded, not sent.
        with mock.patch("monitoring.counting._enqueue_refresh") as job, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(
                f"/api/monitoring/ips/{(ip or self.ip).id}/reset-availability/", body,
                format="json")
        self.queued = [c.args[0] for c in job.call_args_list]
        return r

    def test_a_reason_is_required(self):
        self.login()
        r = self.post({})
        self.assertEqual(r.status_code, 400)
        self.assertIn("reason", r.json())
        r = self.post({"reason": "   "})
        self.assertEqual(r.status_code, 400)
        self.assertIn("reason", r.json())
        r = self.post({"reason": "x" * 201})
        self.assertEqual(r.status_code, 400)
        self.ip.refresh_from_db()
        self.assertIsNone(self.ip.availability_since)

    def test_reset_from_now_is_on_the_record(self):
        self.login()
        CheckState.objects.filter(pk=self.state.pk).update(
            flapping_since=timezone.now(), flap_count=4)
        r = self.post({"reason": "New host on the address"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.queued, [str(self.ip.id)])
        m = r.json()["monitoring"]
        self.assertEqual(m["reset_by"], "bob")
        self.assertEqual(m["reset_reason"], "New host on the address")
        self.assertIsNotNone(m["counts_from"])
        self.ip.refresh_from_db()
        self.assertLess(abs((timezone.now() - self.ip.availability_since).total_seconds()), 60)
        entry = ChangeLogEntry.objects.filter(
            object_id=str(self.ip.id), changes__has_key="availability_since").get()
        self.assertEqual(entry.user_name, "bob")
        self.assertEqual(entry.changes["availability_reset_reason"]["new"],
                         "New host on the address")
        note = JournalEntry.objects.get(object_id=str(self.ip.id))
        self.assertTrue(note.comments.startswith("Availability reset - counts from "))
        self.assertTrue(note.comments.endswith("Reason: New host on the address."))
        # The old host's flapping says nothing about the new one.
        self.state.refresh_from_db()
        self.assertIsNone(self.state.flapping_since)
        b = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").json()
        self.assertEqual(b["monitoring"]["reset_by"], "bob")

    def test_a_day_is_midnight_in_the_viewers_timezone(self):
        self.login()
        with mock.patch("monitoring.charts.viewer_tz", return_value=ZoneInfo("Europe/Copenhagen")):
            r = self.post({"since": "2026-09-01", "reason": "Reused"})
        self.assertEqual(r.status_code, 200, r.content)
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.availability_since,
                         datetime(2026, 8, 31, 22, tzinfo=UTC))

    def test_future_and_before_the_address_are_refused(self):
        self.login()
        tomorrow = (timezone.now() + timedelta(days=2)).date().isoformat()
        r = self.post({"since": tomorrow, "reason": "x"})
        self.assertEqual(r.json(), {"since": ["Can't be in the future."]})
        r = self.post({"since": "2020-01-01", "reason": "x"})
        self.assertEqual(r.json(), {"since": ["Before the address existed."]})

    def test_an_echoed_reset_passes_the_ip_api(self):
        """GET, then PATCH back exactly what it said - the rendered form of
        the counts-from moment - saves."""
        self.login()
        self.post({"reason": "New host"})
        got = self.client.get(f"/api/ips/{self.ip.id}/").json()
        self.assertIsNotNone(got["availability_since"])
        r = self.client.patch(
            f"/api/ips/{self.ip.id}/",
            {"availability_since": got["availability_since"], "description": "x"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"/api/ips/{self.ip.id}/",
                              {"availability_since": "2026-01-01T00:00:00Z"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("availability_since", r.json())
        r = self.client.patch(f"/api/ips/{self.ip.id}/",
                              {"availability_since": "not a date"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_clearing_with_no_reset_in_force_is_refused(self):
        self.login()
        r = self.post({"clear": True, "reason": "Nothing"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json(), {"detail": "No reset to clear."})
        self.assertEqual(self.queued, [])
        self.assertFalse(JournalEntry.objects.filter(object_id=str(self.ip.id)).exists())
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_id=str(self.ip.id), changes__has_key="reason").exists())

    def test_the_helper_needs_a_reason_too(self):
        for reason in ("", "   "):
            with self.assertRaises(ValueError):
                reset(self.ip, counts_from=T0, user=self.user, reason=reason)
            with self.assertRaises(ValueError):
                reset(self.ip, counts_from=None, user=self.user, reason=reason)
        self.ip.refresh_from_db()
        self.assertIsNone(self.ip.availability_since)

    def test_clearing_counts_everything_again(self):
        self.login()
        self.post({"reason": "New host"})
        r = self.post({"clear": True, "reason": "Wrong address"})
        self.assertEqual(r.status_code, 200, r.content)
        self.ip.refresh_from_db()
        self.assertIsNone(self.ip.availability_since)
        self.assertIsNone(r.json()["monitoring"]["reset_by"])
        self.assertTrue(JournalEntry.objects.filter(
            object_id=str(self.ip.id),
            comments__startswith="Availability reset cleared").exists())

    def _member(self, name, grants):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for slug, actions in grants.items():
            perm = ObjectPermission.objects.create(
                name=f"{slug}-{name}", object_types=[slug], actions=actions)
            perm.users.add(user)
            perm.tenants.add(self.tenant)
        return user

    def test_a_viewer_is_refused(self):
        self.login(self._member("viewer", {"ipaddress": ["view"]}))
        self.assertEqual(self.post({"reason": "x"}).status_code, 403)

    def _agreement(self):
        a = SlaAgreement.objects.create(
            tenant=self.tenant, name="Gold", target_pct=Decimal("99.000"), timezone="UTC")
        other = SlaAgreement.objects.create(
            tenant=self.tenant, name="Silver", target_pct=Decimal("99.000"), timezone="UTC")
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=a, period_key="2026-09", state="open",
            period_start=T0, period_end=T0 + timedelta(days=20),
            units=[{"member": True, "items": [{"ip_id": str(self.ip.id), "name": "ping"}]}],
        )
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=other, period_key="2026-09", state="open",
            period_start=T0, period_end=T0 + timedelta(days=20),
            units=[{"member": True, "items": [{"ip_id": str(self.ip2.id)}]}],
        )
        return a, other

    def test_an_address_in_an_agreement_needs_the_sla_grant(self):
        gold, _silver = self._agreement()
        editor = self._member("editor", {"ipaddress": ["view", "change"]})
        self.login(editor)
        self.assertEqual(self.post({"reason": "x"}).status_code, 403)
        sla_editor = self._member("sla", {"ipaddress": ["view", "change"],
                                          "slaagreement": ["view", "change"]})
        self.login(sla_editor)
        r = self.post({"reason": "Reused"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["agreements"], 1)
        # The agreement's own journal names the address and the reason.
        note = JournalEntry.objects.get(object_id=str(gold.id))
        self.assertIn("10.7.0.5", note.comments)
        self.assertTrue(note.comments.endswith("Reason: Reused."))
        # The address's gives a count: its readers may not see the agreement.
        own = JournalEntry.objects.get(object_id=str(self.ip.id))
        self.assertTrue(own.comments.endswith("Reason: Reused. Affects 1 SLA agreement."))
        self.assertNotIn("Gold", own.comments)

    def test_a_closed_period_that_ended_before_the_reset_is_left_alone(self):
        """Not counted as affected - no SLA grant asked, no journal, no
        refresh - unless the reset reaches back into it."""
        bronze = SlaAgreement.objects.create(
            tenant=self.tenant, name="Bronze", target_pct=Decimal("99.000"), timezone="UTC")
        ended = timezone.now() - timedelta(days=3)
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=bronze, period_key="2026-08", state="closed",
            period_start=ended - timedelta(days=30), period_end=ended,
            units=[{"member": True, "items": [{"ip_id": str(self.ip.id)}]}],
        )
        editor = self._member("editor", {"ipaddress": ["view", "change"]})
        self.login(editor)
        r = self.post({"reason": "New host"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["agreements"], 0)
        self.assertFalse(JournalEntry.objects.filter(object_id=str(bronze.id)).exists())
        # Backdated into that period: now it is affected, and needs the grant.
        day = (ended - timedelta(days=2)).date().isoformat()
        self.assertEqual(self.post({"since": day, "reason": "Earlier"}).status_code, 403)

    def test_the_job_refreshes_only_the_agreements_that_count_it(self):
        from .counting import refresh_after_reset

        gold, _silver = self._agreement()
        with mock.patch("monitoring.sla.refresh_agreement") as refresh:
            self.assertEqual(refresh_after_reset(str(self.ip.id)), 1)
        self.assertEqual([c.args[0].pk for c in refresh.call_args_list], [gold.pk])

    def test_the_job_leaves_a_period_that_ended_before_the_change(self):
        from .counting import refresh_after_reset

        gold, _silver = self._agreement()
        SlaPeriodResult.objects.filter(agreement=gold).update(state="closed")
        end = SlaPeriodResult.objects.get(agreement=gold).period_end
        with mock.patch("monitoring.sla.refresh_agreement") as refresh:
            self.assertEqual(refresh_after_reset(str(self.ip.id), end.isoformat()), 0)
            self.assertEqual(
                refresh_after_reset(str(self.ip.id),
                                    (end - timedelta(days=1)).isoformat()), 1)
        self.assertEqual(refresh.call_count, 1)

    def test_reset_through_the_helper_without_a_request(self):
        """A job or script: the user is still named on the record."""
        with mock.patch("monitoring.counting._enqueue_refresh"):
            reset(self.ip, counts_from=T0, user=self.user, reason="Scripted")
        entry = ChangeLogEntry.objects.get(
            object_id=str(self.ip.id), changes__has_key="availability_since")
        self.assertEqual(entry.user_name, "bob")
