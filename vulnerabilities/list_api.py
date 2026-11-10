"""The Vulnerabilities page's two lists (#451): one row per record
(``GET /api/vulnerabilities/``) and one row per match
(``GET /api/vulnerabilities/matches/``), paged, sorted and faceted on the
server the way ``api.list_table`` does it for the big inventory lists, so the
SPA's ``useServerList`` drives both.

On top of the plain filters of ``match_api._filter_matches`` (``status``,
``priority``, ``severity``, ``kev``, ``epss_min``, ``site``, ``platform``,
``application``, ``q``, …) each list takes:

* ``search`` - the list's search box, as ``q``;
* ``f_<facet>=a,b`` - the rail's selection (``lib/url-filters`` codec):
  ``priority``, ``severity`` (``unscored`` for no score), ``kev``
  (``yes``/``no``), ``first_seen`` (``7d``/``30d``/``older``), ``site``,
  ``platform``, ``application``, ``epss`` (a range, ``0.5..`` - EPSS is
  0 to 1); the match list also ``confidence`` and ``via``. Values in one
  facet OR, facets AND;
* ``ordering=<column>`` or ``-<column>``.

``<list>/facets/`` answers ``{facets: {id: [{value, label, count}]},
sortable: [...]}``; each facet counts what every other filter leaves. The
record list counts records, the match list matches. Both are scoped like the
lists: the active tenant, the matches whose device or VM (and install) the
caller may see.

Matches an exception covers are left out unless the ``excepted`` facet
asks for them (``yes``: only those, ``yes,no``: both), or the plain
``excepted=true|all`` parameter does. A record row counts its live matches
and says how many are excepted (``excepted``).
"""
from __future__ import annotations

import datetime
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from django.db.models import Count, F, IntegerField, Max, Min, Q, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from api.list_table import NONE, decode_list, decode_range
from api.natural import natural

from . import priority as prio

_SEVERITIES = ("critical", "high", "medium", "low", "none")
_SITE = Coalesce("device__site_id", "virtual_machine__site_id")
#: ``first_seen`` buckets: days back, or None for "older than 30 days".
_FIRST_SEEN = {"7d": 7, "30d": 30, "older": None}
FIRST_SEEN_LABELS = {"7d": "Last 7 days", "30d": "Last 30 days", "older": "Older"}
PRIORITY_LABELS = {"fix_first": "Fix first", "high": "High", "medium": "Medium", "low": "Low"}
SEVERITY_LABELS = {"critical": "Critical", "high": "High", "medium": "Medium", "low": "Low",
                   "none": "None", "unscored": "No score"}


def _since(days: int):
    return timezone.now() - datetime.timedelta(days=days)


@dataclass(frozen=True)
class MatchFacet:
    """One facet over match rows. ``values`` names fixed buckets
    (``{value: Q}``); otherwise rows group by ``group`` (an id path or
    expression) and ``labels(ids, tenant)`` names the ids."""

    values: Callable[[], dict] | None = None
    group: object = None
    labels: Callable | dict | None = None
    #: The group's empty bucket is offered (``__none__``).
    none: bool = False
    uuid: bool = False
    #: A number between two bounds (``min..max``), no buckets.
    range_field: str = ""

    def q(self, wanted: list[str]) -> Q:
        if self.values is not None:
            known = self.values()
            q = Q(pk__in=[])
            for v in wanted:
                if v in known:
                    q |= known[v]
            return q
        ids = [v for v in wanted if v != NONE]
        if self.uuid:
            ids = [v for v in ids if _is_uuid(v)]
        path = self.group
        if isinstance(path, str):
            q = Q(**{f"{path}__in": ids}) if ids else Q(pk__in=[])
            if self.none and NONE in wanted:
                q |= Q(**{f"{path}__isnull": True})
            return q
        # An expression (the host's site): annotate, then filter.
        q = Q(_facet_site__in=ids) if ids else Q(pk__in=[])
        if self.none and NONE in wanted:
            q |= Q(_facet_site__isnull=True)
        return q

    def count(self, qs, count_expr, tenant) -> list[dict]:
        if self.range_field:
            return []
        if self.values is not None:
            known = self.values()
            got = qs.order_by().aggregate(**{
                f"b{i}": _count(count_expr, q) for i, q in enumerate(known.values())})
            labels = self.labels if isinstance(self.labels, dict) else {}
            out = [{"value": v, "label": labels.get(v), "count": got[f"b{i}"]}
                   for i, v in enumerate(known)]
            return [o for o in out if o["count"]]
        if isinstance(self.group, str):
            rows = qs.order_by().values(key=F(self.group))
        else:
            rows = qs.order_by().alias(_key=self.group).values(key=F("_key"))
        rows = list(rows.annotate(n=_count(count_expr)).order_by("-n")[:500])
        names = self.labels([r["key"] for r in rows if r["key"] is not None], tenant) \
            if callable(self.labels) else {}
        out = []
        for r in rows:
            if r["key"] is None:
                if self.none:
                    out.append({"value": NONE, "label": None, "count": r["n"]})
                continue
            out.append({"value": str(r["key"]), "label": names.get(r["key"]),
                        "count": r["n"]})
        return out


def _count(expr: str, q: Q | None = None):
    if expr == "cve_id":
        return Count("cve_id", distinct=True, filter=q)
    return Count("id", filter=q)


def _is_uuid(v: str) -> bool:
    try:
        uuid.UUID(v)
    except ValueError:
        return False
    return True


def _names(model_path: str):
    def lookup(ids, tenant):
        from django.apps import apps

        model = apps.get_model(model_path)
        return dict(model.objects.filter(tenant=tenant, pk__in=ids).values_list("pk", "name"))

    return lookup


def _priority_values():
    return {v: Q(priority=v) for v in prio.LEVELS}


def _severity_values():
    out = {v: Q(cve__cvss_severity=v) for v in _SEVERITIES}
    out["unscored"] = Q(cve__cvss_severity="")
    return out


def _kev_values():
    return {"yes": Q(cve__kev_added__isnull=False), "no": Q(cve__kev_added__isnull=True)}


def first_seen_q(bucket: str) -> Q:
    days = _FIRST_SEEN[bucket]
    return Q(first_seen_at__gte=_since(days)) if days else Q(first_seen_at__lt=_since(30))


def _excepted_values():
    return {"yes": Q(excepted__isnull=False), "no": Q(excepted__isnull=True)}


def _first_seen_values():
    return {k: first_seen_q(k) for k in _FIRST_SEEN}


RECORD_FACETS: dict[str, MatchFacet] = {
    "priority": MatchFacet(values=_priority_values, labels=PRIORITY_LABELS),
    "severity": MatchFacet(values=_severity_values, labels=SEVERITY_LABELS),
    "kev": MatchFacet(values=_kev_values,
                      labels={"yes": "Known exploited", "no": "Not in KEV"}),
    "first_seen": MatchFacet(values=_first_seen_values, labels=FIRST_SEEN_LABELS),
    "epss": MatchFacet(range_field="cve__epss"),
    "excepted": MatchFacet(values=_excepted_values,
                           labels={"yes": "Excepted", "no": "Not excepted"}),
    "site": MatchFacet(group=_SITE, labels=_names("api.Site"), none=True, uuid=True),
    "platform": MatchFacet(group="mapping__platform_id", labels=_names("api.Platform"),
                           uuid=True),
    "application": MatchFacet(group="installed_software__application_id",
                              labels=_names("api.Application"), uuid=True),
}

MATCH_FACETS: dict[str, MatchFacet] = {
    **RECORD_FACETS,
    "confidence": MatchFacet(values=lambda: {v: Q(confidence=v)
                                             for v in ("exact", "range", "partial")}),
    "via": MatchFacet(values=lambda: {v: Q(via=v)
                                      for v in ("platform", "application", "package")}),
}


def _excepted_picked(request) -> bool:
    return bool(decode_list(request.query_params.get("f_excepted")))


def live_q(request) -> Q | None:
    """Which of the rows a record row counts: the excepted facet's (or the
    ``excepted`` parameter's) choice, else the matches no exception
    covers."""
    from .match_api import excepted_mode, excepted_q

    if _excepted_picked(request):
        return None
    if "excepted" in request.query_params:
        return excepted_q(excepted_mode(request))
    return Q(excepted__isnull=True)


def apply_facets(request, qs, facets: dict[str, MatchFacet], *, skip: str | None = None,
                 exclude_excepted: bool = True):
    """The rail's ``f_<facet>`` selection on match rows. An unknown facet is
    a 400, as on the inventory lists. Without an ``excepted`` choice (the
    facet or the parameter), ``exclude_excepted`` leaves out the matches an
    exception covers."""
    params = request.query_params
    if (exclude_excepted and skip != "excepted" and "excepted" in facets
            and not _excepted_picked(request) and "excepted" not in params):
        qs = qs.filter(excepted__isnull=True)
    for key in list(params.keys()):
        if not key.startswith("f_"):
            continue
        fid = key[2:]
        facet = facets.get(fid)
        if facet is None:
            raise ValidationError({key: f"Unknown filter: {fid}."})
        if facet.range_field:
            lo, hi = decode_range(params.get(key))
            if fid != skip and lo is not None:
                qs = qs.filter(**{f"{facet.range_field}__gte": lo})
            if fid != skip and hi is not None:
                qs = qs.filter(**{f"{facet.range_field}__lte": hi})
            continue
        wanted = decode_list(params.get(key))
        if fid == skip or not wanted:
            continue
        if len(wanted) > 200:
            raise ValidationError({"facets": "Too many values in one facet."})
        if facet.group is not None and not isinstance(facet.group, str):
            qs = qs.alias(_facet_site=facet.group)
        qs = qs.filter(facet.q(wanted))
    return qs


def facet_counts(request, qs, facets, count_expr: str, tenant) -> dict:
    out = {}
    for fid, facet in facets.items():
        out[fid] = facet.count(apply_facets(request, qs, facets, skip=fid), count_expr, tenant)
    return out


def search(request, qs):
    """``search`` (the list's box) as the plain ``q``: id or description."""
    s = (request.query_params.get("search") or "").strip()
    if s:
        qs = qs.filter(Q(cve__vuln_id__icontains=s) | Q(cve__summary__icontains=s)
                       | Q(cve__aliases__icontains=s))
    return qs


def table_params(request) -> None:
    """``view`` and ``include`` ride along from ``useServerList``; the rows
    are the same either way."""
    request.query_params.get("view")
    request.query_params.get("include")


# ─── ordering ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Order:
    keys: tuple
    annotate: dict = field(default_factory=dict)


def _ordered(qs, request, orders: dict[str, Order], default: tuple):
    raw = (request.query_params.get("ordering") or "").strip()
    if not raw:
        return qs.order_by(*default)
    desc = raw.startswith("-")
    col = raw.lstrip("-")
    order = orders.get(col)
    if order is None:
        raise ValidationError({"ordering": f"This list can't sort by {col or '-'}."})
    if order.annotate:
        qs = qs.annotate(**order.annotate)
    terms = []
    for k in order.keys:
        expr = F(k) if isinstance(k, str) else k
        terms.append(expr.desc(nulls_last=True) if desc else expr.asc(nulls_last=True))
    return qs.order_by(*terms, *default)


def _severity_rank(path: str):
    from django.db.models import Case, When

    return Case(*[When(**{path: s}, then=Value(i)) for i, s in enumerate(_SEVERITIES)],
                default=Value(len(_SEVERITIES)), output_field=IntegerField())


#: Record list columns (aggregates of the grouped rows).
RECORD_ORDERS: dict[str, Order] = {
    "record": Order(("cve__vuln_id",)),
    "priority": Order(("worst",)),
    "severity": Order(("_sev",), {"_sev": Min(_severity_rank("cve__cvss_severity"))}),
    "score": Order(("score",)),
    "kev": Order(("_kev",), {"_kev": Max("cve__kev_added")}),
    "epss": Order(("_epss",), {"_epss": Max("cve__epss")}),
    "devices": Order(("devices",)),
    "virtual_machines": Order(("virtual_machines",)),
    "installs": Order(("installs",)),
    "first_seen": Order(("first_seen_at",)),
}
RECORD_DEFAULT = ("worst", F("score").desc(nulls_last=True), "cve__vuln_id")


def ordered_records(qs, request):
    return _ordered(qs, request, RECORD_ORDERS, RECORD_DEFAULT)


def _host_name():
    return Coalesce("device__name", "virtual_machine__name")


MATCH_ORDERS: dict[str, Order] = {
    "record": Order(("cve__vuln_id",)),
    "priority": Order(("rank",)),
    "severity": Order(("_sev",), {"_sev": _severity_rank("cve__cvss_severity")}),
    "score": Order(("cve__cvss_score",)),
    "kev": Order(("cve__kev_added",)),
    "epss": Order(("cve__epss",)),
    "host": Order((natural("_host"),), {"_host": _host_name()}),
    "application": Order((natural("installed_software__application__name"),)),
    "version": Order(("version",)),
    "via": Order(("via",)),
    "confidence": Order(("confidence",)),
    "mapping": Order(("mapping__vendor", "mapping__product")),
    "first_seen": Order(("first_seen_at",)),
    "resolved": Order(("resolved_at",)),
}
MATCH_DEFAULT = ("rank", F("cve__cvss_score").desc(nulls_last=True), "cve__vuln_id", "id")


def ordered_matches(qs, request):
    return _ordered(qs, request, MATCH_ORDERS, MATCH_DEFAULT)
