"""Milestone 9 tests — stale + skipped states, settings, stats."""
from __future__ import annotations

import socket

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Status, Prefix
from core.models import Organization, Tenant

from .checkers import CheckOutcome
from .models import (
    CheckAssignment,
    CheckKind,
    CheckResult,
    CheckState,
    CheckTemplate,
    MonitoringSettings,
)
from .scheduler import dispatch, materialise_states
from .state import apply_outcome


from api.test_utils import status_for


def _open_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s, s.getsockname()[1]


class M9Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="127.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="127.0.0.1", prefix=self.prefix
        )
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class StaleStateTests(M9Base):
    def test_down_becomes_stale_after_scans(self):
        t = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP, fall=1
        )
        st = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=t, kind="icmp"
        )
        now = timezone.now()
        results = []
        for _ in range(3):
            apply_outcome(
                st, rise=1, fall=1, outcome=CheckOutcome("down"), now=now,
                stale_after_scans=3, stale_after_days=0,
            )
            results.append(st.status)
        self.assertEqual(results, ["down", "down", "stale"])


class SkippedStateTests(M9Base):
    def test_skip_status_marks_skipped_not_run(self):
        listener, port = _open_port()
        try:
            reserved = Status.objects.create(
                tenant=self.tenant, name="Reserved", slug="reserved"
            )
            self.ip.status = reserved
            self.ip.save()
            settings = MonitoringSettings.for_tenant(self.tenant)
            settings.skip_ip_statuses.add(reserved)

            t = CheckTemplate.objects.create(
                tenant=self.tenant, name="tcp", slug="tcp",
                kind=CheckKind.TCP, params={"port": port}, rise=1,
            )
            CheckAssignment.objects.create(
                tenant=self.tenant, template=t, ip_address=self.ip
            )
            materialise_states(tenant=self.tenant)
            dispatch(sync=True)

            st = CheckState.objects.get(target_ip=self.ip, template=t)
            self.assertEqual(st.status, "skipped")
            # Skipped means not dialed — no CheckResult written.
            self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 0)
        finally:
            listener.close()

    def test_non_skip_status_runs_normally(self):
        listener, port = _open_port()
        try:
            t = CheckTemplate.objects.create(
                tenant=self.tenant, name="tcp", slug="tcp",
                kind=CheckKind.TCP, params={"port": port}, rise=1,
            )
            CheckAssignment.objects.create(
                tenant=self.tenant, template=t, ip_address=self.ip
            )
            materialise_states(tenant=self.tenant)
            dispatch(sync=True)
            st = CheckState.objects.get(target_ip=self.ip, template=t)
            self.assertEqual(st.status, "up")
        finally:
            listener.close()


class SettingsApiTests(M9Base):
    def test_get_and_patch_settings(self):
        r = self.client.get("/api/monitoring/settings/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["stale_after_scans"], 10)  # default

        reserved = Status.objects.create(
            tenant=self.tenant, name="Reserved", slug="reserved"
        )
        r = self.client.patch(
            "/api/monitoring/settings/",
            {
                "stale_after_scans": 5,
                "global_enabled": False,
                "skip_ip_statuses": [str(reserved.id)],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["stale_after_scans"], 5)
        self.assertFalse(r.json()["global_enabled"])
        self.assertEqual(len(r.json()["skip_ip_status_detail"]), 1)

    def test_skip_status_must_be_in_tenant(self):
        other_org = Organization.objects.create(name="O", slug="o")
        other_t = Tenant.objects.create(org=other_org, name="O", slug="o")
        foreign = Status.objects.create(tenant=other_t, name="X", slug="x")
        r = self.client.patch(
            "/api/monitoring/settings/",
            {"skip_ip_statuses": [str(foreign.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 400)


class StatsApiTests(M9Base):
    def test_stats_breakdown(self):
        listener, port = _open_port()
        try:
            t = CheckTemplate.objects.create(
                tenant=self.tenant, name="tcp", slug="tcp",
                kind=CheckKind.TCP, params={"port": port}, rise=1,
            )
            CheckAssignment.objects.create(
                tenant=self.tenant, template=t, ip_address=self.ip
            )
            materialise_states(tenant=self.tenant)
            dispatch(sync=True)

            r = self.client.get("/api/monitoring/stats/")
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertEqual(body["by_status"].get("up"), 1)
            self.assertEqual(body["by_kind"].get("tcp"), 1)
            self.assertEqual(body["total_checks"], 1)
            self.assertEqual(body["monitored_ips"], 1)
        finally:
            listener.close()
