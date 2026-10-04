"""SLA and rollup edge cases: outages across a period's edge, budgets with
unmeasured members, redundancy coverage, daylight saving, rollup windows,
report rules, stored period bounds, report recipients and scoped member
lists, and incidents that follow the counting rules (#257-#266)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from django.contrib.auth.models import User
from django.test import SimpleTestCase

from api.models import Device
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile

from . import sla
from . import sla_time as st
from .figures import figures as row_figures
from .figures import span_window
from .models import CheckRollupHourly, SlaAgreementRevision, SlaPeriodResult
from .rollups import HOUR, CountingRules, roll
from .tests_sla import DAY, NOW, SEP
from .tests_sla import _Base as _EngineBase
from .tests_sla_api import A
from .tests_sla_api import _WithFigures as _ApiBase

AUG = datetime(2026, 8, 1, tzinfo=UTC)


class OutageAcrossTheEdgeTests(_EngineBase):
    """#257: the minimum outage judges the whole outage, not each piece."""

    def test_an_outage_across_the_month_counts_in_both_months(self):
        self.agreement.min_outage_seconds = 900
        self.agreement.save()
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP - timedelta(minutes=10), "down")
        self.tr(ip, self.ping, SEP + timedelta(minutes=10), "up")
        aug = sla.compute(self.agreement, AUG, SEP, now=NOW)["figures"]
        sep = self.compute()["figures"]
        self.assertEqual((aug["down_s"], aug["incidents"]), (600, 1))
        self.assertEqual((sep["down_s"], sep["incidents"]), (600, 1))

    def test_a_short_outage_is_still_forgiven(self):
        self.agreement.min_outage_seconds = 900
        self.agreement.save()
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, minutes=10), "up")
        self.assertEqual(self.compute()["figures"]["down_s"], 0)


class BudgetTests(_EngineBase):
    """#258: members with no data do not dilute the budget."""

    def test_unmeasured_members_leave_the_budget_alone(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=9), "down")
        alone = self.compute()["figures"]
        for n in range(9):
            quiet = Device.objects.create(
                tenant=self.tenant, name=f"quiet{n}", device_type=self.dtype, role=self.role,
                site=self.site, status=status_for(self.tenant),
            )
            self.member(quiet)
        crowd = self.compute()["figures"]
        self.assertEqual(crowd["availability"], alone["availability"])
        self.assertEqual(crowd["down_s"], alone["down_s"])
        self.assertEqual(crowd["budget_spent_pct"], alone["budget_spent_pct"])


class RedundancyCoverageTests(_EngineBase):
    """#261: a pair replaced mid-period never covers more than 100%."""

    def test_one_after_the_other(self):
        a, _ = self.device("old", 1)
        b, _ = self.device("new", 2)
        swap = SEP + timedelta(days=5)
        self.member(a, redundancy_group="pair", left_at=swap)
        m = self.member(b, redundancy_group="pair")
        m.joined_at = swap
        m.save()
        out = self.compute()
        unit = next(u for u in out["units"] if u["key"] == "rg:pair")
        self.assertEqual(unit["service_s"], 10 * DAY)
        self.assertEqual(unit["up_s"], 10 * DAY)
        self.assertLessEqual(out["figures"]["coverage"], 100.0)


class DaylightSavingTests(SimpleTestCase):
    """#260: a month is as long as it really is."""

    def test_october_and_march_in_amsterdam(self):
        ams = ZoneInfo("Europe/Amsterdam")
        october = st.service_windows(
            datetime(2026, 10, 1, tzinfo=ams), datetime(2026, 11, 1, tzinfo=ams), "Europe/Amsterdam"
        )
        march = st.service_windows(
            datetime(2026, 3, 1, tzinfo=ams), datetime(2026, 4, 1, tzinfo=ams), "Europe/Amsterdam"
        )
        self.assertEqual(st.total(october), 745 * 3600)
        self.assertEqual(st.total(march), 743 * 3600)
        # Service hours drawn day by day add up the same way.
        days = st.service_windows(
            datetime(2026, 10, 1, tzinfo=ams), datetime(2026, 11, 1, tzinfo=ams),
            "Europe/Amsterdam", {d: [["00:00", "24:00"]] for d in st.WEEKDAYS},
        )
        self.assertEqual(st.total(days), 745 * 3600)

    def test_tally_counts_real_seconds(self):
        ams = ZoneInfo("Europe/Amsterdam")
        s, e = datetime(2026, 10, 25, 0, tzinfo=ams), datetime(2026, 10, 26, 0, tzinfo=ams)
        self.assertEqual(st.tally([(s, e, st.UP)])["up_s"], 25 * 3600)


class SpanWindowTests(SimpleTestCase):
    """#259: an exact period end leaves the next period's first hour out."""

    def test_exact_end_is_exclusive(self):
        sep, octo = datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 10, 1, tzinfo=UTC)
        last = span_window(sep, octo).parts[-1]
        self.assertEqual(last[2], octo)

    def test_mid_hour_until_keeps_its_hour(self):
        until = datetime(2026, 9, 10, 14, 30, tzinfo=UTC)
        last = span_window(datetime(2026, 9, 1, tzinfo=UTC), until).parts[-1]
        self.assertEqual(last[2], datetime(2026, 9, 10, 15, tzinfo=UTC))


class ReportRulesTests(_EngineBase):
    """#262: a report shows the rules its period was worked out under."""

    def test_rules_line_is_the_periods(self):
        from .sla_report import report_html

        dev, _ = self.device("leaf1", 1)
        self.member(dev)
        SlaAgreementRevision.objects.create(
            agreement=self.agreement, number=1, rules=self.agreement.rules()
        )
        oct3 = datetime(2026, 10, 3, tzinfo=UTC)
        sla.refresh_agreement(self.agreement, now=oct3)
        self.agreement.min_outage_seconds = 300
        self.agreement.count_stale_as = "down"
        self.agreement.revision = 2
        self.agreement.save()
        sep = SlaPeriodResult.objects.get(agreement=self.agreement, period_key="2026-09")
        html = report_html(self.agreement, sep)
        self.assertIn("outages under 0s ignored", html)
        self.assertIn("stale counts as not measured", html)


class IncidentRulesTests(_EngineBase):
    """#266: going blind is an incident only where stale counts as down."""

    def test_stale_is_counted_apart(self):
        _dev, ip = self.device("leaf1", 1)
        hour = datetime(2026, 9, 3, 10, tzinfo=UTC)
        self.tr(ip, self.ping, hour + timedelta(minutes=15), "stale")
        self.tr(ip, self.ping, hour + timedelta(minutes=30), "up")
        self.tr(ip, self.ping, hour + timedelta(minutes=40), "down")
        self.tr(ip, self.ping, hour + timedelta(minutes=45), "up")
        roll(self.tenant.id, HOUR, hour, hour + HOUR, now=hour + 2 * HOUR)
        row = CheckRollupHourly.objects.get(target_ip=ip, template=self.ping, bucket=hour)
        self.assertEqual((row.incidents, row.blind_incidents), (1, 2))
        summed = {"incidents": row.incidents, "blind_incidents": row.blind_incidents,
                  "up_s": row.up_s, "down_s": row.down_s, "stale_s": row.stale_s}
        self.assertEqual(row_figures(summed)["incidents"], 1)
        self.assertEqual(row_figures(summed, CountingRules(stale="down"))["incidents"], 2)


class StoredBoundsTests(_ApiBase):
    """#263: the analysis of a stored period keeps that period's bounds."""

    def test_timezone_change_keeps_old_bounds(self):
        res = SlaPeriodResult.objects.filter(agreement_id=self.agreement_id).first()
        res.state = "closed"
        res.save()
        since = res.figures["since"]
        r = self.client.patch(f"{A}{self.agreement_id}/", {"timezone": "Pacific/Auckland"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = self.client.get(
            f"{A}{self.agreement_id}/analysis/", {"period": res.period_key}
        ).json()
        self.assertEqual(body["figures"]["since"], since)


def _scoped_user(test, name, *, credits=False, change=False):
    user = User.objects.create_user(name, password="x")
    UserProfile.objects.create(user=user, role="custom").tenants.add(test.tenant)
    actions = ["view"] + (["change"] if change else []) + (["view_credits"] if credits else [])
    sla_perm = ObjectPermission.objects.create(
        name=f"sla-{name}", object_types=["slaagreement"], actions=actions
    )
    sla_perm.users.add(user)
    sla_perm.tenants.add(test.tenant)
    dev_perm = ObjectPermission.objects.create(
        name=f"dev-{name}", object_types=["device"], actions=["view"]
    )
    dev_perm.users.add(user)
    dev_perm.tenants.add(test.tenant)
    dev_perm.sites.add(test.site_a)
    return user


class RecipientsTests(_ApiBase):
    """#264: the automatic report's recipients need what the report shows."""

    def test_without_view_credits_refused(self):
        self.login(_scoped_user(self, "editor", change=True))
        r = self.client.patch(f"{A}{self.agreement_id}/",
                              {"report_recipients": ["out@example.net"]}, format="json")
        self.assertEqual(r.status_code, 403, r.content)

    def test_site_scoped_refused_even_with_view_credits(self):
        self.login(_scoped_user(self, "scoped", change=True, credits=True))
        r = self.client.patch(f"{A}{self.agreement_id}/",
                              {"report_recipients": ["out@example.net"]}, format="json")
        self.assertEqual(r.status_code, 403, r.content)

    def test_admin_may(self):
        r = self.client.patch(f"{A}{self.agreement_id}/",
                              {"report_recipients": ["out@example.net"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_echoing_the_same_list_is_fine(self):
        self.client.patch(f"{A}{self.agreement_id}/",
                          {"report_recipients": ["out@example.net"]}, format="json")
        self.login(_scoped_user(self, "editor2", change=True))
        r = self.client.patch(f"{A}{self.agreement_id}/",
                              {"report_recipients": ["out@example.net"], "name": "Gold 2"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)


class ScopedMembersTests(_ApiBase):
    """#265: members and filter choices leave out what the viewer can't see."""

    def test_members_list_and_analysis_options(self):
        self.login(_scoped_user(self, "viewer"))
        rows = self.client.get("/api/monitoring/sla-members/",
                               {"agreement": self.agreement_id}).json()
        rows = rows.get("results", rows)
        self.assertEqual({str(m["object_id"]) for m in rows}, {str(self.dev_a.id)})
        opts = self.client.get(f"{A}{self.agreement_id}/analysis/",
                               {"period": "current"}).json()["options"]
        self.assertEqual([m["name"] for m in opts["members"]], ["a1"])
        self.assertEqual([s["name"] for s in opts["sites"]], ["Alpha"])

    def test_an_unscoped_viewer_sees_both(self):
        rows = self.client.get("/api/monitoring/sla-members/",
                               {"agreement": self.agreement_id}).json()
        rows = rows.get("results", rows)
        self.assertEqual(len(rows), 2)

