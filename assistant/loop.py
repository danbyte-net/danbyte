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

MAX_TURNS = 14         # model → tools → model round trips before we stop
MAX_TOOL_CHARS = 24000  # one tool result handed back to the model

SYSTEM = """\
You are the assistant inside Danbyte, a network source of truth: IP space,
devices, racks, interfaces, cabling, circuits, virtual machines, monitoring
state, hardware lifecycle dates and a full change log.

Answer questions about this data by calling the tools. Never invent a
device, address or status - if a tool did not return it, say so. Start with
`search` or `list` when you do not know an object's id; `types` shows what
this person can see.

Reach for the tool that answers the whole question at once. `count` with
`group_by` tells you the spread across sites or roles in one call; listing
a type once per site instead will run out of room before you have an
answer.

You act as the person asking, with their permissions. If a tool says
something is not visible, tell them plainly rather than trying another way
around it.

Results are capped. When a result says it was truncated, say so instead of
implying you saw everything.

Be brief and concrete. Prefer a short list of names over prose. Give
numbers where they matter. This is an operations tool: no preamble, no
restating the question, and never narrate what you are about to do.

Write in Markdown, which is rendered:

* **bold** for a name that matters, `code` for identifiers and addresses.
* A list for a handful of things; a table when each thing has the same two
  or three attributes worth comparing.
* Link every object you name, using the `url` each row carries:
  `[aarhus-core-1](/devices/<id>)`. A reader should be able to click
  straight through to it.

Filters take names, not ids: `list(type="device", filters={"site": "Aarhus"})`
works. Only fall back to searching for an id if a name is refused.

When a request is broad ("every site", "all of them"), ask before you go
looking: agreeing the shape first is quicker than exploring and then
finding out you guessed wrong.

Before changing anything, stop and ask when you would be guessing:

* More than two objects at once. Say what you intend to create, and ask
  with `ask_user` before you start - a naming scheme is the usual thing to
  agree first.
* A name, a parent, a type or a site you inferred rather than were told.
* Anything you would have to delete afterwards to undo.

Call `ask_user` once and say nothing else in that turn, then wait.

Ask for everything you need in that one question. Options and fields are
answered together, so a question like "which model, and what naming
scheme?" carries an `object_type` field for the model and a text field for
the pattern - do not ask again for something you could have asked for
here.

Finish what you start. An object that needs another to be usable is not
done until both exist, and if you cannot finish it, say which part is
missing:

* A **circuit** carries traffic only once it has both ends. Land each with
  `terminate(circuit=..., side="A"|"Z", site=...)` - a termination lands at
  a site or a provider network, never on a device. Then cable each side to
  the port that carries it, naming the circuit and the side:
  `connect(a_device="kbh-fw1", a_port="ethernet1/5", b_device="AAL-CPH-001",
  b_port="Z", b_kind="circuit_termination")`. A circuit whose sides are not
  cabled to a port draws nothing on the map.
* A **cable** joins two ports. Always use `connect` with the four names -
  `connect(a_device="aalborg-sw1", a_port="Gi1/0/3", b_device="aalborg-fw1",
  b_port="ethernet1/3")`. Never build a cable payload with `create`. To see
  a device's ports: `list(type="interface", filters={"device": "aalborg-sw1"})`.
* An **interface** belongs to a device. An **IP address** is unassigned
  until it points at an interface.

Ask which port or site to terminate on rather than choosing one.

Danbyte also runs saved Python scripts, so "give me a report of...",
"check every month whether..." or "bulk-rename these" can be answered with
a script instead of a one-off answer. Offer one when the person will want
the same answer again, or when the work is larger than a handful of
changes. Call `script_guide` first - it returns the SDK a script may
import and the fields a script row takes - then save it with
`create(type="script", ...)` and link to it. You cannot run a script; say
that the person runs it from its page."""


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


def preview_of(payload) -> dict | None:
    """The one object a tool call was about, shaped for a card.

    Answers read far better with the object attached than described, and
    everything here is already in the serializer - a picture of the model,
    where it sits, and coordinates for a map.
    """
    if not isinstance(payload, dict):
        return None
    obj = payload.get("object")
    if not isinstance(obj, dict) or not obj.get("id"):
        return None
    kind = str(payload.get("type") or "")

    def name_of(value):
        if isinstance(value, dict):
            return value.get("name") or value.get("display") or value.get("address")
        return value

    facts: list[dict] = []

    def fact(label, value, url=None):
        text = name_of(value)
        if text not in (None, "", [], {}):
            facts.append({"label": label, "value": str(text), "url": url})

    dtype = obj.get("device_type") if isinstance(obj.get("device_type"), dict) else {}
    if kind == "device":
        fact("Site", obj.get("site"), _url_for("site", obj.get("site")))
        fact("Location", obj.get("location"))
        rack = name_of(obj.get("rack"))
        if rack:
            unit = obj.get("position")
            fact("Rack", f"{rack}{f' · U{unit}' if unit else ''}",
                 _url_for("rack", obj.get("rack")))
        fact("Type", dtype.get("name"), _url_for("devicetype", dtype))
        fact("Platform", obj.get("platform"))
        fact("Primary IP", obj.get("primary_ip"), _url_for("ipaddress", obj.get("primary_ip")))
        fact("Serial", obj.get("serial_number"))
        fact("Interfaces", obj.get("interface_count"))
    elif kind == "virtualmachine":
        fact("Cluster", obj.get("cluster"), _url_for("cluster", obj.get("cluster")))
        fact("Host", obj.get("device"), _url_for("device", obj.get("device")))
        fact("Site", obj.get("site"), _url_for("site", obj.get("site")))
        fact("vCPU", obj.get("vcpus"))
        if obj.get("memory_mb"):
            fact("Memory", f"{round(int(obj['memory_mb']) / 1024, 1)} GB")
        if obj.get("disk_gb"):
            fact("Disk", f"{obj['disk_gb']} GB")
        fact("Primary IP", obj.get("primary_ip"), _url_for("ipaddress", obj.get("primary_ip")))
    elif kind == "circuit":
        fact("Provider", obj.get("provider"), _url_for("provider", obj.get("provider")))
        fact("Type", obj.get("type"))
        for term in (obj.get("terminations") or [])[:2]:
            if isinstance(term, dict):
                side = str(term.get("term_side") or "").upper() or "End"
                fact(f"{side} side", term.get("site") or term.get("interface"))
        if not obj.get("terminations"):
            fact("Terminations", "none yet")
        if obj.get("commit_rate_kbps"):
            fact("Commit rate", f"{int(obj['commit_rate_kbps']) // 1000} Mbps")
    elif kind == "site":
        fact("Region", obj.get("region"), _url_for("region", obj.get("region")))
        fact("Address", obj.get("address"))
        fact("Devices", obj.get("device_count"))
        fact("Racks", obj.get("rack_count"))
        fact("Prefixes", obj.get("prefix_count"))
    else:
        for label, key in (("Site", "site"), ("Tenant", "tenant"), ("Status", "status"),
                           ("Role", "role"), ("Device", "device"), ("VRF", "vrf")):
            fact(label, obj.get(key))

    status = obj.get("status") if isinstance(obj.get("status"), dict) else None
    lat, lon = obj.get("latitude"), obj.get("longitude")
    if lat in (None, "") and isinstance(obj.get("site"), dict):
        lat, lon = obj["site"].get("latitude"), obj["site"].get("longitude")

    return {
        "type": kind,
        "id": str(obj["id"]),
        "title": str(
            name_of(obj) or obj.get("cid") or obj.get("address")
            or obj.get("prefix") or obj.get("display") or obj["id"]
        ),
        "url": obj.get("url"),
        "description": str(obj.get("description") or "")[:200],
        "status": {"name": status.get("name"), "color": status.get("color")}
        if status and status.get("name") else None,
        "image": dtype.get("front_image") or dtype.get("rear_image") or None,
        "latitude": float(lat) if _is_number(lat) else None,
        "longitude": float(lon) if _is_number(lon) else None,
        "facts": facts[:8],
        "created": bool(payload.get("created")),
        "updated": bool(payload.get("updated")),
    }


def _url_for(slug: str, value) -> str | None:
    from agents.dispatch import _ROUTES_UI

    if not isinstance(value, dict) or not value.get("id"):
        return None
    route = _ROUTES_UI.get(slug)
    return f"/{route}/{value['id']}" if route else None


def _is_number(value) -> bool:
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def run_tool(ctx, name: str, arguments: dict) -> tuple[str, int, str, dict | None]:
    """Execute one tool. Returns (result for the model, rows, error)."""
    tool = tool_registry.BY_NAME.get(name)
    if tool is None:
        return f"There is no tool called {name}.", 0, "unknown tool", None
    if tool.writes and not ctx.writes_enabled:
        message = ("Writing is switched off for this Danbyte, so that cannot be done "
                   "from the chat.")
        # Recorded: an attempt to write is exactly what an admin wants to see.
        _record(ctx, name, arguments, rows=0, ms=0, wrote=False, error=message)
        return message, 0, message, None
    started = time.monotonic()
    try:
        with acting_as(ctx.user):
            payload = tool.run(ctx, **arguments)
    except ToolError as exc:
        _record(ctx, name, arguments, rows=0, ms=_ms(started), wrote=False, error=str(exc))
        return str(exc), 0, str(exc), None
    except Exception as exc:  # noqa: BLE001 - the model must not see a traceback
        logger.exception("assistant tool %s failed", name)
        _record(ctx, name, arguments, rows=0, ms=_ms(started), wrote=False, error=repr(exc))
        return f"{name} could not complete.", 0, str(exc), None
    rows = _rows_in(payload)
    _record(ctx, name, arguments, rows=rows, ms=_ms(started), wrote=tool.writes)
    return _shorten(payload), rows, "", preview_of(payload)


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


def looking_at(context: dict | None) -> str:
    """One line telling the model which page the person has open."""
    if not context:
        return ""
    kind = str(context.get("type") or "").strip()
    label = str(context.get("label") or "").strip()
    ident = str(context.get("id") or "").strip()
    if not kind or not ident:
        return ""
    named = f" called {label}" if label else ""
    return (f"\n\nRight now the person is looking at the {kind}{named} "
            f"(id {ident}). When they say \"this\" or \"the {kind} I am on\", "
            f"they mean that one.")


def answer(conn, ctx, history: list[dict], question: str, context: dict | None = None):
    """Run one exchange, yielding frames for the socket to forward.

    Frames: ``{"t": "delta", "d": str}`` as text arrives, ``{"t": "tool",
    ...}`` per tool call, and finally ``{"t": "final", ...}``.
    """
    transcript = Transcript(provider=conn.provider, messages=list(history))
    transcript.user(question)
    system = SYSTEM + looking_at(context)
    tool_specs = [t.spec() for t in tool_registry.available(writes=ctx.writes_enabled)]
    full_text: list[str] = []
    tokens_in = tokens_out = 0

    for turn in range(MAX_TURNS):
        text_this_turn: list[str] = []
        pending_text: list[str] = []
        calls: list[dict] = []
        for event in providers.stream(conn, system, transcript.messages, tool_specs):
            if event.kind == "text" and event.text:
                text_this_turn.append(event.text)
                # Held back until the turn ends: if it turns out to be
                # narration before a tool call, it is never shown.
                pending_text.append(event.text)
            elif event.kind == "tool":
                calls.append({"id": event.tool_id or f"call_{turn}_{len(calls)}",
                              "name": event.tool_name,
                              "arguments": event.tool_input or {}})
            elif event.kind == "usage":
                tokens_in += event.tokens_in
                tokens_out += event.tokens_out

        joined = "".join(text_this_turn)

        if not calls:
            for piece in pending_text:
                yield {"t": "delta", "d": piece}
            if joined:
                full_text.append(joined)
            transcript.assistant_text(joined)
            break
        # A turn that ends in a tool call only narrates what it is about to
        # look up; the tool lines show that already. Keep it for the model's
        # own context, drop it from the answer.
        if joined:
            transcript.assistant_text(joined)

        asked = None
        for call in calls:
            result, rows, error, card = run_tool(ctx, call["name"], call["arguments"])
            call["result"] = result
            call["error"] = error
            if call["name"] == "ask_user" and not error:
                asked = json.loads(result)
                continue  # a question is not a lookup; it gets its own frame
            yield {"t": "tool", "name": call["name"], "args": call["arguments"],
                   "rows": rows, "error": error, "card": card}
        if asked is not None:
            # The turn ends here: the answer arrives as their next message.
            for piece in pending_text:
                yield {"t": "delta", "d": piece}
            if joined:
                full_text.append(joined)
            transcript.assistant_text(joined)
            yield {"t": "ask", **asked}
            break
        transcript.tool_round(calls)
    else:
        note = "I stopped after several rounds of looking things up."
        full_text.append(note)
        yield {"t": "delta", "d": "\n" + note}

    yield {
        "t": "final",
        "text": "\n\n".join(t for t in full_text if t.strip()),
        "messages": transcript.messages,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
    }
