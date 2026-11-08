"""The Compliance overview: the summary endpoint, violation facets and filters,
and triage (acknowledge / snooze / clear)."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Prefix, Site
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import ComplianceRule, ComplianceTriage
from .tests import _make_device

SUMMARY = "/api/compliance/summary/"
EVALUATE = "/api/compliance/evaluate/"
TRIAGE = "/api/compliance/triage/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.sw1 = _make_device(self.tenant, "sw1")
        self.sw2 = _make_device(self.tenant, "sw2")
        self.sw1.site = self.ams
        self.sw1.save()
        self.sw2.site = self.lon
        self.sw2.save()
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", description="ok")
        self.p2 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.1.0/24")
        self.serial = ComplianceRule.objects.create(
            tenant=self.tenant, name="Serial", object_type="device",
            check_type="required", field="serial_number", severity="critical",
        )
        self.asset = ComplianceRule.objects.create(
            tenant=self.tenant, name="Asset tag", object_type="device",
            check_type="required", field="asset_tag", severity="warning",
        )
        self.desc = ComplianceRule.objects.create(
            tenant=self.tenant, name="Prefix description", object_type="prefix",
            check_type="required", field="description", severity="info",
        )
        self.passing = ComplianceRule.objects.create(
            tenant=self.tenant, name="Name set", object_type="device",
            check_type="required", field="name", severity="critical",
        )
        ComplianceRule.objects.create(
            tenant=self.tenant, name="Off", object_type="device",
            check_type="required", field="serial_number", enabled=False,
        )
        self.user = self.login_as(
            "ops", ["compliancerule", "compliancetriage", "device", "prefix"],
            ["view", "change"],
        )

    def login_as(self, name, types, actions, sites=()):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name=name, object_types=types, actions=actions)
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        return user


class SummaryTests(_Base):
    def test_totals_rules_and_offenders(self):
        r = self.client.get(SUMMARY)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        t = body["totals"]
        self.assertEqual(t["rules"], 4)
        self.assertEqual(t["disabled_rules"], 1)
        self.assertEqual(t["passing"], 1)
        self.assertEqual(t["failing"], 3)
        self.assertEqual(t["violations"], 5)  # 2 serial + 2 asset + 1 prefix
        self.assertEqual(t["open"], 5)
        self.assertEqual(t["objects_in_violation"], 3)
        self.assertEqual(body["by_severity"]["critical"]["open"], 2)
        self.assertEqual(body["by_severity"]["critical"]["rules"], 2)
        self.assertEqual(body["by_severity"]["critical"]["failing_rules"], 1)
        self.assertEqual(body["by_severity"]["info"]["violations"], 1)
        # Worst first: critical failing, then warning, then info, passing last.
        self.assertEqual(
            [row["name"] for row in body["rules"]],
            ["Serial", "Asset tag", "Prefix description", "Name set"],
        )
        self.assertEqual(body["rules"][0]["check_type"], "required")
        top = body["top_offenders"]
        self.assertEqual({o["object_repr"] for o in top[:2]}, {"sw1", "sw2"})
        self.assertEqual(top[0]["violations"], 2)
        self.assertEqual(top[0]["worst_severity"], "critical")
        self.assertEqual(top[2]["object_repr"], "10.0.1.0/24")
        self.assertIn("evaluated_at", body)

    def test_needs_compliance_view(self):
        self.login_as("nobody", ["device"], ["view"])
        self.assertEqual(self.client.get(SUMMARY).status_code, 403)

    def test_other_tenant_rules_never_counted(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        _make_device(other, "foreign")
        ComplianceRule.objects.create(
            tenant=other, name="Foreign", object_type="device",
            check_type="required", field="serial_number",
        )
        body = self.client.get(SUMMARY).json()
        self.assertNotIn("Foreign", {row["name"] for row in body["rules"]})
        self.assertNotIn("foreign", str(body))
        self.assertEqual(body["totals"]["violations"], 5)

    def test_offenders_follow_site_scope_counts_stay_whole(self):
        self.login_as("ams", ["compliancerule", "device", "prefix"], ["view"],
                      sites=[self.ams])
        body = self.client.get(SUMMARY).json()
        names = {o["object_repr"] for o in body["top_offenders"]}
        self.assertIn("sw1", names)
        self.assertNotIn("sw2", names)
        self.assertEqual(body["totals"]["violations"], 5)

    def _queries(self, n_rules: int) -> int:
        ComplianceRule.objects.filter(tenant=self.tenant).delete()
        for i in range(n_rules):
            ComplianceRule.objects.create(
                tenant=self.tenant, name=f"r{i}",
                object_type="device" if i % 2 else "prefix",
                check_type=("required", "required_tag", "regex")[i % 3],
                field="description", tag="t", pattern=r"^\w+$",
                severity=("critical", "warning", "info")[i % 3],
            )
        self.client.get(SUMMARY)  # warm per-process caches
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(SUMMARY)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["totals"]["rules"], n_rules)
        return len(ctx.captured_queries)

    def test_query_count_does_not_grow_with_rules(self):
        three = self._queries(3)
        self._queries(30)
        # Same object types, ten times the rules: the same queries.
        with self.assertNumQueries(three):
            r = self.client.get(SUMMARY)
        self.assertEqual(r.json()["totals"]["rules"], 30)


class FacetAndFilterTests(_Base):
    def test_violation_rows_carry_site_tags_and_state(self):
        body = self.client.get(EVALUATE).json()
        row = next(v for v in body["violations"] if v["object_repr"] == "sw1")
        self.assertEqual(row["site_id"], str(self.ams.id))
        self.assertEqual(row["site_name"], "AMS")
        self.assertEqual(row["state"], "open")
        self.assertEqual(row["tags"], [])
        self.assertEqual(body["objects_in_violation"], 3)

    def test_facets_count_the_visible_list(self):
        f = self.client.get(EVALUATE).json()["facets"]
        self.assertEqual(
            {x["value"]: x["count"] for x in f["severity"]},
            {"critical": 2, "warning": 2, "info": 1},
        )
        self.assertEqual({x["label"]: x["count"] for x in f["site"]},
                         {"AMS": 2, "LON": 2, "No site": 1})
        self.assertEqual({x["value"]: x["count"] for x in f["state"]}, {"open": 5})
        self.assertEqual(f["rule"][0]["count"], 2)

    def test_site_rule_and_state_filters(self):
        body = self.client.get(EVALUATE + f"?site={self.lon.id}").json()
        self.assertEqual({v["object_repr"] for v in body["violations"]}, {"sw2"})
        body = self.client.get(EVALUATE + "?site=none").json()
        self.assertEqual({v["object_repr"] for v in body["violations"]}, {"10.0.1.0/24"})
        body = self.client.get(EVALUATE + f"?rule={self.serial.id},{self.desc.id}").json()
        self.assertEqual(len(body["violations"]), 3)
        ComplianceTriage.objects.create(
            tenant=self.tenant, rule=self.serial, object_type="device",
            object_id=self.sw1.id, acknowledged_at=timezone.now(),
        )
        body = self.client.get(EVALUATE + "?state=acknowledged").json()
        self.assertEqual(
            [(v["rule_name"], v["object_repr"]) for v in body["violations"]],
            [("Serial", "sw1")],
        )
        self.assertEqual(len(self.client.get(EVALUATE + "?state=open").json()["violations"]), 4)

    def test_tag_filter(self):
        from core.models import Tag

        tag = Tag.objects.create(tenant=self.tenant, name="PCI", slug="pci", color="#ff0000")
        self.sw2.tags.add(tag)
        body = self.client.get(EVALUATE + "?tag=pci").json()
        self.assertEqual({v["object_repr"] for v in body["violations"]}, {"sw2"})
        facet = body["facets"]["tag"]
        self.assertEqual(len(facet), 1)
        self.assertEqual(
            {k: facet[0][k] for k in ("value", "label", "count", "color", "id")},
            {"value": "pci", "label": "PCI", "count": 2, "color": "#ff0000", "id": tag.pk},
        )


class TriageTests(_Base):
    def post(self, action, items, **extra):
        return self.client.post(TRIAGE, {"action": action, "items": items, **extra},
                                format="json")

    def item(self, rule, obj):
        return {"rule_id": str(rule.id), "object_id": str(obj.id)}

    def test_acknowledge_marks_state_and_counts(self):
        r = self.post("acknowledge", [self.item(self.serial, self.sw1)], note="known")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"updated": 1})
        t = ComplianceTriage.objects.get()
        self.assertEqual(t.acknowledged_by, self.user)
        self.assertEqual(t.note, "known")
        body = self.client.get(SUMMARY).json()
        serial = next(row for row in body["rules"] if row["name"] == "Serial")
        self.assertEqual((serial["open"], serial["acknowledged"]), (1, 1))
        self.assertEqual(body["totals"]["acknowledged"], 1)
        row = next(v for v in self.client.get(EVALUATE).json()["violations"]
                   if v["rule_name"] == "Serial" and v["object_repr"] == "sw1")
        self.assertEqual(row["state"], "acknowledged")
        self.assertEqual(row["acknowledged_by"], "ops")

    def test_snooze_until_and_expiry(self):
        until = timezone.now() + timedelta(days=7)
        r = self.post("snooze", [self.item(self.desc, self.p2)], until=until.isoformat())
        self.assertEqual(r.status_code, 200, r.content)
        row = self.client.get(EVALUATE + "?state=snoozed").json()["violations"]
        self.assertEqual([v["object_repr"] for v in row], ["10.0.1.0/24"])
        # Past its time, a snooze reads as open again.
        ComplianceTriage.objects.update(snoozed_until=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.client.get(EVALUATE + "?state=snoozed").json()["violations"], [])

    def test_snooze_needs_a_future_bounded_time(self):
        item = [self.item(self.desc, self.p2)]
        self.assertEqual(self.post("snooze", item).status_code, 400)
        past = (timezone.now() - timedelta(hours=1)).isoformat()
        self.assertEqual(self.post("snooze", item, until=past).status_code, 400)
        far = (timezone.now() + timedelta(days=400)).isoformat()
        self.assertEqual(self.post("snooze", item, until=far).status_code, 400)

    def test_clear_returns_to_open(self):
        self.post("acknowledge", [self.item(self.serial, self.sw1)])
        r = self.post("clear", [self.item(self.serial, self.sw1)])
        self.assertEqual(r.json(), {"updated": 1})
        self.assertFalse(ComplianceTriage.objects.exists())

    def test_change_log_and_journal(self):
        self.post("acknowledge", [self.item(self.serial, self.sw1),
                                  self.item(self.serial, self.sw2)])
        self.assertEqual(
            ChangeLogEntry.objects.filter(object_type="compliance.compliancetriage").count(), 2
        )
        rule_note = JournalEntry.objects.get(
            object_type="compliance.compliancerule", object_id=str(self.serial.id)
        )
        self.assertIn("Acknowledged 2 violations", rule_note.comments)
        dev_note = JournalEntry.objects.get(object_type="api.device", object_id=str(self.sw1.id))
        self.assertEqual(dev_note.object_site_id, self.ams.id)

    def test_needs_change_on_compliance_triage(self):
        self.login_as("viewer", ["compliancerule", "compliancetriage", "device"], ["view"])
        r = self.post("acknowledge", [self.item(self.serial, self.sw1)])
        self.assertEqual(r.status_code, 403)
        self.assertFalse(ComplianceTriage.objects.exists())

    def test_other_tenants_rule_or_object_refused(self):
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        foreign_dev = _make_device(other, "foreign")
        foreign_rule = ComplianceRule.objects.create(
            tenant=other, name="F", object_type="device",
            check_type="required", field="serial_number",
        )
        self.assertEqual(
            self.post("acknowledge", [self.item(foreign_rule, self.sw1)]).status_code, 400
        )
        self.assertEqual(
            self.post("acknowledge", [self.item(self.serial, foreign_dev)]).status_code, 400
        )
        self.assertFalse(ComplianceTriage.objects.exists())

    def test_object_outside_the_callers_sites_refused(self):
        self.login_as("ams-ops", ["compliancerule", "compliancetriage", "device"],
                      ["view", "change"], sites=[self.ams])
        r = self.post("acknowledge", [self.item(self.serial, self.sw1),
                                      self.item(self.serial, self.sw2)])
        self.assertEqual(r.status_code, 400)
        self.assertFalse(ComplianceTriage.objects.exists())
        r = self.post("acknowledge", [self.item(self.serial, self.sw1)])
        self.assertEqual(r.status_code, 200, r.content)

    def test_rule_delete_drops_its_triage(self):
        self.post("acknowledge", [self.item(self.serial, self.sw1)])
        self.serial.delete()
        self.assertFalse(ComplianceTriage.objects.exists())
