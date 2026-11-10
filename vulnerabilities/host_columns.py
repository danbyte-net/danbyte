"""Vulnerability columns and filters on the Devices and VMs lists (#451).

Each row of the slim table (``view=table``) carries ``vulnerabilities``:
``{open, priority, kev}`` - the open records on the host, the worst
priority among them and whether one is in CISA KEV - from three correlated
subqueries on the page's query, so a page costs the same however many rows
it has. The rail's ``vulnerabilities`` facet buckets hosts by that worst
priority (``none`` for a clean host) and ``vuln_kev`` by the KEV flag; the
column sorts worst first.

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
    Case,
    Count,
    Exists,
    F,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce, Least
from rest_framework.exceptions import ValidationError

from . import priority as prio

#: The worst-priority rank of a host without open records.
NONE_RANK = len(prio.LEVELS)
_RANK = Case(*[When(priority=k, then=Value(v)) for k, v in prio.RANK.items()],
             default=Value(NONE_RANK), output_field=IntegerField())
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


def _open_matches(request, kind: str):
    """The open matches of the outer host row the caller may see."""
    from api.models import InstalledSoftware
    from api.views import _get_active_tenant
    from auth_api import rbac

    from .models import VulnerabilityMatch

    m = VulnerabilityMatch.objects.filter(
        **{kind: OuterRef("pk")}, tenant_id=OuterRef("tenant_id"), resolved_at__isnull=True)
    user = request.user
    if not user.is_superuser:
        tenant = _get_active_tenant(request)
        installs = rbac.restrict_queryset(
            InstalledSoftware.objects.filter(tenant=tenant), user, tenant,
            "installedsoftware", "view")
        m = m.filter(Q(installed_software__isnull=True)
                     | Q(installed_software__in=installs.values("pk")))
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
    m = _open_matches(request, kind)
    rank = m.annotate(_r=_RANK).order_by("_r").values("_r")[:1]
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


# ─── the table's facets and sort (api.list_specs) ────────────────────────────


def priority_buckets(request) -> dict:
    if not enabled(request):
        return {}
    return {v: Q(vuln_rank=i) for i, v in enumerate(BUCKETS)}


def kev_buckets(request) -> dict:
    if not enabled(request):
        return {}
    return {"yes": Q(vuln_kev=True), "no": Q(vuln_kev=False)}


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


__all__ = ["BUCKETS", "LABELS", "annotate", "apply_filters", "enabled", "kev_buckets",
           "payload", "prepare", "priority_buckets", "sort_prepare"]
