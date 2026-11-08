"""Deploy dispatch - launch an AWX/AAP job template, or POST a signed payload to
a generic webhook. Runs on the RQ low queue; records a DeployRun. All failures
are contained so a deploy problem never breaks the originating request/save.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid

from django.db import transaction

from core.ssrf import safe_get, safe_post, safe_request  # SSRF-guarded outbound

logger = logging.getLogger("danbyte.deploy")


def _device_payload(tenant, device_ids):
    """A small, stable payload describing what to deploy."""
    return {
        "tenant": tenant.slug,
        "device_ids": [str(d) for d in device_ids],
        "limit": ",".join(str(d) for d in device_ids),
    }


# ── built-in automation providers ────────────────────────────────────────────
# Each is run(target, payload, event) -> (status, detail). Registered below so a
# plugin can add more (or override) via integrations.providers.


def _awx_provider(target, payload, event):
    if not target.job_template_id:
        return "failed", "No job_template_id set."
    url = (
        target.base_url.rstrip("/")
        + f"/api/v2/job_templates/{target.job_template_id}/launch/"
    )
    resp = safe_post(
        url,
        json={"extra_vars": payload},
        headers={"Authorization": f"Bearer {target.token or ''}"},
        timeout=15,
        verify=target.ssl_verify,
    )
    if resp.status_code in (200, 201, 202):
        job = ""
        try:
            job = f" (job {resp.json().get('id')})"
        except Exception:  # noqa: BLE001
            pass
        return "launched", f"AWX job launched{job}."
    return "failed", f"AWX returned {resp.status_code}: {resp.text[:300]}"


def _webhook_provider(target, payload, event):
    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "X-Danbyte-Event": f"deploy.{event}",
        "X-Danbyte-Delivery": str(uuid.uuid4()),
    }
    if target.token:
        sig = hmac.new(target.token.encode(), body, hashlib.sha512).hexdigest()
        headers["X-Danbyte-Signature"] = f"sha512={sig}"
    resp = safe_post(
        target.base_url, data=body, headers=headers, timeout=15,
        verify=target.ssl_verify,
    )
    if 200 <= resp.status_code < 300:
        return "launched", f"Webhook accepted ({resp.status_code})."
    return "failed", f"Webhook returned {resp.status_code}."


def _register_builtin_providers():
    from .providers import register_automation_provider
    from .script_targets import script_provider

    register_automation_provider("awx", _awx_provider)
    register_automation_provider("webhook", _webhook_provider)
    register_automation_provider("script", script_provider)


_register_builtin_providers()


def _vm_payload(tenant, vm_ids):
    """The provision payload: the intended VMs' build specs, re-read now.

    Ids are re-filtered to the target's tenant and to VMs still intended -
    the job runs later than the request, and a VM can be moved, deleted or
    un-ticked in between. ``device_ids``/``limit`` carry the VM ids too, for
    runners that only read those keys; ``object_type`` says what they are.
    """
    from api.models import VirtualMachine
    from api.vm_build import vm_build_spec

    vms = list(
        VirtualMachine.objects.filter(tenant=tenant, intended=True, id__in=vm_ids)
        .select_related("cluster", "device", "represents_device")
        .order_by("name")
    )
    ids = [str(v.id) for v in vms]
    return {
        "tenant": tenant.slug,
        "device_ids": ids,
        "limit": ",".join(ids),
        "object_type": "virtualmachine",
        "object_ids": ids,
        "represents_device_ids": [
            str(v.represents_device_id) for v in vms if v.represents_device_id
        ],
        "virtual_machines": [vm_build_spec(v) for v in vms],
    }


def _dispatch_user(user_id):
    """The user who started the deploy, re-read now: one deactivated since
    the enqueue starts nothing."""
    if not user_id:
        return None
    from django.contrib.auth import get_user_model

    return get_user_model().objects.filter(pk=user_id, is_active=True).first()


def dispatch_deploy(target_id, device_ids, event="manual", run_id=None,
                    object_type="device", user_id=None, pipeline=None, dry_run=False):
    """Fire the target. Returns a small result dict and updates the DeployRun.
    ``user_id`` is who started the deploy (Deploy pressed, or the change's
    author); a script target runs as them when the script runs as its caller.
    ``pipeline`` is the step context of a pipeline run (``pipeline_run_id``,
    ``step``, ``dry_run``, ``steps``), added to the payload after the target's
    extra vars so a target cannot override it. ``dry_run`` asks a single
    target deploy to only report what it would do."""
    from .models import AutomationTarget, DeployRun
    from .script_targets import DispatchContext, current_dispatch

    target = AutomationTarget.objects.select_related("tenant").filter(
        id=target_id
    ).first()
    run = DeployRun.objects.filter(id=run_id).first() if run_id else None

    def finish(status, detail):
        if run is not None:
            from django.utils import timezone

            # Conditional: a script started by this dispatch may already have
            # finished (inline, or on another worker) and set the final status.
            DeployRun.objects.filter(pk=run.pk, status="queued").update(
                status=status, detail=detail[:2000], finished_at=timezone.now(),
            )
        return {"ok": status == "launched", "status": status, "detail": detail}

    if target is None or not target.enabled:
        return finish("failed", "Target missing or disabled.")

    if object_type == "virtualmachine":
        base = _vm_payload(target.tenant, device_ids)
        if not base["object_ids"]:
            return finish(
                "failed", "No intended virtual machine of this tenant is left to provision."
            )
    else:
        base = _device_payload(target.tenant, device_ids)
    payload = {**base, "event": event}
    if run is not None:
        # So a webhook runner can report the outcome to
        # /api/deploy-runs/<run_id>/result/.
        payload["run_id"] = str(run.id)
    payload.update(target.extra_vars or {})
    if pipeline:
        payload.update(pipeline)
    elif dry_run:
        payload["dry_run"] = True

    # Select the provider by kind; an unknown kind degrades to the generic
    # webhook rather than crashing (plugins register their own via
    # integrations.providers.register_automation_provider).
    from .providers import automation_provider

    provider = automation_provider(target.kind) or automation_provider("webhook")

    token = current_dispatch.set(DispatchContext(
        run=run, user=_dispatch_user(user_id), device_ids=list(base["device_ids"]),
        object_type=base.get("object_type") or "device",
        pipeline=pipeline or ({"dry_run": True} if dry_run else None),
    ))
    try:
        status, detail = provider(target, payload, event)
        return finish(status, detail)
    except Exception as exc:  # noqa: BLE001
        logger.warning("deploy dispatch error (%s): %s", target.name, exc)
        return finish("failed", str(exc))
    finally:
        current_dispatch.reset(token)


def enqueue_deploy(target, device_ids, *, event="manual", attempt=1, retry_of=None,
                   object_type="device", user=None, dry_run=False):
    """Create a DeployRun and enqueue the dispatch on the low queue. Returns the
    run (so the API can report it). ``attempt``/``retry_of`` link a re-dispatch
    back to the run it retries. ``object_type`` names what the ids are
    (``virtualmachine`` for a provision). ``user`` started the deploy. Never
    raises."""
    from .models import DeployRun

    user_id = str(user.pk) if getattr(user, "is_authenticated", False) else None

    run = DeployRun.objects.create(
        tenant=target.tenant, target=target, target_name=target.name,
        event=event, device_ids=[str(d) for d in device_ids], status="queued",
        attempt=attempt, retry_of=retry_of, object_type=object_type, dry_run=bool(dry_run),
    )
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(
            dispatch_deploy, str(target.id), [str(d) for d in device_ids],
            event=event, run_id=str(run.id), object_type=object_type, user_id=user_id,
            dry_run=bool(dry_run),
        )
    except Exception:  # noqa: BLE001
        # Redis down etc. - run dispatch inline so the deploy still happens.
        try:
            dispatch_deploy(str(target.id), [str(d) for d in device_ids],
                            event=event, run_id=str(run.id), object_type=object_type,
                            user_id=user_id, dry_run=bool(dry_run))
        except Exception:  # noqa: BLE001
            logger.exception("inline deploy dispatch failed")
    return run


# ─── auto-dispatch on change (P2.5) ──────────────────────────────────────────
# Opt-in: an AutomationTarget with auto_on_change=True fires a deploy whenever a
# matching object in its tenant is saved. Best-effort - wrapped so a deploy (or a
# down Redis) can never break the originating save, exactly like webhooks.


def _slug_for(instance):
    from auth_api.object_types import slug_for_model

    try:
        return slug_for_model(type(instance))
    except Exception:  # noqa: BLE001
        return None


def target_covers(target, slug: str) -> bool:
    """object_types defaults to [device] when unset."""
    types = target.object_types or ["device"]
    return "*" in types or slug in types


def auto_fire(instance, slug: str | None = None) -> None:
    """Find auto_on_change targets for the instance's tenant + object type and
    enqueue a deploy for that single object. Never raises."""
    try:
        tenant_id = getattr(instance, "tenant_id", None)
        if tenant_id is None:
            return
        slug = slug or _slug_for(instance)
        if not slug:
            return
        from .models import AutomationTarget

        targets = [
            t
            for t in AutomationTarget.objects.filter(
                tenant_id=tenant_id, enabled=True, auto_on_change=True
            )
            if target_covers(t, slug)
        ]
        from .pipelines import auto_pipelines

        pipelines = auto_pipelines(tenant_id, slug)
        if not targets and not pipelines:
            return
        object_id = getattr(instance, "pk", None)
        if object_id is None:
            return
        from audit.context import current_user

        # The change's author: a script target that runs as its caller runs
        # as them. Read now - the commit hook may run outside the request.
        author = current_user()
        # After commit (#357): a rolled-back change must not be pushed to a
        # device, and the job must read the change as saved.
        transaction.on_commit(
            lambda: _auto_enqueue(targets, object_id, author, pipelines, slug)
        )
    except Exception:  # noqa: BLE001 - never break the originating save
        logger.exception("auto-deploy dispatch failed")


def _auto_enqueue(targets, object_id, author=None, pipelines=(), slug="device") -> None:
    for t in targets:
        try:
            enqueue_deploy(t, [object_id], event="auto", user=author)
        except Exception:  # noqa: BLE001
            logger.exception("auto-deploy dispatch failed (%s)", t.name)
    from .pipelines import start

    for p in pipelines:
        try:
            start(p, [object_id], object_type=slug, trigger="on_change", user=author)
        except Exception:  # noqa: BLE001
            logger.exception("auto-deploy pipeline failed (%s)", p.name)


def _on_auto_save(sender, instance, created, **kwargs):
    auto_fire(instance)


def connect() -> None:
    """Connect post_save for every tenant-scoped registered object type that an
    AutomationTarget could plausibly deploy. Targets self-filter via
    object_types; today only `device` is meaningful, but wiring the whole
    registry keeps it future-proof and cheap (the filter short-circuits)."""
    from django.db.models.signals import post_save

    from auth_api.object_types import _registry

    from .models import (
        AutomationTarget,
        DeployPipeline,
        DeployPipelineRun,
        DeployPipelineStep,
        DeployRun,
        Webhook,
    )

    skip = {AutomationTarget, DeployRun, Webhook, DeployPipeline, DeployPipelineRun,
            DeployPipelineStep}
    for slug, entry in _registry().items():
        model = entry["model"]
        if model in skip:
            continue
        if not any(f.name == "tenant" for f in model._meta.concrete_fields):
            continue
        post_save.connect(
            _on_auto_save, sender=model, dispatch_uid=f"autodeploy_save_{slug}"
        )
