"""Webhook delivery — signal handlers + the RQ worker that POSTs payloads.

Wiring: ``apps.ready()`` connects ``post_save`` / ``post_delete`` for every
tenant-scoped model in the RBAC object-type registry. On a matching change we
enqueue ``deliver_webhook`` on the ``low`` queue. Everything in the signal path
is wrapped so a webhook problem (or a down Redis) can never break the actual
save — webhooks are best-effort.
"""
from __future__ import annotations

import datetime
import decimal
import hashlib
import hmac
import json
import logging
import uuid

from django.db.models.fields.files import FieldFile
from django.db.models.signals import post_delete, post_save

from core.ssrf import safe_get, safe_post, safe_request  # SSRF-guarded outbound

logger = logging.getLogger("danbyte.webhooks")

_SKIP_FIELDS = {"created_at", "updated_at"}


def _ser(v):
    if isinstance(v, (uuid.UUID, decimal.Decimal)):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, FieldFile):
        return v.name or None
    return v


def _field_dict(instance) -> dict:
    # Never send secrets to an external URL. EncryptedJSONField columns decrypt
    # transparently on read, so a naive getattr() would ship plaintext SNMP
    # creds / API tokens in the webhook payload. Mask via the same classifier
    # the audit trail and exports use (core.secret_fields) — "•••" when set,
    # None when empty, so the payload shows a field changed without its value.
    from core.secret_fields import is_secret_field

    out = {}
    for f in instance._meta.concrete_fields:
        if f.name in _SKIP_FIELDS:
            continue
        if is_secret_field(instance, f):
            out[f.name] = "•••" if getattr(instance, f.attname, None) else None
            continue
        out[f.name] = _ser(getattr(instance, f.attname, None))
    return out


def _slug_for(instance) -> str | None:
    from auth_api.object_types import slug_for_model

    try:
        return slug_for_model(type(instance))
    except Exception:  # noqa: BLE001
        return None


def _fire(instance, event: str) -> None:
    """Find matching webhooks for the instance's tenant and enqueue delivery.

    Best-effort: any failure here is swallowed so the save/delete still
    succeeds.
    """
    try:
        tenant_id = getattr(instance, "tenant_id", None)
        if tenant_id is None:
            return
        slug = _slug_for(instance)
        if not slug:
            return
        from .models import Webhook

        hooks = [
            h
            for h in Webhook.objects.filter(tenant_id=tenant_id, enabled=True)
            if h.matches(slug, event)
        ]
        if not hooks:
            return
        data = _field_dict(instance)
        object_id = str(getattr(instance, "pk", ""))
        import django_rq

        queue = django_rq.get_queue("low")
        for h in hooks:
            queue.enqueue(
                deliver_webhook, str(h.id), event, slug, object_id, data
            )
    except Exception:  # noqa: BLE001 — never break the originating save
        logger.exception("webhook dispatch failed (%s)", event)


def _on_save(sender, instance, created, **kwargs):
    _fire(instance, "created" if created else "updated")


def _on_delete(sender, instance, **kwargs):
    _fire(instance, "deleted")


def connect() -> None:
    """Connect signals for every tenant-scoped registered object type."""
    from auth_api.object_types import _registry

    from .models import Webhook

    for slug, entry in _registry().items():
        model = entry["model"]
        if model is Webhook:
            continue  # don't fire webhooks about webhook config itself
        if not any(f.name == "tenant" for f in model._meta.concrete_fields):
            continue
        post_save.connect(
            _on_save, sender=model, dispatch_uid=f"webhook_save_{slug}"
        )
        post_delete.connect(
            _on_delete, sender=model, dispatch_uid=f"webhook_delete_{slug}"
        )


# ─── delivery (runs on the RQ worker) ────────────────────────────────────────
def build_payload(webhook, event: str, slug: str, object_id: str, data: dict) -> dict:
    return {
        "event": event,
        "model": slug,
        "object_id": object_id,
        "webhook": webhook.name,
        "data": data,
    }


def deliver_webhook(webhook_id, event, slug, object_id, data, *, delivery_id=None):
    """POST the payload to the webhook's URL. Returns a small result dict."""
    import requests

    from .models import Webhook

    hook = Webhook.objects.filter(id=webhook_id).first()
    if hook is None or not hook.enabled:
        return {"ok": False, "error": "webhook missing or disabled"}

    payload = build_payload(hook, event, slug, object_id, data)
    body = json.dumps(payload, default=str).encode()
    delivery_id = delivery_id or str(uuid.uuid4())

    headers = {
        "Content-Type": hook.http_content_type or "application/json",
        "X-Danbyte-Event": event,
        "X-Danbyte-Delivery": delivery_id,
        "User-Agent": "Danbyte-Webhook/1.0",
    }
    # User-supplied headers can't override hop-by-hop / routing-sensitive ones
    # (forging Host/Content-Length/etc. is a request-smuggling / SSRF lever).
    _FORBIDDEN_HEADERS = {
        "host", "content-length", "transfer-encoding", "connection",
        "x-danbyte-signature", "x-danbyte-delivery",
    }
    for line in (hook.additional_headers or "").splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            k = k.strip()
            if k and k.lower() not in _FORBIDDEN_HEADERS:
                headers[k] = v.strip()
    if hook.secret:
        sig = hmac.new(
            hook.secret.encode(), body, hashlib.sha512
        ).hexdigest()
        headers["X-Danbyte-Signature"] = f"sha512={sig}"

    try:
        resp = safe_request(
            hook.http_method or "POST",
            hook.payload_url,
            data=body,
            headers=headers,
            timeout=10,
            verify=hook.ssl_verification,
        )
        ok = 200 <= resp.status_code < 300
        if not ok:
            logger.warning(
                "webhook %s → %s returned %s", hook.name, hook.payload_url,
                resp.status_code,
            )
        return {"ok": ok, "status_code": resp.status_code}
    except Exception as exc:  # noqa: BLE001
        logger.warning("webhook %s delivery error: %s", hook.name, exc)
        return {"ok": False, "error": str(exc)}
