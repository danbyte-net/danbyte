"""Deploy dispatch — launch an AWX/AAP job template, or POST a signed payload to
a generic webhook. Runs on the RQ low queue; records a DeployRun. All failures
are contained so a deploy problem never breaks the originating request/save.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid

from core.ssrf import safe_get, safe_post, safe_request  # SSRF-guarded outbound

logger = logging.getLogger("danbyte.deploy")


def _device_payload(tenant, device_ids):
    """A small, stable payload describing what to deploy."""
    return {
        "tenant": tenant.slug,
        "device_ids": [str(d) for d in device_ids],
        "limit": ",".join(str(d) for d in device_ids),
    }


def dispatch_deploy(target_id, device_ids, event="manual", run_id=None):
    """Fire the target. Returns a small result dict and updates the DeployRun."""
    import requests

    from .models import AutomationTarget, DeployRun

    target = AutomationTarget.objects.select_related("tenant").filter(
        id=target_id
    ).first()
    run = DeployRun.objects.filter(id=run_id).first() if run_id else None

    def finish(status, detail):
        if run is not None:
            from django.utils import timezone

            run.status = status
            run.detail = detail[:2000]
            run.finished_at = timezone.now()
            run.save(update_fields=["status", "detail", "finished_at"])
        return {"ok": status == "launched", "status": status, "detail": detail}

    if target is None or not target.enabled:
        return finish("failed", "Target missing or disabled.")

    payload = {**_device_payload(target.tenant, device_ids), "event": event}
    payload.update(target.extra_vars or {})

    try:
        if target.kind == "awx":
            if not target.job_template_id:
                return finish("failed", "No job_template_id set.")
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
                return finish("launched", f"AWX job launched{job}.")
            return finish("failed", f"AWX returned {resp.status_code}: {resp.text[:300]}")

        # generic webhook
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
            return finish("launched", f"Webhook accepted ({resp.status_code}).")
        return finish("failed", f"Webhook returned {resp.status_code}.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("deploy dispatch error (%s): %s", target.name, exc)
        return finish("failed", str(exc))


def enqueue_deploy(target, device_ids, *, event="manual", attempt=1, retry_of=None):
    """Create a DeployRun and enqueue the dispatch on the low queue. Returns the
    run (so the API can report it). ``attempt``/``retry_of`` link a re-dispatch
    back to the run it retries. Never raises."""
    from .models import DeployRun

    run = DeployRun.objects.create(
        tenant=target.tenant, target=target, target_name=target.name,
        event=event, device_ids=[str(d) for d in device_ids], status="queued",
        attempt=attempt, retry_of=retry_of,
    )
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(
            dispatch_deploy, str(target.id), [str(d) for d in device_ids],
            event=event, run_id=str(run.id),
        )
    except Exception:  # noqa: BLE001
        # Redis down etc. — run dispatch inline so the deploy still happens.
        try:
            dispatch_deploy(str(target.id), [str(d) for d in device_ids],
                            event=event, run_id=str(run.id))
        except Exception:  # noqa: BLE001
            logger.exception("inline deploy dispatch failed")
    return run


# ─── auto-dispatch on change (P2.5) ──────────────────────────────────────────
# Opt-in: an AutomationTarget with auto_on_change=True fires a deploy whenever a
# matching object in its tenant is saved. Best-effort — wrapped so a deploy (or a
# down Redis) can never break the originating save, exactly like webhooks.


def _slug_for(instance):
    from auth_api.object_types import slug_for_model

    try:
        return slug_for_model(type(instance))
    except Exception:  # noqa: BLE001
        return None


def _target_covers(target, slug: str) -> bool:
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
            if _target_covers(t, slug)
        ]
        if not targets:
            return
        object_id = getattr(instance, "pk", None)
        if object_id is None:
            return
        for t in targets:
            enqueue_deploy(t, [object_id], event="auto")
    except Exception:  # noqa: BLE001 — never break the originating save
        logger.exception("auto-deploy dispatch failed")


def _on_auto_save(sender, instance, created, **kwargs):
    auto_fire(instance)


def connect() -> None:
    """Connect post_save for every tenant-scoped registered object type that an
    AutomationTarget could plausibly deploy. Targets self-filter via
    object_types; today only `device` is meaningful, but wiring the whole
    registry keeps it future-proof and cheap (the filter short-circuits)."""
    from django.db.models.signals import post_save

    from auth_api.object_types import _registry
    from .models import AutomationTarget, DeployRun, Webhook

    skip = {AutomationTarget, DeployRun, Webhook}
    for slug, entry in _registry().items():
        model = entry["model"]
        if model in skip:
            continue
        if not any(f.name == "tenant" for f in model._meta.concrete_fields):
            continue
        post_save.connect(
            _on_auto_save, sender=model, dispatch_uid=f"autodeploy_save_{slug}"
        )
