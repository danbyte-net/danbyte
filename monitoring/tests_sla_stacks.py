"""A switch stack in an SLA: one member, measured on the address that
stands for it, never its addressless members as "no data" beside it."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import (
    Device,
    DeviceType,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
    VirtualChassis,
)
from api.test_utils import status_for
from core.models import Organization, Tenant

from . import sla, sla_analysis
from .models import (
    CheckState,
    EventImpact,
    MaintenanceEvent,
    SlaCheckGroup,
    SlaCheckItem,
    SlaExclusion,
    SlaMember,
    SlaPeriodResult,
)
from .tests_sla import DAY, NOW, SEP, _Base

VC = "api.virtualchassis"


class _Stack(_Base):
    def bare(self, name, dtype=None):
        """A device with no address."""
        return Device.objects.create(
            tenant=self.tenant, name=name, device_type=dtype or self.dtype, role=self.role,
            site=self.site, status=status_for(self.tenant),
        )

    def join(self, vc, dev, pos):
        dev.virtual_chassis = vc
        dev.vc_position = pos
        dev.save()

    def stack(self, name="sw1", size=3, n=10, master_ip=True, dtype=None):
        """A chassis whose master alone has an address and checks."""
        vc = VirtualChassis.objects.create(tenant=self.tenant, name=name)
        if master_ip:
            master, ip = self.device(f"{name}-1", n)
            if dtype is not None:
                master.device_type = dtype
                master.save()
        else:
            master, ip = self.bare(f"{name}-1", dtype), None
        self.join(vc, master, 1)
        members = [master]
        for i in range(2, size + 1):
            d = self.bare(f"{name}-{i}", dtype)
            self.join(vc, d, i)
            members.append(d)
        vc.master = master
        vc.save()
        return vc, members, ip

    def vc_member(self, vc, group=None, **kw):
        return SlaMember.objects.create(
            tenant=self.tenant, agreement=self.agreement, group=group or self.group,
            object_type=VC, object_id=vc.id, joined_at=SEP - timedelta(days=30), **kw,
        )

    def rows(self, out=None):
        out = out or self.compute()
        return [u for u in out["units"] if u.get("member")]

    def down_hour(self, ip, day=2):
        self.tr(ip, self.ping, SEP + timedelta(days=day), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=day, hours=1), "up")


class ChassisMemberTests(_Stack):
    def test_a_chassis_is_measured_on_the_masters_address(self):
        vc, _members, ip = self.stack()
        self.vc_member(vc)
        self.down_hour(ip)
        out = self.compute()
        self.assertEqual(out["figures"]["down_s"], 3600)
        self.assertEqual(out["figures"]["coverage"], 100.0)
        [row] = self.rows(out)
        self.assertEqual((row["object_type"], row["name"]), (VC, "sw1"))
        self.assertEqual(row["site_id"], str(self.site.id))
        self.assertEqual({i["address"] for i in row["items"]}, {"10.0.0.10"})
        # An explicit chassis with nothing folded into it has no via.
        self.assertNotIn("via", row)
        self.assertNotIn("member_ids", row)

    def test_a_chassis_without_a_master_uses_the_lowest_member(self):
        vc, _members, _ip = self.stack()
        vc.master = None
        vc.save()
        self.vc_member(vc)
        [row] = self.rows()
        self.assertEqual({i["address"] for i in row["items"]}, {"10.0.0.10"})

    def test_a_master_without_an_address_falls_back_to_a_member_with_one(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="sw9")
        a, _ = self.device("sw9-1", 21)
        b, _ = self.device("sw9-2", 22)
        master = self.bare("sw9-3")
        for pos, d in ((1, a), (2, b), (3, master)):
            self.join(vc, d, pos)
        vc.master = master
        vc.save()
        self.vc_member(vc)
        [row] = self.rows()
        self.assertEqual({i["address"] for i in row["items"]}, {"10.0.0.21"})

    def test_a_stack_with_no_address_is_not_measured_never_down(self):
        vc, _members, _ip = self.stack(master_ip=False)
        self.vc_member(vc)
        self.agreement.count_unknown_as = "down"
        self.agreement.save()
        out = self.compute()
        [row] = self.rows(out)
        self.assertIsNone(row["availability"])
        self.assertEqual(row["coverage"], 0.0)
        self.assertEqual(out["figures"]["state"], "no_data")
        self.assertEqual(out["figures"]["down_s"], 0)

    def test_every_address_reads_all_members(self):
        vc, members, _ip = self.stack()
        extra = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.30", prefix=self.prefix,
            assigned_device=members[2],
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=extra, template=self.ping, kind=self.ping.kind,
            status="up",
        )
        self.group.target = "all"
        self.group.save()
        self.vc_member(vc)
        [row] = self.rows()
        self.assertEqual({i["address"] for i in row["items"]}, {"10.0.0.10", "10.0.0.30"})

    def test_the_same_stack_in_two_groups_is_two_rows(self):
        vc, _members, _ip = self.stack()
        other = SlaCheckGroup.objects.create(
            tenant=self.tenant, agreement=self.agreement, name="Core"
        )
        SlaCheckItem.objects.create(group=other, template=self.ping)
        self.vc_member(vc)
        self.vc_member(vc, group=other)
        self.assertEqual(len(self.rows()), 2)


class FoldTests(_Stack):
    def test_three_stack_devices_count_once(self):
        vc, members, ip = self.stack()
        rows = [self.member(d) for d in members]
        self.down_hour(ip)
        out = self.compute()
        self.assertEqual(out["figures"]["members"], 1)
        self.assertEqual(out["figures"]["units"], 1)
        self.assertEqual(out["figures"]["coverage"], 100.0)
        [row] = self.rows(out)
        self.assertEqual((row["object_type"], row["object_id"]), (VC, str(vc.id)))
        self.assertEqual([v["name"] for v in row["via"]], ["sw1-1", "sw1-2", "sw1-3"])
        # The master's row stands for the stack, whatever the row ids.
        self.assertEqual(row["member_id"], str(rows[0].id))
        self.assertEqual(sorted(row["member_ids"]), sorted(str(r.id) for r in rows))
        self.assertFalse(row["selected"])

    def test_the_stack_row_is_one_that_has_not_left(self):
        _vc, members, _ip = self.stack()
        rows = [self.member(d) for d in members]
        # The master's row left on day 3; the others still fold the stack,
        # and exclusions go on a row that is still in.
        rows[0].left_at = SEP + timedelta(days=3)
        rows[0].save()
        [row] = self.rows()
        self.assertEqual(row["member_id"], str(rows[1].id))
        self.assertEqual(sorted(row["member_ids"]), sorted(str(r.id) for r in rows))

    def test_a_masters_redundancy_group_holds_whatever_the_row_ids(self):
        # The master and a peer back each other up; a stack member without
        # an address joins with no label. Row ids are random, so try both
        # orders: the stack stays in "core", one unit with the peer.
        _vc, members, ip = self.stack()
        peer, _ = self.device("peer", 40)
        self.down_hour(ip)
        low, high = uuid.UUID(int=1), uuid.UUID(int=2)
        for master_row, other_row in ((low, high), (high, low)):
            with self.subTest(master_first=master_row == low):
                SlaMember.objects.all().delete()
                self.member(members[0], id=master_row, redundancy_group="core")
                self.member(peer, redundancy_group="core")
                self.member(members[1], id=other_row)
                out = self.compute()
                self.assertEqual(out["figures"]["units"], 1)
                self.assertEqual(out["figures"]["down_s"], 0)
                stack_row = next(r for r in self.rows(out) if r["object_type"] == VC)
                self.assertEqual(stack_row["redundancy_group"], "core")

    def test_the_first_label_by_role_is_the_stacks(self):
        vc, members, _ip = self.stack()
        self.member(members[0])
        self.member(members[2], redundancy_group="edge")
        self.member(members[1], redundancy_group="core")
        # No label on the master's row: the next member by position has one.
        [row] = self.rows()
        self.assertEqual(row["redundancy_group"], "core")
        # A chassis row's label comes first; an empty one gives way.
        own = self.vc_member(vc)
        self.assertEqual(self.rows()[0]["redundancy_group"], "core")
        own.redundancy_group = "stack"
        own.save()
        self.assertEqual(self.rows()[0]["redundancy_group"], "stack")

    def test_a_chassis_row_and_device_rows_merge(self):
        vc, members, _ip = self.stack()
        own = self.vc_member(vc, redundancy_group="core")
        self.member(members[1], redundancy_group="other")
        [row] = self.rows()
        self.assertEqual(row["member_id"], str(own.id))
        self.assertEqual(row["redundancy_group"], "core")
        self.assertEqual([v["name"] for v in row["via"]], ["sw1-2"])
        self.assertEqual(len(row["member_ids"]), 2)

    def test_a_stack_where_every_member_has_an_address_is_unchanged(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="fw")
        a, _ = self.device("fw-a", 1)
        b, ipb = self.device("fw-b", 2)
        self.join(vc, a, 1)
        self.join(vc, b, 2)
        self.member(a)
        self.member(b)
        self.down_hour(ipb)
        rows = self.rows()
        self.assertEqual([r["object_type"] for r in rows], ["api.device", "api.device"])
        self.assertTrue(all("via" not in r and "member_ids" not in r for r in rows))
        # The peer's outage still counts, halved by the mean as before.
        self.assertEqual(self.compute()["figures"]["down_s"], 1800)

    def test_the_mean_budget_counts_the_stack_once(self):
        # Three rows used to be three units, two of them empty: the mean
        # spent 3600 / 3. Folded, the stack is one unit of two.
        vc, members, ip = self.stack()
        for d in members:
            self.member(d)
        solo, _ = self.device("leaf9", 40)
        self.member(solo)
        self.down_hour(ip)
        f = self.compute()["figures"]
        self.assertEqual(f["units"], 2)
        self.assertEqual(f["down_s"], 1800)

    def test_selectors_fold_stacks(self):
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="S", slug="s")
        stacked = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="Stack", name="Stack")
        self.stack(dtype=stacked)
        self.device("leaf9", 40)
        self.group.use_selector = True
        self.group.save()
        self.group.match_roles.add(self.role)
        out = self.compute()
        self.assertEqual(out["figures"]["members"], 2)
        stack_row = next(r for r in self.rows(out) if r["object_type"] == VC)
        self.assertTrue(stack_row["selected"])
        self.assertIsNone(stack_row["member_id"])
        self.assertEqual(len(stack_row["via"]), 3)
        self.group.match_roles.clear()
        self.group.match_device_types.add(stacked)
        self.assertEqual([r["name"] for r in self.rows()], ["sw1"])

    def test_excluding_the_chassis_keeps_a_selected_stack_out(self):
        vc, members, _ip = self.stack()
        self.device("leaf9", 40)
        self.group.use_selector = True
        self.group.save()
        self.group.match_roles.add(self.role)
        self.member(members[1], excluded=True)
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        stack_row = next(r for r in rows if r["object_type"] == VC)
        self.assertEqual([v["name"] for v in stack_row["via"]], ["sw1-1", "sw1-3"])
        self.vc_member(vc, excluded=True)
        self.assertEqual([r["name"] for r in self.rows()], ["leaf9"])

    def test_maintenance_on_the_chassis_or_the_measured_member_excuses_it(self):
        vc, members, ip = self.stack()
        self.vc_member(vc)
        self.tr(ip, self.ping, SEP + timedelta(days=2), "down")
        self.tr(ip, self.ping, SEP + timedelta(days=2, hours=3), "up")
        status = status_for(self.tenant, "confirmed")

        def works(target, otype, hour):
            ev = MaintenanceEvent.objects.create(
                tenant=self.tenant, name=f"Works {hour}", status=status,
                starts_at=SEP + timedelta(days=2, hours=hour),
                ends_at=SEP + timedelta(days=2, hours=hour + 1),
            )
            EventImpact.objects.create(
                tenant=self.tenant, event=ev, object_type=otype, object_id=target.id,
                level="outage",
            )

        # Work on a member that is not measured excuses nothing.
        works(members[1], "api.device", 0)
        self.assertEqual(self.compute()["figures"]["down_s"], 3 * 3600)
        works(members[0], "api.device", 1)
        works(vc, VC, 2)
        self.assertEqual(self.compute()["figures"]["down_s"], 3600)

    def test_an_exclusion_on_any_folded_row_excuses_the_stack(self):
        _vc, members, ip = self.stack()
        rows = sorted((self.member(d) for d in members), key=lambda r: str(r.id))
        self.down_hour(ip)
        SlaExclusion.objects.create(
            tenant=self.tenant, agreement=self.agreement, member=rows[-1],
            reason="Stack upgrade", starts_at=SEP + timedelta(days=2),
            ends_at=SEP + timedelta(days=2, hours=1),
        )
        self.assertEqual(self.compute()["figures"]["down_s"], 0)

    def test_a_device_that_leaves_its_chassis_is_itself_again(self):
        _vc, members, _ip = self.stack()
        for d in members:
            self.member(d)
        for d in members[1:]:
            d.virtual_chassis = None
            d.vc_position = None
            d.save()
        rows = self.rows()
        self.assertEqual({r["object_type"] for r in rows}, {"api.device"})
        self.assertEqual(sorted(r["name"] for r in rows), ["sw1-1", "sw1-2", "sw1-3"])

    def test_another_tenants_member_is_ignored(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="Far")
        mfr = Manufacturer.objects.create(tenant=other, name="M", slug="m")
        dtype = DeviceType.objects.create(tenant=other, manufacturer=mfr, model="X")
        vc, _members, _ip = self.stack()
        # Written behind the API's back: a foreign device in our chassis.
        foreign = Device.objects.create(
            tenant=other, name="spy", device_type=dtype, site=site, status=status_for(other),
        )
        foreign.virtual_chassis = vc
        foreign.vc_position = 0
        foreign.save()
        net = Prefix.objects.create(
            tenant=other, cidr="192.0.2.0/24", status=status_for(other, "container"))
        IPAddress.objects.create(
            tenant=other, ip_address="192.0.2.1", prefix=net, assigned_device=foreign)
        self.group.target = "all"
        self.group.save()
        self.vc_member(vc)
        [row] = self.rows()
        self.assertEqual({i["address"] for i in row["items"]}, {"10.0.0.10"})
        self.assertEqual(sla.member_ip_ids([self.agreement.id]), {_ip.id})


class ConsumerTests(_Stack):
    def test_no_stack_leaves_members_as_they_were(self):
        a, _ = self.device("leaf1", 1)
        b = self.bare("leaf2")
        self.member(a)
        self.member(b)
        _key, start, end = sla.period_for(self.agreement, NOW)
        entries = sla.resolve_members(self.agreement, start, end)
        self.assertEqual(
            {k for e in entries for k in e},
            {"member_id", "group", "object_type", "object_id", "site_id",
             "redundancy_group", "monitor_ip_id", "active"},
        )
        for row in self.rows():
            self.assertNotIn("via", row)
            self.assertNotIn("member_ids", row)

    def test_addresses_for_views_objectives_and_the_analysis(self):
        vc, members, ip = self.stack()
        for d in members:
            self.member(d)
        self.assertEqual(sla.member_ip_ids([self.agreement.id]), {ip.id})
        _key, start, end = sla.period_for(self.agreement, NOW)
        ips = sla_analysis._window_ips(self.agreement, start, end, {"member": [str(vc.id)]})
        self.assertEqual(ips, {ip.id})
        opts = sla_analysis.options(self.agreement, NOW)
        self.assertEqual(
            opts["members"], [{"id": str(vc.id), "object_type": VC, "name": "sw1"}]
        )
        body = sla_analysis.analyse(self.agreement, start, end, now=NOW)
        [m] = body["by_member"]
        self.assertEqual(len(m["via"]), 3)
        self.assertEqual(len(m["member_ids"]), 3)

    def test_the_query_count_does_not_grow_with_the_stack(self):
        vc, members, _ip = self.stack()
        for d in members:
            self.member(d)
        _key, start, end = sla.period_for(self.agreement, NOW)
        with CaptureQueriesContext(connection) as small:
            sla.resolve_members(self.agreement, start, end)
        for i in range(4, 10):
            d = self.bare(f"sw1-{i}")
            self.join(vc, d, i)
            self.member(d)
        with CaptureQueriesContext(connection) as big:
            entries = sla.resolve_members(self.agreement, start, end)
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(big), len(small))


class PeriodTests(_Stack):
    def test_frozen_results_keep_their_rows_and_grace_week_ones_fold(self):
        vc, members, _ip = self.stack()
        for d in members:
            self.member(d)
        old_units = [{"member": True, "key": "x", "object_type": "api.device",
                      "object_id": str(members[1].id), "name": "sw1-2", "availability": None}]
        old_figures = {"availability": None, "state": "no_data", "members": 3}
        aug = SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=self.agreement, period_key="2026-08",
            period_start=datetime(2026, 8, 1, tzinfo=UTC), period_end=SEP,
            state="frozen", figures=old_figures, units=old_units,
        )
        sep = SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=self.agreement, period_key="2026-09",
            period_start=SEP, period_end=datetime(2026, 10, 1, tzinfo=UTC),
            state="closed", figures=old_figures, units=old_units,
        )
        sla.refresh_agreement(self.agreement, now=datetime(2026, 10, 3, tzinfo=UTC))
        aug.refresh_from_db()
        sep.refresh_from_db()
        self.assertEqual((aug.figures, aug.units), (old_figures, old_units))
        self.assertEqual(sep.state, "closed")
        self.assertEqual(sep.figures["members"], 1)
        self.assertEqual([u["object_type"] for u in sep.units if u.get("member")], [VC])

    def test_a_selector_added_in_the_grace_week_counts_for_the_closed_period(self):
        # Selector matches are read live from the period's start: a role
        # added on 2 October changes September until it freezes.
        a, _ = self.device("leaf1", 1)
        self.member(a)
        self.device("leaf2", 2)
        oct1 = datetime(2026, 10, 1, 1, tzinfo=UTC)
        sla.refresh_agreement(self.agreement, now=oct1)
        sep = SlaPeriodResult.objects.get(period_key="2026-09")
        self.assertEqual(sep.figures["members"], 1)
        self.group.use_selector = True
        self.group.save()
        self.group.match_roles.add(self.role)
        sla.refresh_agreement(self.agreement, now=oct1 + timedelta(days=1))
        sep.refresh_from_db()
        self.assertEqual(sep.figures["members"], 2)
        self.assertEqual(sep.figures["full_service_s"], 30 * DAY)
