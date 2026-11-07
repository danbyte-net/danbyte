"""Danbyte scripts as deploy targets, and a deploy run's final status.

A ``script`` automation target runs one of the tenant's scripts instead of
calling out to a runner. The deploy creates a :class:`scripting.ScriptRun`
with the deployed ids as its ``device_ids`` parameter and links it on the
:class:`DeployRun`; when the script run ends, the deploy run becomes
``succeeded`` or ``failed`` with the tail of the log as its detail.

Who a script runs as follows the script's own ``run_as``: ``caller`` is the
person who pressed Deploy (or the author of the change, for an automatic
deploy), ``owner`` its owner. Whoever starts it must hold ``run`` on the
script, and ``trust`` as well when the script is trusted - checked when the
target is saved and again when the deploy is dispatched, so a target never
lets anyone start code they could not start themselves.

Runners that are not scripts (a webhook) can report the outcome back with a
signed POST to ``/api/deploy-runs/<id>/result/``; see :class:`DeployResultView`.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from contextvars import ContextVar
from dataclasses import dataclass

from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger("danbyte.deploy")

#: The parameter a target script must declare: the ids being deployed.
DEVICE_IDS_PARAM = "device_ids"
DETAIL_LIMIT = 2000
LOG_TAIL = 1500


@dataclass
class DispatchContext:
    """What the dispatch knows beyond (target, payload, event): the deploy
    run being dispatched and the user who started it."""

    run: object | None = None
    user: object | None = None
    #: The ids being deployed and what they are, before the target's extra
    #: vars are merged into the payload.
    device_ids: list | None = None
    object_type: str | None = None


#: Set by ``dispatch_deploy`` around the provider call. Providers keep the
#: plain ``run(target, payload, event)`` signature; the script provider
#: reads the run and the user from here.
current_dispatch: ContextVar[DispatchContext | None] = ContextVar(
    "deploy_dispatch", default=None
)


# ── checks shared by the serializer and the dispatch ─────────────────────────


def declares_device_ids(script) -> bool:
    return any(
        isinstance(p, dict) and p.get("name") == DEVICE_IDS_PARAM
        for p in (script.params_schema or [])
    )


def may_start(user, script) -> str | None:
    """Why ``user`` may not start ``script`` from a deploy, or ``None``.
    The same rights as pressing Run on the script itself, plus ``trust``
    for a trusted script."""
    from auth_api import rbac
    from scripting.visibility import can_see

    if user is None or not getattr(user, "is_active", False):
        return "There is no active user to start this script."
    tenant = script.tenant
    if not can_see(script, user):
        return f"{user.get_username()} cannot see this script."
    if not rbac.can_act_on(user, tenant, "script", "run", script):
        return f"{user.get_username()} may not run this script."
    if script.trusted and not rbac.can_act_on(user, tenant, "script", "trust", script):
        return "This script is trusted. Only someone with trust on it can start it from a deploy."
    return None


# ── the provider ─────────────────────────────────────────────────────────────


def script_provider(target, payload, event):
    """Start the target's script with the deployed ids. Returns
    ``("launched", "Script run <id> queued.")`` or ``("failed", why)``."""
    from scripting.runner import create_run, enqueue

    ctx = current_dispatch.get() or DispatchContext()
    script = target.script
    if script is None:
        return "failed", "No script is set on this target."
    if script.tenant_id != target.tenant_id:
        return "failed", "The script belongs to another tenant."
    if not script.enabled:
        return "failed", f"The script {script.name} is disabled."
    if not declares_device_ids(script):
        return "failed", f"The script {script.name} does not declare a device_ids parameter."

    actor = ctx.user
    if script.run_as == "owner":
        if script.owner_id is None:
            return "failed", "This script runs as its owner and has no owner."
        principal = actor or script.owner
    else:
        if actor is None:
            return "failed", (
                "This script runs as the person who deploys, and this deploy has no user."
            )
        principal = actor
    why = may_start(principal, script)
    if why:
        return "failed", why

    params = {
        **(target.extra_vars or {}),
        DEVICE_IDS_PARAM: list(
            ctx.device_ids if ctx.device_ids is not None else payload.get("device_ids") or []
        ),
        "event": event,
        "object_type": ctx.object_type or payload.get("object_type") or "device",
    }
    sr = create_run(script, user=actor, params=params)
    if ctx.run is not None:
        # Linked before the run can start, so its end always finds the deploy.
        type(ctx.run).objects.filter(pk=ctx.run.pk).update(script_run=sr)
        ctx.run.script_run = sr
    enqueue(sr)
    return "launched", f"Script run {sr.id} queued."


# ── final status ─────────────────────────────────────────────────────────────


def finalise(run_id, status: str, detail: str) -> bool:
    """Give a deploy run its outcome. Only a run not yet final changes, and
    only once: the update is conditional, so a second report is a no-op."""
    from .models import DeployRun

    changed = DeployRun.objects.filter(
        pk=run_id, status__in=("queued", "launched")
    ).update(status=status, detail=(detail or "")[:DETAIL_LIMIT], finished_at=timezone.now())
    return bool(changed)


def _log_tail(sr) -> str:
    text = (sr.log or "").rstrip()
    tail = text[-LOG_TAIL:]
    if len(text) > LOG_TAIL:
        tail = "…" + tail
    head = f"Script run {sr.status}"
    if sr.exit_code is not None:
        head += f" (exit {sr.exit_code})"
    if sr.error:
        head += f": {sr.error}"
    return f"{head}.\n{tail}" if tail else f"{head}."


def on_script_run_finished(sender, run, **kwargs) -> None:
    """``scripting.runner.run_finished`` receiver: close every deploy run
    this script run was started for."""
    from .models import DeployRun

    status = "succeeded" if run.status == "success" and (run.exit_code in (0, None)) else "failed"
    detail = _log_tail(run)
    for pk in DeployRun.objects.filter(script_run=run).values_list("pk", flat=True):
        finalise(pk, status, detail)


def connect() -> None:
    from scripting.runner import run_finished

    run_finished.connect(on_script_run_finished, dispatch_uid="deploy_script_run_finished")


# ── result callback for webhook runners ──────────────────────────────────────

SIGNATURE_HEADER = "HTTP_X_DANBYTE_SIGNATURE"
CALLBACK_KINDS = ("webhook",)
MAX_BODY = 64 * 1024


def sign(secret: str, body: bytes) -> str:
    """The outbound scheme: ``sha512=<hex HMAC-SHA512 of the raw body>``."""
    return "sha512=" + hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()


def verify(secret: str, body: bytes, header: str) -> bool:
    if not secret or not header:
        return False
    return hmac.compare_digest(sign(secret, body), header.strip())


class DeployResultView(APIView):
    """POST ``/api/deploy-runs/<id>/result/`` - a webhook runner reports how
    the deploy went. Unauthenticated by session or token on purpose: the
    ``X-Danbyte-Signature`` header (HMAC-SHA512 of the raw body with the
    target's secret, the same scheme Danbyte signs its own deliveries with)
    is the credential. Body ``{"status": "succeeded"|"failed", "detail": ""}``.

    Only a run in ``launched`` can be finalised; once final it never
    changes, so a replayed callback cannot rewrite it. Every refusal before
    the signature check answers the same 403, so the route tells an outsider
    nothing about which run ids exist.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request, run_id=None):
        from .models import DeployRun

        body = request.body or b""
        if len(body) > MAX_BODY:
            return Response({"detail": "Body too large."}, status=413)
        run = DeployRun.objects.select_related("target", "tenant").filter(pk=run_id).first()
        target = run.target if run is not None else None
        if (
            target is None
            or target.tenant_id != run.tenant_id
            or not run.tenant.is_active
            or target.kind not in CALLBACK_KINDS
            or not verify(target.token or "", body, request.META.get(SIGNATURE_HEADER, ""))
        ):
            return Response({"detail": "Invalid signature."}, status=403)
        try:
            data = json.loads(body.decode() or "{}")
        except (UnicodeDecodeError, ValueError):
            return Response({"detail": "Body is not JSON."}, status=400)
        if not isinstance(data, dict):
            return Response({"detail": "Body must be a JSON object."}, status=400)
        status = data.get("status")
        if status not in DeployRun.FINAL_STATUSES:
            return Response({"status": ["One of succeeded, failed."]}, status=400)
        detail = data.get("detail", "")
        if not isinstance(detail, str):
            return Response({"detail": ["A string."]}, status=400)
        changed = DeployRun.objects.filter(pk=run.pk, status="launched").update(
            status=status, detail=detail[:DETAIL_LIMIT], finished_at=timezone.now(),
        )
        if not changed:
            current = DeployRun.objects.filter(pk=run.pk).values_list("status", flat=True).first()
            return Response(
                {"detail": f"This run is {current}; only a launched run can be finalised."},
                status=409,
            )
        return Response({"id": str(run.pk), "status": status})
