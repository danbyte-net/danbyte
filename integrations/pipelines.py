"""Deploy pipelines: several automation targets run in order for the same
objects.

A :class:`DeployPipelineRun` snapshots the pipeline's steps when it starts.
Step N+1 starts only once step N has a final status. There is no polling
loop: :func:`advance` runs on the RQ ``low`` queue and is re-enqueued from
the points where a step can become final:

* the dispatch itself - a webhook/AWX step that does not wait for a result
  is done once it is launched (or failed);
* ``scripting.runner.run_finished`` - a script step is done when its script
  run ends (``script_targets.on_script_run_finished``);
* the signed result callback (``DeployResultView``) - a step that waits for
  its result;
* the timeout sweep (:func:`sweep_timeouts`, the ``sweep_deploy_pipelines``
  command on the scripts tick) - a waiting step past its deadline fails.

A failed step with ``stop_on_failure`` fails the run; the steps after it are
never started and show as skipped. Every advance re-checks that the tenant
is active, the pipeline still exists and is enabled, the user who started it
is still active and may still see the objects, and that each step's target
belongs to the run's tenant.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("danbyte.deploy")

#: The kinds that can report a result back through the signed callback.
WAITABLE_KINDS = ("webhook",)


# ── what a step is ───────────────────────────────────────────────────────────


def snapshot_steps(pipeline) -> list[dict]:
    return [
        {
            "target": str(s.target_id),
            "target_name": s.target.name,
            "kind": s.target.kind,
            "stop_on_failure": s.stop_on_failure,
            "wait_for_result": bool(s.wait_for_result and s.target.kind in WAITABLE_KINDS),
            "timeout_minutes": s.timeout_minutes,
        }
        for s in pipeline.steps.select_related("target").order_by("order")
    ]


def step_done(step: dict, dr) -> bool:
    """Whether a step's deploy run has its outcome as far as the pipeline is
    concerned."""
    if dr.status in ("succeeded", "failed"):
        return True
    if dr.status == "launched":
        # A script step ends with its script run; a waiting step with its
        # callback (or its deadline). Anything else is done once launched.
        return step.get("kind") != "script" and not dr.wait_for_result
    return False


def step_status(step: dict, dr, run) -> str:
    """The status a step shows: its deploy run's, or pending/skipped for a
    step that never started."""
    if dr is None:
        if run.status == "cancelled":
            return "cancelled"
        return "skipped" if run.status in run.FINAL_STATUSES else "pending"
    if dr.status == "launched":
        return "succeeded" if step_done(step, dr) else "running"
    if dr.status == "queued":
        return "running" if run.status not in run.FINAL_STATUSES else dr.status
    return dr.status


def output_url(script_run_id, output_id) -> str:
    """The script-run output download route (``scripting.api_views``)."""
    return f"/api/scripts/runs/{script_run_id}/outputs/{output_id}/download/"


def earlier_steps(run, upto: int) -> list[dict]:
    """``[{target, status, script_run_id, outputs:[{name,url}]}]`` for the
    steps before ``upto`` (1-based), as the next step receives them."""
    from .models import DeployRun

    runs = {
        dr.pipeline_step: dr
        for dr in DeployRun.objects.filter(pipeline_run=run, pipeline_step__lt=upto)
        .select_related("script_run").prefetch_related("script_run__outputs")
    }
    out = []
    for i, step in enumerate(run.steps[: max(upto - 1, 0)], start=1):
        dr = runs.get(i)
        sr = dr.script_run if dr is not None else None
        out.append({
            "step": i,
            "target": step.get("target_name", ""),
            "status": step_status(step, dr, run),
            "script_run_id": str(sr.id) if sr is not None else None,
            "outputs": [
                {"name": o.name, "url": output_url(sr.id, o.id)}
                for o in sorted(sr.outputs.all(), key=lambda o: o.name)
            ] if sr is not None else [],
        })
    return out


def step_context(run, step_no: int) -> dict:
    """The keys a step's payload (and a script step's params) gain."""
    return {
        "pipeline_run_id": str(run.id),
        "pipeline": run.pipeline_name,
        "step": step_no,
        "dry_run": bool(run.dry_run),
        "steps": earlier_steps(run, step_no),
    }


# ── starting a run ───────────────────────────────────────────────────────────


def pipeline_covers(pipeline, slug: str) -> bool:
    types = pipeline.object_types or ["device"]
    return "*" in types or slug in types


def start(pipeline, object_ids, *, object_type="device", trigger="deploy", user=None,
          dry_run=False, rerun_of=None):
    """Create a run and enqueue its first advance. Returns the run."""
    from .models import DeployPipelineRun

    authed = getattr(user, "is_authenticated", False)
    run = DeployPipelineRun.objects.create(
        tenant=pipeline.tenant, pipeline=pipeline, pipeline_name=pipeline.name,
        object_type=object_type, object_ids=[str(i) for i in object_ids],
        trigger=trigger, rerun_of=rerun_of, triggered_by=user if authed else None,
        dry_run=bool(dry_run), steps=snapshot_steps(pipeline),
    )
    enqueue_advance(run.id)
    return run


def enqueue_advance(run_id) -> None:
    """Advance the run on the low queue once the current transaction
    commits; inline when Redis is down. Never raises."""

    def go():
        try:
            import django_rq

            django_rq.get_queue("low").enqueue(advance, str(run_id))
        except Exception:  # noqa: BLE001 - Redis down: advance inline
            try:
                advance(str(run_id))
            except Exception:  # noqa: BLE001
                logger.exception("pipeline advance failed (%s)", run_id)

    transaction.on_commit(go)


# ── the re-checks ────────────────────────────────────────────────────────────


def _user(run):
    if run.triggered_by_id is None:
        return None
    from django.contrib.auth import get_user_model

    return get_user_model().objects.filter(pk=run.triggered_by_id, is_active=True).first()


def allowed_object_ids(run, user) -> list[str]:
    """The run's objects still in its tenant and, when a person started it,
    still visible to them (the same scope the deploy endpoints check)."""
    from api.models import Device, VirtualMachine
    from auth_api import rbac

    if run.object_type == "virtualmachine":
        qs = VirtualMachine.objects.filter(
            tenant_id=run.tenant_id, intended=True, id__in=run.object_ids
        )
        slug, action = "virtualmachine", "provision"
    else:
        qs = Device.objects.filter(tenant_id=run.tenant_id, id__in=run.object_ids)
        slug, action = "device", "view"
    if user is not None:
        qs = rbac.restrict_queryset(qs, user, run.tenant, slug, action)
    found = {str(i) for i in qs.values_list("id", flat=True)}
    return [i for i in run.object_ids if i in found]


def recheck(run) -> tuple[str | None, object, list[str]]:
    """``(why_not, user, object_ids)`` - why the run may not go on, or None."""
    if not run.tenant.is_active:
        return "The tenant is inactive.", None, []
    p = run.pipeline
    if p is None or p.tenant_id != run.tenant_id:
        return "The pipeline was deleted.", None, []
    if not p.enabled:
        return f"The pipeline {p.name} is disabled.", None, []
    user = None
    if run.triggered_by_id is not None:
        user = _user(run)
        if user is None:
            return "The user who started this run is no longer active.", None, []
    ids = allowed_object_ids(run, user)
    if not ids:
        return "None of the objects is left to deploy.", user, []
    return None, user, ids


# ── advancing ────────────────────────────────────────────────────────────────


def _close(run, status: str, detail: str = "") -> None:
    from .models import DeployPipelineRun

    DeployPipelineRun.objects.filter(
        pk=run.pk, status__in=("queued", "running")
    ).update(status=status, detail=(detail or "")[:2000], finished_at=timezone.now())


def advance(run_id) -> str | None:
    """Move a run on: start the next step, or close the run. Safe to call any
    number of times; the row lock keeps two workers from starting the same
    step. Returns the run's status."""
    from .dispatch import dispatch_deploy
    from .models import AutomationTarget, DeployPipelineRun, DeployRun

    for _ in range(64):  # a step done at launch moves straight on; bounded
        with transaction.atomic():
            run = (
                DeployPipelineRun.objects.select_for_update(of=("self",))
                .select_related("tenant", "pipeline").filter(pk=run_id).first()
            )
            if run is None:
                return None
            if run.status in run.FINAL_STATUSES:
                return run.status
            why, user, ids = recheck(run)
            if why:
                _close(run, "failed", why)
                return "failed"
            runs = {dr.pipeline_step: dr for dr in DeployRun.objects.filter(pipeline_run=run)}
            failed = False
            nxt = None
            for no, step in enumerate(run.steps, start=1):
                dr = runs.get(no)
                if dr is None:
                    nxt = (no, step)
                    break
                if not step_done(step, dr):
                    return run.status  # in flight; its completion advances us
                if dr.status == "failed":
                    failed = True
                    if step.get("stop_on_failure", True):
                        _close(run, "failed", f"Step {no} {step.get('target_name')} failed.")
                        return "failed"
            if nxt is None:
                if failed:
                    _close(run, "failed", "A step failed.")
                    return "failed"
                _close(run, "succeeded")
                return "succeeded"
            no, step = nxt
            target = AutomationTarget.objects.filter(
                pk=step.get("target"), tenant_id=run.tenant_id
            ).first()
            now = timezone.now()
            if run.status == "queued":
                DeployPipelineRun.objects.filter(pk=run.pk).update(
                    status="running", started_at=now
                )
            deadline = None
            if step.get("wait_for_result"):
                deadline = now + timedelta(minutes=int(step.get("timeout_minutes") or 30))
            dr = DeployRun.objects.create(
                tenant=run.tenant, target=target,
                target_name=step.get("target_name") or (target.name if target else ""),
                event=run.event, device_ids=ids, object_type=run.object_type,
                status="queued", pipeline_run=run, pipeline_step=no,
                wait_for_result=bool(step.get("wait_for_result")),
                result_deadline=deadline,
            )
            if target is None:
                DeployRun.objects.filter(pk=dr.pk).update(
                    status="failed", detail="The target is missing or in another tenant.",
                    finished_at=now,
                )
                continue
            context = step_context(run, no)
            user_id = str(user.pk) if user is not None else None
        # Outside the lock: the dispatch makes an outbound call.
        dispatch_deploy(
            str(target.id), ids, event=run.event, run_id=str(dr.id),
            object_type=run.object_type, user_id=user_id, pipeline=context,
        )
    logger.warning("pipeline run %s: advance gave up after many steps", run_id)
    return None


def on_step_final(deploy_run_ids) -> None:
    """A step's deploy run became final: move its pipeline run on."""
    from .models import DeployRun

    for pr in set(
        DeployRun.objects.filter(pk__in=list(deploy_run_ids), pipeline_run__isnull=False)
        .values_list("pipeline_run_id", flat=True)
    ):
        enqueue_advance(pr)


# ── cancel, timeouts ─────────────────────────────────────────────────────────


def cancel(run) -> bool:
    """Stop a run: no further step starts, a running script run is cancelled
    and a step waiting for its result fails. Returns whether it changed."""
    from scripting.runner import cancel as cancel_script

    from .models import DeployPipelineRun, DeployRun
    from .script_targets import finalise

    changed = DeployPipelineRun.objects.filter(
        pk=run.pk, status__in=("queued", "running")
    ).update(status="cancelled", detail="Cancelled.", finished_at=timezone.now())
    if not changed:
        return False
    for dr in DeployRun.objects.filter(
        pipeline_run=run, status__in=("queued", "launched")
    ).select_related("script_run"):
        if dr.script_run is not None and dr.script_run.active:
            cancel_script(dr.script_run)
        finalise(dr.pk, "failed", "Cancelled with the pipeline run.")
    return True


def sweep_timeouts(now=None) -> int:
    """Fail every waiting step past its deadline and move its run on."""
    from .models import DeployRun
    from .script_targets import finalise

    now = now or timezone.now()
    late = list(
        DeployRun.objects.filter(
            status="launched", wait_for_result=True, result_deadline__lt=now
        ).values_list("pk", "result_deadline", "created_at")
    )
    failed = []
    for pk, deadline, created in late:
        minutes = int(round((deadline - created).total_seconds() / 60))
        if finalise(pk, "failed", f"No result was reported within {minutes} minutes."):
            failed.append(pk)
    if failed:
        on_step_final(failed)
    return len(failed)


# ── on change ────────────────────────────────────────────────────────────────


def auto_pipelines(tenant_id, slug: str) -> list:
    from .models import DeployPipeline

    return [
        p for p in DeployPipeline.objects.filter(
            tenant_id=tenant_id, enabled=True, auto_on_change=True
        ).select_related("tenant")
        if pipeline_covers(p, slug)
    ]
