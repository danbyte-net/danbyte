from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    Interface,
    RearPort,
)
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


class PortRuleCountingTests(APITestCase):
    """The sweep reads the device card's counts (0.17): physical interfaces
    and front ports, virtual interfaces only when the deployment counts
    them, rear ports never."""

    def setUp(self):
        cache.clear()
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        # sw: 1 of 1 physical port cabled, plus two SVIs (100% counted, 33%
        # with the SVIs counted); vr: only a loopback; pp: only a rear port.
        self.sw = Device.objects.create(tenant=self.tenant, name="sw")
        i = Interface.objects.create(device=self.sw, name="Gi1")
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=i)
        Interface.objects.create(device=self.sw, name="Vlan10", virtual=True)
        Interface.objects.create(device=self.sw, name="Vlan20", type="virtual")
        self.vr = Device.objects.create(tenant=self.tenant, name="vr")
        Interface.objects.create(device=self.vr, name="lo0", virtual=True)
        self.pp = Device.objects.create(tenant=self.tenant, name="pp")
        RearPort.objects.create(device=self.pp, name="R1", positions=12)
        self.cam = Device.objects.create(tenant=self.tenant, name="cam")

    def _run(self, **rule_kwargs):
        PortUtilizationRule.objects.create(tenant=self.tenant, **rule_kwargs)
        with patch("monitoring.port_utilization.notify_event") as mock:
            result = evaluate_port_rules()
        return result, {c.args[1].split()[1]: c.args for c in mock.call_args_list}

    def test_no_ports_still_means_no_port_of_any_kind(self):
        r, events = self._run(name="Bare", condition="no_ports")
        # vr has only a virtual port and pp only a rear one: both have ports.
        self.assertEqual(list(events), ["cam"])
        self.assertEqual(r["fired"], 1)

    def test_threshold_rules_skip_devices_with_nothing_counted(self):
        r, events = self._run(name="Idle", condition="below", threshold_pct=50)
        self.assertEqual(r["fired"], 0, events)

    def test_setting_on_counts_virtual_interfaces(self):
        from core.models import DeploymentSettings

        ds = DeploymentSettings.load()
        ds.port_count_virtual = True
        ds.save()
        r, events = self._run(name="Idle", condition="below", threshold_pct=50)
        # sw: 1 of 3 (33%); vr: 0 of 1. pp's rear port still does not count.
        self.assertEqual(sorted(events), ["sw", "vr"])
        _, _, body, payload = events["sw"]
        self.assertIn("uses 1 of 3 ports (33%)", body)
        self.assertNotIn("Virtual interfaces not counted", body)
        self.assertIs(payload["count_virtual"], True)

    def test_message_and_payload_state_the_basis(self):
        Device.objects.create(tenant=self.tenant, name="plain")
        plain = Device.objects.get(name="plain")
        j = Interface.objects.create(device=plain, name="Gi1")
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=j)
        r, events = self._run(name="Full", condition="above", threshold_pct=90)
        self.assertEqual(sorted(events), ["plain", "sw"])
        _, _, body, payload = events["sw"]
        self.assertIn("uses 1 of 1 ports (100%)", body)
        self.assertIn("Virtual interfaces not counted.", body)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["virtual"], 2)
        self.assertIs(payload["count_virtual"], False)
        self.assertNotIn("Virtual interfaces", events["plain"][2])

    def test_no_ports_and_zero_percent_do_not_refire(self):
        """The hysteresis flag stores the pct, and 0 is one: it must still
        read as "already alerted"."""
        PortUtilizationRule.objects.create(
            tenant=self.tenant, name="Bare", condition="no_ports"
        )
        Interface.objects.create(device=self.pp, name="Gi1")  # 0% used
        PortUtilizationRule.objects.create(
            tenant=self.tenant, name="Idle", condition="below", threshold_pct=10
        )
        with patch("monitoring.port_utilization.notify_event") as mock:
            evaluate_port_rules()
            evaluate_port_rules()
        names = sorted(c.args[1].split()[1] for c in mock.call_args_list)
        self.assertEqual(names, ["cam", "pp"])


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
