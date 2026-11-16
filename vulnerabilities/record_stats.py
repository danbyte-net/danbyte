"""Per-record open-match counts of a tenant (#520).

Two small tables stand in for the open matches on the Vulnerabilities page:

* ``VulnerabilityRecordStat``, one row per record with open matches in a
  tenant: the record's priority there, how many devices, VMs and installs
  its live matches (open, no exception) affect, how many live and excepted
  matches it has, and when the first and the latest live one appeared;
* ``VulnerabilityMatchGroup``, the open matches of a record counted per
  everything a rail facet looks at (site, platform, application, via,
  confidence, first seen, excepted) - a few rows per record and site.

The record list, both rails and the summary read these instead of grouping
every open match, so a page costs the same however many matches there are.

Rows are rebuilt from the matches, never adjusted by deltas, so they are
always what the ground-truth query over the matches says (:func:`refresh`,
which writes only the rows that differ):

* the recompute refreshes the records whose matches it wrote; a full one
  checks all of the tenant's (read-only when nothing changed);
* :func:`exceptions.apply` refreshes the records whose ``excepted`` moved;
* a re-prioritisation refreshes the records whose priority moved;
* a host's site change and a deleted host or install (their matches go with
  them) queue a whole-tenant refresh (``jobs.enqueue_stats``).

Only callers that see every match of the tenant read the rows (``sees_all``
in :mod:`vulnerabilities.match_api`); a site-bound or constrained role reads
the matches themselves, as does any plain filter on a match property.
"""
from __future__ import annotations

from collections.abc import Iterable

from django.db.models import Count, F, Max, Min, Q
from django.db.models.functions import Coalesce

from . import priority as prio

_FIELDS = ("priority", "rank", "devices", "virtual_machines", "installs", "matches",
           "excepted", "first_seen_at", "last_first_seen_at")
_GROUP_KEY = ("cve_id", "priority", "site_id", "platform_id", "application_id", "via",
              "confidence", "first_seen_at", "excepted")


def compute(tenant_id, cve_ids: Iterable | None = None, *, match_model=None):
    """``({cve id: {field: value}}, {group key: matches})`` - the ground
    truth from the open matches (of ``cve_ids`` only, when given). Two
    grouped queries."""
    from .models import VulnerabilityMatch

    base = (match_model or VulnerabilityMatch).objects.filter(
        tenant_id=tenant_id, resolved_at__isnull=True)
    if cve_ids is not None:
        base = base.filter(cve_id__in=list(cve_ids))
    live = Q(excepted__isnull=True)
    stats: dict = {}
    for row in base.order_by().values("cve_id").annotate(
            rank_=Min("rank"),
            devices=Count("device_id", distinct=True, filter=live),
            virtual_machines=Count("virtual_machine_id", distinct=True, filter=live),
            installs=Count("installed_software_id", distinct=True, filter=live),
            matches=Count("id", filter=live),
            excepted_=Count("id", filter=Q(excepted__isnull=False)),
            first_=Min("first_seen_at", filter=live),
            last_=Max("first_seen_at", filter=live)):
        rank = min(row.pop("rank_"), len(prio.LEVELS) - 1)
        cve_id = row.pop("cve_id")
        row["excepted"] = row.pop("excepted_")
        row["first_seen_at"] = row.pop("first_")
        row["last_first_seen_at"] = row.pop("last_")
        stats[cve_id] = {"priority": prio.LEVELS[rank], "rank": rank, **row}
    groups: dict = {}
    if stats:
        for row in base.order_by().annotate(
                _site=Coalesce("device__site_id", "virtual_machine__site_id"),
                _platform=F("mapping__platform_id"),
                _application=F("installed_software__application_id"),
                _exc=Q(excepted__isnull=False)).values(
                "cve_id", "priority", "_site", "_platform", "_application", "via",
                "confidence", "first_seen_at", "_exc").annotate(n=Count("id")):
            groups[(row["cve_id"], row["priority"], row["_site"], row["_platform"],
                    row["_application"], row["via"], row["confidence"],
                    row["first_seen_at"], row["_exc"])] = row["n"]
    return stats, groups


def refresh(tenant_id, cve_ids: Iterable | None = None, *, models=None) -> int:
    """Bring the tenant's rows (of ``cve_ids`` only, when given) in line
    with the matches; only rows that differ are written. Returns how many
    rows were written or deleted. The caller holds the tenant's recompute
    lock (``matching._lock``) or runs in one transaction with the writes.
    ``models``: ``(match, stat, group)`` models for a migration."""
    from .models import VulnerabilityMatch, VulnerabilityMatchGroup, VulnerabilityRecordStat

    match_model, stat_model, group_model = models or (
        VulnerabilityMatch, VulnerabilityRecordStat, VulnerabilityMatchGroup)
    if cve_ids is not None:
        cve_ids = set(cve_ids)
        if not cve_ids:
            return 0
    want, want_groups = compute(tenant_id, cve_ids, match_model=match_model)

    def scoped(model):
        qs = model.objects.filter(tenant_id=tenant_id)
        return qs if cve_ids is None else qs.filter(cve_id__in=list(cve_ids))

    have = {r.cve_id: r for r in scoped(stat_model)}
    new, changed = [], []
    for cve_id, fields in want.items():
        row = have.pop(cve_id, None)
        if row is None:
            new.append(stat_model(tenant_id=tenant_id, cve_id=cve_id, **fields))
        elif any(getattr(row, f) != fields[f] for f in _FIELDS):
            for f in _FIELDS:
                setattr(row, f, fields[f])
            changed.append(row)
    gone = [r.pk for r in have.values()]
    stat_model.objects.bulk_create(new, batch_size=1000)
    stat_model.objects.bulk_update(changed, list(_FIELDS), batch_size=1000)
    if gone:
        stat_model.objects.filter(pk__in=gone).delete()

    new_groups, changed_groups, gone_groups = [], [], []
    for row in scoped(group_model).iterator(chunk_size=5000):
        key = tuple(getattr(row, f) for f in _GROUP_KEY)
        n = want_groups.pop(key, None)
        if n is None:
            gone_groups.append(row.pk)
        elif n != row.matches:
            row.matches = n
            changed_groups.append(row)
    for key, n in want_groups.items():
        new_groups.append(group_model(tenant_id=tenant_id, matches=n,
                                      **dict(zip(_GROUP_KEY, key, strict=True))))
    group_model.objects.bulk_create(new_groups, batch_size=1000)
    group_model.objects.bulk_update(changed_groups, ["matches"], batch_size=1000)
    for i in range(0, len(gone_groups), 5000):
        group_model.objects.filter(pk__in=gone_groups[i:i + 5000]).delete()
    return (len(new) + len(changed) + len(gone) + len(new_groups) + len(changed_groups)
            + len(gone_groups))


def refresh_locked(tenant_id) -> int:
    """A whole-tenant refresh under the tenant's recompute lock (the job)."""
    from django.db import transaction

    from .matching import _lock

    with transaction.atomic():
        _lock(tenant_id)
        return refresh(tenant_id)
