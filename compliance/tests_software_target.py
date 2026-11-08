"""The ``software_target`` compliance check (#395)."""
from __future__ import annotations

from django.test import TestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Platform,
    VirtualMachine,
)
from core.models import Organization, Tenant

from .api import ComplianceRuleSerializer
from .engine import evaluate, evaluate_for_object
from .models import ComplianceRule


class SoftwareTargetCheckTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ios = Platform.objects.create(
            tenant=self.tenant, name="IOS-XE", slug="ios-xe", target_version="17.9.5"
        )
        self.loose = Platform.objects.create(tenant=self.tenant, name="Linux", slug="linux")

    def rule(self, object_type="device", **kw):
        return ComplianceRule.objects.create(
            tenant=self.tenant, name="on target", object_type=object_type,
            check_type="software_target", **kw,
        )

    def device(self, name, version="", platform=None, **kw):
        return Device.objects.create(
            tenant=self.tenant, name=name, software_version=version,
            platform=platform, **kw,
        )

    def failing(self, rule):
        return sorted(v["object_repr"] for v in evaluate(self.tenant, rules=[rule])["violations"])

    def test_off_target_fails_with_a_reason(self):
        self.device("on", "17.9.5", self.ios)
        self.device("off", "17.9.4a", self.ios)
        res = evaluate(self.tenant, rules=[self.rule()])
        self.assertEqual([v["object_repr"] for v in res["violations"]], ["off"])
        self.assertEqual(res["violations"][0]["detail"], "Running 17.9.4a, target 17.9.5")

    def test_no_target_passes(self):
        self.device("a", "6.1", self.loose)
        self.device("b", "", None)
        self.assertEqual(self.failing(self.rule(fail_on_unknown=True)), [])

    def test_unknown_version_passes_by_default(self):
        self.device("blank", "", self.ios)
        self.assertEqual(self.failing(self.rule()), [])

    def test_unknown_version_fails_with_fail_on_unknown(self):
        self.device("blank", "", self.ios)
        self.device("on", "17.9.5", self.ios)
        rule = self.rule(fail_on_unknown=True)
        self.assertEqual(self.failing(rule), ["blank"])
        res = evaluate(self.tenant, rules=[rule])
        self.assertEqual(res["violations"][0]["detail"], "No version recorded, target 17.9.5")

    def test_device_type_platform_is_the_fallback(self):
        dt = DeviceType.objects.create(tenant=self.tenant, model="C9300", platform=self.ios)
        self.device("typed", "17.6.1", None, device_type=dt)
        # The device's own platform wins, even without a target.
        self.device("own", "17.6.1", self.loose, device_type=dt)
        self.assertEqual(self.failing(self.rule()), ["typed"])

    def test_virtual_machines(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="ESXi", slug="esxi")
        cl = Cluster.objects.create(tenant=self.tenant, name="cl", type=ct)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-off", cluster=cl, platform=self.ios,
            software_version="17.9.1",
        )
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-on", cluster=cl, platform=self.ios,
            software_version="17.9.5",
        )
        self.assertEqual(self.failing(self.rule("virtualmachine")), ["vm-off"])

    def test_single_object_evaluation(self):
        rule = self.rule()
        off = self.device("off", "1", self.ios)
        on = self.device("on", "17.9.5", self.ios)
        self.assertEqual(evaluate_for_object(self.tenant, "device", off), [rule])
        self.assertEqual(evaluate_for_object(self.tenant, "device", on), [])

    def test_serializer_rules(self):
        ok = ComplianceRuleSerializer(data={
            "name": "x", "object_type": "virtualmachine",
            "check_type": "software_target", "fail_on_unknown": True,
        })
        self.assertTrue(ok.is_valid(), ok.errors)
        bad = ComplianceRuleSerializer(data={
            "name": "x", "object_type": "prefix", "check_type": "software_target",
        })
        self.assertFalse(bad.is_valid())
        self.assertIn("object_type", bad.errors)
