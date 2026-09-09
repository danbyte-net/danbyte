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


def _list(ctx, type: str = "", filters: dict | None = None, limit: int | None = None,
          cursor: int = 0, **_kw) -> dict:
    cap = min(int(limit or ctx.max_rows), ctx.max_rows)
    return dispatch.list_objects(
        ctx.principal, type, filters or {}, limit=cap, cursor=int(cursor or 0),
        settings_row=ctx.settings,
    )


def _count(ctx, type: str = "", group_by: str = "", filters=None, **_kw) -> dict:
    """How many, optionally broken down by a field.

    One call answers "which site has the most devices", which otherwise
    costs a list per site and burns the whole conversation.
    """
    result = dispatch.list_objects(
        ctx.principal, type, filters or {}, limit=dispatch.FETCH_CAP,
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


def _ask_user(ctx, question: str = "", options=None, fields=None, **_kw) -> dict:
    """Put a question back to the person and stop.

    The loop turns this into a small form in the chat and ends the turn; the
    answer arrives as their next message. This is how a bulk change gets a
    naming scheme agreed before anything is written, instead of after.
    """
    clean_options = []
    for option in list(options or [])[:6]:
        if isinstance(option, dict):
            label = str(option.get("label") or option.get("value") or "").strip()
            hint = str(option.get("hint") or option.get("description") or "").strip()
        else:
            label, hint = str(option).strip(), ""
        if label:
            clean_options.append({"label": label[:120], "hint": hint[:160]})
    clean_fields = []
    for entry in list(fields or [])[:4]:
        if isinstance(entry, dict) and entry.get("name"):
            clean_fields.append({
                "name": str(entry["name"])[:40],
                "label": str(entry.get("label") or entry["name"])[:80],
                "placeholder": str(entry.get("placeholder") or "")[:80],
            })
        elif isinstance(entry, str):
            clean_fields.append({"name": entry[:40], "label": entry[:80], "placeholder": ""})
    return {
        "asked": str(question or "").strip()[:500],
        "options": clean_options,
        "fields": clean_fields,
    }


# ─── write tools ────────────────────────────────────────────────────────────

def _create(ctx, type: str = "", payload: dict | None = None, **_kw) -> dict:
    return dispatch.create_object(ctx.principal, type, payload or {}, settings_row=ctx.settings)


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
        "ask_user", "Ask the person a question",
        "Stop and ask before doing work whose shape you are guessing at - a "
        "naming scheme, which site, whether to go ahead with many changes. "
        "Give 2-4 concrete `options` they can pick, and `fields` for anything "
        "they must type. Say nothing else in that turn: their answer comes "
        "back as the next message.",
        {"question": STR,
         "options": {"type": "array", "items": {"type": "string"}},
         "fields": {"type": "array", "items": {"type": "string"}}},
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
