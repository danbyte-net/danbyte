"""Flapping as a state: flagged by the sweep, sticky until confirmed (or
quiet long enough, when the tenant asks), mirrored onto alerts, cleared by
an operator with a change-log entry, read by every surface."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix, Site, Status
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .flapping import clear_flapping, flapping_ips, sweep_flapping
from .models import (
    Alert,
    CheckKind,
    CheckState,
    CheckTemplate,
    MonitoringSettings,
    StateTransition,
)


class _Base(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site_a)
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix, site=self.site_a,
            assigned_device=self.device,
        )
        self.ip_b = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.6", prefix=self.prefix, site=self.site_b,
        )
        self.t = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind=CheckKind.ICMP
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp", status="down"
        )
        self.state_b = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.t, kind="icmp", status="down"
        )
        self.ms = MonitoringSettings.for_tenant(self.tenant)
        self.ms.flap_threshold = 3
        self.ms.flap_window_minutes = 60
        self.ms.save()
        self.now = timezone.now()

    def _flaps(self, ip, n, to="down", ago=timedelta(minutes=1)):
        for _ in range(n):
            StateTransition.objects.create(
                tenant=self.tenant, target_ip=ip, template=self.t, kind="icmp",
                from_status="up", to_status=to, at=self.now - ago,
            )

    def sweep(self, now=None):
        return sweep_flapping(now or self.now)


class SweepTests(_Base):
    def test_flagged_at_threshold_and_read_back(self):
        self._flaps(self.ip, 4)
        out = self.sweep()
        self.assertEqual(out["flagged"], 1)
        self.state.refresh_from_db()
        self.assertIsNotNone(self.state.flapping_since)
        self.assertEqual(self.state.flap_count, 4)
        rows = flapping_ips(self.tenant)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ip_address"], "10.0.0.5")
        self.assertEqual(rows[0]["flap_count"], 4)
        self.assertEqual(rows[0]["template_name"], "ping")
        self.assertEqual(rows[0]["state_id"], str(self.state.id))

    def test_under_threshold_not_flagged(self):
        self._flaps(self.ip, 2)
        self.assertEqual(self.sweep()["flagged"], 0)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_threshold_zero_disables(self):
        self.ms.flap_threshold = 0
        self.ms.save()
        self._flaps(self.ip, 9)
        self.assertEqual(self.sweep()["flagged"], 0)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_per_ip_exclusion_never_flags_and_clears(self):
        self._flaps(self.ip, 5)
        self.sweep()
        self.ip.flap_exclude = True
        self.ip.save()
        out = self.sweep()
        self.assertEqual(out["cleared"], 1)
        self.state.refresh_from_db()
        self.assertIsNone(self.state.flapping_since)
        self.assertEqual(flapping_ips(self.tenant), [])

    def test_status_exclusion(self):
        dhcp = Status.objects.create(tenant=self.tenant, name="DHCP", slug="dhcp", color="#3b82f6")
        self.ip.status = dhcp
        self.ip.save()
        self.ms.flap_exclude_ip_statuses.add(dhcp)
        self._flaps(self.ip, 5)
        self.assertEqual(self.sweep()["flagged"], 0)

    def test_window_scopes_old_transitions_out(self):
        self._flaps(self.ip, 5, ago=timedelta(hours=3))
        self.assertEqual(self.sweep()["flagged"], 0)

    def test_sticky_by_default(self):
        """Quiet for hours is still flapping until somebody says otherwise."""
        self._flaps(self.ip, 3)
        self.sweep()
        later = self.now + timedelta(hours=5)
        out = self.sweep(later)
        self.assertEqual(out["cleared"], 0)
        self.assertEqual(out["flapping"], 1)
        self.state.refresh_from_db()
        self.assertIsNotNone(self.state.flapping_since)
        # The count reflects the window, the flag does not follow it down.
        self.assertEqual(self.state.flap_count, 0)

    def test_auto_clear_after_the_settle_time(self):
        self.ms.auto_clear_flapping = True
        self.ms.auto_clear_flapping_after_minutes = 30
        self.ms.save()
        self._flaps(self.ip, 3)
        self.sweep()
        # Under threshold but a bad transition 10 minutes ago: not settled.
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            from_status="up", to_status="down", at=self.now + timedelta(minutes=50),
        )
        self.assertEqual(self.sweep(self.now + timedelta(minutes=60))["cleared"], 0)
        # Quiet for 30 minutes and under threshold: clears itself.
        out = self.sweep(self.now + timedelta(minutes=85))
        self.assertEqual(out["cleared"], 1)
        self.state.refresh_from_db()
        self.assertIsNone(self.state.flapping_since)
        self.assertIsNone(self.state.flap_cleared_by)

    def test_alert_mirrors_the_state(self):
        alert = Alert.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
            dedup_key="x", severity="warning", status="firing", check_status="down",
            opened_at=self.now, last_status_at=self.now,
        )
        self._flaps(self.ip, 3)
        self.sweep()
        alert.refresh_from_db()
        self.assertTrue(alert.flapping)
        clear_flapping([CheckState.objects.get(pk=self.state.pk)], None, self.now)
        alert.refresh_from_db()
        self.assertFalse(alert.flapping)


class ClearTests(_Base):
    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user("ops", password="x")
        self._flaps(self.ip, 3)
        self.sweep()
        self.state.refresh_from_db()

    def test_clear_records_who_and_writes_the_change_log(self):
        n = clear_flapping([self.state], self.user, self.now)
        self.assertEqual(n, 1)
        self.state.refresh_from_db()
        self.assertIsNone(self.state.flapping_since)
        self.assertEqual(self.state.flap_cleared_by, self.user)
        self.assertEqual(self.state.flap_cleared_at, self.now)
        entry = ChangeLogEntry.objects.get(object_id=str(self.ip.id), action="update")
        self.assertEqual(entry.changes["flapping"]["new"], False)
        self.assertEqual(entry.changes["flapping"]["checks"], ["ping"])
        self.assertEqual(entry.user, self.user)

    def test_only_new_evidence_re_arms_it(self):
        clear_flapping([self.state], self.user, self.now)
        # The same three transitions are still inside the window.
        out = self.sweep(self.now + timedelta(minutes=1))
        self.assertEqual(out["flagged"], 0)
        # Three *new* ones do it again.
        for i in range(3):
            StateTransition.objects.create(
                tenant=self.tenant, target_ip=self.ip, template=self.t, kind="icmp",
                from_status="up", to_status="down", at=self.now + timedelta(minutes=2 + i),
            )
        out = self.sweep(self.now + timedelta(minutes=10))
        self.assertEqual(out["flagged"], 1)

    def test_clearing_a_calm_state_is_a_no_op(self):
        clear_flapping([self.state], self.user, self.now)
        self.state.refresh_from_db()
        self.assertEqual(clear_flapping([self.state], self.user), 0)
        self.assertEqual(
            ChangeLogEntry.objects.filter(object_id=str(self.ip.id), action="update").count(), 1
        )


class ApiTests(APITestCase, _Base):
    def setUp(self):
        _Base.setUp(self)
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self._flaps(self.ip, 3)
        self._flaps(self.ip_b, 3)
        self.sweep()

    def login(self, user=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_every_surface_says_flapping(self):
        self.login()
        b = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").json()
        self.assertEqual(b["flapping"], 1)
        b = self.client.get(f"/api/monitoring/devices/{self.device.id}/checks/").json()
        self.assertEqual(b["rollup"]["flapping"], 1)
        self.assertEqual(b["ips"][0]["flapping"], 1)
        b = self.client.get(f"/api/monitoring/status/?ips={self.ip.id}").json()
        self.assertEqual(b["statuses"][str(self.ip.id)]["flapping"], 1)
        b = self.client.get(f"/api/monitoring/status/?devices={self.device.id}").json()
        self.assertEqual(b["statuses"][str(self.device.id)]["flapping"], 1)
        b = self.client.get("/api/monitoring/checks/?flapping=1").json()
        self.assertEqual(b["count"], 2)
        self.assertEqual(b["flapping_count"], 2)
        self.assertEqual(b["facets"]["flapping"][0]["count"], 2)
        self.assertEqual(self.client.get("/api/monitoring/checks/?flapping=0").json()["count"], 0)
        b = self.client.get("/api/monitoring/flapping/").json()
        self.assertEqual(len(b["results"]), 2)
        b = self.client.get("/api/dashboard/").json()
        self.assertEqual(len(b["flapping"]), 2)

    def test_confirm_endpoints(self):
        self.login()
        r = self.client.post(
            f"/api/monitoring/ips/{self.ip.id}/flapping/clear/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cleared"], 1)
        r = self.client.post(
            "/api/monitoring/flapping/clear/", {"ip_ids": [str(self.ip_b.id)]}, format="json"
        )
        self.assertEqual(r.json()["cleared"], 1)
        self.assertEqual(self.client.get("/api/monitoring/flapping/").json()["results"], [])
        r = self.client.post("/api/monitoring/flapping/clear/", {}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_device_confirm_and_state_ids(self):
        self.login()
        r = self.client.post(
            f"/api/monitoring/devices/{self.device.id}/flapping/clear/", {}, format="json"
        )
        self.assertEqual(r.json()["cleared"], 1)
        r = self.client.post(
            "/api/monitoring/flapping/clear/", {"state_ids": [str(self.state_b.id)]},
            format="json",
        )
        self.assertEqual(r.json()["cleared"], 1)

    def _viewer(self, actions, sites):
        user = User.objects.create_user(f"u-{'-'.join(actions)}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for slug in ("ipaddress", "device"):
            perm = ObjectPermission.objects.create(
                name=f"{slug}-{'-'.join(actions)}", object_types=[slug], actions=list(actions)
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            perm.sites.add(*sites)
        return user

    def test_confirm_needs_change_and_stays_inside_the_site(self):
        viewer = self._viewer(["view"], [self.site_a, self.site_b])
        self.login(viewer)
        r = self.client.post(
            "/api/monitoring/flapping/clear/",
            {"ip_ids": [str(self.ip.id), str(self.ip_b.id)]}, format="json",
        )
        self.assertEqual(r.status_code, 403)
        editor = self._viewer(["view", "change"], [self.site_a])
        self.login(editor)
        r = self.client.post(
            "/api/monitoring/flapping/clear/",
            {"ip_ids": [str(self.ip.id), str(self.ip_b.id)]}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cleared"], 1)
        self.state_b.refresh_from_db()
        self.assertIsNotNone(self.state_b.flapping_since)
        # And the list shows only their site.
        self.assertEqual(
            [row["ip_address"] for row in self.client.get("/api/monitoring/flapping/").json()["results"]],
            [],
        )

    def test_settings_carry_the_switch(self):
        self.login()
        r = self.client.get("/api/monitoring/settings/")
        self.assertFalse(r.json()["auto_clear_flapping"])
        self.assertEqual(r.json()["auto_clear_flapping_after_minutes"], 30)
