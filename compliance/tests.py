"""Compliance rule evaluation."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Prefix
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .api import ComplianceRuleSerializer
from .engine import evaluate
from .models import ComplianceRule


class ComplianceTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", description="ok")
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.1.0/24", description="")

    def test_required_field_violations(self):
        r = ComplianceRule.objects.create(
            tenant=self.tenant, name="needs desc", object_type="prefix",
            check_type="required", field="description",
        )
        res = evaluate(self.tenant, rules=[r])
        self.assertEqual(res["total_violations"], 1)
        self.assertEqual(res["violations"][0]["object_repr"], "10.0.1.0/24")

    def test_regex_only_flags_nonmatching_present_values(self):
        r = ComplianceRule.objects.create(
            tenant=self.tenant, name="desc word", object_type="prefix",
            check_type="regex", field="description", pattern=r"^\w+$",
        )
        res = evaluate(self.tenant, rules=[r])
        # "ok" matches; "" is empty (skipped by regex). → 0 violations.
        self.assertEqual(res["total_violations"], 0)

    def test_disabled_rules_excluded(self):
        ComplianceRule.objects.create(
            tenant=self.tenant, name="off", object_type="prefix",
            check_type="required", field="description", enabled=False,
        )
        res = evaluate(self.tenant)  # only enabled
        self.assertEqual(res["rules"], [])

    def test_regex_value_is_length_capped(self):
        # ReDoS mitigation: the matched value is truncated to _REGEX_VALUE_CAP
        # before re.search, bounding worst-case backtracking input size. A field
        # value whose only match sits past the cap must read as non-matching.
        from .engine import _REGEX_VALUE_CAP

        long_desc = "a" * (_REGEX_VALUE_CAP + 50) + "X"
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.2.0/24", description=long_desc
        )
        r = ComplianceRule.objects.create(
            tenant=self.tenant, name="ends X", object_type="prefix",
            check_type="regex", field="description", pattern=r"X$",
        )
        res = evaluate(self.tenant, rules=[r])
        # The trailing "X" is truncated away → no match → counts as a violation
        # for the long row (the two setUp rows are empty/short and skip regex).
        reprs = {v["object_repr"] for v in res["violations"]}
        self.assertIn("10.0.2.0/24", reprs)

    def test_uncompilable_regex_rejected_at_save(self):
        # An invalid pattern must 400 at write time — otherwise the engine
        # silently swallows re.error and reports "no violation" for every row.
        ser = ComplianceRuleSerializer(data={
            "name": "bad", "object_type": "prefix",
            "check_type": "regex", "field": "description", "pattern": "([a-z",
        })
        self.assertFalse(ser.is_valid())
        self.assertIn("pattern", ser.errors)

    def test_valid_regex_accepted_at_save(self):
        ser = ComplianceRuleSerializer(data={
            "name": "good", "object_type": "prefix",
            "check_type": "regex", "field": "description", "pattern": r"^\w+$",
        })
        self.assertTrue(ser.is_valid(), ser.errors)


def _make_device(tenant, name: str):
    from api.models import Device, DeviceType, Manufacturer, Site

    site, _ = Site.objects.get_or_create(tenant=tenant, name="AMS")
    mfr, _ = Manufacturer.objects.get_or_create(tenant=tenant, name="C", slug="c")
    dt, _ = DeviceType.objects.get_or_create(
        tenant=tenant, manufacturer=mfr, model="X"
    )
    return Device.objects.create(
        tenant=tenant, name=name, device_type=dt, site=site
    )


class ComplianceApiTests(APITestCase):
    """Remediation round-trip, per-device status, and evaluate URL filters."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u", password="x")
        prof = UserProfile.objects.create(user=self.user)
        prof.tenants.add(self.tenant)
        # compliancerule full access + device view (the per-device endpoint is
        # row-scoped over devices, and the affected-object serialization is too).
        perm = ObjectPermission.objects.create(
            name="compliance",
            object_types=["compliancerule", "device"],
            actions=["view", "add", "change", "delete"],
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

        self.device = _make_device(self.tenant, "sw1")
        self.rule = ComplianceRule.objects.create(
            tenant=self.tenant, name="devices need serial", object_type="device",
            check_type="required", field="serial_number", severity="critical",
        )

    # ── remediation ─────────────────────────────────────────────────────────
    def test_remediation_round_trips(self):
        md = "## Fix\n\n1. Find the serial\n2. `PATCH` the device"
        r = self.client.patch(
            f"/api/compliance-rules/{self.rule.id}/",
            {"remediation": md},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["remediation"], md)
        r = self.client.get(f"/api/compliance-rules/{self.rule.id}/")
        self.assertEqual(r.json()["remediation"], md)

    def test_remediation_write_requires_change_perm(self):
        viewer = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="cr view", object_types=["compliancerule"], actions=["view"]
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.client.force_login(viewer)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.patch(
            f"/api/compliance-rules/{self.rule.id}/",
            {"remediation": "nope"},
            format="json",
        )
        self.assertEqual(r.status_code, 403)

    # ── per-device status ────────────────────────────────────────────────────
    def test_device_status_lists_violations_with_remediation(self):
        self.rule.remediation = "Set the **serial**."
        self.rule.save()
        r = self.client.get(f"/api/compliance/devices/{self.device.id}/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertFalse(body["all_clear"])
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["device"]["name"], "sw1")
        v = body["violations"][0]
        self.assertEqual(v["rule_id"], str(self.rule.id))
        self.assertEqual(v["severity"], "critical")
        self.assertEqual(v["remediation"], "Set the **serial**.")

    def test_device_status_all_clear(self):
        self.device.serial_number = "ABC123"
        self.device.save()
        r = self.client.get(f"/api/compliance/devices/{self.device.id}/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["all_clear"])
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["violations"], [])

    def test_device_status_ignores_disabled_and_other_type_rules(self):
        self.rule.enabled = False
        self.rule.save()
        ComplianceRule.objects.create(
            tenant=self.tenant, name="prefix desc", object_type="prefix",
            check_type="required", field="description",
        )
        r = self.client.get(f"/api/compliance/devices/{self.device.id}/")
        self.assertTrue(r.json()["all_clear"])

    def test_device_status_cross_tenant_404(self):
        org2 = Organization.objects.create(name="O2", slug="o2")
        t2 = Tenant.objects.create(org=org2, name="T2", slug="t2")
        other = _make_device(t2, "other-sw")
        r = self.client.get(f"/api/compliance/devices/{other.id}/")
        self.assertEqual(r.status_code, 404)

    def test_device_status_requires_compliance_view(self):
        stranger = User.objects.create_user("s", password="x")
        UserProfile.objects.create(user=stranger).tenants.add(self.tenant)
        self.client.force_login(stranger)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.get(f"/api/compliance/devices/{self.device.id}/")
        self.assertEqual(r.status_code, 403)

    def test_device_status_anonymous_denied(self):
        self.client.logout()
        r = self.client.get(f"/api/compliance/devices/{self.device.id}/")
        self.assertIn(r.status_code, (401, 403))

    # ── evaluate URL filters ────────────────────────────────────────────────
    def test_evaluate_filters_narrow_violations(self):
        # A second (warning) rule so severity/rule filters have something to cut.
        rule2 = ComplianceRule.objects.create(
            tenant=self.tenant, name="devices need asset tag", object_type="device",
            check_type="required", field="asset_tag", severity="warning",
        )
        dev2 = _make_device(self.tenant, "sw2")

        base = "/api/compliance/evaluate/"
        full = self.client.get(base).json()
        self.assertEqual(full["total_violations"], 4)
        self.assertEqual(len(full["violations"]), 4)

        by_sev = self.client.get(base + "?severity=critical").json()
        self.assertEqual({v["severity"] for v in by_sev["violations"]}, {"critical"})
        self.assertEqual(len(by_sev["violations"]), 2)
        # Summary stays unfiltered — badges rely on the true total.
        self.assertEqual(by_sev["total_violations"], 4)

        by_rule = self.client.get(base + f"?rule={rule2.id}").json()
        self.assertEqual({v["rule_id"] for v in by_rule["violations"]}, {str(rule2.id)})

        by_obj = self.client.get(base + f"?object={dev2.id}").json()
        self.assertEqual({v["object_id"] for v in by_obj["violations"]}, {str(dev2.id)})
        self.assertEqual(len(by_obj["violations"]), 2)

        by_q = self.client.get(base + "?q=asset").json()
        self.assertEqual(
            {v["rule_name"] for v in by_q["violations"]}, {"devices need asset tag"}
        )

        combined = self.client.get(
            base + f"?severity=warning&object={dev2.id}"
        ).json()
        self.assertEqual(len(combined["violations"]), 1)
        self.assertEqual(combined["violations"][0]["rule_id"], str(rule2.id))
