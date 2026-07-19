"""Config-drift ingest (P3) — compute_drift helper + the device endpoint."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant
from integrations.drift import compute_drift
from integrations.models import DeviceConfigState


class ComputeDriftTests(SimpleTestCase):
    def test_identical_is_in_sync(self):
        status, diff = compute_drift("a\nb\n", "a\nb")
        self.assertEqual(status, "in_sync")
        self.assertEqual(diff, "")

    def test_trailing_whitespace_ignored(self):
        status, _ = compute_drift("hostname r1   \n", "hostname r1")
        self.assertEqual(status, "in_sync")

    def test_difference_is_drift_with_diff(self):
        status, diff = compute_drift("ntp 1.1.1.1\n", "ntp 9.9.9.9\n")
        self.assertEqual(status, "drift")
        self.assertIn("-ntp 1.1.1.1", diff)
        self.assertIn("+ntp 9.9.9.9", diff)

    def test_empty_side_is_unknown(self):
        self.assertEqual(compute_drift("", "x")[0], "unknown")
        self.assertEqual(compute_drift("x", "")[0], "unknown")


class DriftIngestEndpointTests(APITestCase):
    def setUp(self):
        from api.models import (
            Device, DeviceType, ExportTemplate, Manufacturer, Site,
        )

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site
        )
        self.tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="hostname", object_type="device",
            template_code="hostname {{ device.name }}",
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _url(self):
        return f"/api/devices/{self.dev.id}/config-state/"

    def test_get_before_report_404(self):
        self.assertEqual(self.client.get(self._url()).status_code, 404)

    def test_post_in_sync(self):
        res = self.client.post(
            self._url(),
            {"intended_config": "ntp 1.1.1.1", "actual_config": "ntp 1.1.1.1",
             "source": "ansible"},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "in_sync")
        self.assertEqual(res.json()["source"], "ansible")
        state = DeviceConfigState.objects.get(device=self.dev)
        self.assertIsNotNone(state.reported_at)

    def test_post_drift(self):
        res = self.client.post(
            self._url(),
            {"intended_config": "ntp 1.1.1.1", "actual_config": "ntp 9.9.9.9"},
            format="json",
        )
        self.assertEqual(res.json()["status"], "drift")
        self.assertIn("+ntp 9.9.9.9", res.json()["diff"])

    def test_post_renders_intended_from_template(self):
        # No intended posted → Danbyte renders the template (→ "hostname sw1").
        res = self.client.post(
            self._url(),
            {"template": str(self.tmpl.id), "actual_config": "hostname sw1"},
            format="json",
        )
        self.assertEqual(res.json()["status"], "in_sync")
        res2 = self.client.post(
            self._url(),
            {"template": str(self.tmpl.id), "actual_config": "hostname WRONG"},
            format="json",
        )
        self.assertEqual(res2.json()["status"], "drift")

    def test_post_actual_only_is_unknown(self):
        res = self.client.post(
            self._url(), {"actual_config": "whatever"}, format="json"
        )
        self.assertEqual(res.json()["status"], "unknown")

    def test_post_then_get_returns_latest(self):
        self.client.post(
            self._url(),
            {"intended_config": "a", "actual_config": "a"},
            format="json",
        )
        got = self.client.get(self._url())
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.json()["status"], "in_sync")
        # Upsert: a second report updates the same row, doesn't create a new one.
        self.client.post(
            self._url(),
            {"intended_config": "a", "actual_config": "b"},
            format="json",
        )
        self.assertEqual(DeviceConfigState.objects.filter(device=self.dev).count(), 1)
        self.assertEqual(self.client.get(self._url()).json()["status"], "drift")

    def test_tenant_wide_list_and_status_filter(self):
        self.client.post(
            self._url(),
            {"intended_config": "a", "actual_config": "b"},  # → drift
            format="json",
        )
        listing = self.client.get("/api/config-states/")
        self.assertEqual(listing.status_code, 200)
        rows = listing.json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["device_name"], "sw1")
        self.assertEqual(rows[0]["status"], "drift")
        # The light list serializer must not ship the big config blobs.
        self.assertNotIn("intended_config", rows[0])
        self.assertNotIn("diff", rows[0])
        # Status filter.
        self.assertEqual(
            len(self.client.get("/api/config-states/?status=drift").json()["results"]),
            1,
        )
        self.assertEqual(
            len(
                self.client.get("/api/config-states/?status=in_sync").json()["results"]
            ),
            0,
        )


class DriftComplianceTieInTests(APITestCase):
    """A drifted device shows up as a synthetic compliance violation."""

    def setUp(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _evaluate(self):
        return self.client.get("/api/compliance/evaluate/").json()

    def test_no_drift_no_synthetic_violation(self):
        ev = self._evaluate()
        self.assertFalse(
            any(v["rule_id"] == "config-drift" for v in ev["violations"])
        )

    def test_drifted_device_becomes_violation(self):
        DeviceConfigState.objects.create(
            tenant=self.tenant, device=self.dev, status="drift",
            intended_config="a", actual_config="b", diff="x",
        )
        ev = self._evaluate()
        drift = [v for v in ev["violations"] if v["rule_id"] == "config-drift"]
        self.assertEqual(len(drift), 1)
        self.assertEqual(drift[0]["object_id"], str(self.dev.id))
        self.assertEqual(drift[0]["object_type"], "device")
        self.assertEqual(drift[0]["severity"], "warning")
        self.assertGreaterEqual(ev["total_violations"], 1)

    def test_in_sync_device_is_not_a_violation(self):
        DeviceConfigState.objects.create(
            tenant=self.tenant, device=self.dev, status="in_sync",
            intended_config="a", actual_config="a",
        )
        ev = self._evaluate()
        self.assertFalse(
            any(v["rule_id"] == "config-drift" for v in ev["violations"])
        )


class DriftHistoryTests(APITestCase):
    """Snapshot history is an append-on-change transition log."""

    def setUp(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _report(self, intended, actual):
        return self.client.post(
            f"/api/devices/{self.dev.id}/config-state/",
            {"intended_config": intended, "actual_config": actual},
            format="json",
        )

    def test_snapshot_only_on_change(self):
        from integrations.models import DeviceConfigSnapshot

        self._report("a", "a")  # in_sync — first snapshot
        self.assertEqual(DeviceConfigSnapshot.objects.count(), 1)
        self._report("a", "a")  # unchanged — no new snapshot
        self.assertEqual(DeviceConfigSnapshot.objects.count(), 1)
        self._report("a", "b")  # → drift — new snapshot
        self.assertEqual(DeviceConfigSnapshot.objects.count(), 2)
        self._report("a", "a")  # back in sync — new snapshot
        self.assertEqual(DeviceConfigSnapshot.objects.count(), 3)

    def test_history_endpoint_filters_by_device(self):
        self._report("a", "b")  # drift
        self._report("a", "a")  # in_sync
        res = self.client.get(f"/api/config-snapshots/?device={self.dev.id}")
        self.assertEqual(res.status_code, 200)
        rows = res.json()["results"]
        self.assertEqual(len(rows), 2)
        # Newest first.
        self.assertEqual(rows[0]["status"], "in_sync")
        self.assertEqual(rows[1]["status"], "drift")
