from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from api.models import Cable, CableTermination, Device, DeviceRole, Interface
from core.models import Organization, Tenant

from .models import PortUtilizationRule
from .port_utilization import evaluate_port_rules

User = get_user_model()


class PortRuleEvalTests(APITestCase):
    """evaluate_port_rules: conditions, scoping and hysteresis."""

    def setUp(self):
        cache.clear()
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Panel", slug="panel"
        )
        # pp-full: 1/1 cabled (100%); pp-empty: 0/1 (0%); cam: no ports.
        self.full = Device.objects.create(
            tenant=self.tenant, name="pp-full", role=self.role
        )
        i = Interface.objects.create(device=self.full, name="P1")
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=i)
        self.empty = Device.objects.create(
            tenant=self.tenant, name="pp-empty", role=self.role
        )
        Interface.objects.create(device=self.empty, name="P1")
        self.cam = Device.objects.create(tenant=self.tenant, name="cam-01")

    def _events(self, **rule_kwargs):
        PortUtilizationRule.objects.create(tenant=self.tenant, **rule_kwargs)
        with patch("monitoring.port_utilization.notify_event") as mock:
            result = evaluate_port_rules()
        return result, [c.args for c in mock.call_args_list]

    def test_above_fires_only_over_threshold(self):
        r, events = self._events(name="Full", condition="above", threshold_pct=90)
        self.assertEqual(r["fired"], 1)
        self.assertIn("pp-full", events[0][1])

    def test_below_fires_only_under_threshold(self):
        r, events = self._events(name="Idle", condition="below", threshold_pct=10)
        self.assertEqual(r["fired"], 1)
        self.assertIn("pp-empty", events[0][1])

    def test_no_ports_fires_for_portless_devices(self):
        r, events = self._events(name="Bare", condition="no_ports")
        self.assertEqual(r["fired"], 1)
        self.assertIn("cam-01", events[0][1])

    def test_role_scope_excludes_other_devices(self):
        # cam-01 has no role, so a role-scoped no_ports rule stays quiet.
        r, _ = self._events(name="Bare", condition="no_ports", role=self.role)
        self.assertEqual(r["fired"], 0)

    def test_device_scope_hits_only_that_device(self):
        r, events = self._events(
            name="One", condition="above", threshold_pct=50, device=self.full
        )
        self.assertEqual(r["fired"], 1)
        self.assertIn("pp-full", events[0][1])

    def test_hysteresis_no_refire_until_cleared(self):
        rule = PortUtilizationRule.objects.create(
            tenant=self.tenant, name="Full", condition="above", threshold_pct=90
        )
        with patch("monitoring.port_utilization.notify_event") as mock:
            evaluate_port_rules()
            evaluate_port_rules()
        self.assertEqual(mock.call_count, 1)
        # Condition stops holding → re-armed, next crossing fires again.
        CableTermination.objects.all().delete()
        with patch("monitoring.port_utilization.notify_event") as mock:
            r = evaluate_port_rules()
        self.assertEqual(r["rearmed"], 1)
        i = Interface.objects.get(device=self.full)
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=i)
        with patch("monitoring.port_utilization.notify_event") as mock:
            evaluate_port_rules()
        self.assertEqual(mock.call_count, 1)
        self.assertTrue(rule.enabled)

    def test_disabled_rule_is_ignored(self):
        r, _ = self._events(
            name="Off", condition="above", threshold_pct=1, enabled=False
        )
        self.assertEqual(r["fired"], 0)


class PortRuleApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_crud_and_threshold_validation(self):
        r = self.client.post(
            "/api/monitoring/port-utilization-rules/",
            {"name": "Panels near full", "condition": "above",
             "threshold_pct": 90},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        rule_id = r.json()["id"]
        r = self.client.patch(
            f"/api/monitoring/port-utilization-rules/{rule_id}/",
            {"threshold_pct": 80},
            format="json",
        )
        self.assertEqual(r.json()["threshold_pct"], 80)
        # above/below without a threshold is rejected with a field error.
        r = self.client.post(
            "/api/monitoring/port-utilization-rules/",
            {"name": "Broken", "condition": "below"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("threshold_pct", r.json())
