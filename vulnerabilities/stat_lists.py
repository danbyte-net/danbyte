"""The record list, both facet rails, the match list's total and the
summary from the per-record counts (#520, :mod:`vulnerabilities.record_stats`).

Used when the caller sees every match of the tenant (``match_api.sees_all``)
and no plain parameter filters on a match property. The rails then take any
selection (they count ``VulnerabilityMatchGroup`` rows exactly as they would
count matches); the record list and the match list's total also need the
rail's selection to be about the record only (priority, severity, KEV,
EPSS). Everything else goes to the queries over the matches in
:mod:`vulnerabilities.match_api`, which these answers equal.
"""
from __future__ import annotations

from django.db.models import Count, Exists, F, OuterRef, Q, Sum
from django.db.models.functions import Coalesce

from api.list_table import decode_list

from . import list_api
from . import priority as prio

#: Plain parameters that filter on a match property.
MATCH_PARAMS = ("device", "virtual_machine", "mapping", "platform", "application", "site",
                "confidence", "via", "excepted")
#: Rail facets over a match property: a selection in one needs the matches
#: for the record list and the match list's total (not for the rails).
MATCH_FACET_IDS = ("site", "platform", "application", "first_seen", "confidence", "via",
                   "excepted")


def usable(request, tenant, *, rail: bool = False) -> bool:
    """The counts answer this request exactly. ``rail``: for a facets
    request, where any rail selection is fine."""
    from .match_api import sees_all

    params = request.query_params
    for name in MATCH_PARAMS:
        if (params.get(name) or "").strip():
            return False
    if (params.get("status") or "open").strip().lower() != "open":
        return False
    if not rail:
        for fid in MATCH_FACET_IDS:
            if decode_list(params.get(f"f_{fid}")):
                return False
    return sees_all(request, tenant)


def _filtered(request, model, tenant):
    """The tenant's rows of ``model`` filtered by the plain record
    parameters and the search box."""
    from .match_api import filter_record_params

    qs = model.objects.filter(tenant=tenant)
    return list_api.search(request, filter_record_params(request, qs))


def _stats(request, tenant, facets):
    from .models import VulnerabilityRecordStat

    return list_api.apply_facets(request, _filtered(request, VulnerabilityRecordStat, tenant),
                                 facets, exclude_excepted=False)


# ─── the record list and the match list's total ─────────────────────────────

STAT_ORDERS: dict[str, list_api.Order] = {
    "record": list_api.Order(("cve__vuln_id",)),
    "priority": list_api.Order(("rank",)),
    "severity": list_api.Order(("_sev",),
                               {"_sev": list_api._severity_rank("cve__cvss_severity")}),
    "score": list_api.Order(("cve__cvss_score",)),
    "kev": list_api.Order(("cve__kev_added",)),
    "epss": list_api.Order(("cve__epss",)),
    "devices": list_api.Order(("devices",)),
    "virtual_machines": list_api.Order(("virtual_machines",)),
    "installs": list_api.Order(("installs",)),
    "first_seen": list_api.Order(("first_seen_at",)),
}
STAT_DEFAULT = ("rank", F("cve__cvss_score").desc(nulls_last=True), "cve__vuln_id")


def record_rows(request, tenant):
    """The ordered rows of the record list: records with live matches."""
    qs = _stats(request, tenant, list_api.RECORD_FACETS).filter(matches__gt=0)
    return list_api._ordered(qs.select_related("cve"), request, STAT_ORDERS, STAT_DEFAULT)


def record_dict(row) -> dict:
    from .match_api import cve_brief

    return {
        "id": row.cve.vuln_id,
        **cve_brief(row.cve),
        "priority": row.priority,
        "devices": row.devices,
        "virtual_machines": row.virtual_machines,
        "installs": row.installs,
        "matches": row.matches,
        "excepted": row.excepted,
        "first_seen_at": row.first_seen_at,
    }


def live_matches(request, tenant) -> int:
    """How many matches the match list holds (no exception, the record
    filters and the rail applied)."""
    qs = _stats(request, tenant, list_api.MATCH_FACETS)
    return qs.aggregate(n=Coalesce(Sum("matches"), 0))["n"]


# ─── facets ──────────────────────────────────────────────────────────────────


def facets(request, tenant, facet_defs: dict, *, records: bool) -> dict:
    """``{facet: [{value, label, count}]}`` - records (``records``) or
    matches per value, each over what the other filters leave: the facet
    counter of the matches (``list_api.group_facets``) over the stored
    groups. One query for the groups, one for their records."""
    from .models import VulnerabilityMatchGroup

    list_api.validate_facets(request, facet_defs)
    since7, since30 = list_api._since(7), list_api._since(30)
    groups = [{
        "cve_id": g["cve_id"], "priority": g["priority"], "via": g["via"],
        "confidence": g["confidence"], "_site": g["site_id"],
        "_platform": g["platform_id"], "_application": g["application_id"],
        "_fs": list_api.first_seen_bucket(g["first_seen_at"], since7, since30),
        "_exc": int(g["excepted"]), "_n": g["matches"],
    } for g in _filtered(request, VulnerabilityMatchGroup, tenant).values(
        "cve_id", "priority", "via", "confidence", "site_id", "platform_id",
        "application_id", "first_seen_at", "excepted", "matches")]
    return list_api.group_facets(request, groups, facet_defs, records=records, tenant=tenant)


# ─── summary ─────────────────────────────────────────────────────────────────


def summary(tenant) -> dict:
    from api.models import Device, VirtualMachine

    from .models import VulnerabilityMatch, VulnerabilityRecordStat

    rows = VulnerabilityRecordStat.objects.filter(tenant=tenant)
    live = rows.filter(matches__gt=0)
    by_priority = dict(live.order_by().values_list("priority").annotate(n=Count("id")))
    week = list_api._since(7)
    totals = live.aggregate(
        records=Count("id"),
        matches_n=Coalesce(Sum("matches"), 0),
        kev=Count("id", filter=Q(cve__kev_added__isnull=False)),
        critical=Count("id", filter=Q(cve__cvss_severity="critical")),
        new_this_week=Count("id", filter=Q(last_first_seen_at__gte=week)),
    )
    totals["matches"] = totals.pop("matches_n")
    ex = rows.aggregate(n=Coalesce(Sum("excepted"), 0),
                        records=Count("id", filter=Q(excepted__gt=0)))

    def hosts(model, field):
        # A probe per host through the match's host index.
        has = VulnerabilityMatch.objects.filter(
            tenant=tenant, resolved_at__isnull=True, excepted__isnull=True,
            **{field: OuterRef("pk")})
        return model.objects.filter(tenant=tenant).filter(Exists(has)).count()

    return {**totals,
            "devices": hosts(Device, "device"),
            "virtual_machines": hosts(VirtualMachine, "virtual_machine"),
            "excepted": ex["n"], "excepted_records": ex["records"],
            "by_priority": {k: by_priority.get(k, 0) for k in prio.LEVELS}}
