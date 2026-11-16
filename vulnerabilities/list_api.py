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
                                      for v in ("platform", "application", "package",
                                                "os_build")}),
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


def validate_facets(request, facets) -> None:
    """The rail's selection is known (a 400 otherwise, as on the inventory
    lists), without building a query."""
    for key in request.query_params.keys():
        if not key.startswith("f_"):
            continue
        fid = key[2:]
        facet = facets.get(fid)
        if facet is None:
            raise ValidationError({key: f"Unknown filter: {fid}."})
        if not facet.range_field and len(decode_list(request.query_params.get(key))) > 200:
            raise ValidationError({"facets": "Too many values in one facet."})


def match_groups(qs) -> list[dict]:
    """The matches of ``qs`` grouped by everything a facet looks at: the
    record, the priority, the host's site, the platform and application,
    via, confidence, the first-seen bucket (``_fs``: 0 within 7 days, 1
    within 30, 2 older) and whether an exception covers them (``_exc``);
    ``_n`` matches each. One scan."""
    since7, since30 = _since(7), _since(30)
    from django.db.models import Case, When

    return list(qs.order_by().annotate(
        _site=_SITE, _platform=F("mapping__platform_id"),
        _application=F("installed_software__application_id"),
        _fs=Case(When(first_seen_at__gte=since7, then=Value(0)),
                 When(first_seen_at__gte=since30, then=Value(1)),
                 default=Value(2), output_field=IntegerField()),
        _exc=Case(When(excepted__isnull=True, then=Value(0)), default=Value(1),
                  output_field=IntegerField()),
    ).values("cve_id", "priority", "via", "confidence", "_site", "_platform",
             "_application", "_fs", "_exc").annotate(_n=Count("id")))


def first_seen_bucket(when, since7, since30) -> int:
    """``match_groups``' ``_fs`` of one first-seen time."""
    return 0 if when >= since7 else 1 if when >= since30 else 2


def facet_counts(request, qs, facets, count_expr: str, tenant) -> dict:
    """Every facet's counts from **one** grouped scan of ``qs`` (#520)
    rather than one query per facet. Records (``count_expr="cve_id"``) are
    distinct records, matches summed."""
    validate_facets(request, facets)
    return group_facets(request, match_groups(qs), facets,
                        records=count_expr == "cve_id", tenant=tenant)


def group_facets(request, groups, facets, *, records: bool, tenant) -> dict:
    """Each facet counted over the groups the other facets' selections
    leave, as :func:`apply_facets` filters the matches (without an
    ``excepted`` choice, the matches an exception covers are left out of
    every facet but ``excepted``)."""
    from .models import Cve

    params = request.query_params
    default_live = not _excepted_picked(request) and "excepted" not in params
    cves = {c["id"]: c for c in Cve.objects.filter(
        pk__in={g["cve_id"] for g in groups}).values("id", "cvss_severity", "kev_added",
                                                       "epss")} if groups else {}
    tests = {fid: _facet_test(fid, facets[fid], params.get(f"f_{fid}"))
             for fid in facets if params.get(f"f_{fid}")}
    out = {}
    for fid, facet in facets.items():
        keep = [g for g in groups
                if (fid == "excepted" or not default_live or "excepted" not in facets
                    or not g["_exc"])
                and all(t(g, cves[g["cve_id"]]) for k, t in tests.items()
                        if k != fid and t is not None)]
        out[fid] = _count_groups(fid, facet, keep, cves, records, tenant)
    return out


_FS_BUCKETS = {"7d": (0,), "30d": (0, 1), "older": (2,)}


def _key_of(fid, g, cve):
    """The value of facet ``fid`` for one group."""
    if fid == "priority":
        return g["priority"]
    if fid == "severity":
        return cve["cvss_severity"] or "unscored"
    if fid == "kev":
        return "yes" if cve["kev_added"] is not None else "no"
    if fid == "excepted":
        return "yes" if g["_exc"] else "no"
    if fid in ("via", "confidence"):
        return g[fid]
    if fid in ("site", "platform", "application"):
        v = g[f"_{fid}"]
        return None if v is None else str(v)
    return None


def _facet_test(fid, facet, raw):
    """A predicate ``(group, cve) -> bool`` for the rail's selection in
    ``fid``, or None when it selects nothing (the SQL filter's twin)."""
    import decimal

    if facet.range_field:
        lo, hi = decode_range(raw)
        if lo is None and hi is None:
            return None
        lo = None if lo is None else decimal.Decimal(str(lo))
        hi = None if hi is None else decimal.Decimal(str(hi))

        def in_range(g, cve):
            v = cve["epss"]
            return v is not None and (lo is None or v >= lo) and (hi is None or v <= hi)
        return in_range
    wanted = decode_list(raw)
    if not wanted:
        return None
    if fid == "first_seen":
        ok = {b for v in wanted for b in _FS_BUCKETS.get(v, ())}
        return lambda g, cve: g["_fs"] in ok
    if facet.values is not None:
        known = set(facet.values())
        want = {v for v in wanted if v in known}
        if fid == "severity":
            # ``none`` is a CVSS severity of its own; ``unscored`` is ''.
            return lambda g, cve: (cve["cvss_severity"] or "unscored") in want
        return lambda g, cve: _key_of(fid, g, cve) in want
    ids = {v for v in wanted if v != NONE and (not facet.uuid or _is_uuid(v))}
    if facet.uuid:
        ids = {str(uuid.UUID(v)) for v in ids}
    none = facet.none and NONE in wanted

    def member(g, cve):
        k = _key_of(fid, g, cve)
        return (k is None and none) or (k is not None and k in ids)
    return member


def _count_groups(fid, facet, groups, cves, records: bool, tenant) -> list[dict]:
    if facet.range_field:
        return []
    found: dict = {}
    for g in groups:
        cve = cves[g["cve_id"]]
        if fid == "first_seen":
            keys = [k for k, bs in _FS_BUCKETS.items() if g["_fs"] in bs]
        else:
            keys = [_key_of(fid, g, cve)]
        for k in keys:
            if records:
                found.setdefault(k, set()).add(g["cve_id"])
            else:
                found[k] = found.get(k, 0) + g["_n"]
    counts = {k: (len(v) if records else v) for k, v in found.items()}
    if facet.values is not None:
        labels = facet.labels if isinstance(facet.labels, dict) else {}
        return [{"value": v, "label": labels.get(v), "count": counts[v]}
                for v in facet.values() if counts.get(v)]
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:500]
    names = facet.labels([uuid.UUID(k) for k, _n in top if k is not None], tenant) \
        if callable(facet.labels) else {}
    names = {str(k): v for k, v in names.items()}
    out = []
    for k, n in top:
        if k is None:
            if facet.none:
                out.append({"value": NONE, "label": None, "count": n})
            continue
        out.append({"value": k, "label": names.get(k), "count": n})
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
#: Worst first, then the top score, the record and the row: the open-match
#: index ``vuln_match_open_order`` serves it, so a page reads only its rows.
MATCH_DEFAULT = ("rank", F("cvss_score").desc(nulls_last=True), "cve_id", "id")


def ordered_matches(qs, request):
    return _ordered(qs, request, MATCH_ORDERS, MATCH_DEFAULT)
