"""The ``vulnerabilities`` compliance check (#451)."""
from __future__ import annotations

from decimal import Decimal

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from api.models import Cluster, ClusterType, Device, Platform, Site, VirtualMachine
from core.models import Organization, Tenant
from vulnerabilities import matching
from vulnerabilities.models import ProductMapping, VulnerabilityException, VulnerabilitySettings
from vulnerabilities.tests_matching import make_cve, xe_range

from .api import ComplianceRuleSerializer
from .engine import detail_for, evaluate, evaluate_for_object
from .models import ComplianceRule


class VulnerabilityRuleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        org = Organization.objects.create(name="O", slug="o")
        cls.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        cls.other = Tenant.objects.create(org=org, name="U", slug="u")
        cls.site = Site.objects.create(tenant=cls.tenant, name="HQ")
        cls.xe = Platform.objects.create(tenant=cls.tenant, name="IOS-XE", slug="ios-xe")
        ProductMapping.objects.create(tenant=cls.tenant, platform=cls.xe, kind="cpe",
                                      part="o", vendor="cisco", product="ios_xe")
        cls.kev = make_cve("CVE-2024-0001", xe_range("17.9.5"), score=7.5, kev=True)
        cls.crit = make_cve("CVE-2024-0002", xe_range("17.6.1"), score=9.8, epss=0.9)
        cls.mid = make_cve("CVE-2024-0003", xe_range("17.12.1"), score=5.0)
        mk = lambda name, v: Device.objects.create(  # noqa: E731
            tenant=cls.tenant, name=name, platform=cls.xe, software_version=v, site=cls.site)
        cls.old = mk("old", "17.3.1")      # kev, crit, mid
        cls.mid_dev = mk("mid", "17.9.4")  # kev, mid
        cls.new = mk("new", "17.12.1")     # nothing
        ct = ClusterType.objects.create(tenant=cls.tenant, name="ESXi", slug="esxi")
        cl = Cluster.objects.create(tenant=cls.tenant, name="cl", type=ct)
        cls.vm = VirtualMachine.objects.create(tenant=cls.tenant, name="vm", cluster=cl,
                                               platform=cls.xe, software_version="17.11.1")
        matching.recompute(cls.tenant)

    def rule(self, fail_on, object_types=("device",), cvss_min=None):
        return ComplianceRule.objects.create(
            tenant=self.tenant, name=f"vulns {fail_on}", object_types=list(object_types),
            check_type="vulnerabilities", vuln_fail_on=fail_on, cvss_min=cvss_min)

    def failing(self, rule, tenant=None):
        res = evaluate(tenant or self.tenant, rules=[rule])
        return sorted(v["object_repr"] for v in res["violations"])

    def test_fail_on(self):
        self.assertEqual(self.failing(self.rule("kev")), ["mid", "old"])
        self.assertEqual(self.failing(self.rule("fix_first")), ["mid", "old"])
        self.assertEqual(self.failing(self.rule("cvss", cvss_min=Decimal("9.0"))), ["old"])
        self.assertEqual(self.failing(self.rule("cvss", cvss_min=Decimal("4.0"))),
                         ["mid", "old"])

    def test_exceptions_are_skipped(self):
        rule = self.rule("kev")
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=self.kev, status="not_applicable", reason="r",
            device=self.old)
        self.assertEqual(self.failing(rule), ["mid"])
        VulnerabilityException.objects.create(
            tenant=self.tenant, cve=self.kev, status="not_applicable", reason="r")
        self.assertEqual(self.failing(rule), [])

    def test_detail_and_link(self):
        res = evaluate(self.tenant, rules=[self.rule("cvss", cvss_min=Decimal("1.0"))])
        rows = {v["object_repr"]: v for v in res["violations"]}
        # Worst priority first, then the higher score.
        self.assertEqual(rows["old"]["detail"],
                         "CVE-2024-0002, CVE-2024-0001 (KEV), CVE-2024-0003")
        self.assertEqual(rows["old"]["link"], f"/devices/{self.old.pk}?tab=vulnerabilities")

    def test_virtual_machines_and_single_object(self):
        rule = self.rule("cvss", object_types=("device", "virtualmachine"),
                         cvss_min=Decimal("4.0"))
        self.assertIn("vm", self.failing(rule))
        self.assertEqual(evaluate_for_object(self.tenant, "device", self.old), [rule])
        self.assertEqual(evaluate_for_object(self.tenant, "device", self.new), [])
        self.assertEqual(detail_for(rule, self.mid_dev), "CVE-2024-0001 (KEV), CVE-2024-0003")

    def test_off_passes_and_other_tenant_isolated(self):
        rule = self.rule("kev")
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=False)
        self.assertEqual(self.failing(rule), [])
        VulnerabilitySettings.objects.filter(pk=1).update(enabled=True)
        theirs = ComplianceRule.objects.create(
            tenant=self.other, name="k", object_types=["device"], check_type="vulnerabilities",
            vuln_fail_on="kev")
        Device.objects.create(tenant=self.other, name="x")
        self.assertEqual(self.failing(theirs, self.other), [])

    def test_query_count_does_not_grow_with_devices(self):
        rule = self.rule("kev")
        with CaptureQueriesContext(connection) as before:
            evaluate(self.tenant, rules=[rule])
        for i in range(5):
            Device.objects.create(tenant=self.tenant, name=f"e{i}", platform=self.xe,
                                  software_version="17.9.4", site=self.site)
        matching.recompute(self.tenant)
        with CaptureQueriesContext(connection) as after:
            res = evaluate(self.tenant, rules=[rule])
        self.assertEqual(len(res["violations"]), 7)
        self.assertEqual(len(after), len(before))

    def test_serializer(self):
        ok = ComplianceRuleSerializer(data={
            "name": "x", "object_types": ["device", "virtualmachine"],
            "check_type": "vulnerabilities", "vuln_fail_on": "cvss", "cvss_min": "9.0"})
        self.assertTrue(ok.is_valid(), ok.errors)
        for data, field in (
                ({"object_types": ["prefix"], "vuln_fail_on": "kev"}, "object_types"),
                ({"object_types": ["device"]}, "vuln_fail_on"),
                ({"object_types": ["device"], "vuln_fail_on": "cvss"}, "cvss_min"),
                ({"object_types": ["device"], "vuln_fail_on": "cvss", "cvss_min": "0"},
                 "cvss_min")):
            with self.subTest(field=field):
                bad = ComplianceRuleSerializer(data={"name": "x",
                                                     "check_type": "vulnerabilities", **data})
                self.assertFalse(bad.is_valid())
                self.assertIn(field, bad.errors)
        kev = ComplianceRuleSerializer(data={
            "name": "x", "object_types": ["device"], "check_type": "vulnerabilities",
            "vuln_fail_on": "kev", "cvss_min": "9.0"})
        self.assertTrue(kev.is_valid(), kev.errors)
        self.assertIsNone(kev.validated_data["cvss_min"])
