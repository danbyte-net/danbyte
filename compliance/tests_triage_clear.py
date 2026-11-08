"""An acknowledgement covers one occurrence of a violation: when the object
passes, the evaluation clears it. A snooze keeps to its date."""
from __future__ import annotations

from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from api.models import IPAddress
from audit.models import ChangeLogEntry, JournalEntry
from core.models import Organization, Tenant

from .engine import CLEARED_BY, evaluate
from .models import ComplianceRule, ComplianceTriage
from .tests import _make_device
from .tests_overview import EVALUATE, SUMMARY, _Base


class AcknowledgementFollowsTheOccurrenceTests(_Base):
    def triage(self, rule, obj, ack=True, snooze_days=None, note=""):
        return ComplianceTriage.objects.create(
            tenant=self.tenant, rule=rule, object_type=rule.object_type,
            object_id=obj.pk, object_repr=str(obj),
            acknowledged_at=timezone.now() if ack else None,
            acknowledged_by=self.user if ack else None,
            snoozed_until=(timezone.now() + timedelta(days=snooze_days)
                           if snooze_days is not None else None),
            note=note,
        )

    def state(self, rule, obj):
        rows = self.client.get(EVALUATE + f"?rule={rule.id}&object={obj.id}").json()
        return [v["state"] for v in rows["violations"]]

    def fix(self, device, value="S1"):
        device.serial_number = value
        device.save()

    def test_acknowledged_then_passes_is_cleared(self):
        self.triage(self.serial, self.sw1, note="known")
        self.assertEqual(self.state(self.serial, self.sw1), ["acknowledged"])
        self.fix(self.sw1)
        self.client.get(SUMMARY)
        self.assertFalse(ComplianceTriage.objects.exists())
        # Failing again, it is a new occurrence: open.
        self.fix(self.sw1, "")
        self.assertEqual(self.state(self.serial, self.sw1), ["open"])

    def test_clear_is_logged_and_noted(self):
        t = self.triage(self.serial, self.sw1)
        self.fix(self.sw1)
        self.client.get(EVALUATE)
        entry = ChangeLogEntry.objects.get(
            object_type="compliance.compliancetriage", object_id=str(t.pk), action="delete"
        )
        self.assertEqual((entry.user_name, entry.via, entry.user), (CLEARED_BY, "system", None))
        self.assertEqual(entry.tenant, self.tenant)
        dev = JournalEntry.objects.get(object_type="api.device", object_id=str(self.sw1.id))
        self.assertIn("Cleared: the object passed Serial", dev.comments)
        self.assertEqual(dev.author_name, CLEARED_BY)
        self.assertEqual(dev.object_site_id, self.ams.id)
        rule = JournalEntry.objects.get(
            object_type="compliance.compliancerule", object_id=str(self.serial.id)
        )
        self.assertIn("Cleared: 1 acknowledged object passed", rule.comments)
        self.assertIn("sw1", rule.comments)

    def test_still_failing_keeps_the_acknowledgement(self):
        self.triage(self.serial, self.sw1)
        self.client.get(SUMMARY)
        self.assertEqual(self.state(self.serial, self.sw1), ["acknowledged"])
        self.assertFalse(JournalEntry.objects.exists())

    def test_snoozed_then_passes_stays_snoozed(self):
        self.triage(self.serial, self.sw1, ack=False, snooze_days=7)
        self.fix(self.sw1)
        self.client.get(SUMMARY)
        self.assertTrue(ComplianceTriage.objects.exists())
        self.fix(self.sw1, "")
        self.assertEqual(self.state(self.serial, self.sw1), ["snoozed"])

    def test_acknowledged_and_snoozed_keeps_the_snooze(self):
        t = self.triage(self.serial, self.sw1, snooze_days=7, note="vendor")
        self.fix(self.sw1)
        self.client.get(SUMMARY)
        t.refresh_from_db()
        self.assertIsNone(t.acknowledged_at)
        self.assertIsNone(t.acknowledged_by)
        self.assertIsNotNone(t.snoozed_until)
        self.assertEqual(t.note, "vendor")
        entry = ChangeLogEntry.objects.get(
            object_type="compliance.compliancetriage", object_id=str(t.pk), action="update"
        )
        self.assertEqual(set(entry.changes), {"acknowledged_at", "acknowledged_by"})
        self.assertIsNone(entry.changes["acknowledged_at"]["new"])
        # Failing again before the snooze ends: snoozed, not acknowledged.
        self.fix(self.sw1, "")
        self.assertEqual(self.state(self.serial, self.sw1), ["snoozed"])

    def test_snooze_expiry_reads_open(self):
        t = self.triage(self.serial, self.sw1, ack=False, snooze_days=7)
        self.fix(self.sw1)
        self.client.get(SUMMARY)
        self.fix(self.sw1, "")
        ComplianceTriage.objects.filter(pk=t.pk).update(
            snoozed_until=timezone.now() - timedelta(minutes=1)
        )
        self.assertEqual(self.state(self.serial, self.sw1), ["open"])

    def test_rule_violations_clears_only_its_rule(self):
        self.triage(self.serial, self.sw1)
        self.triage(self.asset, self.sw1)
        self.fix(self.sw1)
        self.sw1.asset_tag = "A1"
        self.sw1.save()
        r = self.client.get(f"/api/compliance-rules/{self.serial.id}/violations/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            list(ComplianceTriage.objects.values_list("rule_id", flat=True)), [self.asset.id]
        )

    def test_disabled_rule_is_not_judged(self):
        self.triage(self.serial, self.sw1)
        self.fix(self.sw1)
        self.serial.enabled = False
        self.serial.save()
        self.client.get(SUMMARY)
        self.assertTrue(ComplianceTriage.objects.exists())

    def test_row_past_the_cap_is_left(self):
        self.triage(self.serial, self.sw1)
        self.triage(self.serial, self.sw2)
        self.fix(self.sw1)
        self.fix(self.sw2)
        evaluate(self.tenant, rules=[self.serial], cap=1)
        self.assertEqual(ComplianceTriage.objects.count(), 1)

    def test_a_reacknowledged_row_is_left(self):
        """A row changed after the evaluation read it is not cleared."""
        from . import engine

        t = self.triage(self.serial, self.sw1)
        self.fix(self.sw1)
        original = engine.clear_passed_acknowledgements

        def later(tenant, passed):
            ComplianceTriage.objects.filter(pk=t.pk).update(
                acknowledged_at=timezone.now() + timedelta(seconds=1)
            )
            return original(tenant, passed)

        engine.clear_passed_acknowledgements = later
        try:
            evaluate(self.tenant)
        finally:
            engine.clear_passed_acknowledgements = original
        self.assertTrue(ComplianceTriage.objects.exists())

    def test_other_tenant_untouched(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        dev = _make_device(other, "foreign")
        dev.serial_number = "S"
        dev.save()
        rule = ComplianceRule.objects.create(
            tenant=other, name="F", object_type="device",
            check_type="required", field="serial_number",
        )
        ComplianceTriage.objects.create(
            tenant=other, rule=rule, object_type="device", object_id=dev.pk,
            acknowledged_at=timezone.now(),
        )
        self.client.get(SUMMARY)
        self.assertTrue(ComplianceTriage.objects.filter(tenant=other).exists())

    def test_address_note_carries_its_prefixs_site(self):
        from api.models import Prefix

        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24", site=self.lon)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.9.0.5", prefix=prefix)
        rule = ComplianceRule.objects.create(
            tenant=self.tenant, name="DNS", object_type="ipaddress",
            check_type="required", field="dns_name",
        )
        self.triage(rule, ip)
        ip.dns_name = "a.example"
        ip.save()
        self.client.get(SUMMARY)
        self.assertFalse(ComplianceTriage.objects.exists())
        note = JournalEntry.objects.get(object_type="api.ipaddress", object_id=str(ip.pk))
        self.assertEqual(note.object_site_id, self.lon.id)

    def _clear_queries(self, pairs) -> int:
        """Queries for one summary that clears ``(rule, device, snoozed)``
        acknowledgements: snoozed rows are updated, the others deleted."""
        ComplianceTriage.objects.all().delete()
        for d in (self.sw1, self.sw2):
            d.serial_number = ""
            d.asset_tag = ""
            d.save()
        for rule, dev, snoozed in pairs:
            self.triage(rule, dev, snooze_days=7 if snoozed else None)
        for d in (self.sw1, self.sw2):
            d.serial_number = "S"
            d.asset_tag = "A"
            d.save()
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(SUMMARY)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(
            ComplianceTriage.objects.filter(acknowledged_at__isnull=False).exists()
        )
        return len(ctx.captured_queries)

    def test_clear_query_count_does_not_grow_with_rows(self):
        self.client.get(SUMMARY)  # warm per-process caches
        two = self._clear_queries([(self.serial, self.sw1, False),
                                   (self.asset, self.sw1, True)])
        four = self._clear_queries([
            (self.serial, self.sw1, False), (self.serial, self.sw2, False),
            (self.asset, self.sw1, True), (self.asset, self.sw2, True),
        ])
        self.assertEqual(two, four)

    def test_nothing_to_clear_adds_no_query(self):
        self.client.get(SUMMARY)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(SUMMARY)
        before = len(ctx.captured_queries)
        self.triage(self.serial, self.sw1)  # still failing: nothing to clear
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(SUMMARY)
        self.assertEqual(len(ctx.captured_queries), before)
