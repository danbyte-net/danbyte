"""Scheduled config-drift dispatch tests — Settings toggle, throttle, fan-out."""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from core.models import DeploymentSettings, Organization, Tenant
from integrations import dispatch_drift as DD
from integrations.models import AutomationTarget, DeployRun


class ScheduledDriftDispatchTests(TestCase):
    def setUp(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site
        )
        self.target = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx",
            base_url="https://awx.test", job_template_id="7", token="tok",
        )

    def _enable(self, **kw):
        ds = DeploymentSettings.load()
        ds.config_drift_enabled = True
        for k, v in kw.items():
            setattr(ds, k, v)
        ds.save()
        return ds

    def test_disabled_does_nothing(self):
        with mock.patch("integrations.dispatch.enqueue_deploy") as enq:
            res = DD.run_scheduled_drift_dispatch()
        self.assertEqual(res, {"enabled": False})
        enq.assert_not_called()
        self.assertEqual(DeployRun.objects.count(), 0)

    def test_enabled_dispatches_drift_run(self):
        self._enable()
        with mock.patch("requests.post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            res = DD.run_scheduled_drift_dispatch()
        self.assertEqual(res["runs"], 1)
        self.assertEqual(res["tenants"], 1)
        run = DeployRun.objects.get()
        self.assertEqual(run.event, "drift")
        self.assertEqual(run.device_ids, [str(self.dev.id)])
        ds = DeploymentSettings.load()
        self.assertIsNotNone(ds.config_drift_last_run)

    def test_second_immediate_call_is_throttled(self):
        self._enable(config_drift_interval_minutes=60)
        with mock.patch("requests.post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            DD.run_scheduled_drift_dispatch()
            res2 = DD.run_scheduled_drift_dispatch()
        self.assertEqual(res2, {"skipped": "throttled"})
        self.assertEqual(DeployRun.objects.count(), 1)

    def test_runs_again_after_interval_elapsed(self):
        ds = self._enable(config_drift_interval_minutes=60)
        ds.config_drift_last_run = timezone.now() - timedelta(minutes=61)
        ds.save()
        with mock.patch("requests.post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            res = DD.run_scheduled_drift_dispatch()
        self.assertEqual(res["runs"], 1)

    def test_disabled_target_not_dispatched(self):
        self.target.enabled = False
        self.target.save()
        self._enable()
        with mock.patch("integrations.dispatch.enqueue_deploy") as enq:
            res = DD.run_scheduled_drift_dispatch()
        enq.assert_not_called()
        self.assertEqual(res["runs"], 0)

    def test_inactive_tenant_skipped(self):
        self.tenant.is_active = False
        self.tenant.save()
        self._enable()
        with mock.patch("integrations.dispatch.enqueue_deploy") as enq:
            res = DD.run_scheduled_drift_dispatch()
        enq.assert_not_called()
        self.assertEqual(res["tenants"], 0)
