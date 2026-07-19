"""Deploy dispatch tests — webhook signing, AWX path, run records."""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from auth_api.models import UserProfile
from core.models import Organization, Tenant
from integrations import dispatch as D
from integrations.models import AutomationTarget, DeployRun


class DeployDispatchTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _run(self, target):
        return DeployRun.objects.create(
            tenant=self.tenant, target=target, target_name=target.name,
            device_ids=["d1"], status="queued",
        )

    def test_webhook_signed_and_marks_launched(self):
        tgt = AutomationTarget.objects.create(
            tenant=self.tenant, name="ci", kind="webhook",
            base_url="http://x.test/d", token="sek",
        )
        run = self._run(tgt)
        cap = {}

        class R:
            status_code = 200

        def fake_post(url, data=None, headers=None, **kw):
            cap["data"] = data
            cap["headers"] = headers
            return R()

        with mock.patch("integrations.dispatch.safe_post", side_effect=fake_post):
            res = D.dispatch_deploy(str(tgt.id), ["d1"], run_id=str(run.id))

        self.assertTrue(res["ok"])
        payload = json.loads(cap["data"])
        self.assertEqual(payload["device_ids"], ["d1"])
        expect = "sha512=" + hmac.new(b"sek", cap["data"], hashlib.sha512).hexdigest()
        self.assertEqual(cap["headers"]["X-Danbyte-Signature"], expect)
        run.refresh_from_db()
        self.assertEqual(run.status, "launched")

    def test_awx_launch(self):
        tgt = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx",
            base_url="https://awx.test", job_template_id="7", token="tok",
        )
        run = self._run(tgt)

        class R:
            status_code = 201

            def json(self):
                return {"id": 42}

        cap = {}

        def fake_post(url, json=None, headers=None, **kw):
            cap["url"] = url
            cap["headers"] = headers
            cap["json"] = json
            return R()

        with mock.patch("integrations.dispatch.safe_post", side_effect=fake_post):
            res = D.dispatch_deploy(str(tgt.id), ["d1"], run_id=str(run.id))

        self.assertTrue(res["ok"])
        self.assertIn("/api/v2/job_templates/7/launch/", cap["url"])
        self.assertEqual(cap["headers"]["Authorization"], "Bearer tok")
        self.assertIn("device_ids", cap["json"]["extra_vars"])

    def test_error_is_graceful(self):
        tgt = AutomationTarget.objects.create(
            tenant=self.tenant, name="bad", kind="webhook",
            base_url="http://x.test/d",
        )
        run = self._run(tgt)
        with mock.patch("integrations.dispatch.safe_post", side_effect=OSError("boom")):
            res = D.dispatch_deploy(str(tgt.id), ["d1"], run_id=str(run.id))
        self.assertFalse(res["ok"])
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")


class AutoDispatchTests(TestCase):
    """P2.5 — a device save fires auto_on_change targets, and nothing else."""

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

    def _target(self, **kw):
        opts = dict(
            tenant=self.tenant, name="awx", kind="awx",
            base_url="https://awx.test", job_template_id="7", token="tok",
        )
        opts.update(kw)
        return AutomationTarget.objects.create(**opts)

    def test_auto_target_fires_on_save(self):
        self._target(auto_on_change=True)
        with mock.patch.object(D, "enqueue_deploy") as enq:
            self.dev.name = "sw1-renamed"
            self.dev.save()
        enq.assert_called_once()
        target, ids = enq.call_args.args[0], enq.call_args.args[1]
        self.assertTrue(target.auto_on_change)
        self.assertEqual([str(i) for i in ids], [str(self.dev.pk)])
        self.assertEqual(enq.call_args.kwargs.get("event"), "auto")

    def test_manual_target_does_not_fire(self):
        self._target(auto_on_change=False)
        with mock.patch.object(D, "enqueue_deploy") as enq:
            self.dev.save()
        enq.assert_not_called()

    def test_object_type_scope_respected(self):
        # Target scoped to interfaces only — a device save must not fire it.
        self._target(auto_on_change=True, object_types=["interface"])
        with mock.patch.object(D, "enqueue_deploy") as enq:
            self.dev.save()
        enq.assert_not_called()

    def test_disabled_target_does_not_fire(self):
        self._target(auto_on_change=True, enabled=False)
        with mock.patch.object(D, "enqueue_deploy") as enq:
            self.dev.save()
        enq.assert_not_called()


class _DeployEndpointBase(APITestCase):
    """Shared fixture: a tenant with two devices + an enabled AWX target."""

    def setUp(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
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
        self.d1 = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site
        )
        self.d2 = Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=dt, site=site
        )
        self.target = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx",
            base_url="https://awx.test", job_template_id="7", token="tok",
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")


class BulkDeployEndpointTests(_DeployEndpointBase):
    """POST /api/automation-targets/<id>/deploy/ — the bulk deploy action."""

    def _url(self, target=None):
        return f"/api/automation-targets/{(target or self.target).id}/deploy/"

    def test_bulk_deploy_creates_one_run(self):
        with mock.patch.object(D, "enqueue_deploy", wraps=D.enqueue_deploy) as enq, \
                mock.patch("integrations.dispatch.safe_post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            res = self.client.post(
                self._url(),
                {"device_ids": [str(self.d1.id), str(self.d2.id)]},
                format="json",
            )
        self.assertEqual(res.status_code, 202)
        enq.assert_called_once()
        run = DeployRun.objects.get(id=res.json()["id"])
        self.assertEqual(run.event, "bulk")
        self.assertEqual(sorted(run.device_ids),
                         sorted([str(self.d1.id), str(self.d2.id)]))

    def test_empty_list_rejected(self):
        res = self.client.post(self._url(), {"device_ids": []}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_cross_tenant_device_filtered_out(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        site = Site.objects.create(tenant=self.other, name="X")
        mfr = Manufacturer.objects.create(tenant=self.other, name="D", slug="d")
        dt = DeviceType.objects.create(
            tenant=self.other, manufacturer=mfr, model="Y"
        )
        foreign = Device.objects.create(
            tenant=self.other, name="nope", device_type=dt, site=site
        )
        with mock.patch("integrations.dispatch.safe_post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            res = self.client.post(
                self._url(), {"device_ids": [str(foreign.id)]}, format="json"
            )
        # No device in the active tenant matched → 400, nothing dispatched.
        self.assertEqual(res.status_code, 400)

    def test_disabled_target_rejected(self):
        self.target.enabled = False
        self.target.save()
        res = self.client.post(
            self._url(), {"device_ids": [str(self.d1.id)]}, format="json"
        )
        self.assertEqual(res.status_code, 400)


class RetryDeployEndpointTests(_DeployEndpointBase):
    """POST /api/deploy-runs/<id>/retry/ — re-fire a failed run."""

    def _failed_run(self):
        return DeployRun.objects.create(
            tenant=self.tenant, target=self.target, target_name=self.target.name,
            event="bulk", device_ids=[str(self.d1.id)], status="failed",
            detail="Webhook returned 502.", attempt=1,
        )

    def _retry_url(self, run):
        return f"/api/deploy-runs/{run.id}/retry/"

    def test_retry_failed_creates_linked_run(self):
        run = self._failed_run()
        with mock.patch.object(D, "enqueue_deploy", wraps=D.enqueue_deploy), \
                mock.patch("integrations.dispatch.safe_post") as post:
            post.return_value = mock.Mock(status_code=201, json=lambda: {"id": 9})
            res = self.client.post(self._retry_url(run))
        self.assertEqual(res.status_code, 202)
        new = DeployRun.objects.get(id=res.json()["id"])
        self.assertNotEqual(new.id, run.id)
        self.assertEqual(new.attempt, 2)
        self.assertEqual(str(new.retry_of_id), str(run.id))
        self.assertEqual(new.event, "bulk")
        self.assertEqual(new.device_ids, [str(self.d1.id)])

    def test_retry_non_failed_rejected(self):
        run = self._failed_run()
        run.status = "launched"
        run.save()
        res = self.client.post(self._retry_url(run))
        self.assertEqual(res.status_code, 400)

    def test_retry_disabled_target_rejected(self):
        run = self._failed_run()
        self.target.enabled = False
        self.target.save()
        res = self.client.post(self._retry_url(run))
        self.assertEqual(res.status_code, 400)

    def test_collection_post_is_405(self):
        # Enabling POST for the retry action must not reopen the generic create.
        res = self.client.post("/api/deploy-runs/", {}, format="json")
        self.assertEqual(res.status_code, 405)

    def test_can_retry_flag_in_serializer(self):
        run = self._failed_run()
        res = self.client.get(f"/api/deploy-runs/?device={self.d1.id}")
        row = next(r for r in res.json()["results"] if r["id"] == str(run.id))
        self.assertTrue(row["can_retry"])
        self.assertEqual(row["attempt"], 1)
