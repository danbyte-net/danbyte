"""The conversation: ask the model, run the tools it asks for, repeat.

The tools are the ones the MCP server already exposes
(:mod:`agents.tools`), executed through :mod:`agents.dispatch` as the
person who is chatting. So the assistant sees exactly what they see - the
same tenant, sites, permissions and row caps - and there is no second
implementation of any of that here.

Two provider shapes have to be fed differently: Anthropic wants tool
results as ``tool_result`` blocks in a user turn, OpenAI-compatible ones
want a ``tool`` role message per call. :func:`Transcript` keeps both.
"""
from __future__ import annotations

import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

from agents import tools as tool_registry
from agents.dispatch import ToolError
from agents.models import AgentCall, AgentSettings

from . import providers

logger = logging.getLogger(__name__)

MAX_TURNS = 6          # model → tools → model round trips before we stop
MAX_TOOL_CHARS = 24000  # one tool result handed back to the model

SYSTEM = """\
You are the assistant inside Danbyte, a network source of truth: IP space,
devices, racks, interfaces, cabling, circuits, virtual machines, monitoring
state, hardware lifecycle dates and a full change log.

Answer questions about this data by calling the tools. Never invent a
device, address or status - if a tool did not return it, say so. Start with
`search` or `list` when you do not know an object's id; `types` shows what
this person can see.

You act as the person asking, with their permissions. If a tool says
something is not visible, tell them plainly rather than trying another way
around it.

Results are capped. When a result says it was truncated, say so instead of
implying you saw everything.

Be brief and concrete. Prefer a short list of names over prose. Give
numbers where they matter. This is an operations tool: no preamble, no
restating the question."""


@dataclass
class Transcript:
    """The messages so far, in whichever shape the provider wants."""

    provider: str
    messages: list[dict] = field(default_factory=list)

    def user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def assistant_text(self, text: str) -> None:
        if text.strip():
            self.messages.append({"role": "assistant", "content": text})

    def tool_round(self, calls: list[dict]) -> None:
        """Record the calls the model made and what each returned."""
        if self.provider == "anthropic":
            self.messages.append({
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": c["id"], "name": c["name"],
                     "input": c["arguments"]}
                    for c in calls
                ],
            })
            self.messages.append({
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": c["id"], "content": c["result"],
                     **({"is_error": True} if c["error"] else {})}
                    for c in calls
                ],
            })
            return
        self.messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": c["id"], "type": "function",
                 "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                for c in calls
            ],
        })
        for c in calls:
            self.messages.append({
                "role": "tool", "tool_call_id": c["id"], "content": c["result"],
            })


def context_for(user, tenant, *, writes: bool):
    """The same Context the MCP endpoint builds, minus a token: a chat runs
    as the signed-in person, so row caps and allowed types still apply."""
    from agents.views import Context

    settings_row, _ = AgentSettings.objects.get_or_create(tenant=tenant)
    return Context(user=user, token=None, tenant=tenant, settings=settings_row,
                   writes_enabled=writes, client="chat")


@contextlib.contextmanager
def acting_as(user):
    """Attribute writes to the person chatting.

    The audit context is normally set by HTTP middleware; a WebSocket turn
    never touches it, so without this every change an assistant made would
    land in the change log with no name against it.
    """
    from audit.context import _request, _request_id, _user, _via

    tokens = (
        _user.set(user), _request.set(None),
        _request_id.set(uuid.uuid4().hex), _via.set("chat"),
    )
    try:
        yield
    finally:
        _user.reset(tokens[0])
        _request.reset(tokens[1])
        _request_id.reset(tokens[2])
        _via.reset(tokens[3])


def _shorten(payload) -> str:
    text = json.dumps(payload, default=str)
    if len(text) <= MAX_TOOL_CHARS:
        return text
    return text[:MAX_TOOL_CHARS] + "\n… result truncated to fit."


def run_tool(ctx, name: str, arguments: dict) -> tuple[str, int, str]:
    """Execute one tool. Returns (result for the model, rows, error)."""
    tool = tool_registry.BY_NAME.get(name)
    if tool is None:
        return f"There is no tool called {name}.", 0, "unknown tool"
    if tool.writes and not ctx.writes_enabled:
        message = ("Writing is switched off for this Danbyte, so that cannot be done "
                   "from the chat.")
        return message, 0, message
    started = time.monotonic()
    try:
        with acting_as(ctx.user):
            payload = tool.run(ctx, **arguments)
    except ToolError as exc:
        _record(ctx, name, arguments, rows=0, ms=_ms(started), wrote=False, error=str(exc))
        return str(exc), 0, str(exc)
    except Exception as exc:  # noqa: BLE001 - the model must not see a traceback
        logger.exception("assistant tool %s failed", name)
        _record(ctx, name, arguments, rows=0, ms=_ms(started), wrote=False, error=repr(exc))
        return f"{name} could not complete.", 0, str(exc)
    rows = _rows_in(payload)
    _record(ctx, name, arguments, rows=rows, ms=_ms(started), wrote=tool.writes)
    return _shorten(payload), rows, ""


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _rows_in(payload) -> int:
    from agents.views import _rows_in as counter

    return counter(payload)


def _record(ctx, name, arguments, *, rows, ms, wrote, error="") -> None:
    """Chat tool calls land in the same log as agent ones, marked `chat`."""
    from agents.views import _digest

    try:
        AgentCall.objects.create(
            tenant=ctx.tenant, user=ctx.user, token=None, token_name="",
            client="chat", tool=name,
            object_type=str((arguments or {}).get("type") or "")[:64],
            arguments=_digest(arguments), rows=rows, ms=ms, wrote=wrote,
            error=error[:2000],
        )
    except Exception:  # noqa: BLE001 - the log must never break an answer
        logger.warning("could not record chat tool call %s", name, exc_info=True)


def answer(conn, ctx, history: list[dict], question: str):
    """Run one exchange, yielding frames for the socket to forward.

    Frames: ``{"t": "delta", "d": str}`` as text arrives, ``{"t": "tool",
    ...}`` per tool call, and finally ``{"t": "final", ...}``.
    """
    transcript = Transcript(provider=conn.provider, messages=list(history))
    transcript.user(question)
    tool_specs = [t.spec() for t in tool_registry.available(writes=ctx.writes_enabled)]
    full_text: list[str] = []
    tokens_in = tokens_out = 0

    for turn in range(MAX_TURNS):
        text_this_turn: list[str] = []
        calls: list[dict] = []
        for event in providers.stream(conn, SYSTEM, transcript.messages, tool_specs):
            if event.kind == "text" and event.text:
                text_this_turn.append(event.text)
                yield {"t": "delta", "d": event.text}
            elif event.kind == "tool":
                calls.append({"id": event.tool_id or f"call_{turn}_{len(calls)}",
                              "name": event.tool_name,
                              "arguments": event.tool_input or {}})
            elif event.kind == "usage":
                tokens_in += event.tokens_in
                tokens_out += event.tokens_out

        joined = "".join(text_this_turn)
        if joined:
            full_text.append(joined)

        if not calls:
            transcript.assistant_text(joined)
            break

        for call in calls:
            result, rows, error = run_tool(ctx, call["name"], call["arguments"])
            call["result"] = result
            call["error"] = error
            yield {"t": "tool", "name": call["name"], "args": call["arguments"],
                   "rows": rows, "error": error}
        transcript.tool_round(calls)
    else:
        note = "I stopped after several rounds of looking things up."
        full_text.append(note)
        yield {"t": "delta", "d": "\n" + note}

    yield {
        "t": "final",
        "text": "".join(full_text),
        "messages": transcript.messages,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
    }
