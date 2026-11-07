"""Danbyte scripts as deploy targets, a deploy run's final status, and the
signed result callback for webhook runners."""
from __future__ import annotations

import hashlib
import hmac
import json
from unittest import mock

from django.contrib.auth.models import User
from django.test import Client
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations import dispatch as D
from integrations.models import AutomationTarget, DeployRun
from scripting.models import Script, ScriptRun
from scripting.runner import cancel, run_finished

DEVICE_IDS = [{"name": "device_ids", "type": "object"}]


def grant(user, tenant, slug, actions):
    p = ObjectPermission.objects.create(
        name=f"{user.username}-{slug}-{'-'.join(actions)}", object_types=[slug],
        actions=list(actions), enabled=True,
    )
    p.users.add(user)
    p.tenants.add(tenant)
    return p


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        self.op = self._member("op")
        grant(self.op, self.tenant, "automationtarget", ["view", "add", "change"])
        grant(self.op, self.tenant, "script", ["view", "run"])
        self.owner = self._member("owner")
        grant(self.owner, self.tenant, "script", ["view", "add", "change", "run"])
        self.enq = mock.patch("scripting.runner.enqueue")
        self.enqueue = self.enq.start()
        self.addCleanup(self.enq.stop)

    def _member(self, name):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        return user

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _script(self, tenant=None, **kw):
        kw.setdefault("name", "push")
        kw.setdefault("owner", self.owner)
        kw.setdefault("visibility", "global")
        kw.setdefault("params_schema", DEVICE_IDS)
        return Script.objects.create(tenant=tenant or self.tenant, source="print(1)", **kw)

    def _target(self, script, **kw):
        kw.setdefault("name", "script-target")
        return AutomationTarget.objects.create(
            tenant=self.tenant, kind="script", script=script, **kw
        )

    def _run(self, target, status="queued"):
        return DeployRun.objects.create(
            tenant=self.tenant, target=target, target_name=target.name,
            device_ids=["d1"], status=status,
        )


class TargetValidationTests(_Base):
    URL = "/api/automation-targets/"

    def post(self, **body):
        return self.client.post(self.URL, {"name": "S", "kind": "script", **body},
                                format="json")

    def test_script_target_needs_no_base_url(self):
        script = self._script()
        self.login(self.op)
        r = self.post(script=str(script.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["script"], str(script.id))
        self.assertEqual(r.json()["script_name"], "push")
        self.assertEqual(r.json()["base_url"], "")

    def test_script_is_required(self):
        self.login(self.op)
        r = self.post()
        self.assertEqual(r.status_code, 400)
        self.assertIn("script", r.json())

    def test_script_without_device_ids_is_a_field_error(self):
        script = self._script(params_schema=[{"name": "site", "type": "string"}])
        self.login(self.op)
        r = self.post(script=str(script.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_ids", r.json()["script"][0])

    def test_other_tenants_script_is_refused(self):
        theirs = self._script(tenant=self.other, name="theirs")
        self.login(self.op)
        r = self.post(script=str(theirs.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("script", r.json())

    def test_patch_cannot_point_at_another_tenants_script(self):
        target = self._target(self._script())
        theirs = self._script(tenant=self.other, name="theirs")
        self.login(self.op)
        r = self.client.patch(f"{self.URL}{target.id}/", {"script": str(theirs.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        target.refresh_from_db()
        self.assertNotEqual(target.script_id, theirs.id)

    def test_trusted_script_needs_trust(self):
        script = self._script(trusted=True)
        self.login(self.op)
        r = self.post(script=str(script.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("trust", r.json()["script"][0])
        grant(self.op, self.tenant, "script", ["trust"])
        self.assertEqual(self.post(script=str(script.id)).status_code, 201)

    def test_script_the_user_cannot_run_is_refused(self):
        script = self._script(visibility="owner")
        self.login(self.op)
        self.assertEqual(self.post(script=str(script.id)).status_code, 400)

    def test_webhook_still_needs_base_url(self):
        self.login(self.op)
        r = self.client.post(self.URL, {"name": "W", "kind": "webhook"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("base_url", r.json())

    def test_unrelated_edit_does_not_need_script_rights(self):
        target = self._target(self._script(trusted=True))
        self.login(self.op)
        r = self.client.patch(f"{self.URL}{target.id}/", {"enabled": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)


class ScriptDispatchTests(_Base):
    def dispatch(self, target, run, user=None, ids=("d1",), event="manual"):
        return D.dispatch_deploy(
            str(target.id), list(ids), event=event, run_id=str(run.id),
            user_id=str(user.pk) if user else None,
        )

    def test_queues_a_script_run_as_the_caller(self):
        script = self._script()
        target = self._target(script, extra_vars={"branch": "main", "device_ids": ["x"]})
        run = self._run(target)
        res = self.dispatch(target, run, user=self.op)
        self.assertTrue(res["ok"], res)
        sr = ScriptRun.objects.get(script=script)
        self.assertEqual(sr.params, {"device_ids": ["d1"], "event": "manual",
                                     "object_type": "device", "branch": "main"})
        self.assertEqual(sr.started_by, self.op)
        self.assertEqual(sr.run_as_user, self.op)
        self.enqueue.assert_called_once()
        run.refresh_from_db()
        self.assertEqual(run.status, "launched")
        self.assertEqual(run.script_run, sr)
        self.assertEqual(run.detail, f"Script run {sr.id} queued.")

    def test_owner_script_runs_as_owner_without_a_user(self):
        script = self._script(run_as="owner")
        target = self._target(script)
        run = self._run(target)
        self.assertTrue(self.dispatch(target, run, event="drift")["ok"])
        sr = ScriptRun.objects.get(script=script)
        self.assertEqual(sr.run_as_user, self.owner)
        self.assertIsNone(sr.started_by)

    def test_caller_script_without_a_user_fails(self):
        target = self._target(self._script())
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, event="drift")["ok"])
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertFalse(ScriptRun.objects.exists())

    def test_trusted_script_rechecked_at_dispatch(self):
        script = self._script()
        target = self._target(script)
        Script.objects.filter(pk=script.pk).update(trusted=True)
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, user=self.op)["ok"])
        run.refresh_from_db()
        self.assertIn("trusted", run.detail)
        self.assertFalse(ScriptRun.objects.exists())

    def test_lost_run_right_rechecked_at_dispatch(self):
        target = self._target(self._script())
        ObjectPermission.objects.filter(users=self.op, object_types=["script"]).delete()
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, user=self.op)["ok"])
        self.assertFalse(ScriptRun.objects.exists())

    def test_script_moved_to_another_tenant_fails(self):
        script = self._script()
        target = self._target(script)
        Script.objects.filter(pk=script.pk).update(tenant=self.other)
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, user=self.op)["ok"])
        self.assertFalse(ScriptRun.objects.exists())

    def test_device_ids_dropped_from_schema_fails(self):
        script = self._script()
        target = self._target(script)
        Script.objects.filter(pk=script.pk).update(params_schema=[])
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, user=self.op)["ok"])

    def test_inactive_user_starts_nothing(self):
        target = self._target(self._script())
        User.objects.filter(pk=self.op.pk).update(is_active=False)
        run = self._run(target)
        self.assertFalse(self.dispatch(target, run, user=self.op)["ok"])
        self.assertFalse(ScriptRun.objects.exists())

    def test_bulk_deploy_passes_the_caller(self):
        from api.models import Device, DeviceType, Manufacturer, Site

        grant(self.op, self.tenant, "device", ["view"])
        grant(self.op, self.tenant, "deployrun", ["view"])
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt, site=site)
        target = self._target(self._script())
        self.login(self.op)
        with mock.patch("django_rq.get_queue", side_effect=RuntimeError("no redis")):
            r = self.client.post(f"/api/automation-targets/{target.id}/deploy/",
                                 {"device_ids": [str(dev.id)]}, format="json")
        self.assertEqual(r.status_code, 202, r.content)
        sr = ScriptRun.objects.get()
        self.assertEqual(sr.run_as_user, self.op)
        self.assertEqual(sr.params["device_ids"], [str(dev.id)])
        row = self.client.get(f"/api/deploy-runs/{r.json()['id']}/").json()
        self.assertEqual(row["script_run"], str(sr.id))
        self.assertEqual(row["status"], "launched")


class FinalStatusTests(_Base):
    def _started(self):
        script = self._script()
        target = self._target(script)
        run = self._run(target)
        D.dispatch_deploy(str(target.id), ["d1"], run_id=str(run.id), user_id=str(self.op.pk))
        run.refresh_from_db()
        return run, run.script_run

    def _finish(self, sr, status, code, log=""):
        ScriptRun.objects.filter(pk=sr.pk).update(status=status, exit_code=code, log=log)
        sr.refresh_from_db()
        run_finished.send(sender=ScriptRun, run=sr)

    def test_success_marks_succeeded_with_the_log_tail(self):
        run, sr = self._started()
        self._finish(sr, "success", 0, "x" * 5000 + "pushed sw1\n")
        run.refresh_from_db()
        self.assertEqual(run.status, "succeeded")
        self.assertIn("pushed sw1", run.detail)
        self.assertLessEqual(len(run.detail), 2000)
        self.assertIsNotNone(run.finished_at)

    def test_failure_marks_failed_and_stays_final(self):
        run, sr = self._started()
        self._finish(sr, "failed", 2, "boom")
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("exit 2", run.detail)
        self._finish(sr, "success", 0, "later")
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")

    def test_cancel_fails_the_deploy(self):
        run, sr = self._started()
        cancel(sr)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("canceled", run.detail)

    def test_script_finishing_before_launch_is_recorded_keeps_its_outcome(self):
        def finish_now(sr):
            self._finish(sr, "success", 0, "done")

        self.enqueue.side_effect = finish_now
        script = self._script()
        target = self._target(script)
        run = self._run(target)
        D.dispatch_deploy(str(target.id), ["d1"], run_id=str(run.id), user_id=str(self.op.pk))
        run.refresh_from_db()
        self.assertEqual(run.status, "succeeded")

    def test_runner_end_sends_the_signal(self):
        from scripting import runner

        run, sr = self._started()
        with mock.patch.object(runner, "confine", side_effect=RuntimeError("no sandbox")):
            runner.run_script(str(sr.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("no sandbox", run.detail)


class ResultCallbackTests(_Base):
    def setUp(self):
        super().setUp()
        self.target = AutomationTarget.objects.create(
            tenant=self.tenant, name="ci", kind="webhook",
            base_url="https://ci.example/hook", token="sek",
        )
        self.run = self._run(self.target, status="launched")
        self.http = Client(enforce_csrf_checks=True)

    def url(self, run=None):
        return f"/api/deploy-runs/{(run or self.run).id}/result/"

    def call(self, body, secret="sek", run=None, sig=None):
        raw = json.dumps(body).encode()
        if sig is None:
            sig = "sha512=" + hmac.new(secret.encode(), raw, hashlib.sha512).hexdigest()
        return self.http.post(self.url(run), raw, content_type="application/json",
                              HTTP_X_DANBYTE_SIGNATURE=sig)

    def test_signed_result_finalises_once(self):
        r = self.call({"status": "succeeded", "detail": "pushed"})
        self.assertEqual(r.status_code, 200, r.content)
        self.run.refresh_from_db()
        self.assertEqual((self.run.status, self.run.detail), ("succeeded", "pushed"))
        again = self.call({"status": "failed", "detail": "replay"})
        self.assertEqual(again.status_code, 409)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, "succeeded")

    def test_bad_or_missing_signature_is_refused(self):
        self.assertEqual(self.call({"status": "failed"}, secret="wrong").status_code, 403)
        self.assertEqual(self.call({"status": "failed"}, sig="").status_code, 403)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, "launched")

    def test_unknown_run_looks_like_a_bad_signature(self):
        import uuid

        r = self.http.post(f"/api/deploy-runs/{uuid.uuid4()}/result/", b"{}",
                           content_type="application/json", HTTP_X_DANBYTE_SIGNATURE="x")
        self.assertEqual(r.status_code, 403)

    def test_only_a_launched_run(self):
        queued = self._run(self.target, status="queued")
        self.assertEqual(self.call({"status": "succeeded"}, run=queued).status_code, 409)
        queued.refresh_from_db()
        self.assertEqual(queued.status, "queued")

    def test_status_must_be_final(self):
        self.assertEqual(self.call({"status": "launched"}).status_code, 400)
        self.assertEqual(self.call({"status": "succeeded", "detail": 3}).status_code, 400)

    def test_no_secret_or_non_webhook_target_is_refused(self):
        AutomationTarget.objects.filter(pk=self.target.pk).update(token="")
        self.assertEqual(self.call({"status": "succeeded"}, secret="").status_code, 403)
        awx = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="awx", base_url="https://awx.example",
            token="sek",
        )
        run = self._run(awx, status="launched")
        self.assertEqual(self.call({"status": "succeeded"}, run=run).status_code, 403)

    def test_webhook_payload_carries_the_run_id(self):
        run = self._run(self.target)
        cap = {}

        class R:
            status_code = 200

        def fake_post(url, data=None, **kw):
            cap["data"] = data
            return R()

        with mock.patch("integrations.dispatch.safe_post", side_effect=fake_post):
            D.dispatch_deploy(str(self.target.id), ["d1"], run_id=str(run.id))
        self.assertEqual(json.loads(cap["data"])["run_id"], str(run.id))
        run.refresh_from_db()
        self.assertEqual(run.status, "launched")
