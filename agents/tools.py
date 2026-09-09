"""The tools an assistant sees, and what each one does.

Read tools are always available once the feature is on. Write tools appear
only when the tenant's writes switch is on *and* the token is not
read-only - a read-scope token is refused at the authentication layer
anyway, so hiding them just stops the assistant trying.

Every tool ends up in :mod:`agents.dispatch`, which calls the real
viewsets; nothing here touches the ORM or builds SQL.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from django.utils import timezone

from . import dispatch
from .dispatch import ToolError

STR = {"type": "string"}
INT = {"type": "integer"}


@dataclass(frozen=True)
class Tool:
    name: str
    title: str
    description: str
    schema: dict
    run: Callable[..., Any]
    writes: bool = False
    required: tuple[str, ...] = field(default=())

    def spec(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": {
                "type": "object",
                "properties": self.schema,
                "required": list(self.required),
            },
            "annotations": {
                "readOnlyHint": not self.writes,
                "destructiveHint": self.name == "delete",
            },
        }


# ─── read tools ─────────────────────────────────────────────────────────────

def _types(ctx, **_kw) -> dict:
    """Which types this token can read, with how many rows it can see."""
    allowed = [dispatch._normalise(t) for t in (ctx.settings.allowed_types or [])]
    out = []
    for slug in dispatch.known_types():
        if allowed and slug not in allowed:
            continue
        if not dispatch.can(ctx.user, ctx.tenant, slug, "view"):
            continue
        out.append({"type": slug, "count": dispatch.visible_count(ctx.user, ctx.tenant, slug)})
    return {"types": out, "writes_enabled": ctx.writes_enabled}


def _search(ctx, q: str = "", type: str = "", limit: int = 20, **_kw) -> dict:
    """The product's own ranked search, so results match the palette."""
    from rest_framework.test import APIRequestFactory, force_authenticate

    from api.search_views import search as search_view

    if not q.strip():
        raise ToolError("Pass something to search for.")
    params = {"q": q, "limit": min(int(limit or 20), ctx.max_rows)}
    if type:
        params["type"] = dispatch._normalise(type)
    request = APIRequestFactory().get("/api/search/", params)
    force_authenticate(request, user=ctx.user, token=ctx.token)
    response = search_view(request)
    if hasattr(response, "render") and not getattr(response, "is_rendered", True):
        response.render()
    if response.status_code >= 400:
        raise ToolError(str((response.data or {}).get("detail") or "Search failed."))
    data = response.data or {}
    hits = [
        {k: h.get(k) for k in ("type", "type_label", "id", "title", "subtitle", "context")}
        for h in data.get("hits", [])
    ]
    return {"query": q, "total": data.get("total", len(hits)), "hits": hits}


def _get(ctx, type: str = "", id: str = "", **_kw) -> dict:
    return dispatch.get_object(ctx.principal, type, id, settings_row=ctx.settings)


def _as_filters(value) -> dict:
    """Filters, whether they arrived as an object or as JSON in a string.

    A model that hands back `'{"device_id": "..."}'` meant the object; a
    crash on `.items()` teaches it nothing and costs a turn.
    """
    if value in (None, ""):
        return {}
    if isinstance(value, str):
        import json

        text = value.strip()
        # A stray closing brace is the common mangling; try the text as sent
        # first, then once more without it.
        for candidate in (text, text.rstrip("}") + "}"):
            try:
                value = json.loads(candidate)
                break
            except ValueError:
                continue
    if not isinstance(value, dict):
        raise ToolError('`filters` must be an object, e.g. {"site": "Aarhus"}.')
    return value


def _list(ctx, type: str = "", filters: dict | None = None, limit: int | None = None,
          cursor: int = 0, **_kw) -> dict:
    cap = min(int(limit or ctx.max_rows), ctx.max_rows)
    return dispatch.list_objects(
        ctx.principal, type, _as_filters(filters), limit=cap, cursor=int(cursor or 0),
        settings_row=ctx.settings,
    )


def _count(ctx, type: str = "", group_by: str = "", filters=None, **_kw) -> dict:
    """How many, optionally broken down by a field.

    One call answers "which site has the most devices", which otherwise
    costs a list per site and burns the whole conversation.
    """
    result = dispatch.list_objects(
        ctx.principal, type, _as_filters(filters), limit=dispatch.FETCH_CAP,
        settings_row=ctx.settings,
    )
    rows = result["rows"]
    if not group_by:
        return {"type": result["type"], "count": result["total"]}

    buckets: dict[str, int] = {}
    for row in rows:
        value = row.get(group_by)
        if value is None:
            value = row.get(f"{group_by}_name")
        if isinstance(value, dict):
            value = value.get("name") or value.get("display") or value.get("id")
        buckets[str(value) if value not in (None, "") else "(none)"] = (
            buckets.get(str(value) if value not in (None, "") else "(none)", 0) + 1
        )
    ordered = sorted(buckets.items(), key=lambda kv: (-kv[1], kv[0]))
    return {
        "type": result["type"],
        "count": len(rows),
        "group_by": group_by,
        "groups": [{"value": k, "count": v} for k, v in ordered[:60]],
    }


# Types with a tool that beats writing the payload by hand. Cable ends are
# a list of {kind, id}, and every attempt to build one from the field list
# has gone wrong; `connect` takes the names instead.
_TYPE_TOOLS = {
    "cable": "Use the `connect` tool to cable two ports; do not build a cable "
             "payload from these fields.",
}


def _explain(ctx, type: str = "", **_kw) -> dict:
    """A type's fields and what this token may do with it.

    Read off the serializer, so every type is described - the bulk-edit
    allow list only covers a handful, and reporting "no fields" made the
    assistant conclude it could not write at all.
    """
    slug, prefix, viewset = dispatch.resolve(type, ctx.settings)
    model = viewset.queryset.model
    fields = []
    try:
        serializer = viewset.serializer_class()
        for name, field in serializer.fields.items():
            if name in ("permissions", "custom_fields", "tags", "tag_ids"):
                continue
            fields.append({
                "name": name,
                # `type` is this tool's own argument name, so the builtin is
                # shadowed here - read the class off the object instead.
                "kind": field.__class__.__name__.replace("Field", "").lower() or "text",
                "writable": not field.read_only,
                "required": bool(field.required and not field.read_only),
                **({"options": list(field.choices)[:20]}
                   if getattr(field, "choices", None) else {}),
                # The serializer's own help text. A nested shape - a list of
                # termination dicts, say - is otherwise just "list", and the
                # assistant has to guess what goes in it.
                **({"help": str(field.help_text)}
                   if getattr(field, "help_text", None) else {}),
            })
    except Exception:  # noqa: BLE001 - fall back to the model's own fields
        fields = [
            {"name": f.name, "kind": f.get_internal_type().replace("Field", "").lower(),
             "writable": f.editable, "required": not f.blank}
            for f in model._meta.concrete_fields
        ]
    actions = [
        a for a in ("view", "add", "change", "delete")
        if dispatch.can(ctx.user, ctx.tenant, slug, a)
    ]
    writable = [f["name"] for f in fields if f["writable"]]
    return {
        "type": slug,
        "label": model._meta.verbose_name.title(),
        "endpoint": f"/api/{prefix}/",
        "you_may": actions,
        "fields": fields,
        "writable_fields": writable,
        "note": (
            "Send only the fields you want to change. A field ending in _id "
            "takes an object's id; `list` and `search` return ids. Fields not "
            "marked writable are set by Danbyte."
        ),
        **({"instead": _TYPE_TOOLS[slug]} if slug in _TYPE_TOOLS else {}),
    }


def _where_is(ctx, type: str = "", id: str = "", **_kw) -> dict:
    """Where an object physically or logically lives."""
    obj = dispatch.get_object(ctx.principal, type, id, settings_row=ctx.settings)["object"]
    keys = ("name", "site", "site_name", "location", "location_name", "rack", "rack_name",
            "position", "face", "cluster", "cluster_name", "device", "device_name",
            "primary_ip", "primary_ip_address", "oob_ip", "tenant_name", "address",
            "prefix", "vrf_name")
    return {"type": type, "where": {k: obj[k] for k in keys if obj.get(k) not in (None, "")}}


def _monitoring_status(ctx, type: str = "", id: str = "", **_kw) -> dict:
    """Check state and open alerts for a device, VM, IP or prefix."""
    obj = dispatch.get_object(ctx.principal, type, id, settings_row=ctx.settings)["object"]
    keys = ("name", "address", "status", "status_name", "monitoring", "check_status",
            "last_seen", "alerts", "alert_count", "reachable", "snmp")
    return {"type": type, "monitoring": {k: obj[k] for k in keys if k in obj}}


def _changes(ctx, type: str = "", id: str = "", since: str = "", limit: int = 20,
             **_kw) -> dict:
    """Change-log entries for one object: who, when, and what moved."""
    from audit.models import ChangeLogEntry

    slug, _prefix, viewset = dispatch.resolve(type, ctx.settings)
    model = viewset.queryset.model
    found = dispatch.get_object(ctx.principal, slug, id, settings_row=ctx.settings)["object"]
    qs = ChangeLogEntry.objects.filter(
        object_type=model._meta.label_lower, object_id=str(found.get("id"))
    )
    if ctx.tenant is not None:
        qs = qs.filter(tenant=ctx.tenant)
    if since:
        cutoff = _since(since)
        if cutoff is not None:
            qs = qs.filter(timestamp__gte=cutoff)
    entries = [
        {
            "at": e.timestamp.isoformat(),
            "who": e.user_name or "system",
            "action": e.action,
            "via": e.via,
            "changes": {k: v for k, v in (e.changes or {}).items()},
        }
        for e in qs.order_by("-timestamp")[: min(int(limit or 20), ctx.max_rows)]
    ]
    return {"type": slug, "object": found.get("name") or str(found.get("id")),
            "entries": entries, "returned": len(entries)}


def _since(text: str):
    """Accept an ISO timestamp or a plain "7d" / "48h"."""
    text = str(text).strip().lower()
    if not text:
        return None
    if text[-1] in "hd" and text[:-1].isdigit():
        amount = int(text[:-1])
        delta = timedelta(hours=amount) if text[-1] == "h" else timedelta(days=amount)
        return timezone.now() - delta
    from django.utils.dateparse import parse_datetime

    parsed = parse_datetime(text)
    if parsed and timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed)
    return parsed


def _lifecycle(ctx, before: str = "", limit: int | None = None, **_kw) -> dict:
    """Device types past or approaching end of sale or support."""
    cap = min(int(limit or ctx.max_rows), ctx.max_rows)
    cutoff = _since(before) if before else None
    horizon = (cutoff or (timezone.now() + timedelta(days=365))).date()
    result = dispatch.list_objects(
        ctx.principal, "devicetype", {"limit": cap * 4}, limit=cap * 4,
        settings_row=ctx.settings,
    )
    out = []
    for row in result["rows"]:
        eos, eol = row.get("end_of_sale"), row.get("end_of_support")
        if not eos and not eol:
            continue
        soonest = min([d for d in (eos, eol) if d], default=None)
        if soonest and str(soonest) <= str(horizon):
            out.append({
                "type": row.get("model") or row.get("name"),
                "manufacturer": row.get("manufacturer_name"),
                "end_of_sale": eos, "end_of_support": eol,
                "device_count": row.get("device_count"),
            })
    out.sort(key=lambda r: str(r.get("end_of_support") or r.get("end_of_sale")))
    return {"before": str(horizon), "types": out[:cap], "returned": len(out[:cap])}


def _sdk_surface() -> dict:
    """The SDK read off the package, so this cannot drift from the code."""
    import inspect

    from danbyte_sdk import Client, Run

    def members(cls) -> list[dict]:
        out = []
        for name, member in vars(cls).items():
            if name.startswith("_"):
                continue
            if isinstance(member, property):
                out.append(_entry(name, member.fget))
                continue
            if not callable(member):
                continue
            signature = str(inspect.signature(member)).replace("self, ", "", 1)
            out.append(_entry(f"{name}{signature}", member))
        return out

    return {"db": members(Client), "run": members(Run)}


def _entry(call: str, func) -> dict:
    """A call and its first docstring sentence, when it has one."""
    doc = " ".join((func.__doc__ or "").split())
    what = doc.split(". ")[0].rstrip(".") if doc else ""
    return {"call": call, "what": what} if what else {"call": call}


def _script_guide(ctx, **_kw) -> dict:
    """How to write a Danbyte script, so the assistant does not invent an API."""
    from scripting.models import (
        DEFAULT_TIMEOUT,
        LANGUAGES,
        MAX_TIMEOUT,
        RUN_AS,
        TOKEN_SCOPES,
        VISIBILITY,
    )
    from scripting.serializers import PARAM_TYPES

    may_write = dispatch.can(ctx.user, ctx.tenant, "script", "add") and ctx.writes_enabled
    return {
        "what": (
            "Danbyte stores and runs Python scripts. A person opens one at "
            "/scripts, fills in its parameters and runs it; runs keep their log, "
            "exit code and any files the script wrote."
        ),
        "you_may": (
            "Write the script and save it with `create`. You cannot run it - the "
            "person runs it from its page, and sees the log there."
            if may_write else
            "You can read scripts but not save one. Show the person the code and "
            "tell them to paste it into a new script at /scripts."
        ),
        "runtimes": {
            "sandboxed": (
                "The default. The script gets `db`, an HTTP client on a "
                "short-lived token with exactly the caller's access. No ORM, no "
                "network beyond Danbyte."
            ),
            "trusted": (
                "Adds `orm` for direct database access. Only a person holding the "
                "script `trust` permission can turn this on, so write for `db` - "
                "the same code keeps working if it is later trusted."
            ),
        },
        "sdk": {
            "import": "from danbyte_sdk import db, run",
            "note": (
                "Standard library plus danbyte_sdk. `db` types are plural API "
                "paths: 'devices', 'interfaces', 'prefixes'."
            ),
            **_sdk_surface(),
        },
        "params_schema": {
            "what": "Renders the Run dialog; the answers arrive as run.params.",
            "shape": [{
                "name": "site", "label": "Site", "type": "string",
                "required": True, "default": "", "choices": [], "help": "",
            }],
            "types": list(PARAM_TYPES),
            "note": ("A `choice` needs its `choices`; an `object_type` (say "
                     "\"device\") makes the field a picker of what exists."),
        },
        "fields": {
            "language": [c[0] for c in LANGUAGES],
            "visibility": [c[0] for c in VISIBILITY],
            "run_as": [c[0] for c in RUN_AS],
            "token_scope": [c[0] for c in TOKEN_SCOPES],
            "timeout_seconds": {"default": DEFAULT_TIMEOUT, "max": MAX_TIMEOUT},
        },
        "create_with": {
            "tool": "create",
            "type": "script",
            "payload": {
                "name": "Devices without a serial",
                "description": "One line saying what it reports.",
                "source": "<the code>",
                "params_schema": [],
                "timeout_seconds": DEFAULT_TIMEOUT,
                "visibility": "owner",
            },
        },
        "example": (
            "from danbyte_sdk import db, run\n"
            "\n"
            "site = run.param('site', '')\n"
            "devices = db.list('devices', **({'site': site} if site else {}))\n"
            "missing = [d for d in devices if not d.get('serial')]\n"
            "run.log(f'{len(missing)} of {len(devices)} device(s) have no serial')\n"
            "run.output_csv('missing-serials.csv', missing,\n"
            "               fields=['name', 'site_name', 'device_type_model'])\n"
        ),
        "rules": [
            "Call `explain` with type 'script' for the exact fields a script row takes.",
            "Print progress with run.log, not print, so the run log is timestamped.",
            "End a bad run with run.fail('why'), not sys.exit.",
            "Write files with run.output/output_csv/output_json - they attach to the run.",
            "Ask what the script should do before writing it if the request is vague.",
        ],
    }


def _ask_user(ctx, question: str = "", options=None, fields=None, questions=None,
              **_kw) -> dict:
    """Put a question back to the person and stop.

    Takes either one question (``question`` plus ``options``/``fields``) or
    several (``questions``). More than one becomes a short step-by-step
    form, so a person answers one thing at a time instead of facing a wall.
    The turn ends here; the answers arrive as their next message.
    """
    steps: list[dict] = []

    def add(title: str, name: str, options_in=None, field=None) -> None:
        step: dict = {
            "name": (name or f"q{len(steps) + 1}")[:40],
            "title": str(title or "").strip()[:300],
            "choices": [],
            "endpoint": "",
            "object_type": "",
            "placeholder": "",
            "free_text": False,
        }
        for option in list(options_in or [])[:6]:
            if isinstance(option, dict):
                label = str(option.get("label") or option.get("value") or "").strip()
                hint = str(option.get("hint") or option.get("description") or "").strip()
            else:
                label, hint = str(option).strip(), ""
            if label:
                step["choices"].append({"label": label[:120], "hint": hint[:160]})
        if field is not None:
            step["free_text"] = True
            step["placeholder"] = str(field.get("placeholder") or "")[:80]
            wanted = str(field.get("object_type") or "").strip()
            if wanted:
                try:
                    slug, prefix, _viewset = dispatch.resolve(wanted, ctx.settings)
                    step["object_type"] = slug
                    step["endpoint"] = f"/api/{prefix}/"
                except ToolError:
                    pass
        if step["title"] and (step["choices"] or step["free_text"]):
            steps.append(step)

    for entry in list(questions or [])[:6]:
        if not isinstance(entry, dict):
            continue
        has_field = bool(entry.get("object_type") or entry.get("free_text")
                         or entry.get("placeholder"))
        add(entry.get("title") or entry.get("question"), entry.get("name"),
            entry.get("options") or entry.get("choices"),
            entry if has_field and not entry.get("options") else None)

    if not steps:
        add(question, "choice", options, None)
        for entry in list(fields or [])[:4]:
            if isinstance(entry, dict) and entry.get("name"):
                add(entry.get("label") or entry["name"], entry["name"], None, entry)
            elif isinstance(entry, str):
                add(entry, entry, None, {})

    return {
        "asked": str(question or (steps[0]["title"] if steps else "")).strip()[:500],
        "steps": steps,
    }


# ─── write tools ────────────────────────────────────────────────────────────

def _create(ctx, type: str = "", payload: dict | None = None, **_kw) -> dict:
    return dispatch.create_object(ctx.principal, type, payload or {}, settings_row=ctx.settings)


# A cable end is {kind, id}, and the kinds are the serializer's own. Each
# maps to the type this module already knows how to look a port up in.
_CABLE_KINDS = {
    "interface": "interface",
    "front_port": "frontport",
    "rear_port": "rearport",
    "console_port": "consoleport",
    "console_server_port": "consoleserverport",
    "power_port": "powerport",
    "power_outlet": "poweroutlet",
    "power_feed": "powerfeed",
    "aux_port": "auxport",
    "circuit_termination": "circuittermination",
}
# These do not hang off a device, so a device name is not asked for.
_DEVICELESS_KINDS = ("power_feed", "circuit_termination")


def _end(ctx, end: str, device: str, port: str, kind: str) -> dict:
    """One cable end, resolved from the names a person would use."""
    kind = (kind or "interface").strip().lower().replace("-", "_")
    slug = _CABLE_KINDS.get(kind)
    if slug is None:
        raise ToolError(
            f"'{kind}' is not a cable end. One of: {', '.join(sorted(_CABLE_KINDS))}."
        )
    port = str(port or "").strip()
    if not port:
        raise ToolError(f"Say which port on the {end} end.")
    filters: dict = {"name": port}
    if kind not in _DEVICELESS_KINDS:
        if not str(device or "").strip():
            raise ToolError(f"Say which device the {end} end is on.")
        filters["device"] = str(device).strip()
    found = dispatch.list_objects(
        ctx.principal, slug, filters, limit=2, settings_row=ctx.settings
    )
    rows = found["rows"]
    if len(rows) == 1:
        return {"kind": kind, "id": rows[0]["id"], "name": rows[0].get("name"), "on": device}
    if len(rows) > 1:
        raise ToolError(f"{device} has more than one {kind} called '{port}'.")
    raise ToolError(_no_such_port(ctx, slug, kind, device, port))


def _no_such_port(ctx, slug: str, kind: str, device: str, port: str) -> str:
    """Say what the device does have, so the next call can be right."""
    where = f"{device} has no {kind} '{port}'." if device else f"No {kind} '{port}'."
    if kind in _DEVICELESS_KINDS or not device:
        return where
    have = dispatch.list_objects(
        ctx.principal, slug, {"device": device}, limit=40, settings_row=ctx.settings
    )
    names = [str(r.get("name")) for r in have["rows"] if r.get("name")]
    if not names:
        return f"{where} It has no {kind}s at all."
    return f"{where} It has: {', '.join(names[:30])}."


def _connect(ctx, a_device: str = "", a_port: str = "", b_device: str = "", b_port: str = "",
             a_kind: str = "interface", b_kind: str = "interface", type: str = "",
             label: str = "", status: str = "", **_kw) -> dict:
    """Cable two ports together, named the way a person names them.

    A cable's ends are a list of ``{kind, id}``, which an assistant has to
    get exactly right after four lookups. This asks for the two device and
    port names instead and does the resolving here, so the whole class of
    malformed-termination failures cannot happen.
    """
    a = _end(ctx, "A", a_device, a_port, a_kind)
    b = _end(ctx, "B", b_device, b_port, b_kind)
    payload = {
        "a": [{"kind": a["kind"], "id": a["id"]}],
        "b": [{"kind": b["kind"], "id": b["id"]}],
    }
    if type:
        payload["type"] = type
    if label:
        payload["label"] = label
    if status:
        payload["status"] = status
    result = dispatch.create_object(ctx.principal, "cable", payload, settings_row=ctx.settings)
    result["connected"] = (
        f"{a['on'] or a['name']} {a['name']} to {b['on'] or b['name']} {b['name']}"
    )
    return result


def _terminate(ctx, circuit: str = "", side: str = "", site: str = "",
               provider_network: str = "", **fields) -> dict:
    """Land one end of a circuit at a site, by name.

    A circuit is connected to nothing until both ends exist, and the
    payload needs two ids the assistant has just read as names. Cable the
    termination to a port afterwards with `connect`, kind
    `circuit_termination`.
    """
    end = str(side or "").strip().upper()
    if end not in ("A", "Z"):
        raise ToolError("`side` is \"A\" or \"Z\".")
    if not (site or provider_network):
        raise ToolError("Say where it lands: a `site` or a `provider_network`.")

    payload = {
        "circuit_id": dispatch.id_of(ctx.principal, "circuit", circuit, ctx.settings),
        "term_side": end,
    }
    if site:
        payload["site_id"] = dispatch.id_of(ctx.principal, "site", site, ctx.settings)
    if provider_network:
        payload["provider_network_id"] = dispatch.id_of(
            ctx.principal, "providernetwork", provider_network, ctx.settings
        )
    for key in ("port_speed_kbps", "upstream_speed_kbps", "xconnect_id", "pp_info",
                "description"):
        if fields.get(key) not in (None, ""):
            payload[key] = fields[key]
    return dispatch.create_object(
        ctx.principal, "circuittermination", payload, settings_row=ctx.settings
    )


def _update(ctx, type: str = "", id: str = "", payload: dict | None = None, **_kw) -> dict:
    return dispatch.update_object(
        ctx.principal, type, id, payload or {}, settings_row=ctx.settings
    )


def _delete(ctx, type: str = "", id: str = "", confirm: str = "", **_kw) -> dict:
    return dispatch.delete_object(ctx.principal, type, id, confirm, settings_row=ctx.settings)


TOOLS: tuple[Tool, ...] = (
    Tool(
        "types", "List object types",
        "The object types this token can read, with how many rows it can see. "
        "Start here when you do not know what Danbyte holds.",
        {}, _types,
    ),
    Tool(
        "search", "Search",
        "Danbyte's ranked search across every indexed object - the same one the "
        "web app's palette uses. Narrowing tokens work inside the query: "
        "`type:device site:aarhus role:core`. Use this to find an object before "
        "calling `get`.",
        {"q": STR, "type": STR, "limit": INT}, _search, required=("q",),
    ),
    Tool(
        "get", "Get one object",
        "One object in full, by id or by exact name.",
        {"type": STR, "id": STR}, _get, required=("type", "id"),
    ),
    Tool(
        "list", "List objects",
        "Rows of one type, with the same filters the web app uses (for example "
        "{'site': 'aarhus', 'status': 'active'}). Results are capped; when "
        "`truncated` is true, call again with `cursor` set to `next_cursor`.",
        {"type": STR, "filters": {"type": "object"}, "limit": INT, "cursor": INT},
        _list, required=("type",),
    ),
    Tool(
        "count", "Count objects",
        "How many objects of a type, optionally grouped by a field: "
        "`count(type=\"device\", group_by=\"site\")` answers which site has the "
        "most in one call. Use this instead of listing a type once per site.",
        {"type": STR, "group_by": STR, "filters": {"type": "object"}},
        _count, required=("type",),
    ),
    Tool(
        "explain", "Describe a type",
        "A type's fields, their kinds and the actions this token may take on it. "
        "Call this before writing, so the payload matches what Danbyte expects.",
        {"type": STR}, _explain, required=("type",),
    ),
    Tool(
        "where_is", "Locate an object",
        "Where an object sits: site, location, rack and unit, cluster and host, "
        "and its primary address.",
        {"type": STR, "id": STR}, _where_is, required=("type", "id"),
    ),
    Tool(
        "monitoring_status", "Monitoring state",
        "Live check state, last seen and open alerts for a device, virtual "
        "machine, IP address or prefix.",
        {"type": STR, "id": STR}, _monitoring_status, required=("type", "id"),
    ),
    Tool(
        "changes", "Change history",
        "Change-log entries for one object: who changed what, when, and through "
        "which surface. `since` takes an ISO timestamp or a shorthand like 48h "
        "or 7d.",
        {"type": STR, "id": STR, "since": STR, "limit": INT},
        _changes, required=("type", "id"),
    ),
    Tool(
        "lifecycle", "Hardware lifecycle",
        "Device types whose end of sale or end of support falls before a date "
        "(default: within a year).",
        {"before": STR, "limit": INT}, _lifecycle,
    ),
    Tool(
        "script_guide", "How to write a Danbyte script",
        "Danbyte runs saved Python scripts (/scripts). This returns the SDK a "
        "script may import, the fields a script row takes and a worked example. "
        "Call it before writing or changing a script, so the code uses the real "
        "API rather than an invented one.",
        {}, _script_guide,
    ),
    Tool(
        "ask_user", "Ask the person a question",
        "Stop and ask before doing work whose shape you are guessing at - a "
        "naming scheme, which site, whether to go ahead with many changes.\n"
        "Ask everything you need in this one call. `questions` takes a list, "
        "each `{name, title, options}` for a choice or "
        "`{name, title, object_type|placeholder}` for something they supply; "
        "an `object_type` (say \"devicetype\") becomes a searchable list of "
        "what exists, so they pick rather than spell. Two or more become a "
        "short step-by-step form. Keep each title to one line. Say nothing "
        "else in that turn: the answers come back as their next message.",
        {"question": STR,
         "options": {"type": "array", "items": {"type": "string"}},
         "fields": {"type": "array", "items": {"type": "object"}},
         "questions": {"type": "array", "items": {"type": "object"}}},
        _ask_user, required=("question",),
    ),
    Tool(
        "create", "Create an object",
        "Create one object. The payload is what the API expects - call `explain` "
        "first if you are unsure. The change is recorded under this token's "
        "account.",
        {"type": STR, "payload": {"type": "object"}}, _create,
        writes=True, required=("type", "payload"),
    ),
    Tool(
        "connect", "Cable two ports",
        "Cable one port to another by name: "
        "`connect(a_device=\"aalborg-sw1\", a_port=\"Gi1/0/3\", "
        "b_device=\"aalborg-fw1\", b_port=\"ethernet1/3\")`. Use this for every "
        "cable - never build a cable payload by hand. `a_kind`/`b_kind` default "
        "to interface; the others are front_port, rear_port, console_port, "
        "console_server_port, power_port, power_outlet, power_feed, aux_port and "
        "circuit_termination. If a port name is wrong the refusal lists the ones "
        "the device has.",
        {"a_device": STR, "a_port": STR, "b_device": STR, "b_port": STR,
         "a_kind": STR, "b_kind": STR, "type": STR, "label": STR, "status": STR},
        _connect, writes=True, required=("a_port", "b_port"),
    ),
    Tool(
        "terminate", "Land a circuit end",
        "Give a circuit its A or Z end at a site, by name: "
        "`terminate(circuit=\"NX-4471\", side=\"Z\", site=\"K\u00f8benhavn HQ\")`. "
        "A circuit reaches nowhere until both ends exist. To join that end to a "
        "port, call `connect` with `a_kind=\"circuit_termination\"`.",
        {"circuit": STR, "side": STR, "site": STR, "provider_network": STR,
         "port_speed_kbps": INT, "upstream_speed_kbps": INT, "xconnect_id": STR,
         "pp_info": STR, "description": STR},
        _terminate, writes=True, required=("circuit", "side"),
    ),
    Tool(
        "update", "Update an object",
        "Change fields on one object. Send only the fields that change.",
        {"type": STR, "id": STR, "payload": {"type": "object"}}, _update,
        writes=True, required=("type", "id", "payload"),
    ),
    Tool(
        "delete", "Delete an object",
        "Delete one object. `confirm` must be the object's own name, so a "
        "mistaken instruction cannot remove the wrong row.",
        {"type": STR, "id": STR, "confirm": STR}, _delete,
        writes=True, required=("type", "id", "confirm"),
    ),
)

BY_NAME = {t.name: t for t in TOOLS}


def available(*, writes: bool) -> list[Tool]:
    return [t for t in TOOLS if writes or not t.writes]
