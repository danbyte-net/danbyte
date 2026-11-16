"""Vulnerability columns and filters on the Devices and VMs lists (#451).

Each row of the slim table (``view=table``) carries ``vulnerabilities``:
``{open, priority, kev}`` - the open records on the host, the worst
priority among them and whether one is in CISA KEV. For a caller who sees
every match of the tenant they come from the host's stored summary
(``host_stats``, one join, #526); for anyone else from three correlated
subqueries over the matches they may see. The rail's ``vulnerabilities`` facet buckets hosts by that worst
priority (``none`` for a clean host) and ``vuln_kev`` by the KEV flag; the
column sorts worst first.

The table row and the detail read also carry ``vulnerability_summary``:
``{open, worst_severity, max_cvss, fix_first, kev}`` - the open matches
(the host's Vulnerabilities tab by default), the worst CVSS severity and top
score among them, and how many are fix first or in KEV - from one
correlated subquery that builds the object. ``ordering=vuln_score`` sorts by
that top score.

The plain list takes the same as filters: ``vuln_priority=fix_first,high``
(the worst priority, ``none`` for none), ``vuln_kev=true|false`` and
``cve_severity=critical,high`` (an open record of that CVSS severity).

Counted like ``match_api.visible_matches``: the host is in the caller's
list already; an application match also needs ``view`` on its install; a
match an exception covers is left out.
While vulnerability data is off nothing is annotated, the facets are empty
and the filters are read but do nothing.
"""
from __future__ import annotations

from django.db.models import (
    BooleanField,
    Case,
    Count,
    Exists,
    F,
    IntegerField,
    JSONField,
    Max,
    Min,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce, JSONObject, Least
from rest_framework.exceptions import ValidationError

from . import priority as prio

#: The worst-priority rank of a host without open records.
NONE_RANK = len(prio.LEVELS)
_SEVERITIES = ("critical", "high", "medium", "low", "none")
_TRUE = ("1", "true", "yes")
_FALSE = ("0", "false", "no")
#: The facet's bucket values: the priorities, then a clean host.
BUCKETS = (*prio.LEVELS, "none")
LABELS = {"fix_first": "Fix first", "high": "High", "medium": "Medium", "low": "Low",
          "none": "None open"}


def enabled(request) -> bool:
    """Vulnerability data on, read once per request."""
    cached = getattr(request, "_vuln_enabled", None)
    if cached is None:
        from .models import VulnerabilitySettings

        cached = VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists()
        try:
            request._vuln_enabled = cached
        except AttributeError:
            pass
    return cached


def stored(request) -> bool:
    """Read the per-host summaries (``host_stats``, #526): the caller sees
    every match of the tenant, so the stored numbers are theirs. Anyone else
    reads the matches they may see, per row."""
    cached = getattr(request, "_vuln_stored", None)
    if cached is None:
        from api.views import _get_active_tenant

        from .match_api import sees_all

        tenant = _get_active_tenant(request)
        cached = tenant is not None and sees_all(request, tenant)
        try:
            request._vuln_stored = cached
        except AttributeError:
            pass
    return cached


def _open_matches(request, kind: str, hosts=None):
    """The open matches of the outer host row the caller may see - or, with
    ``hosts`` (a host queryset), of those hosts, uncorrelated."""
    from api.models import InstalledSoftware
    from api.views import _get_active_tenant
    from auth_api import rbac

    from .models import VulnerabilityMatch

    if hosts is None:
        m = VulnerabilityMatch.objects.filter(
            **{kind: OuterRef("pk")}, tenant_id=OuterRef("tenant_id"), resolved_at__isnull=True)
    else:
        m = VulnerabilityMatch.objects.filter(
            **{f"{kind}__in": hosts.order_by().values("pk")},
            tenant=_get_active_tenant(request), resolved_at__isnull=True)
    user = request.user
    if not user.is_superuser:
        tenant = _get_active_tenant(request)
        installs = rbac.restrict_queryset(
            InstalledSoftware.objects.filter(tenant=tenant), user, tenant,
            "installedsoftware", "view")
        m = m.filter(Q(installed_software__isnull=True)
                     | Q(installed_software__in=installs.values("pk")))
        if not rbac.has_action(user, tenant, "installedsoftware", "view"):
            # Inventory-read matches (packages, the Windows build) read with
            # installed-software view, as in ``match_api.visible_matches``.
            m = m.filter(host_package__isnull=True).exclude(via="os_build")
    # A match an exception covers is not open work.
    return m.filter(excepted__isnull=True)


def annotate(qs, request, kind: str):
    """``vuln_rank`` (worst priority rank), ``vuln_open`` (open records) and
    ``vuln_kev`` on a device (``kind="device"``) or VM
    (``"virtual_machine"``) queryset. Off: only a constant ``vuln_rank``, so
    a sort still works."""
    if "vuln_rank" in qs.query.annotations:
        return qs
    if not enabled(request):
        return qs.annotate(vuln_rank=Value(NONE_RANK, output_field=IntegerField()))
    if stored(request):
        # One LEFT JOIN on the host's summary row; no row = nothing open.
        return qs.annotate(
            vuln_rank=Coalesce(F("vulnerability_stat__rank"), Value(NONE_RANK),
                               output_field=IntegerField()),
            vuln_open=Coalesce(F("vulnerability_stat__open_records"), Value(0),
                               output_field=IntegerField()),
            vuln_kev=Coalesce(F("vulnerability_stat__kev"), Value(False),
                              output_field=BooleanField()),
        )
    m = _open_matches(request, kind)
    # The stored rank (#520), not a CASE over the priority sorted per row:
    # a plain MIN over the host's matches.
    rank = m.order_by().values(kind).annotate(_r=Min("rank")).values("_r")[:1]
    count = (m.order_by().values(kind).annotate(n=Count("cve_id", distinct=True))
             .values("n")[:1])
    return qs.annotate(
        vuln_rank=Coalesce(Subquery(rank, output_field=IntegerField()), Value(NONE_RANK)),
        vuln_open=Coalesce(Subquery(count, output_field=IntegerField()), Value(0)),
        vuln_kev=Exists(m.filter(cve__kev_added__isnull=False)),
    )


def payload(obj) -> dict | None:
    """The row's ``vulnerabilities`` field; None when not annotated (the
    feature is off, or a response that does not carry it)."""
    if not hasattr(obj, "vuln_open"):
        return None
    rank = obj.vuln_rank
    return {
        "open": obj.vuln_open,
        "priority": prio.LEVELS[rank] if rank is not None and rank < NONE_RANK else "",
        "kev": bool(obj.vuln_kev),
    }


_SEV_RANK = Case(*[When(cve__cvss_severity=k, then=Value(i)) for i, k in enumerate(_SEVERITIES)],
                 default=Value(len(_SEVERITIES)), output_field=IntegerField())


def annotate_summary(qs, request, kind: str):
    """``vuln_summary`` on a device or VM queryset: one correlated subquery
    over the host's open matches (as ``_open_matches``) that returns the
    summary as a JSON object. Off: nothing, so the field reads null."""
    if "vuln_summary" in qs.query.annotations or not enabled(request):
        return qs
    agg = (_open_matches(request, kind).order_by().values(kind).annotate(j=JSONObject(
        open=Count("id"),
        fix_first=Count("id", filter=Q(priority="fix_first")),
        kev=Count("id", filter=Q(cve__kev_added__isnull=False)),
        sev=Min(_SEV_RANK),
        max_cvss=Max("cve__cvss_score"),
    )).values("j")[:1])
    return qs.annotate(vuln_summary=Subquery(agg, output_field=JSONField()))


def summary_payload(obj) -> dict | None:
    """The row's ``vulnerability_summary``; None when not annotated (the
    feature is off, or a response that does not carry it)."""
    if not hasattr(obj, "vuln_summary"):
        return None
    j = obj.vuln_summary or {}
    sev = j.get("sev")
    score = j.get("max_cvss")
    return {
        "open": j.get("open") or 0,
        "worst_severity": _SEVERITIES[sev] if isinstance(sev, int) and sev < len(
            _SEVERITIES) else "",
        "max_cvss": round(float(score), 1) if score is not None else None,
        "fix_first": j.get("fix_first") or 0,
        "kev": j.get("kev") or 0,
    }


def score_sort_prepare(kind: str):
    """``vuln_score``: the top CVSS score among the open matches; a clean
    host (null) sorts last either way."""

    def run(qs, request):
        if "_sort_vuln_score" in qs.query.annotations:
            return qs
        if not enabled(request):
            return qs.annotate(_sort_vuln_score=Value(None, output_field=IntegerField()))
        if stored(request):
            return qs.annotate(_sort_vuln_score=F("vulnerability_stat__max_cvss"))
        top = (_open_matches(request, kind).order_by().values(kind)
               .annotate(s=Max("cve__cvss_score")).values("s")[:1])
        return qs.annotate(_sort_vuln_score=Subquery(top))

    return run


# ─── the table's facets and sort (api.list_specs) ────────────────────────────


def priority_buckets(request) -> dict:
    if not enabled(request):
        return {}
    return {v: Q(vuln_rank=i) for i, v in enumerate(BUCKETS)}


def kev_buckets(request) -> dict:
    if not enabled(request):
        return {}
    return {"yes": Q(vuln_kev=True), "no": Q(vuln_kev=False)}


def priority_counter(kind: str):
    """The priority facet counted in one grouped query (#526): from the
    hosts' summary rows, or - for a caller who sees fewer matches - their
    worst rank grouped once over the matches they may see, the hosts without
    one ``none``. Not the rank's subquery for every host in every bucket."""

    def run(qs, request) -> dict:
        from api.list_table import fans_out, group_count, row_count

        out: dict[str, int] = {}
        if stored(request):
            rows = annotate(qs, request, kind).order_by().values("vuln_rank")
            for row in rows.annotate(_n=Count("pk", distinct=fans_out(rows))).order_by():
                name = BUCKETS[min(row["vuln_rank"], NONE_RANK)]
                out[name] = out.get(name, 0) + row["_n"]
            return out
        worst = (_open_matches(request, kind, hosts=qs).order_by().values(kind)
                 .annotate(_r=Min("rank")).values(kind, "_r"))
        for rank, n in group_count(worst, "_r"):
            name = BUCKETS[min(rank, NONE_RANK)]
            out[name] = out.get(name, 0) + n
        clean = row_count(qs) - sum(out.values())
        out["none"] = out.get("none", 0) + clean
        return out

    return run


def kev_classify(request):
    """The KEV facet counted by grouping on the flag: its subquery once per
    host, not once per bucket (#526)."""
    return ("vuln_kev",), lambda row: "yes" if row["vuln_kev"] else "no"


def prepare(kind: str):
    def run(qs, request):
        return annotate(qs, request, kind)

    return run


def sort_prepare(kind: str):
    """Worst priority first, then the most open records."""

    def run(qs, request):
        qs = annotate(qs, request, kind)
        if "vuln_open" not in qs.query.annotations:
            return qs.annotate(_sort_vuln=F("vuln_rank"))
        return qs.annotate(_sort_vuln=F("vuln_rank") * 100_000
                           - Least(F("vuln_open"), Value(99_999)))

    return run


# ─── plain list filters ──────────────────────────────────────────────────────


def _values(request, name: str) -> list[str]:
    out: list[str] = []
    for raw in request.query_params.getlist(name):
        out.extend(p.strip() for p in raw.split(",") if p.strip())
    return out


def apply_filters(qs, request, kind: str):
    """``vuln_priority``, ``vuln_kev``, ``cve_severity`` on a device or VM
    list (see the module doc). Read on every request, applied while the
    feature is on."""
    priorities = _values(request, "vuln_priority")
    kev_raw = (request.query_params.get("vuln_kev") or "").strip().lower()
    severities = _values(request, "cve_severity")
    if not (priorities or kev_raw or severities):
        return qs
    bad = [v for v in priorities if v not in BUCKETS]
    if bad:
        raise ValidationError({"vuln_priority": f"One of: {', '.join(BUCKETS)}."})
    bad = [v for v in severities if v not in _SEVERITIES]
    if bad:
        raise ValidationError({"cve_severity": f"One of: {', '.join(_SEVERITIES)}."})
    if kev_raw and kev_raw not in _TRUE + _FALSE:
        raise ValidationError({"vuln_kev": "true or false."})
    if not enabled(request):
        return qs
    if priorities or kev_raw:
        qs = annotate(qs, request, kind)
    if priorities:
        qs = qs.filter(vuln_rank__in=[BUCKETS.index(v) for v in priorities])
    if kev_raw:
        qs = qs.filter(vuln_kev=kev_raw in _TRUE)
    if severities:
        qs = qs.filter(Exists(_open_matches(request, kind).filter(
            cve__cvss_severity__in=severities)))
    return qs


__all__ = ["BUCKETS", "LABELS", "annotate", "annotate_summary", "apply_filters", "enabled",
           "kev_buckets", "payload", "prepare", "priority_buckets", "score_sort_prepare",
           "sort_prepare", "summary_payload"]
