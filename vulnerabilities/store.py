"""Writes normalised records into the store (#451).

Bulk, in batches, and idempotent: a record only replaces what is stored when
it is newer (NVD ``lastModified``, per-advisory OSV ``modified``), so
replaying a page or a file writes nothing. NVD owns a row's description,
CVSS, configurations and KEV dates; OSV adds its advisories' affected
packages under ``osv`` and fills the NVD fields only while no NVD record has
arrived. Microsoft's monthly data adds its Windows fixed builds under
``msrc`` (per month, replaced when Microsoft revised it) and fills the
description and CVSS while no NVD record has arrived, ahead of OSV's.
``CveProduct`` is rebuilt from the stored row whenever it changes.

Rows are written with ``bulk_create`` / ``bulk_update``: no signals, no
change log - this is fetched public data, thousands of rows per run.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from .models import NVD_SOURCES, Cve, CveProduct
from .products import TrackedProducts
from .sources import cpe_products

BATCH = 500

#: Called with the set of changed ``vuln_id`` values after each store (the
#: matching phase registers its recompute here).
_AFTER_STORE: list[Callable[[set[str]], None]] = []

_NVD_FIELDS = (
    "summary", "published", "last_modified", "vuln_status", "rejected",
    "cvss_version", "cvss_score", "cvss_severity", "cvss_vector", "attack_vector",
    "cvss_verified", "cwes", "references", "configurations", "fixed_in", "source",
)
_UPDATE_FIELDS = (*_NVD_FIELDS, "aliases", "osv", "msrc", "kev_added", "kev_due",
                  "kev_action", "fetched_at")


def register_after_store(fn: Callable[[set[str]], None]) -> None:
    if fn not in _AFTER_STORE:
        _AFTER_STORE.append(fn)


def unregister_after_store(fn: Callable[[set[str]], None]) -> None:
    if fn in _AFTER_STORE:
        _AFTER_STORE.remove(fn)


def after_store(changed: set[str]) -> None:
    if changed:
        for fn in list(_AFTER_STORE):
            fn(changed)


def _apply_common(row: Cve, rec: dict, source: str) -> None:
    metric = rec.get("cvss") or {}
    row.summary = rec["summary"]
    row.published = rec["published"]
    row.last_modified = rec["last_modified"]
    row.vuln_status = rec["vuln_status"]
    row.rejected = rec["rejected"]
    row.cvss_version = metric.get("version", "")
    row.cvss_score = metric.get("score")
    row.cvss_severity = metric.get("severity", "")
    row.cvss_vector = metric.get("vector", "")
    row.attack_vector = metric.get("attack_vector", "")
    row.cvss_verified = bool(metric.get("verified"))
    row.cwes = rec["cwes"]
    row.references = rec["references"]
    row.source = source


def _apply_nvd(row: Cve, rec: dict, source: str) -> bool:
    if row.source in NVD_SOURCES and row.last_modified is not None \
            and rec["last_modified"] <= row.last_modified:
        return False
    _apply_common(row, rec, source)
    row.configurations = rec["configurations"]
    row.fixed_in = rec["fixed_in"]
    kev = rec.get("kev")
    if kev:
        # NVD carries CISA's dates; the ransomware flag only comes with the
        # KEV file and is left alone.
        row.kev_added, row.kev_due = kev["added"], kev["due"]
        row.kev_action = kev["action"] or row.kev_action
    return True


def _apply_osv(row: Cve, rec: dict) -> bool:
    adv = rec["osv"]
    stored = (row.osv or {}).get(adv["id"])
    if stored and stored.get("modified", "") >= adv["modified"]:
        return False
    row.osv = {**(row.osv or {}), adv["id"]: {
        "modified": adv["modified"], "affected": adv["affected"],
        "fixed_in": adv["fixed_in"]}}
    if row.source in ("", "osv"):
        # No NVD or Microsoft record yet: the advisory's own description
        # and severity.
        _apply_common(row, rec, "osv")
    return True


def _apply_msrc(row: Cve, rec: dict) -> bool:
    """Microsoft's monthly data, filed under its month. Microsoft is the CNA
    for its own CVEs: its title and CVSS fill the row while no NVD record
    has arrived (over OSV's), and NVD's replace them when it does."""
    data = rec["msrc"]
    month = data["month"]
    stored = (row.msrc or {}).get(month)
    entry = {"revised": data["revised"], "products": data["products"]}
    if stored == entry or (stored and stored.get("revised", "") > data["revised"]):
        return False
    row.msrc = {**(row.msrc or {}), month: entry}
    if row.source in ("", "osv", "msrc"):
        _apply_common(row, rec, "msrc")
    return True


def _merge_aliases(row: Cve, aliases: Iterable[str]) -> bool:
    merged = sorted(set(row.aliases or []) | set(aliases) - {row.vuln_id})
    if merged != list(row.aliases or []):
        row.aliases = merged
        return True
    return False


def products_of(row: Cve) -> set[tuple[str, str, str, str]]:
    keys = set(cpe_products(row.configurations or []))
    for adv in (row.osv or {}).values():
        for a in adv.get("affected") or []:
            if a.get("purl_type") and a.get("package"):
                keys.add(("purl", "", a["purl_type"], a["package"]))
    for month in (row.msrc or {}).values():
        for key in (month.get("products") or {}):
            keys.add(("msrc", "", "microsoft", key))
    return keys


def _write_batch(records: list[dict], *, source: str, now: datetime,
                 counts: dict) -> set[str]:
    ids = {r["vuln_id"] for r in records}
    existing = {c.vuln_id: c for c in Cve.objects.filter(vuln_id__in=ids)}
    new: dict[str, Cve] = {}
    changed: dict[str, Cve] = {}
    for rec in records:
        vid = rec["vuln_id"]
        row = existing.get(vid) or new.get(vid)
        created = row is None
        if created:
            row = Cve(vuln_id=vid)
        if rec["kind"] == "nvd":
            touched = _apply_nvd(row, rec, source)
        elif rec["kind"] == "msrc":
            touched = _apply_msrc(row, rec)
        else:
            touched = _apply_osv(row, rec)
        touched = _merge_aliases(row, rec["aliases"]) or touched
        if not touched:
            counts["unchanged"] += 1
            continue
        row.fetched_at = now
        if created or vid in new:
            new[vid] = row
        else:
            changed[vid] = row
        counts["cvss_mismatch"] += 1 if rec.get("cvss_mismatch") else 0
    if not new and not changed:
        return set()
    with transaction.atomic():
        if new:
            Cve.objects.bulk_create(new.values(), batch_size=BATCH)
        if changed:
            Cve.objects.bulk_update(changed.values(), _UPDATE_FIELDS, batch_size=BATCH)
        rows = [*new.values(), *changed.values()]
        if rows:
            CveProduct.objects.filter(cve__in=[r.pk for r in changed.values()]).delete()
            CveProduct.objects.bulk_create(
                [CveProduct(cve=r, kind=k, part=p, vendor=v[:128], product=pr[:255])
                 for r in rows for (k, p, v, pr) in sorted(products_of(r))],
                batch_size=2000, ignore_conflicts=True)
    counts["created"] += len(new)
    counts["updated"] += len(changed)
    return set(new) | set(changed)


def store_records(records: Iterable[dict], *, source: str, tracked: TrackedProducts,
                  counts: dict | None = None,
                  progress: Callable[[dict], None] | None = None) -> dict:
    """Store every record that names a tracked product. ``source`` is the
    NVD provenance (``nvd_api``/``nvd_feed``/``browser``); OSV records are
    always ``osv``. Returns the counts."""
    counts = counts if counts is not None else {}
    for key in ("records", "created", "updated", "unchanged", "not_tracked",
                "cvss_mismatch", "truncated"):
        counts.setdefault(key, 0)
    now = timezone.now()
    batch: list[dict] = []
    changed: set[str] = set()
    for rec in records:
        counts["records"] += 1
        if not tracked.wants(rec["products"]):
            counts["not_tracked"] += 1
            continue
        if rec.get("configurations_truncated"):
            counts["truncated"] += 1
        batch.append(rec)
        if len(batch) >= BATCH:
            changed |= _write_batch(batch, source=source, now=now, counts=counts)
            batch = []
            if progress:
                progress(counts)
    if batch:
        changed |= _write_batch(batch, source=source, now=now, counts=counts)
    after_store(changed)
    return counts


_MONTHS = {m: i for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def month_start(month: str):
    """``date(2026, 11, 1)`` of ``2026-Nov``."""
    from datetime import date

    year, _, name = month.partition("-")
    return date(int(year), _MONTHS[name], 1)


def record_msrc_month(month: str, *, current_release, via: str, products, records: int) -> None:
    """Note that a monthly Microsoft document was read (bookkeeping, by
    upsert)."""
    from .models import MsrcMonth

    MsrcMonth.objects.update_or_create(month=month, defaults={
        "starts_on": month_start(month), "current_release": current_release,
        "read_at": timezone.now(), "via": via, "products": sorted(products),
        "records": records})


def store_kev(rows: Iterable[dict], counts: dict | None = None) -> dict:
    """KEV catalog rows onto the records already in the store (a KEV entry
    for a CVE nobody tracks has nowhere to go)."""
    counts = counts if counts is not None else {}
    for key in ("records", "updated", "unchanged", "not_in_store"):
        counts.setdefault(key, 0)
    changed: set[str] = set()

    def flush(chunk: dict[str, dict]) -> None:
        rows_ = list(Cve.objects.filter(vuln_id__in=chunk).only(
            "id", "vuln_id", "kev_added", "kev_due", "kev_action", "kev_ransomware"))
        counts["not_in_store"] += len(chunk) - len(rows_)
        dirty = []
        for row in rows_:
            k = chunk[row.vuln_id]
            new = (k["added"], k["due"], k["action"] or row.kev_action, k["ransomware"])
            if new == (row.kev_added, row.kev_due, row.kev_action, row.kev_ransomware):
                counts["unchanged"] += 1
                continue
            row.kev_added, row.kev_due, row.kev_action, row.kev_ransomware = new
            dirty.append(row)
            changed.add(row.vuln_id)
        Cve.objects.bulk_update(dirty, ["kev_added", "kev_due", "kev_action",
                                        "kev_ransomware"], batch_size=BATCH)
        counts["updated"] += len(dirty)

    chunk: dict[str, dict] = {}
    for row in rows:
        counts["records"] += 1
        chunk[row["vuln_id"]] = row
        if len(chunk) >= 2000:
            flush(chunk)
            chunk = {}
    if chunk:
        flush(chunk)
    after_store(changed)
    return counts


def store_epss(rows: Iterable[dict], counts: dict | None = None) -> dict:
    """EPSS scores onto the records in the store. A score older than the
    stored one is ignored, so an old file never rolls a score back."""
    counts = counts if counts is not None else {}
    for key in ("records", "updated", "unchanged", "not_in_store"):
        counts.setdefault(key, 0)
    changed: set[str] = set()

    def flush(chunk: dict[str, dict]) -> None:
        rows_ = list(Cve.objects.filter(vuln_id__in=chunk).only(
            "id", "vuln_id", "epss", "epss_percentile", "epss_date"))
        counts["not_in_store"] += len(chunk) - len(rows_)
        dirty = []
        for row in rows_:
            e = chunk[row.vuln_id]
            if row.epss_date is not None and (
                    e["date"] < row.epss_date
                    or (e["date"] == row.epss_date and row.epss == e["epss"]
                        and row.epss_percentile == e["percentile"])):
                counts["unchanged"] += 1
                continue
            row.epss, row.epss_percentile, row.epss_date = e["epss"], e["percentile"], e["date"]
            dirty.append(row)
            changed.add(row.vuln_id)
        Cve.objects.bulk_update(dirty, ["epss", "epss_percentile", "epss_date"],
                                batch_size=BATCH)
        counts["updated"] += len(dirty)

    chunk: dict[str, dict] = {}
    for row in rows:
        counts["records"] += 1
        chunk[row["vuln_id"]] = row
        if len(chunk) >= 5000:
            flush(chunk)
            chunk = {}
    if chunk:
        flush(chunk)
    after_store(changed)
    return counts

