"""Compliance rule evaluation."""
from __future__ import annotations

from django.test import TestCase

from api.models import Prefix
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
