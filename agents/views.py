"""``POST /api/mcp/`` - the Model Context Protocol endpoint.

Stateless: one JSON-RPC request in, one response out, no session id and no
event stream. API tokens only, so there is no cookie and no CSRF surface,
and the token decides everything - the tenant, the permissions, and whether
writes are even possible.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from django.core.cache import cache
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.token_auth import ApiTokenAuthentication
from integrations.toggles import integration_enabled

from . import protocol, tools
from .dispatch import ToolError
from .models import AgentCall, AgentSettings

logger = logging.getLogger(__name__)

RATE_LIMIT = 120           # calls
RATE_WINDOW = 60           # seconds
MAX_BODY = 256 * 1024


@dataclass
class Context:
    """Everything a tool needs to act as this token's owner."""

    user: Any
    token: Any
    tenant: Any
    settings: AgentSettings
    writes_enabled: bool
    client: str = ""

    @property
    def principal(self):
        return (self.user, self.token)

    @property
    def max_rows(self) -> int:
        return self.settings.effective_max_rows


def _rate_limited(token) -> bool:
    """A per-token counter on the cache, the same shape the login lockout
    uses. A missing cache means no limit, never a refusal."""
    key = f"mcp-rate:{getattr(token, 'pk', 'anon')}"
    try:
        count = cache.incr(key)
    except ValueError:
        cache.set(key, 1, RATE_WINDOW)
        return False
    except Exception:  # noqa: BLE001 - cache down: do not lock the assistant out
        return False
    return count > RATE_LIMIT


def _digest(arguments: dict) -> dict:
    """Arguments as given, minus anything that smells like a credential."""
    out = {}
    for key, value in (arguments or {}).items():
        if any(word in key.lower() for word in ("password", "secret", "token", "key")):
            out[key] = "•••"
        elif isinstance(value, (dict, list)):
            out[key] = json.loads(json.dumps(value, default=str))[:20] if isinstance(
                value, list
            ) else json.loads(json.dumps(value, default=str))
        else:
            out[key] = value
    return out


def _log(ctx: Context, tool_name: str, arguments: dict, *, rows: int, ms: int,
         wrote: bool, error: str = "") -> None:
    try:
        AgentCall.objects.create(
            tenant=ctx.tenant, user=ctx.user, token=ctx.token,
            token_name=getattr(ctx.token, "name", ""), client=ctx.client,
            tool=tool_name, object_type=str((arguments or {}).get("type") or "")[:64],
            arguments=_digest(arguments), rows=rows, ms=ms, wrote=wrote,
            error=error[:2000],
        )
    except Exception:  # noqa: BLE001 - the log must never break the answer
        logger.warning("could not record agent call %s", tool_name, exc_info=True)


def _handle(message: dict, ctx: Context) -> dict | None:
    method = message.get("method") or ""
    request_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        from core.version import system_version

        ctx.client = str((params.get("clientInfo") or {}).get("name") or "")[:120]
        return protocol.result(request_id, protocol.initialize_result(
            system_version().get("version", "")
        ))
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return protocol.result(request_id, {})
    if method == "tools/list":
        listed = tools.available(writes=ctx.writes_enabled)
        return protocol.result(request_id, {"tools": [t.spec() for t in listed]})
    if method in ("resources/list", "prompts/list"):
        return protocol.result(request_id, {"resources": [], "prompts": []}
                               if method == "resources/list" else {"prompts": []})
    if method == "tools/call":
        return _call_tool(request_id, params, ctx)
    return protocol.error(request_id, protocol.METHOD_NOT_FOUND, f"Unknown method: {method}")


def _call_tool(request_id, params: dict, ctx: Context) -> dict:
    name = str(params.get("name") or "")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        return protocol.error(request_id, protocol.INVALID_PARAMS,
                              "arguments must be an object")
    tool = tools.BY_NAME.get(name)
    if tool is None:
        return protocol.error(request_id, protocol.METHOD_NOT_FOUND, f"No tool named {name}.")
    if tool.writes and not ctx.writes_enabled:
        # Named explicitly so the assistant tells the user what to turn on
        # rather than retrying - and recorded, because an attempt to write
        # is exactly what an admin wants to see in the log.
        refusal = (
            "This Danbyte allows agents to read only. An administrator can turn on "
            "writes under Settings → Integrations → Agent access."
        )
        _log(ctx, name, arguments, rows=0, ms=0, wrote=False, error=refusal)
        return protocol.result(request_id, protocol.tool_error(refusal))
    missing = [k for k in tool.required if arguments.get(k) in (None, "")]
    if missing:
        return protocol.result(request_id, protocol.tool_error(
            f"{name} needs: {', '.join(missing)}."
        ))

    started = time.monotonic()
    try:
        payload = tool.run(ctx, **arguments)
    except ToolError as exc:
        ms = int((time.monotonic() - started) * 1000)
        _log(ctx, name, arguments, rows=0, ms=ms, wrote=False, error=str(exc))
        return protocol.result(request_id, protocol.tool_error(str(exc)))
    except Exception as exc:  # noqa: BLE001 - never hand a traceback to a client
        ms = int((time.monotonic() - started) * 1000)
        logger.exception("agent tool %s failed", name)
        _log(ctx, name, arguments, rows=0, ms=ms, wrote=False, error=repr(exc))
        return protocol.result(request_id, protocol.tool_error(
            f"{name} could not complete. The administrator can see why in Recent calls."
        ))
    ms = int((time.monotonic() - started) * 1000)
    rows = _rows_in(payload)
    _log(ctx, name, arguments, rows=rows, ms=ms, wrote=tool.writes)
    return protocol.result(request_id, protocol.tool_result(payload))


def _rows_in(payload) -> int:
    if isinstance(payload, dict):
        for key in ("rows", "hits", "entries", "types"):
            if isinstance(payload.get(key), list):
                return len(payload[key])
        if payload.get("object") is not None:
            return 1
    return 0


@api_view(["POST", "GET", "DELETE"])
@authentication_classes([ApiTokenAuthentication])
@permission_classes([IsAuthenticated])
def mcp(request):
    """The whole protocol surface. GET and DELETE exist because clients probe
    for a streaming session; both answer plainly rather than 405."""
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if not integration_enabled(tenant, "ai"):
        # Same shape as every other integration that is switched off.
        return Response({"detail": "Integration not enabled."}, status=404)
    if request.method in ("GET", "DELETE"):
        return Response(status=405, headers={"Allow": "POST"})

    token = getattr(request, "auth", None)
    if _rate_limited(token):
        return Response(
            protocol.error(None, protocol.RATE_LIMITED,
                           f"More than {RATE_LIMIT} calls a minute; wait and retry."),
            status=429, headers={"Retry-After": str(RATE_WINDOW)},
        )

    body = request.data
    if isinstance(body, list):
        # A JSON-RPC batch. Notifications drop out of the answer.
        ctx = _context(request, tenant)
        answers = [a for a in (_handle(m, ctx) for m in body if isinstance(m, dict)) if a]
        return Response(answers or [], status=200)
    if not isinstance(body, dict):
        return Response(protocol.error(None, protocol.INVALID_REQUEST,
                                       "Expected a JSON-RPC object."), status=400)

    ctx = _context(request, tenant)
    answer = _handle(body, ctx)
    if answer is None:
        return Response(status=202)  # a notification: accepted, nothing to say
    return Response(answer, status=200)


def _context(request, tenant) -> Context:
    settings_row, _ = AgentSettings.objects.get_or_create(tenant=tenant)
    token = getattr(request, "auth", None)
    writes = (
        integration_enabled(tenant, "ai_writes")
        and not bool(getattr(token, "read_only", False))
    )
    return Context(
        user=request.user, token=token, tenant=tenant, settings=settings_row,
        writes_enabled=writes,
        client=str(request.headers.get("User-Agent", ""))[:120],
    )


def token_fingerprint(raw: str) -> str:
    """Only used by the settings page, to show which token a call came from."""
    return hashlib.sha256(raw.encode()).hexdigest()[:12]
