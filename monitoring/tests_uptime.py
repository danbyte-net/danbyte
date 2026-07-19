"""A6 — time-weighted uptime / SLA computation."""
from __future__ import annotations

from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .models import CheckKind, CheckState, CheckTemplate, StateTransition
from .uptime import check_uptime


from api.test_utils import status_for


class UptimeTests(TestCase):
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
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t,
            kind="icmp", status="up",
        )

    def _tr(self, at, to, frm="up"):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status=frm, to_status=to, at=at,
        )

    def test_ninety_percent_uptime(self):
        now = timezone.now()
        since = now - timedelta(days=10)
        # up before the window, then goes down for the final day.
        self._tr(since - timedelta(hours=1), "up")
        self._tr(now - timedelta(days=1), "down", frm="up")
        r = check_uptime(self.state, since, now)
        self.assertAlmostEqual(r["uptime_pct"], 90.0, delta=0.2)
        self.assertEqual(r["incidents"], 1)
        # MTTR ≈ 1 day of downtime / 1 incident.
        self.assertAlmostEqual(r["mttr_seconds"], 86400, delta=120)

    def test_unknown_is_excluded_not_counted_down(self):
        now = timezone.now()
        since = now - timedelta(days=10)
        # No prior history → starts 'unknown' for the whole window.
        r = check_uptime(self.state, since, now)
        self.assertIsNone(r["uptime_pct"])  # nothing measured
        self.assertEqual(r["down_seconds"], 0)
        self.assertGreater(r["excluded_seconds"], 0)

    def test_full_uptime_when_always_up(self):
        now = timezone.now()
        since = now - timedelta(days=5)
        self._tr(since - timedelta(hours=1), "up")
        r = check_uptime(self.state, since, now)
        self.assertEqual(r["uptime_pct"], 100.0)
        self.assertEqual(r["incidents"], 0)
        self.assertIsNone(r["mttr_seconds"])

    def test_endpoint_returns_aggregate(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        self._tr(timezone.now() - timedelta(days=2), "up")
        user = get_user_model().objects.create_superuser("a", "a@b.c", "pw")
        c = APIClient()
        c.force_login(user)
        sess = c.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()
        r = c.get(f"/api/monitoring/ips/{self.ip.id}/uptime/?days=7")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["days"], 7)
        self.assertEqual(len(body["checks"]), 1)
        self.assertEqual(body["overall_uptime_pct"], 100.0)
