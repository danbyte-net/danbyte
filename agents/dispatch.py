"""Calling Danbyte's own API on the assistant's behalf.

Every tool goes through the type's registered DRF viewset with the token's
user and tenant, via ``APIRequestFactory`` + ``force_authenticate``. So
filters, serializers, RBAC, site scoping, audit and journal behave exactly
as they do for the same person in the browser - there is no second
implementation of any of it here, and nothing to drift.

On top of that this module adds three things the API does not need but an
assistant does: a row cap with an honest ``truncated`` flag, the tenant's
``allowed_types`` narrowing, and a secret-field blocklist as defence in
depth behind the serializers' own ``write_only``.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from rest_framework.test import APIRequestFactory, force_authenticate

from auth_api import rbac
from auth_api.object_types import model_for
from core.secret_fields import is_secret_field

logger = logging.getLogger(__name__)

_factory = APIRequestFactory()

# Keys never returned, whatever a serializer says. Credentials are already
# write-only in the serializers; this is the belt to those braces, and it
# also drops shapes an assistant has no use for.
_ALWAYS_STRIP = {
    "permissions", "password", "secret", "secrets", "token", "api_key",
    "private_key", "secret_params", "psk", "key_hash",
}
_DROP_SUFFIXES = ("_thumbnail",)


class ToolError(Exception):
    """A refusal the assistant should read and act on."""


# ─── routing ────────────────────────────────────────────────────────────────

# Every DRF router in the tree, with the path it is mounted under. The main
# API router is not the only one: monitoring owns alerts, checks and SNMP,
# and "which hosts are down" is the whole point of asking an assistant.
_ROUTER_MODULES = (
    ("", "api.api_urls"),
    ("monitoring/", "monitoring.api_urls"),
    ("planning/", "planning.api_urls"),
    ("backups/", "backups.api_urls"),
    ("scripts/", "scripting.api_urls"),
)


@lru_cache(maxsize=1)
def _routes() -> dict[str, tuple[str, Any]]:
    """``slug -> (url path, viewset)`` for every routed type.

    Composed from the routers and the object-type registry, the two sources
    ``api/editable_fields.py`` already uses; no single helper maps a slug to
    its endpoint.
    """
    from importlib import import_module

    out: dict[str, tuple[str, Any]] = {}
    for mount, module_path in _ROUTER_MODULES:
        try:
            router = import_module(module_path).router
        except Exception:  # noqa: BLE001 - an app without a router is fine
            logger.warning("no router in %s", module_path)
            continue
        for prefix, viewset, _basename in router.registry:
            qs = getattr(viewset, "queryset", None)
            if qs is None:
                continue
            slug = getattr(viewset, "rbac_object_type", None) or qs.model._meta.model_name
            out.setdefault(slug, (f"{mount}{prefix}", viewset))
    return out


def known_types() -> list[str]:
    return sorted(_routes())


def _normalise(slug: str) -> str:
    """An assistant will reach for "devices" or "Device" first; accept both."""
    raw = (slug or "").strip().lower().replace(" ", "").replace("-", "").replace("_", "")
    routes = _routes()
    for candidate in (raw, raw.rstrip("s"), raw + "s"):
        if candidate in routes:
            return candidate
    return raw


def resolve(slug: str, settings_row=None) -> tuple[str, str, Any]:
    """``(slug, prefix, viewset)``, honouring the tenant's allowed types."""
    resolved = _normalise(slug)
    entry = _routes().get(resolved)
    if entry is None:
        raise ToolError(
            f"Unknown object type '{slug}'. Call `types` to see what this token can read."
        )
    allowed = [_normalise(t) for t in (getattr(settings_row, "allowed_types", None) or [])]
    if allowed and resolved not in allowed:
        raise ToolError(f"Agent access here is limited to: {', '.join(sorted(allowed))}.")
    return resolved, entry[0], entry[1]


# ─── result cleaning ────────────────────────────────────────────────────────

@lru_cache(maxsize=256)
def _secret_field_names(model) -> frozenset[str]:
    names: set[str] = set()
    for field in model._meta.concrete_fields:
        try:
            secret = is_secret_field(model, field)
        except Exception:  # noqa: BLE001 - a classifier hiccup must fail closed
            secret = True
        if secret:
            names.add(field.name)
            names.add(field.attname)
    return frozenset(names)


def clean(value: Any, model=None) -> Any:
    """Drop secret and noisy keys from a serialized payload, recursively."""
    secret_names = _secret_field_names(model) if model is not None else frozenset()
    return _clean(value, secret_names)


def _clean(value: Any, secret_names: frozenset[str]) -> Any:
    if isinstance(value, list):
        return [_clean(v, secret_names) for v in value]
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, val in value.items():
        if key in _ALWAYS_STRIP or key in secret_names:
            continue
        if any(key.endswith(sfx) for sfx in _DROP_SUFFIXES):
            continue
        out[key] = _clean(val, frozenset())
    return out


def rows_of(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("results") or []
    return []


def count_of(payload, rows: list) -> int:
    if isinstance(payload, dict) and isinstance(payload.get("count"), int):
        return payload["count"]
    return len(rows)


# ─── the calls ──────────────────────────────────────────────────────────────

def _dispatch(principal, viewset, actions: dict, request, **kwargs):
    user, token = principal
    force_authenticate(request, user=user, token=token)
    response = viewset.as_view(actions)(request, **kwargs)
    if hasattr(response, "render") and not getattr(response, "is_rendered", True):
        response.render()
    return response.status_code, getattr(response, "data", None)


def _refuse(status: int, payload, *, slug: str, what: str) -> None:
    """Turn an API refusal into something an assistant can act on.

    A row it may not see reads as "not found", never "forbidden", so the
    endpoint never confirms that an object exists.
    """
    if status < 400:
        return
    detail = ""
    if isinstance(payload, dict):
        detail = str(payload.get("detail") or "")
        if not detail:
            detail = "; ".join(f"{k}: {v}" for k, v in list(payload.items())[:6])
    elif payload:
        detail = str(payload)[:300]
    if status in (403, 404):
        raise ToolError(detail or f"No {slug} matching {what}, or not visible to this token.")
    raise ToolError(detail or f"The request failed ({status}).")


def list_objects(principal, slug: str, filters: dict, *, limit: int, cursor: int = 0,
                 settings_row=None) -> dict:
    resolved, prefix, viewset = resolve(slug, settings_row)
    params = {k: v for k, v in (filters or {}).items() if v is not None}
    # One row more than asked, so "there is more" is a fact rather than a guess.
    params.update({"limit": limit + 1, "offset": cursor} if cursor else {"limit": limit + 1})
    request = _factory.get(f"/api/{prefix}/", params)
    status, payload = _dispatch(principal, viewset, {"get": "list"}, request)
    _refuse(status, payload, slug=resolved, what="those filters")
    rows = rows_of(payload)
    truncated = len(rows) > limit
    rows = rows[:limit]
    model = viewset.queryset.model
    return {
        "type": resolved,
        "rows": [clean(r, model) for r in rows],
        "returned": len(rows),
        "total": count_of(payload, rows),
        "truncated": truncated,
        "next_cursor": (cursor + limit) if truncated else None,
    }


def get_object(principal, slug: str, ident: str, *, settings_row=None) -> dict:
    resolved, prefix, viewset = resolve(slug, settings_row)
    model = viewset.queryset.model
    pk = _identify(principal, resolved, prefix, viewset, ident, settings_row)
    request = _factory.get(f"/api/{prefix}/{pk}/")
    status, payload = _dispatch(principal, viewset, {"get": "retrieve"}, request, pk=pk)
    _refuse(status, payload, slug=resolved, what=ident)
    return {"type": resolved, "object": clean(payload, model)}


def _identify(principal, slug: str, prefix: str, viewset, ident: str, settings_row) -> str:
    """Accept a UUID, a numeric id, or an exact name - an assistant that just
    read a name should not have to look up the id first."""
    text = str(ident or "").strip()
    if not text:
        raise ToolError("Pass an id or a name.")
    if _looks_like_id(text):
        return text
    for field in ("name", "numid", "address", "prefix", "slug"):
        request = _factory.get(f"/api/{prefix}/", {field: text, "limit": 2})
        try:
            status, payload = _dispatch(principal, viewset, {"get": "list"}, request)
        except Exception:  # noqa: BLE001 - the type may not filter on that field
            continue
        if status >= 400:
            continue
        rows = rows_of(payload)
        exact = [r for r in rows if str(r.get(field, "")).lower() == text.lower()]
        if len(exact) == 1:
            return str(exact[0]["id"])
        if len(exact) > 1:
            raise ToolError(f"More than one {slug} is called {text!r}; pass its id.")
    raise ToolError(f"No {slug} with id or name {text!r} is visible to this token.")


def _looks_like_id(text: str) -> bool:
    import uuid

    if text.isdigit():
        return True
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True


def create_object(principal, slug: str, payload: dict, *, settings_row=None) -> dict:
    resolved, prefix, viewset = resolve(slug, settings_row)
    request = _factory.post(f"/api/{prefix}/", payload or {}, format="json")
    status, body = _dispatch(principal, viewset, {"post": "create"}, request)
    _refuse(status, body, slug=resolved, what="that payload")
    return {"type": resolved, "object": clean(body, viewset.queryset.model), "created": True}


def update_object(principal, slug: str, ident: str, payload: dict, *, settings_row=None) -> dict:
    resolved, prefix, viewset = resolve(slug, settings_row)
    pk = _identify(principal, resolved, prefix, viewset, ident, settings_row)
    request = _factory.patch(f"/api/{prefix}/{pk}/", payload or {}, format="json")
    status, body = _dispatch(
        principal, viewset, {"patch": "partial_update"}, request, pk=pk
    )
    _refuse(status, body, slug=resolved, what=ident)
    return {"type": resolved, "object": clean(body, viewset.queryset.model), "updated": True}


def delete_object(principal, slug: str, ident: str, confirm: str, *, settings_row=None) -> dict:
    resolved, prefix, viewset = resolve(slug, settings_row)
    pk = _identify(principal, resolved, prefix, viewset, ident, settings_row)
    current = get_object(principal, resolved, pk, settings_row=settings_row)["object"]
    label = str(current.get("name") or current.get("address") or current.get("prefix") or "")
    if not confirm or confirm.strip() != label:
        raise ToolError(
            f"To delete this {resolved}, pass confirm={label!r} - the object's own name."
        )
    request = _factory.delete(f"/api/{prefix}/{pk}/")
    status, body = _dispatch(principal, viewset, {"delete": "destroy"}, request, pk=pk)
    _refuse(status, body, slug=resolved, what=ident)
    return {"type": resolved, "id": pk, "deleted": True, "was": label}


# ─── helpers the tools share ────────────────────────────────────────────────

def can(user, tenant, slug: str, action: str) -> bool:
    return rbac.has_action(user, tenant, slug, action)


def model_of(slug: str):
    return model_for(_normalise(slug))


def visible_count(user, tenant, slug: str) -> int | None:
    """How many rows of ``slug`` this token can see, or None when the type
    has no tenant field to scope by."""
    model = model_of(slug)
    if model is None:
        return None
    qs = model._default_manager.all()
    if any(f.name == "tenant" for f in model._meta.concrete_fields) and tenant is not None:
        qs = qs.filter(tenant=tenant)
    try:
        return rbac.restrict_queryset(qs, user, tenant, _normalise(slug), "view").count()
    except Exception:  # noqa: BLE001 - a count is a nicety, never worth a 500
        return None
