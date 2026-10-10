"""``POST /api/mcp/`` - the Model Context Protocol endpoint.

Stateless: one JSON-RPC request in, one response out, no session id and no
event stream. API tokens only, so there is no cookie and no CSRF surface,
and the token decides everything - the tenant, the permissions, and whether
writes are even possible.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from django.core.cache import cache
from django.http import Http404
from rest_framework.exceptions import ParseError
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from auth_api.token_auth import ApiTokenAuthentication
from integrations.toggles import integration_enabled

from . import dispatch, protocol, tools
from .dispatch import ToolError
from .models import AgentCall, AgentSettings

logger = logging.getLogger(__name__)

RATE_LIMIT = 120           # messages a minute, single or batched
RATE_WINDOW = 60           # seconds
MAX_BODY = 256 * 1024      # bytes per request
MAX_BATCH = 20             # messages per JSON-RPC batch


class AlwaysJSON(BaseContentNegotiation):
    """Answer JSON whatever the client asked for.

    A Streamable HTTP client sends ``Accept: application/json,
    text/event-stream`` because it is prepared for either; some send only
    the stream type. This server is stateless and always answers a single
    JSON body, so negotiating would just turn a workable request into a
    406.
    """

    def select_parser(self, request, parsers):
        return parsers[0]

    def select_renderer(self, request, renderers, format_suffix=None):
        return (renderers[0], renderers[0].media_type)


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


def _rate_limited(token, messages: int = 1) -> bool:
    """A per-token counter on the cache, the same shape the login lockout
    uses. Every JSON-RPC message counts, so a batch is charged for each
    message it carries before any of them runs (#328). A missing cache
    means no limit, never a refusal."""
    key = f"mcp-rate:{getattr(token, 'pk', 'anon')}"
    try:
        count = cache.incr(key, messages)
    except ValueError:
        cache.set(key, messages, RATE_WINDOW)
        return messages > RATE_LIMIT
    except Exception:  # noqa: BLE001 - cache down: do not lock the assistant out
        return False
    return count > RATE_LIMIT


MASK = "•••"
# A key carrying one of these holds a credential wherever it sits. "key"
# also covers api_key, private_key and key_hash; "credential" the encrypted
# credential blobs.
_SECRET_WORDS = ("password", "passphrase", "secret", "token", "key", "psk", "credential")


def _digest(arguments: dict) -> dict:
    """Arguments as given, minus anything that smells like a credential.

    Masked at every level, not only the top one: a write's values sit
    inside ``payload``, and a refused write is logged as well (#326). A
    key is judged by its name and by what the secret classifier says about
    the target type, so a notification channel's ``config`` is masked
    while a site's is kept.
    """
    arguments = arguments or {}
    secret_names = dispatch.secret_field_names(
        dispatch.model_of(str(arguments.get("type") or ""))
    )
    return _mask(json.loads(json.dumps(arguments, default=str)), secret_names)


def _mask(value, secret_names: frozenset[str]):
    if isinstance(value, dict):
        return {
            key: MASK if _is_secret(key, secret_names) else _mask(val, secret_names)
            for key, val in value.items()
        }
    if isinstance(value, list):
        return [_mask(v, secret_names) for v in value[:20]]
    if isinstance(value, str) and value.lstrip()[:1] in ("{", "["):
        # Tools also take an object sent as JSON text, so a payload can
        # arrive as a string; mask what it holds rather than storing it raw.
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        if isinstance(parsed, (dict, list)):
            masked = _mask(parsed, secret_names)
            return masked if masked != parsed else value
    return value


def _is_secret(key, secret_names: frozenset[str]) -> bool:
    name = str(key).lower()
    return name in secret_names or any(word in name for word in _SECRET_WORDS)


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
    """How much came back, for the log. One object counts as one row."""
    if isinstance(payload, dict):
        for key in ("rows", "hits", "entries", "types"):
            if isinstance(payload.get(key), list):
                return len(payload[key])
        for key in ("object", "where", "monitoring", "fields"):
            if payload.get(key):
                return 1
    return 0


class MCPView(APIView):
    """The whole protocol surface: one JSON-RPC exchange per request."""

    authentication_classes = [ApiTokenAuthentication]
    permission_classes = [IsAuthenticated]
    renderer_classes = [JSONRenderer]
    # JSON-RPC takes a batch (a top-level array) and answers any other
    # non-object body with a protocol error, so it keeps the plain parser
    # rather than the API's object-only default (#373).
    parser_classes = [JSONParser]
    content_negotiation_class = AlwaysJSON

    def _tenant_or_404(self, request):
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if not integration_enabled(tenant, "ai"):
            # The same shape as every other integration that is switched off.
            raise Http404("Integration not enabled.")
        return tenant

    def get(self, request):
        """Clients probe for a streaming session; this server has none."""
        self._tenant_or_404(request)
        return Response({"detail": "This server is stateless; POST JSON-RPC to this URL."},
                        status=405, headers={"Allow": "POST"})

    delete = get

    def post(self, request):
        tenant = self._tenant_or_404(request)
        token = getattr(request, "auth", None)
        # Size, shape and budget are settled before any message runs, so a
        # batch cannot buy more than the per-token limit allows (#328).
        if _too_big(request):
            return _reject(protocol.INVALID_REQUEST,
                           f"Request body larger than {MAX_BODY // 1024} KB.", status=413)
        try:
            body = request.data
        except ParseError as exc:
            return _reject(protocol.PARSE_ERROR, str(exc.detail), status=400)
        if isinstance(body, list) and not body:
            return _reject(protocol.INVALID_REQUEST, "An empty batch.", status=400)
        if isinstance(body, list) and len(body) > MAX_BATCH:
            return _reject(protocol.INVALID_REQUEST,
                           f"A batch may carry at most {MAX_BATCH} messages.", status=400)
        if _rate_limited(token, len(body) if isinstance(body, list) else 1):
            return _reject(
                protocol.RATE_LIMITED,
                f"More than {RATE_LIMIT} calls a minute; wait and retry.",
                status=429, headers={"Retry-After": str(RATE_WINDOW)},
            )
        ctx = _context(request, tenant)
        if isinstance(body, list):
            # A JSON-RPC batch. Notifications drop out of the answer.
            # Anything in it that is not a message is answered as one.
            answers = [
                a for a in (
                    _handle(m, ctx) if isinstance(m, dict) else protocol.error(
                        None, protocol.INVALID_REQUEST, "Expected a JSON-RPC object.")
                    for m in body
                ) if a
            ]
            return Response(answers or [], status=200)
        if not isinstance(body, dict):
            return Response(protocol.error(None, protocol.INVALID_REQUEST,
                                           "Expected a JSON-RPC object."), status=400)
        answer = _handle(body, ctx)
        if answer is None:
            return Response(status=202)  # a notification: accepted, nothing to say
        return Response(answer, status=200)


mcp = MCPView.as_view()


def _too_big(request) -> bool:
    """Over ``MAX_BODY``, judged by the declared length first so an
    oversized body is refused without being read, then by what arrived."""
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        declared = 0
    return declared > MAX_BODY or len(request.body) > MAX_BODY


def _reject(code: int, message: str, *, status: int, headers: dict | None = None) -> Response:
    """A JSON-RPC error with no id: the refusal is about the request as a
    whole, not any one message in it."""
    return Response(protocol.error(None, code, message), status=status, headers=headers)


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
