"""Deploy pipelines: ordered steps, progression from the completion points,
stop on failure, timeouts, dry run, the callback's log lines, as-code
import/export and tenant isolation."""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.test import Client
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations import pipelines as P
from integrations.models import (
    AutomationTarget,
    DeployPipeline,
    DeployPipelineRun,
    DeployPipelineStep,
    DeployRun,
)
from integrations.script_targets import LOG_LIMIT, LOG_TRUNCATED, append_log
from scripting.models import Script, ScriptRun
from scripting.runner import run_finished

DEVICE_IDS = [{"name": "device_ids", "type": "object"}]


def grant(user, tenant, slug, actions):
    p = ObjectPermission.objects.create(
        name=f"{user.username}-{slug}-{'-'.join(actions)}", object_types=[slug],
        actions=list(actions), enabled=True,
    )
    p.users.add(user)
    p.tenants.add(tenant)
    return p


class _Resp:
    def __init__(self, code=202):
        self.status_code = code
        self.text = ""

    def json(self):
        return {}


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        self.op = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=self.op, role="custom").tenants.add(self.tenant)
        for slug, acts in (
            ("device", ["view", "change"]),
            ("deploypipeline", ["view", "add", "change"]),
            ("deploypipelinerun", ["view", "change"]),
            ("automationtarget", ["view"]),
            ("script", ["view", "run"]),
        ):
            grant(self.op, self.tenant, slug, acts)
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Router", slug="router")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="r1", device_type=dt, site=site, role=self.role
        )
        self.script = Script.objects.create(
            tenant=self.tenant, name="vnets", source="print(1)", owner=self.op,
            visibility="global", params_schema=DEVICE_IDS,
        )
        self.t_script = AutomationTarget.objects.create(
            tenant=self.tenant, name="Plan VNets", kind="script", script=self.script
        )
        self.t_apply = AutomationTarget.objects.create(
            tenant=self.tenant, name="Apply VNets", kind="webhook",
            base_url="https://runner.example/vnets", token="sek",
        )
        self.t_push = AutomationTarget.objects.create(
            tenant=self.tenant, name="Push config", kind="webhook",
            base_url="https://runner.example/deploy", token="sek2",
        )
        patches = [
            mock.patch("scripting.runner.enqueue"),
            # No Redis in tests: every enqueue falls back to running inline.
            mock.patch("django_rq.get_queue", side_effect=RuntimeError("no redis")),
            mock.patch("integrations.dispatch.safe_post", side_effect=self._post),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.posts = []
        self.http = Client(enforce_csrf_checks=True)

    def _post(self, url, data=None, **kw):
        self.posts.append((url, json.loads(data)))
        return _Resp(202)

    def login(self, user=None):
        self.client.force_login(user or self.op)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def pipeline(self, *steps, **kw):
        p = DeployPipeline.objects.create(tenant=self.tenant, name=kw.pop("name", "Router"), **kw)
        for i, (target, opts) in enumerate(steps, start=1):
            DeployPipelineStep.objects.create(pipeline=p, order=i, target=target, **opts)
        return p

    def acceptance_pipeline(self):
        return self.pipeline(
            (self.t_script, {}),
            (self.t_apply, {"wait_for_result": True}),
            (self.t_push, {}),
        )

    def deploy(self, pipeline, **body):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/devices/{self.dev.id}/deploy/",
                                 {"pipeline_id": str(pipeline.id), **body}, format="json")
        self.assertEqual(r.status_code, 202, r.content)
        return DeployPipelineRun.objects.get(pk=r.json()["id"])

    def finish_script(self, sr, status="success", code=0, log="done"):
        ScriptRun.objects.filter(pk=sr.pk).update(status=status, exit_code=code, log=log)
        sr.refresh_from_db()
        with self.captureOnCommitCallbacks(execute=True):
            run_finished.send(sender=ScriptRun, run=sr)

    def callback(self, dr, body, secret="sek"):
        raw = json.dumps(body).encode()
        sig = "sha512=" + hmac.new(secret.encode(), raw, hashlib.sha512).hexdigest()
        with self.captureOnCommitCallbacks(execute=True):
            return self.http.post(f"/api/deploy-runs/{dr.id}/result/", raw,
                                  content_type="application/json",
                                  HTTP_X_DANBYTE_SIGNATURE=sig)

    def step(self, run, no):
        return DeployRun.objects.filter(pipeline_run=run, pipeline_step=no).first()


class AcceptanceTests(_Base):
    """[script, webhook waiting for its result, webhook]: in order, one run."""

    def test_steps_run_in_order_and_one_run_lists_all_three(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        s1 = self.step(run, 1)
        self.assertEqual(s1.status, "launched")
        self.assertIsNone(self.step(run, 2), "step 2 must wait for step 1")
        self.assertEqual(self.posts, [])
        sr = s1.script_run
        self.assertEqual(sr.params["pipeline_run_id"], str(run.id))
        self.assertEqual(sr.params["step"], 1)
        self.assertFalse(sr.params["dry_run"])
        self.assertEqual(sr.params["steps"], [])
        self.assertEqual(sr.params["device_ids"], [str(self.dev.id)])

        self.finish_script(sr)
        s2 = self.step(run, 2)
        self.assertEqual(s2.status, "launched")
        self.assertTrue(s2.wait_for_result)
        self.assertIsNone(self.step(run, 3), "step 3 waits for step 2's result")
        self.assertEqual(len(self.posts), 1)
        url, payload = self.posts[0]
        self.assertEqual(url, "https://runner.example/vnets")
        self.assertEqual(payload["pipeline_run_id"], str(run.id))
        self.assertEqual(payload["step"], 2)
        self.assertEqual(payload["run_id"], str(s2.id))
        self.assertEqual(payload["steps"][0]["target"], "Plan VNets")
        self.assertEqual(payload["steps"][0]["status"], "succeeded")
        self.assertEqual(payload["steps"][0]["script_run_id"], str(sr.id))
        self.assertEqual(payload["steps"][0]["outputs"], [])

        # Progress lines do not finish the step.
        r = self.callback(s2, {"status": "running", "log": ["applying", "zone fab"]})
        self.assertEqual(r.status_code, 200, r.content)
        s2.refresh_from_db()
        self.assertEqual((s2.status, s2.log), ("launched", "applying\nzone fab\n"))
        self.assertIsNone(self.step(run, 3))

        r = self.callback(s2, {"status": "succeeded", "log": ["done"]})
        self.assertEqual(r.status_code, 200, r.content)
        s3 = self.step(run, 3)
        self.assertEqual(s3.status, "launched")
        self.assertEqual(len(self.posts), 2)
        self.assertEqual([s["target"] for s in self.posts[1][1]["steps"]],
                         ["Plan VNets", "Apply VNets"])
        run.refresh_from_db()
        self.assertEqual(run.status, "succeeded")

        detail = self.client.get(f"/api/deploy-pipeline-runs/{run.id}/").json()
        self.assertEqual([s["status"] for s in detail["steps"]], ["succeeded"] * 3)
        self.assertEqual([s["target_name"] for s in detail["steps"]],
                         ["Plan VNets", "Apply VNets", "Push config"])
        self.assertEqual(detail["steps"][0]["log_source"], "script")
        self.assertEqual(detail["steps"][1]["log"], "applying\nzone fab\ndone\n")
        listed = self.client.get("/api/deploy-pipeline-runs/").json()["results"]
        self.assertEqual([r["id"] for r in listed], [str(run.id)])
        self.assertEqual(listed[0]["objects"], [{"id": str(self.dev.id), "name": "r1"}])

    def test_a_failed_step_stops_the_rest(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        self.finish_script(self.step(run, 1).script_run)
        r = self.callback(self.step(run, 2), {"status": "failed", "detail": "VNet missing\nx"})
        self.assertEqual(r.status_code, 200)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIsNone(self.step(run, 3))
        self.assertEqual(len(self.posts), 1)
        detail = self.client.get(f"/api/deploy-pipeline-runs/{run.id}/").json()
        self.assertEqual([s["status"] for s in detail["steps"]],
                         ["succeeded", "failed", "skipped"])
        self.assertEqual(detail["failing_step"],
                         {"step": 2, "target_name": "Apply VNets", "error": "VNet missing"})

    def test_failed_script_stops_the_rest(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        self.finish_script(self.step(run, 1).script_run, status="failed", code=1)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIsNone(self.step(run, 2))
        self.assertEqual(self.posts, [])

    def test_step_without_stop_on_failure_goes_on(self):
        self.login()
        p = self.pipeline((self.t_script, {"stop_on_failure": False}), (self.t_push, {}))
        run = self.deploy(p)
        self.finish_script(self.step(run, 1).script_run, status="failed", code=1)
        self.assertEqual(self.step(run, 2).status, "launched")
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")  # a step failed, the rest still ran

    def test_outputs_reach_the_next_step(self):
        from django.core.files.base import ContentFile

        from scripting.models import ScriptOutput

        self.login()
        run = self.deploy(self.acceptance_pipeline())
        sr = self.step(run, 1).script_run
        out = ScriptOutput(run=sr, name="vnet-plan.json", size=2,
                           content_type="application/json")
        out.file.save("vnet-plan.json", ContentFile(b"{}"), save=True)
        self.addCleanup(out.file.delete, False)
        self.finish_script(sr)
        step = self.posts[0][1]["steps"][0]
        self.assertEqual(step["outputs"], [{
            "name": "vnet-plan.json",
            "url": f"/api/scripts/runs/{sr.id}/outputs/{out.id}/download/",
        }])


class DryRunTests(_Base):
    def test_every_step_gets_dry_run(self):
        self.login()
        p = self.pipeline((self.t_script, {}), (self.t_push, {}))
        run = self.deploy(p, dry_run=True)
        self.assertTrue(run.dry_run)
        sr = self.step(run, 1).script_run
        self.assertTrue(sr.params["dry_run"])
        self.finish_script(sr)
        self.assertTrue(self.posts[0][1]["dry_run"])

    def test_target_cannot_override_dry_run(self):
        AutomationTarget.objects.filter(pk=self.t_push.pk).update(extra_vars={"dry_run": False})
        self.login()
        self.deploy(self.pipeline((self.t_push, {})), dry_run=True)
        self.assertTrue(self.posts[0][1]["dry_run"])

    def test_single_target_dry_run(self):
        self.login()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/devices/{self.dev.id}/deploy/",
                                 {"target_id": str(self.t_push.id), "dry_run": True},
                                 format="json")
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()["kind"], "target")
        self.assertTrue(r.json()["dry_run"])
        self.assertTrue(self.posts[0][1]["dry_run"])


class TimeoutTests(_Base):
    def test_waiting_step_fails_after_its_timeout(self):
        self.login()
        p = self.pipeline((self.t_apply, {"wait_for_result": True, "timeout_minutes": 5}),
                          (self.t_push, {}))
        run = self.deploy(p)
        s1 = self.step(run, 1)
        self.assertEqual(s1.status, "launched")
        self.assertAlmostEqual(
            (s1.result_deadline - s1.created_at).total_seconds(), 300, delta=5
        )
        self.assertEqual(P.sweep_timeouts(), 0)
        with self.captureOnCommitCallbacks(execute=True):
            n = P.sweep_timeouts(now=timezone.now() + timedelta(minutes=6))
        self.assertEqual(n, 1)
        s1.refresh_from_db()
        self.assertEqual(s1.status, "failed")
        self.assertIn("5 minutes", s1.detail)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIsNone(self.step(run, 2))
        # A late result changes nothing.
        self.assertEqual(self.callback(s1, {"status": "succeeded"}).status_code, 409)

    def test_sweep_command(self):
        from django.core.management import call_command

        call_command("sweep_deploy_pipelines", stdout=mock.MagicMock())


class RecheckTests(_Base):
    def test_disabled_pipeline_stops_at_the_next_step(self):
        self.login()
        p = self.acceptance_pipeline()
        run = self.deploy(p)
        DeployPipeline.objects.filter(pk=p.pk).update(enabled=False)
        self.finish_script(self.step(run, 1).script_run)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIn("disabled", run.detail)
        self.assertIsNone(self.step(run, 2))

    def test_target_moved_to_another_tenant_fails_its_step(self):
        self.login()
        p = self.pipeline((self.t_push, {}))
        AutomationTarget.objects.filter(pk=self.t_push.pk).update(tenant=self.other)
        run = self.deploy(p)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertEqual(self.posts, [])
        self.assertIn("another tenant", self.step(run, 1).detail)

    def test_deactivated_user_stops_the_run(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        User.objects.filter(pk=self.op.pk).update(is_active=False)
        self.finish_script(self.step(run, 1).script_run)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertIsNone(self.step(run, 2))

    def test_lost_device_scope_stops_the_run(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        ObjectPermission.objects.filter(users=self.op, object_types=["device"]).delete()
        self.finish_script(self.step(run, 1).script_run)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")

    def test_advance_twice_starts_a_step_once(self):
        self.login()
        run = self.deploy(self.pipeline((self.t_apply, {"wait_for_result": True})))
        P.advance(run.id)
        P.advance(run.id)
        self.assertEqual(DeployRun.objects.filter(pipeline_run=run).count(), 1)
        self.assertEqual(len(self.posts), 1)


class CancelRerunTests(_Base):
    def test_cancel_stops_pending_steps_and_the_script_run(self):
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        sr = self.step(run, 1).script_run
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/deploy-pipeline-runs/{run.id}/cancel/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "cancelled")
        self.assertEqual([s["status"] for s in r.json()["steps"]],
                         ["failed", "cancelled", "cancelled"])
        sr.refresh_from_db()
        self.assertEqual(sr.status, "canceled")
        self.assertIsNone(self.step(run, 2))
        self.assertEqual(self.client.post(
            f"/api/deploy-pipeline-runs/{run.id}/cancel/").status_code, 400)

    def test_rerun_starts_a_linked_run(self):
        self.login()
        run = self.deploy(self.pipeline((self.t_push, {})), dry_run=True)
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"/api/deploy-pipeline-runs/{run.id}/rerun/")
        self.assertEqual(r.status_code, 202, r.content)
        new = DeployPipelineRun.objects.get(pk=r.json()["id"])
        self.assertEqual((new.trigger, new.rerun_of_id, new.dry_run), ("rerun", run.id, True))
        self.assertEqual(new.status, "succeeded")

    def test_cancel_needs_change(self):
        viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        grant(viewer, self.tenant, "deploypipelinerun", ["view"])
        self.login()
        run = self.deploy(self.acceptance_pipeline())
        self.login(viewer)
        self.assertEqual(self.client.post(
            f"/api/deploy-pipeline-runs/{run.id}/cancel/").status_code, 403)


class AutoOnChangeTests(_Base):
    def test_saving_a_device_starts_the_pipeline_as_the_author(self):
        from audit.context import clear_context, set_context

        p = self.pipeline((self.t_push, {}), auto_on_change=True)
        set_context(self.op, "req-1")
        self.addCleanup(clear_context)
        with self.captureOnCommitCallbacks(execute=True):
            self.dev.description = "changed"
            self.dev.save()
        run = DeployPipelineRun.objects.get(pipeline=p)
        self.assertEqual((run.trigger, run.triggered_by_id), ("on_change", self.op.id))
        self.assertEqual(self.posts[0][1]["event"], "auto")


class PipelineApiTests(_Base):
    URL = "/api/deploy-pipelines/"

    def body(self, **kw):
        body = {
            "name": "Router", "object_types": ["device"], "roles": [str(self.role.id)],
            "steps": [
                {"target": str(self.t_script.id)},
                {"target": str(self.t_apply.id), "wait_for_result": True,
                 "timeout_minutes": 10},
                {"target": str(self.t_push.id), "stop_on_failure": False},
            ],
        }
        body.update(kw)
        return body

    def test_create_with_nested_steps(self):
        self.login()
        r = self.client.post(self.URL, self.body(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        data = r.json()
        self.assertEqual([s["target_name"] for s in data["steps"]],
                         ["Plan VNets", "Apply VNets", "Push config"])
        self.assertEqual([s["order"] for s in data["steps"]], [1, 2, 3])
        self.assertEqual(data["steps"][1]["timeout_minutes"], 10)
        self.assertEqual(data["role_details"][0]["name"], "Router")
        self.assertEqual(data["steps_count"], 3)

    def test_reorder_keeps_rows(self):
        self.login()
        pid = self.client.post(self.URL, self.body(), format="json").json()["id"]
        before = set(DeployPipelineStep.objects.filter(pipeline_id=pid).values_list("id",
                                                                                    flat=True))
        r = self.client.patch(f"{self.URL}{pid}/", {"steps": [
            {"target": str(self.t_push.id)}, {"target": str(self.t_script.id)},
        ]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([s["target_name"] for s in r.json()["steps"]],
                         ["Push config", "Plan VNets"])
        after = set(DeployPipelineStep.objects.filter(pipeline_id=pid).values_list("id",
                                                                                   flat=True))
        self.assertTrue(after <= before)

    def test_needs_a_step(self):
        self.login()
        self.assertEqual(self.client.post(self.URL, self.body(steps=[]),
                                          format="json").status_code, 400)

    def test_awx_cannot_wait_for_result(self):
        awx = AutomationTarget.objects.create(tenant=self.tenant, name="awx", kind="awx",
                                              base_url="https://awx.example")
        self.login()
        r = self.client.post(self.URL, self.body(steps=[
            {"target": str(awx.id), "wait_for_result": True}]), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("wait_for_result", r.json()["steps"][0])

    def test_object_types_are_checked(self):
        self.login()
        r = self.client.post(self.URL, self.body(object_types=["prefix"]), format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("object_types", r.json())
        r = self.client.post(self.URL, self.body(object_types=["virtualmachine"]),
                             format="json")
        self.assertEqual(r.status_code, 400)  # the targets take devices only
        self.assertIn("steps", r.json())

    def test_export_and_import_round_trip(self):
        self.login()
        pid = self.client.post(self.URL, self.body(), format="json").json()["id"]
        code = self.client.get(f"{self.URL}{pid}/export/").json()
        self.assertEqual(code["steps"][0], {"target": "Plan VNets", "stop_on_failure": True,
                                            "wait_for_result": False, "timeout_minutes": 30})
        self.assertEqual(code["roles"], ["Router"])
        code["name"] = "Router copy"
        r = self.client.post(f"{self.URL}import/", code, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()["steps"]), 3)
        code["description"] = "updated"
        r = self.client.post(f"{self.URL}import/", code, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["description"], "updated")
        self.assertEqual(DeployPipeline.objects.filter(tenant=self.tenant).count(), 2)

    def test_audited(self):
        from audit.models import ChangeLogEntry

        self.login()
        pid = self.client.post(self.URL, self.body(), format="json").json()["id"]
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=pid).exists())

    def test_list_shows_last_run(self):
        self.login()
        p = self.pipeline((self.t_push, {}))
        run = self.deploy(p)
        row = self.client.get(self.URL).json()["results"][0]
        self.assertEqual(row["last_run"]["id"], str(run.id))
        self.assertEqual(row["last_run"]["status"], "succeeded")

    def test_bulk_deploy(self):
        self.login()
        p = self.pipeline((self.t_push, {}))
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(f"{self.URL}{p.id}/deploy/",
                                 {"device_ids": [str(self.dev.id)]}, format="json")
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(self.posts[0][1]["device_ids"], [str(self.dev.id)])

    def test_pipeline_step_run_is_not_retried_alone(self):
        self.login()
        grant(self.op, self.tenant, "automationtarget", ["change"])
        grant(self.op, self.tenant, "deployrun", ["view", "change"])
        run = self.deploy(self.pipeline((self.t_script, {})))
        self.finish_script(self.step(run, 1).script_run, status="failed", code=1)
        dr = self.step(run, 1)
        self.assertFalse(self.client.get(f"/api/deploy-runs/{dr.id}/").json()["can_retry"])
        self.assertEqual(self.client.post(f"/api/deploy-runs/{dr.id}/retry/").status_code, 400)


class CrossTenantTests(_Base):
    URL = "/api/deploy-pipelines/"

    def setUp(self):
        super().setUp()
        self.their_target = AutomationTarget.objects.create(
            tenant=self.other, name="theirs", kind="webhook",
            base_url="https://them.example/hook",
        )
        self.their_role = DeviceRole.objects.create(tenant=self.other, name="R", slug="r")
        self.their_pipeline = DeployPipeline.objects.create(tenant=self.other, name="P")
        DeployPipelineStep.objects.create(pipeline=self.their_pipeline, order=1,
                                          target=self.their_target)

    def test_foreign_target_is_refused_on_create_and_update(self):
        self.login()
        r = self.client.post(self.URL, {"name": "X", "steps": [
            {"target": str(self.their_target.id)}]}, format="json")
        self.assertEqual(r.status_code, 400)
        p = self.pipeline((self.t_push, {}))
        r = self.client.patch(f"{self.URL}{p.id}/", {"steps": [
            {"target": str(self.their_target.id)}]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(list(p.steps.values_list("target_id", flat=True)), [self.t_push.id])

    def test_serializer_refuses_foreign_target_without_a_request(self):
        from integrations.pipelines_api import DeployPipelineSerializer

        ser = DeployPipelineSerializer(data={"name": "X", "steps": [
            {"target": str(self.their_target.id)}]}, context={"tenant": self.tenant})
        self.assertFalse(ser.is_valid())
        self.assertIn("steps", ser.errors)

    def test_foreign_role_is_refused(self):
        self.login()
        r = self.client.post(self.URL, {"name": "X", "roles": [str(self.their_role.id)],
                                        "steps": [{"target": str(self.t_push.id)}]},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_import_resolves_names_in_this_tenant_only(self):
        self.login()
        r = self.client.post(f"{self.URL}import/", {"name": "X", "steps": [
            {"target": "theirs"}]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{self.URL}import/", {"name": "X", "roles": ["R"], "steps": [
            {"target": "Push config"}]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_foreign_pipeline_cannot_be_deployed_or_seen(self):
        self.login()
        r = self.client.post(f"/api/devices/{self.dev.id}/deploy/",
                             {"pipeline_id": str(self.their_pipeline.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(f"{self.URL}{self.their_pipeline.id}/").status_code,
                         404)
        self.assertEqual(self.client.post(
            f"{self.URL}{self.their_pipeline.id}/deploy/",
            {"device_ids": [str(self.dev.id)]}, format="json").status_code, 404)

    def test_bulk_deploy_drops_foreign_devices(self):
        their_site = Site.objects.create(tenant=self.other, name="X")
        mfr = Manufacturer.objects.create(tenant=self.other, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.other, manufacturer=mfr, model="X")
        theirs = Device.objects.create(tenant=self.other, name="x", device_type=dt,
                                       site=their_site)
        p = self.pipeline((self.t_push, {}))
        self.login()
        r = self.client.post(f"{self.URL}{p.id}/deploy/", {"device_ids": [str(theirs.id)]},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_runs_of_another_tenant_are_hidden(self):
        run = DeployPipelineRun.objects.create(tenant=self.other, pipeline=self.their_pipeline,
                                               pipeline_name="P", object_ids=[])
        self.login()
        self.assertEqual(self.client.get("/api/deploy-pipeline-runs/").json()["count"], 0)
        self.assertEqual(self.client.get(f"/api/deploy-pipeline-runs/{run.id}/").status_code,
                         404)
        self.assertEqual(self.client.post(
            f"/api/deploy-pipeline-runs/{run.id}/rerun/").status_code, 404)

    def test_run_does_not_list_foreign_object_names(self):
        their_site = Site.objects.create(tenant=self.other, name="X")
        mfr = Manufacturer.objects.create(tenant=self.other, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.other, manufacturer=mfr, model="X")
        theirs = Device.objects.create(tenant=self.other, name="secret", device_type=dt,
                                       site=their_site)
        p = self.pipeline((self.t_push, {}))
        run = DeployPipelineRun.objects.create(tenant=self.tenant, pipeline=p,
                                               pipeline_name="Router",
                                               object_ids=[str(theirs.id)])
        self.login()
        self.assertEqual(self.client.get(f"/api/deploy-pipeline-runs/{run.id}/").json()
                         ["objects"], [])
        P.advance(run.id)
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertEqual(self.posts, [])


class CallbackLogTests(_Base):
    def setUp(self):
        super().setUp()
        self.dr = DeployRun.objects.create(
            tenant=self.tenant, target=self.t_apply, target_name="Apply VNets",
            device_ids=["d1"], status="launched",
        )

    def test_progress_needs_the_signature(self):
        r = self.callback(self.dr, {"status": "running", "log": ["x"]}, secret="wrong")
        self.assertEqual(r.status_code, 403)
        self.dr.refresh_from_db()
        self.assertEqual(self.dr.log, "")

    def test_log_must_be_strings(self):
        self.assertEqual(self.callback(self.dr, {"status": "running", "log": [1]}).status_code,
                         400)

    def test_final_run_takes_no_lines(self):
        self.callback(self.dr, {"status": "succeeded", "log": ["a"]})
        r = self.callback(self.dr, {"status": "running", "log": ["b"]})
        self.assertEqual(r.status_code, 409)
        self.dr.refresh_from_db()
        self.assertEqual(self.dr.log, "a\n")

    def test_log_is_capped_and_append_only(self):
        big = "x" * 1000
        text = append_log("", [big] * (LOG_LIMIT // 1001 + 10))
        self.assertLessEqual(len(text), LOG_LIMIT + len(LOG_TRUNCATED) + 1)
        self.assertTrue(text.endswith(LOG_TRUNCATED + "\n"))
        self.assertEqual(append_log(text, ["more"]), text)
        self.assertEqual(append_log("a\n", ["b"]), "a\nb\n")
