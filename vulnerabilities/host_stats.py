"""Per-host vulnerability summaries of a tenant (#526).

``VulnerabilityHostStat`` holds, per device or VM with a live match (open,
no exception covering it), the worst priority rank, how many records, whether
one is in CISA KEV and the top CVSS score. The Devices and VMs lists read the
column, the ``vulnerabilities`` and ``vuln_kev`` facets and both sorts from it
(``host_columns``) instead of a subquery over every host's matches - which
grew with hosts x matches: seconds on a tenant with millions of matches.

Rows are rebuilt from the matches, never adjusted by deltas, by
:func:`refresh` - called from ``record_stats.refresh``, so every path that
keeps the per-record counts in line keeps these too: the recompute (the hosts
of the records it wrote; a full one checks all), exceptions, a
re-prioritisation and the whole-tenant refresh after a host or install was
deleted. A deleted host takes its row with it.

Only callers that see every match of the tenant read the rows
(``match_api.sees_all``). A site-bound or constrained role, or one without
the installed-software right, sees fewer matches than the row counts, so its
lists keep the live per-row query.
"""
from __future__ import annotations

from collections.abc import Iterable

from django.db.models import Count, Max, Min, Q, Subquery

from . import priority as prio

_FIELDS = ("rank", "open_records", "kev", "max_cvss")


def _hosts_of(match_model, tenant_id, cve_ids) -> Q:
    """The hosts with a match (open or resolved) of ``cve_ids``: a resolved
    one may have been the host's last."""
    touched = match_model.objects.filter(tenant_id=tenant_id, cve_id__in=list(cve_ids))
    return (Q(device_id__in=Subquery(touched.filter(device_id__isnull=False)
                                     .values("device_id")))
            | Q(virtual_machine_id__in=Subquery(touched.filter(
                virtual_machine_id__isnull=False).values("virtual_machine_id"))))


def compute(tenant_id, cve_ids: Iterable | None = None, *, match_model=None) -> dict:
    """``{(device id, vm id): {field: value}}`` - the ground truth from the
    live matches, of the hosts with a match (open or resolved) of
    ``cve_ids`` when given. One grouped query."""
    from .models import VulnerabilityMatch

    match_model = match_model or VulnerabilityMatch
    live = match_model.objects.filter(
        tenant_id=tenant_id, resolved_at__isnull=True, excepted__isnull=True)
    if cve_ids is not None:
        live = live.filter(_hosts_of(match_model, tenant_id, cve_ids))
    out: dict = {}
    for row in live.order_by().values("device_id", "virtual_machine_id").annotate(
            rank_=Min("rank"),
            open_=Count("cve_id", distinct=True),
            kev_=Count("id", filter=Q(cve__kev_added__isnull=False)),
            max_=Max("cve__cvss_score")):
        out[(row["device_id"], row["virtual_machine_id"])] = {
            "rank": min(row["rank_"], len(prio.LEVELS)),
            "open_records": row["open_"],
            "kev": row["kev_"] > 0,
            "max_cvss": row["max_"],
        }
    return out


def refresh(tenant_id, cve_ids: Iterable | None = None, *, models=None) -> int:
    """Bring the tenant's rows (of the hosts with a match of ``cve_ids``,
    when given) in line with the matches; only rows that differ are written.
    Returns how many rows were written or deleted. Runs where
    ``record_stats.refresh`` does: under the tenant's recompute lock or in
    one transaction with the writes. ``models``: ``(match, host stat)`` for a
    migration."""
    from .models import VulnerabilityHostStat, VulnerabilityMatch

    match_model, stat_model = models or (VulnerabilityMatch, VulnerabilityHostStat)
    if cve_ids is not None:
        cve_ids = set(cve_ids)
        if not cve_ids:
            return 0
    want = compute(tenant_id, cve_ids, match_model=match_model)
    have_qs = stat_model.objects.filter(tenant_id=tenant_id)
    if cve_ids is not None:
        have_qs = have_qs.filter(_hosts_of(match_model, tenant_id, cve_ids))
    have = {(r.device_id, r.virtual_machine_id): r for r in have_qs.iterator(chunk_size=5000)}
    new, changed = [], []
    for key, fields in want.items():
        row = have.pop(key, None)
        if row is None:
            new.append(stat_model(tenant_id=tenant_id, device_id=key[0],
                                  virtual_machine_id=key[1], **fields))
        elif any(getattr(row, f) != fields[f] for f in _FIELDS):
            for f in _FIELDS:
                setattr(row, f, fields[f])
            changed.append(row)
    gone = [r.pk for r in have.values()]
    stat_model.objects.bulk_create(new, batch_size=1000)
    stat_model.objects.bulk_update(changed, list(_FIELDS), batch_size=1000)
    for i in range(0, len(gone), 5000):
        stat_model.objects.filter(pk__in=gone[i:i + 5000]).delete()
    return len(new) + len(changed) + len(gone)
