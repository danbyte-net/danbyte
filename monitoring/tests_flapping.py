"""M22 — proactive flapping-IP monitor + exclusions."""
from __future__ import annotations

from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Status, Prefix
from core.models import Organization, Tenant

from .flapping import flapping_ips
from .models import CheckKind, CheckTemplate, MonitoringSettings, StateTransition


from api.test_utils import status_for


class FlappingTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP
        )
        self.ms = MonitoringSettings.for_tenant(self.tenant)
        self.ms.flap_threshold = 3
        self.ms.flap_window_minutes = 60
        self.ms.save()

    def _flaps(self, ip, n, to="down"):
        now = timezone.now()
        for _ in range(n):
            StateTransition.objects.create(
                tenant=self.tenant, target_ip=ip, template=self.t, kind="icmp",
                from_status="up", to_status=to, at=now,
            )

    def test_flagged_when_over_threshold(self):
        self._flaps(self.ip, 4)
        rows = flapping_ips(self.tenant)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ip_address"], "10.0.0.5")
        self.assertEqual(rows[0]["flap_count"], 4)
        self.assertEqual(rows[0]["template_name"], "ping")

    def test_under_threshold_not_flagged(self):
        self._flaps(self.ip, 2)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_threshold_zero_disables(self):
        self.ms.flap_threshold = 0
        self.ms.save()
        self._flaps(self.ip, 9)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_per_ip_exclusion(self):
        self.ip.flap_exclude = True
        self.ip.save()
        self._flaps(self.ip, 5)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_status_exclusion(self):
        dhcp = Status.objects.create(
            tenant=self.tenant, name="DHCP", slug="dhcp", color="#3b82f6"
        )
        self.ip.status = dhcp
        self.ip.save()
        self.ms.flap_exclude_ip_statuses.add(dhcp)
        self._flaps(self.ip, 5)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_window_scopes_old_transitions_out(self):
        from datetime import timedelta

        old = timezone.now() - timedelta(hours=3)
        for _ in range(5):
            StateTransition.objects.create(
                tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
                from_status="up", to_status="down", at=old,
            )
        self.assertEqual(flapping_ips(self.tenant), [])
