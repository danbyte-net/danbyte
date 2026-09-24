"""SLA figures: counting rules, all-must-pass, redundancy, maintenance,
exclusions, budgets and the period lifecycle."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from django.test import TestCase

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import sla
from .models import (
    CheckKind,
    CheckState,
    CheckTemplate,
    EventImpact,
    HolidayCalendar,
    MaintenanceEvent,
    SlaAgreement,
    SlaCheckGroup,
    SlaCheckItem,
    SlaExclusion,
    SlaMember,
    SlaPeriodResult,
    StateTransition,
)

# September 2026 in UTC; "now" is ten days in.
SEP = datetime(2026, 9, 1, tzinfo=UTC)
NOW = SEP + timedelta(days=10)
DAY = 86400


class _Base(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="Leaf")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Leaf", slug="leaf")
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.ssh = CheckTemplate.objects.create(
            tenant=self.tenant, name="SSH", slug="ssh", kind=CheckKind.SSH
        )
        self.agreement = SlaAgreement.objects.create(
            tenant=self.tenant, name="Gold", target_pct=Decimal("99.000"), timezone="UTC",
        )
        self.group = SlaCheckGroup.objects.create(
            tenant=self.tenant, agreement=self.agreement, name="Leafs"
        )
        SlaCheckItem.objects.create(group=self.group, template=self.ping)

    def device(self, name, n):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.0.0.{n}", prefix=self.prefix
        )
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype, role=self.role,
            site=self.site, status=status_for(self.tenant), primary_ip=ip,
        )
        ip.assigned_device = dev
        ip.save()
        for t in (self.ping, self.ssh):
            CheckState.objects.create(
                tenant=self.tenant, target_ip=ip, template=t, kind=t.kind, status="up"
            )
            self.tr(ip, t, SEP - timedelta(days=1), "up")
        return dev, ip

    def tr(self, ip, tmpl, at, to):
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=tmpl, kind=tmpl.kind,
            from_status="up", to_status=to, at=at,
        )

    def member(self, dev, **kw):
        return SlaMember.objects.create(
            tenant=self.tenant, agreement=self.agreement, group=self.group,
            object_type="api.device", object_id=dev.id, joined_at=SEP - timedelta(days=30),
            **kw,
        )

    def compute(self, **kw):
        _key, start, end = sla.period_for(self.agreement, NOW)
        return sla.compute(self.agreement, start, end, now=NOW, **kw)


class FigureTests(_Base):
    def test_an_hour_down_in_ten_days(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, hours=1), "up")
        f = self.compute()["figures"]
        self.assertAlmostEqual(f["availability"], 100 * (10 * DAY - 3600) / (10 * DAY), places=3)
        self.assertEqual(f["coverage"], 100.0)
        self.assertEqual(f["incidents"], 1)
        self.assertEqual(f["state"], "ok")
        # 1 % of 30 days, 3600 s of it spent.
        self.assertEqual(f["budget_s"], round(0.01 * 30 * DAY))
        self.assertEqual(f["down_s"], 3600)

    def test_only_counted_items_count(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        SlaCheckItem.objects.create(group=self.group, template=self.ssh, counts=False)
        self.tr(ip, self.ssh, SEP + timedelta(days=2), "down")
        out = self.compute()
        self.assertEqual(out["figures"]["availability"], 100.0)
        member = next(u for u in out["units"] if u.get("member"))
        ssh = next(i for i in member["items"] if i["name"] == "SSH")
        self.assertFalse(ssh["counts"])
        self.assertLess(ssh["availability"], 100)

    def test_all_must_pass_across_items(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        SlaCheckItem.objects.create(group=self.group, template=self.ssh)
        self.tr(ip, self.ssh, SEP + timedelta(days=9), "down")
        f = self.compute()["figures"]
        self.assertEqual(f["down_s"], DAY)
        self.assertEqual(f["state"], "breached")

    def test_stale_is_not_measured_by_default(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=5), "stale")
        f = self.compute()["figures"]
        self.assertEqual(f["availability"], 100.0)
        self.assertEqual(f["coverage"], 50.0)
        self.agreement.count_stale_as = "down"
        self.agreement.save()
        self.assertEqual(self.compute()["figures"]["availability"], 50.0)

    def test_grace_forgives_blips(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, seconds=60), "up")
        self.agreement.min_outage_seconds = 120
        self.agreement.save()
        self.assertEqual(self.compute()["figures"]["incidents"], 0)

    def test_redundancy_group_is_down_only_when_both_are(self):
        a, ipa = self.device("leaf1", 1)
        b, ipb = self.device("leaf2", 2)
        self.member(a, redundancy_group="pair")
        self.member(b, redundancy_group="pair")
        self.tr(ipa, self.ping, SEP + timedelta(days=1), "down")
        self.tr(ipa, self.ping, SEP + timedelta(days=3), "up")
        self.tr(ipb, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ipb, self.ping, SEP + timedelta(days=2, hours=2), "up")
        out = self.compute()
        self.assertEqual(out["figures"]["units"], 1)
        self.assertEqual(out["figures"]["down_s"], 7200)
        self.assertEqual(out["incidents"][0]["members"], ["leaf1", "leaf2"])

    def test_mean_versus_worst(self):
        a, ipa = self.device("leaf1", 1)
        b, _ipb = self.device("leaf2", 2)
        self.member(a)
        self.member(b)
        self.tr(ipa, self.ping, SEP + timedelta(days=9), "down")
        self.assertEqual(self.compute()["figures"]["availability"], 95.0)
        self.agreement.aggregation = "worst"
        self.agreement.save()
        self.assertEqual(self.compute()["figures"]["availability"], 90.0)

    def test_service_hours_and_holidays(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        # Down overnight only: outside 08-17 it does not count.
        self.tr(ip, self.ping, SEP + timedelta(days=2, hours=20), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=3, hours=6), "up")
        cal = HolidayCalendar.objects.create(tenant=self.tenant, name="DK", dates=["2026-09-01"])
        self.agreement.service_hours = {
            d: [["08:00", "17:00"]] for d in ("mon", "tue", "wed", "thu", "fri")
        }
        self.agreement.holiday_calendar = cal
        self.agreement.save()
        f = self.compute()["figures"]
        self.assertEqual(f["availability"], 100.0)
        # 1-10 Sept: 8 weekdays, one of them a holiday - 7 x 9 hours.
        member = next(u for u in self.compute()["units"] if u.get("member"))
        self.assertEqual(member["service_s"], 7 * 9 * 3600)

    def test_maintenance_and_exclusions_are_excused(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, hours=2), "up")
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, name="Upgrade", status=status_for(self.tenant, "confirmed"),
            starts_at=SEP + timedelta(days=2), ends_at=SEP + timedelta(days=2, hours=1),
        )
        EventImpact.objects.create(
            tenant=self.tenant, event=ev, object_type="api.device", object_id=dev.id,
            level="outage",
        )
        self.assertEqual(self.compute()["figures"]["down_s"], 3600)
        SlaExclusion.objects.create(
            tenant=self.tenant, agreement=self.agreement, reason="Fibre cut, provider",
            starts_at=SEP + timedelta(days=2, hours=1), ends_at=SEP + timedelta(days=2, hours=2),
        )
        self.assertEqual(self.compute()["figures"]["down_s"], 0)

    def test_a_cancelled_maintenance_excuses_nothing(self):
        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, hours=1), "up")
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, name="Upgrade", status=status_for(self.tenant, "cancelled"),
            starts_at=SEP + timedelta(days=2), ends_at=SEP + timedelta(days=2, hours=1),
        )
        EventImpact.objects.create(
            tenant=self.tenant, event=ev, object_type="api.device", object_id=dev.id,
            level="outage",
        )
        self.assertEqual(self.compute()["figures"]["down_s"], 3600)

    def test_selector_members_and_exclusions(self):
        a, _ = self.device("leaf1", 1)
        b, _ = self.device("leaf2", 2)
        self.group.use_selector = True
        self.group.save()
        self.group.match_roles.add(self.role)
        self.assertEqual(self.compute()["figures"]["members"], 2)
        self.member(b, excluded=True)
        self.assertEqual(self.compute()["figures"]["members"], 1)

    def test_an_empty_selector_matches_nothing(self):
        self.device("leaf1", 1)
        self.group.use_selector = True
        self.group.save()
        self.assertEqual(self.compute()["figures"]["members"], 0)

    def test_leaving_mid_period_counts_the_time_before(self):
        dev, ip = self.device("leaf1", 1)
        m = self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=5), "down")
        m.left_at = SEP + timedelta(days=5)
        m.save()
        f = self.compute()["figures"]
        self.assertEqual(f["availability"], 100.0)

    def test_no_members_is_no_data(self):
        self.assertEqual(self.compute()["figures"]["state"], "no_data")


class PeriodTests(_Base):
    def test_calendar_periods(self):
        self.assertEqual(sla.period_for(self.agreement, NOW)[0], "2026-09")
        self.agreement.period = "quarter"
        key, start, end = sla.period_for(self.agreement, NOW)
        self.assertEqual((key, start.month, end.month), ("2026-Q3", 7, 10))
        self.assertEqual(sla.previous_period(self.agreement, NOW)[0], "2026-Q2")

    def test_lifecycle_open_closed_frozen(self):
        dev, _ip = self.device("leaf1", 1)
        self.member(dev)
        sla.refresh_agreement(self.agreement, now=NOW)
        self.assertEqual(
            set(SlaPeriodResult.objects.values_list("period_key", "state")),
            {("2026-09", "open"), ("2026-08", "frozen")},
        )
        # Early October: September closes, still editable for a week.
        oct3 = datetime(2026, 10, 3, tzinfo=UTC)
        sla.refresh_agreement(self.agreement, now=oct3)
        sep = SlaPeriodResult.objects.get(period_key="2026-09")
        self.assertEqual(sep.state, "closed")
        sla.refresh_agreement(self.agreement, now=oct3 + timedelta(days=6))
        sep.refresh_from_db()
        self.assertEqual(sep.state, "frozen")
        frozen_at = sep.computed_at
        sla.refresh_agreement(self.agreement, now=oct3 + timedelta(days=20))
        sep.refresh_from_db()
        self.assertEqual(sep.computed_at, frozen_at)

    def test_a_closed_period_keeps_its_revision_rules(self):
        from .models import SlaAgreementRevision

        dev, ip = self.device("leaf1", 1)
        self.member(dev)
        self.tr(ip, self.ping, SEP + timedelta(days=5), "stale")
        SlaAgreementRevision.objects.create(
            agreement=self.agreement, number=1, rules=self.agreement.rules()
        )
        oct3 = datetime(2026, 10, 3, tzinfo=UTC)
        sla.refresh_agreement(self.agreement, now=oct3)
        # The rules change in October; September's figure must not.
        self.agreement.count_stale_as = "down"
        self.agreement.revision = 2
        self.agreement.save()
        sla.refresh_agreement(self.agreement, now=oct3 + timedelta(days=1))
        sep = SlaPeriodResult.objects.get(period_key="2026-09")
        self.assertEqual(sep.figures["availability"], 100.0)
        self.assertEqual(sep.revision, 1)
