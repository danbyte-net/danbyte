"""Global search endpoint (#89) - one ranked query over the search index.

``GET /api/search/?q=<query>&type=<slug>&limit=<n>&cursor=<offset>``

Matching runs on the ``danbyte_fold()`` form of each row's title and body
(lowercase, accents stripped; stored as ``title_f`` / ``body_f``) with
trigram similarity plus substring tests, so ``aarhus`` finds ``Århus DC`` and
a near-miss still ranks. Ranking: exact folded title > title prefix > word
start > substring > trigram similarity, plus the row's type weight.
Special forms rank first: an IP or CIDR also lists the prefixes containing
it, an all-digit query matches the short id exactly, and a whole MAC in any
notation finds every row carrying it plus the port it is located on (#284).

``key:value`` tokens narrow the query: ``type:device site:esbjerg
role:firewall status:active tag:core``. Every hit is re-checked against the
caller's RBAC row scope for its type before it is returned.
"""
from __future__ import annotations

import ipaddress
import json
import re
import shlex

from django.db import connection
from django.db.models.expressions import RawSQL
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from auth_api import rbac
from auth_api.object_types import model_for, registry_payload

from .search_index import SPECS, fold
from .views import _get_active_tenant

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
#: Ranked candidates fetched before RBAC and paging.
CANDIDATES = 300

_TOKEN_KEYS = ("type", "site", "role", "status", "tag", "platform", "vrf", "cluster",
               "provider", "manufacturer", "group", "rir", "region", "rack", "vlan")

_TYPE_ALIASES = {
    "ip": "ipaddress", "ips": "ipaddress", "address": "ipaddress",
    "vm": "virtualmachine", "vms": "virtualmachine",
    "mac": "macaddress", "macs": "macaddress",
    "range": "iprange", "ranges": "iprange",
    "stack": "virtualchassis", "stacks": "virtualchassis",
    "wlan": "wirelesslan", "ssid": "wirelesslan",
    "type": "devicetype", "types": "devicetype",
}


def _type_labels() -> dict[str, str]:
    return {e["slug"]: e["label"] for e in registry_payload()}


def _resolve_type(value: str) -> str | None:
    v = fold(value).replace(" ", "").replace("-", "").replace("_", "")
    if v in SPECS:
        return v
    if v in _TYPE_ALIASES:
        return _TYPE_ALIASES[v]
    for slug, label in _type_labels().items():
        lab = fold(label).replace(" ", "")
        if slug in SPECS and v in (lab, lab.rstrip("s"), slug + "s"):
            return slug
    if v.endswith("s") and v[:-1] in SPECS:
        return v[:-1]
    return None


def parse_query(raw: str) -> tuple[str, dict[str, list[str]]]:
    """``"core site:esbjerg type:device"`` → ``("core", {"site": ["esbjerg"],
    "type": ["device"]})``. Quoted values keep their spaces."""
    try:
        parts = shlex.split(raw)
    except ValueError:
        parts = raw.split()
    words, tokens = [], {}
    for part in parts:
        key, sep, value = part.partition(":")
        if sep and key.lower() in _TOKEN_KEYS and value:
            tokens.setdefault(key.lower(), []).append(fold(value))
        else:
            words.append(part)
    return " ".join(words).strip(), tokens


_RANK_SQL = """
SELECT e.object_type, e.object_id, e.title, e.subtitle, e.url, e.facets, e.numid, e.context,
       (CASE
          WHEN e.title_f = %(q)s THEN 4.0
          WHEN e.title_f LIKE %(prefix)s THEN 3.0
          WHEN e.title_f LIKE %(word)s THEN 2.5
          WHEN e.title_f LIKE %(sub)s THEN 2.0
          WHEN e.body_f LIKE %(sub)s THEN 1.0
          ELSE 0 END)
       + similarity(e.title_f, %(q)s)
       + 0.5 * similarity(e.body_f, %(q)s)
       + e.weight / 10.0
       + (CASE WHEN e.numid IS NOT NULL AND e.numid = %(numid)s THEN 5.0 ELSE 0 END)
       AS score
FROM api_searchentry e
WHERE (e.tenant_id = %(tenant)s OR (e.tenant_id IS NULL AND e.object_type = 'tag'))
  {type_clause}
  {facet_clause}
  AND ({match_clause})
ORDER BY score DESC, e.title ASC
LIMIT %(limit)s
"""

# Words: substring anywhere, or a trigram near-miss on the name.
_TEXT_MATCH = """e.title_f LIKE %(sub)s
       OR e.body_f LIKE %(sub)s
       OR e.title_f %% %(q)s
       OR (e.numid IS NOT NULL AND e.numid = %(numid)s)"""
# A term of one or two letters or digits has no trigram, so no index serves
# it and every row of the tenant is read (#300). Reading names is cheap;
# matching bodies and scoring the thousands of rows they add is not. So such
# a term first ranks only the rows whose name contains it (or whose short id
# it is). When that fills the candidates and the last one scores above
# _BODY_ONLY_MAX - the most a row matching only in its body, or only as a
# near-miss, can score: 1.0 for the body, 0.25 title similarity (a name
# without the term shares at most one of its trigrams), 0.5 body similarity
# and the heaviest type weight - the full match returns the same list, so
# it is not run.
_NAME_MATCH = """e.title_f LIKE %(sub)s
       OR (e.numid IS NOT NULL AND e.numid = %(numid)s)"""
_SHORT_TERM = 3
_BODY_ONLY_MAX = 1.0 + 0.25 + 0.5 + max(spec.weight for spec in SPECS.values()) / 10.0

# Addresses and numbers: the name must start with the query. Trigrams on
# "10.0.0.201" would drag in every 10.x address; containment adds the
# prefixes separately.
_ADDR_MATCH = """e.title_f LIKE %(prefix)s
       OR (e.numid IS NOT NULL AND e.numid = %(numid)s)"""
_ADDR_RE = re.compile(r"^[0-9a-f.:/\-]+$")

_BROWSE_SQL = """
SELECT e.object_type, e.object_id, e.title, e.subtitle, e.url, e.facets, e.numid, e.context,
       e.weight / 10.0 AS score
FROM api_searchentry e
WHERE (e.tenant_id = %(tenant)s OR (e.tenant_id IS NULL AND e.object_type = 'tag'))
  {type_clause}
  {facet_clause}
ORDER BY e.title ASC
LIMIT %(limit)s
"""


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def ranked_candidates(q: str, tokens: dict, tenant) -> list[dict]:
    """Top candidates from the index, before RBAC."""
    types = []
    for t in tokens.get("type", []):
        slug = _resolve_type(t)
        if slug:
            types.append(slug)
    params: dict = {"tenant": str(tenant.id), "limit": CANDIDATES}
    type_clause = ""
    if types:
        type_clause = "AND e.object_type = ANY(%(types)s)"
        params["types"] = types
    # A token value is a prefix of the facet's folded name or slug, so
    # ``site:aarhus`` finds "Århus DC" the way typing it into the box would.
    facet_bits = []
    for i, (key, values) in enumerate(tokens.items()):
        if key == "type":
            continue
        for j, v in enumerate(values):
            name = f"f{i}_{j}"
            facet_bits.append(
                "AND EXISTS (SELECT 1 FROM jsonb_array_elements_text("
                f"COALESCE(e.facets->%({name}_key)s, '[]'::jsonb)) fv "
                f"WHERE fv LIKE %({name})s)"
            )
            params[f"{name}_key"] = key
            params[name] = f"{_like(v)}%"
    facet_clause = " ".join(facet_bits)
    fq = fold(q)
    if not fq:
        if not tokens:
            return []
        return _fetch(_BROWSE_SQL.format(type_clause=type_clause, facet_clause=facet_clause),
                      params)
    like = _like(fq)
    params.update({
        "q": fq,
        "prefix": f"{like}%",
        "word": f"% {like}%",
        "sub": f"%{like}%",
        "numid": int(fq) if fq.isdigit() and len(fq) < 10 else -1,
    })
    clauses = {"type_clause": type_clause, "facet_clause": facet_clause}
    if _ADDR_RE.match(fq) and re.search(r"[.:/]", fq):
        return _fetch(_RANK_SQL.format(**clauses, match_clause=_ADDR_MATCH), params)
    if len(fq) < _SHORT_TERM and fq.isascii() and fq.isalnum():
        rows = _fetch(_RANK_SQL.format(**clauses, match_clause=_NAME_MATCH), params)
        if len(rows) == CANDIDATES and float(rows[-1]["score"]) > _BODY_ONLY_MAX:
            return rows
    return _fetch(_RANK_SQL.format(**clauses, match_clause=_TEXT_MATCH), params)


def _fetch(sql: str, params: dict) -> list[dict]:
    with connection.cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
    # A raw cursor returns jsonb as text; the ORM would have decoded it.
    for r in rows:
        for key in ("facets", "context"):
            if isinstance(r.get(key), str):
                try:
                    r[key] = json.loads(r[key])
                except ValueError:
                    r[key] = {}
    return rows


def _network_hits(q: str, tenant) -> list[dict]:
    """An IP or CIDR query also lists the prefixes that contain it."""
    from .models import Prefix

    try:
        net = ipaddress.ip_network(q.strip(), strict=False)
    except ValueError:
        return []
    qs = (
        Prefix.objects.filter(tenant=tenant)
        .annotate(_hit=RawSQL("cidr::inet >>= %s::inet", (str(net),)))
        .filter(_hit=True)
        .select_related("vrf")
        .order_by("-cidr")[:20]
    )
    out = []
    for p in qs:
        try:
            p_len = ipaddress.ip_network(str(p.cidr), strict=False).prefixlen
        except ValueError:
            p_len = 0
        out.append({
            "object_type": "prefix", "object_id": p.id, "title": str(p.cidr),
            "subtitle": f"contains {net}" if str(net) != str(p.cidr) else (p.description or ""),
            "url": f"/prefixes/{p.id}", "facets": {}, "numid": getattr(p, "numid", None),
            "context": {"vrf": p.vrf.name} if p.vrf_id else {},
            # An exact CIDR outranks everything; among containing prefixes the
            # most specific comes first.
            "score": 4.6 if str(net) == str(p.cidr) else 3.6 + p_len / 1000.0,
        })
    return out


# A whole MAC in the notations people paste: 3c:52:82:aa:10:44,
# 3C-52-82-AA-10-44, 3c52.82aa.1044, 3c5282-aa1044, 3c5282aa1044 (#284).
_MAC_QUERY = re.compile(
    r"^(?:[0-9a-f]{2}([:\-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}"
    r"|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}"
    r"|[0-9a-f]{6}-[0-9a-f]{6}"
    r"|[0-9a-f]{12})$",
    re.IGNORECASE,
)


def mac_query(q: str) -> str | None:
    """The canonical ``aa:bb:cc:dd:ee:ff`` form of a MAC-shaped query, else
    ``None``. Fragments wait for a later release."""
    q = (q or "").strip()
    if not _MAC_QUERY.match(q):
        return None
    key = re.sub(r"[^0-9a-f]", "", q.lower())
    return ":".join(key[i:i + 2] for i in range(0, 12, 2))


def _mac_hits(mac: str, tokens: dict, tenant, user) -> list[dict]:
    """Extra candidates for a MAC query: the same address in the notation the
    other indexes carry, and the port the MAC is located on - the first thing
    somebody pasting a MAC wants. The port is an ``interface`` row, so
    ``_allowed`` applies the caller's interface scope to it like any hit."""
    rows = ranked_candidates(mac.replace(":", ""), tokens, tenant)
    types = {_resolve_type(t) for t in tokens.get("type", [])}
    if types and "interface" not in types:
        return rows
    from monitoring.mac_location import locate

    loc = locate(tenant, [mac], user).get(mac)
    if loc is None or not loc.at.interface_id:
        return rows
    where = "learned here" if loc.kind == "access" else "behind uplink"
    vlan = f", VLAN {loc.at.vlan}" if loc.at.vlan else ""
    rows.append({
        "object_type": "interface", "object_id": loc.at.interface_id,
        "title": loc.at.interface_name or loc.at.port_name,
        "subtitle": f"{loc.at.device_name} · {where}{vlan}",
        "url": f"/interfaces/{loc.at.interface_id}", "facets": {}, "numid": None,
        "context": {"device": loc.at.device_name, "mac": mac},
        # Above an exact name match: this is the answer to the question.
        "score": 6.0,
    })
    return rows


def _allowed(rows: list[dict], user, tenant) -> list[dict]:
    """Keep the candidates the caller may view, per type, in one query each."""
    by_type: dict[str, list] = {}
    for r in rows:
        by_type.setdefault(r["object_type"], []).append(r["object_id"])
    ok: dict[str, set] = {}
    for slug, ids in by_type.items():
        if slug == "tag":
            ok[slug] = set(ids)
            continue
        model = model_for(slug)
        if model is None:
            continue
        if slug == "tenant":
            ok[slug] = {tenant.id} & set(ids)
            continue
        qs = rbac.restrict_queryset(model.objects.filter(pk__in=ids), user, tenant, slug, "view")
        ok[slug] = set(qs.values_list("pk", flat=True))
    return [r for r in rows if r["object_id"] in ok.get(r["object_type"], set())]


@extend_schema(
    summary="Global tenant-scoped search: one ranked list across every object type",
    tags=["search"],
    request=None,
    parameters=[
        OpenApiParameter(name="q", type=OpenApiTypes.STR, location=OpenApiParameter.QUERY,
                         description="Query text; key:value tokens (type:, site:, role:, "
                                     "status:, tag:, …) narrow it."),
        OpenApiParameter(name="type", type=OpenApiTypes.STR, location=OpenApiParameter.QUERY,
                         description="Object-type slug to restrict to (same as a type: token)."),
        OpenApiParameter(name="limit", type=OpenApiTypes.INT, location=OpenApiParameter.QUERY,
                         description=f"Page size (default {DEFAULT_LIMIT}, max {MAX_LIMIT})."),
        OpenApiParameter(name="cursor", type=OpenApiTypes.INT, location=OpenApiParameter.QUERY,
                         description="Offset from a previous response's next_cursor."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{q, total, hits:[{type, type_label, id, title, subtitle, url, score}], "
                    "facets:{types:[{type, label, count}]}, next_cursor}",
    ),
)
@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def search(request):
    raw = (request.query_params.get("q") or "").strip()
    try:
        limit = max(1, min(int(request.query_params.get("limit") or DEFAULT_LIMIT), MAX_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    try:
        offset = max(0, int(request.query_params.get("cursor") or 0))
    except (TypeError, ValueError):
        offset = 0

    q, tokens = parse_query(raw)
    type_param = (request.query_params.get("type") or "").strip()
    if type_param:
        tokens.setdefault("type", []).append(type_param)
    if not q and not tokens:
        return Response({"q": raw, "total": 0, "hits": [], "facets": {"types": []},
                         "next_cursor": None})

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")

    mac = mac_query(q)
    rows = ranked_candidates(mac or q, tokens, tenant)
    if mac:
        by_key = {(r["object_type"], r["object_id"]): r for r in rows}
        for h in _mac_hits(mac, tokens, tenant, request.user):
            cur = by_key.get((h["object_type"], h["object_id"]))
            if cur is None:
                by_key[(h["object_type"], h["object_id"])] = h
                rows.append(h)
            elif float(cur["score"]) < float(h["score"]):
                cur.update(score=h["score"], subtitle=h["subtitle"])
        rows.sort(key=lambda r: (-float(r["score"]), r["title"]))
    elif q and (not tokens.get("type") or "prefix" in tokens.get("type", [])):
        by_key = {(r["object_type"], r["object_id"]): r for r in rows}
        for h in _network_hits(q, tenant):
            cur = by_key.get((h["object_type"], h["object_id"]))
            if cur is None:
                rows.append(h)
            elif float(cur["score"]) < h["score"]:
                cur["score"], cur["subtitle"] = h["score"], h["subtitle"]
        rows.sort(key=lambda r: (-float(r["score"]), r["title"]))
    rows = _allowed(rows, request.user, tenant)

    labels = _type_labels()
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["object_type"]] = counts.get(r["object_type"], 0) + 1
    facets = {
        "types": [
            {"type": t, "label": labels.get(t, t), "count": n}
            for t, n in sorted(counts.items(), key=lambda kv: -kv[1])
        ]
    }
    page = rows[offset : offset + limit]
    hits = [
        {
            "type": r["object_type"],
            "type_label": labels.get(r["object_type"], r["object_type"]),
            "id": str(r["object_id"]),
            "title": r["title"],
            "subtitle": r["subtitle"] or "",
            "url": r["url"],
            "score": round(float(r["score"]), 3),
            "numid": r.get("numid"),
            "context": r.get("context") or {},
        }
        for r in page
    ]
    body = {
        "q": raw,
        "total": len(rows),
        "hits": hits,
        "facets": facets,
        "next_cursor": offset + limit if offset + limit < len(rows) else None,
    }
    if mac:
        # The palette offers "Look up MAC …" for this address.
        body["mac"] = mac
    return Response(body)

