"""Browser mode (#451): an admin's browser fetches, the server validates.

The Danbyte server stays offline. A deployment admin opens Settings →
Vulnerability data → Sync now from this browser; the page asks for a plan,
fetches NVD, FIRST EPSS and OSV itself (each answers cross-origin) and posts
every answer here **verbatim**. Nothing the browser computed is trusted: each
page goes through the same streaming parsers and store as an upload and a
server fetch, so CVSS 3.x is recomputed from the vector (a claimed score that
does not match is dropped and severity is derived server side), records are
kept only when they name the product the page was asked for, and replaying a
page writes nothing.

A run is a :class:`~vulnerabilities.models.SyncRun` with ``via="browser"``,
bound to the admin who opened it. It is ``running`` while posts arrive; one
idle for 30 minutes is abandoned by the shared stale rule
(:func:`vulnerabilities.imports.abandon_stale`) and the next start resumes it
from its ``progress`` (posted ``start_index`` values, EPSS batches, OSV
records), for the same or another admin.

The plan reuses server mode's cursors (:func:`fetch.nvd_window`): a product
fetched less than 110 days ago asks only for what changed since. The NVD API
key, when the admin has one, is typed on the sync page and used by the
browser only; it is never sent here, and the key stored for server mode is
never part of a plan.

Nothing here makes an outbound request.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from . import fetch, imports, products, sources, store
from .identifiers import cpe_product, is_vuln_id
from .models import SyncRun, VulnerabilitySettings
from .streaming import CappedReader, ImportFormatError, read_all

#: NVD records per browser page: a 500-CVE IOS XE page is about 3 MB.
PAGE = 500
NVD_RESULTS_MAX = 2000
NVD_POST_MAX = 8 * 1024 * 1024
EPSS_POST_MAX = 1024 * 1024
OSV_IDS_POST_MAX = 4 * 1024 * 1024
OSV_POST_MAX = 8 * 1024 * 1024
#: OSV records per post (the page batches its /v1/vulns answers).
OSV_POST_RECORDS = 25
OSV_IDS_MAX = 50_000
#: Per-run ceilings.
RUN_CVE_MAX = 200_000
RUN_EPSS_MAX = 100_000
EPSS_MAX_AGE = timedelta(days=30)
#: Posts per user per window (seconds).
POST_LIMIT = 20
POST_WINDOW = 10


class Refused(Exception):
    """A request the run cannot take; the message is for the admin."""

    def __init__(self, message: str, status: int = 400, field: str = "detail", **extra):
        super().__init__(message)
        self.status = status
        self.field = field
        self.extra = extra

    def body(self) -> dict:
        return {self.field: str(self), **self.extra}


def browser_mode(row: VulnerabilitySettings | None = None) -> bool:
    row = row or VulnerabilitySettings.load()
    return bool(row.enabled and row.update_source == "browser")


def _gate() -> VulnerabilitySettings:
    row = VulnerabilitySettings.load()
    if not row.enabled:
        raise Refused("Vulnerability data is off.", 409)
    if row.update_source != "browser":
        raise Refused("The update source is not set to Browser.", 409, "update_source")
    return row


def _urls(row: VulnerabilitySettings) -> dict:
    try:
        return {"nvd": fetch._https(row.nvd_url, fetch.NVD_BASE, "NVD") + fetch.NVD_CVES,
                "epss": fetch._https(row.epss_url, fetch.EPSS_BASE, "EPSS") + fetch.EPSS_PATH,
                "osv": fetch._https(row.osv_url, fetch.OSV_BASE, "OSV")}
    except fetch.FetchError as exc:
        raise Refused(str(exc), 409) from None


def _product_name(key) -> str:
    return ":".join(key[1:])


def _key_of(entry: dict):
    """The product key a plan entry stands for (checked again)."""
    key = entry.get("key")
    if not (isinstance(key, list) and len(key) == 4 and key[0] == "cpe"):
        return None
    _, part, vendor, product = key
    parsed = cpe_product(f"cpe:2.3:{part}:{vendor}:{product}:*:*:*:*:*:*:*:*")
    return ("cpe", *parsed) if parsed == (part, vendor, product) else None


def _nvd_entries(keys, now) -> list[dict]:
    out = []
    for key in sorted(keys):
        since, until = fetch.nvd_window(key, now)
        out.append({"product": _product_name(key), "key": list(key), "since": since,
                    "until": until, "params": fetch.nvd_params(key, since, until)})
    return out


def build_plan(row: VulnerabilitySettings, now) -> dict:
    """What the browser fetches. Public data only: no key, no tenant data
    beyond the product names the mappings track."""
    tracked = products.tracked()
    cpe = [k for k in tracked.keys if k[0] == "cpe"]
    purl = sorted(k for k in tracked.keys if k[0] == "purl")
    queries, unsupported = fetch.osv_queries(purl, fetch.package_releases())
    return {
        "resumable": True,
        "urls": _urls(row),
        "page_size": PAGE,
        "spacing": {"nvd": fetch.NVD_SPACING, "nvd_key": fetch.NVD_SPACING_KEY,
                    "epss": fetch.EPSS_SPACING, "osv": fetch.OSV_SPACING},
        "nvd_window": {"requests": 5, "requests_key": 50, "seconds": 30},
        "epss_batch": fetch.EPSS_BATCH,
        "sync_epss": row.sync_epss,
        "osv_batch": fetch.OSV_BATCH,
        "osv_post_records": OSV_POST_RECORDS,
        "nvd": _nvd_entries(cpe, now),
        "osv": {"keys": [list(k) for k in purl], "queries": queries,
                "unsupported": unsupported},
    }


def _merge_new_products(run: SyncRun, row: VulnerabilitySettings, now) -> dict:
    """A resumed plan also covers products mapped since it was made."""
    plan = dict(run.plan or {})
    have = {e["product"] for e in plan.get("nvd") or []}
    tracked = products.tracked()
    new = [k for k in tracked.keys if k[0] == "cpe" and _product_name(k) not in have]
    plan["nvd"] = [*(plan.get("nvd") or []), *_nvd_entries(new, now)]
    plan["urls"] = _urls(row)
    return plan


def start(user) -> SyncRun:
    """Open the admin's browser run: theirs if one is open, else resume the
    latest failed or abandoned browser run of the last 20 hours, else a new
    one. Raises :class:`Refused`."""
    row = _gate()
    if not products.tracked().kinds() & {"cpe", "purl"}:
        raise Refused("No product is mapped yet, so there is nothing to fetch.", 409)
    imports.abandon_stale()
    now = timezone.now()
    current = SyncRun.objects.select_related("started_by").filter(status="running").first()
    if current is not None:
        if current.via == "browser" and current.started_by_id == user.pk:
            return current
        if current.via == "browser":
            who = current.started_by.get_username() if current.started_by_id else "Another admin"
            raise Refused(f"{who} is syncing from their browser. A run with nothing posted "
                          "for 30 minutes is released.", 409)
        raise Refused("An update is already running.", 409)
    prev = (SyncRun.objects.filter(via="browser", status__in=("failed", "abandoned"),
                                   started_at__gte=now - fetch.RESUME_WINDOW,
                                   plan__resumable=True)
            .order_by("-started_at").first())
    try:
        with transaction.atomic():
            if prev is not None:
                progress = {**(prev.progress or {}),
                            "resumed": int((prev.progress or {}).get("resumed", 0)) + 1}
                if SyncRun.objects.filter(pk=prev.pk, status=prev.status).update(
                        status="running", finished_at=None, error="", started_by=user,
                        plan=_merge_new_products(prev, row, now), progress=progress,
                        updated_at=now):
                    prev.refresh_from_db()
                    return prev
            return SyncRun.objects.create(via="browser", started_by=user, started_at=now,
                                          status="running", plan=build_plan(row, now),
                                          progress={"nvd": {}, "epss": {}, "osv": {}})
    except IntegrityError:
        raise Refused("An update is already running.", 409) from None


def _locked(run_id, user) -> SyncRun:
    """The run, row-locked, when it is this admin's open browser run. Call
    inside ``transaction.atomic``."""
    _gate()
    run = SyncRun.objects.select_for_update().filter(pk=run_id).first()
    if run is None or run.via != "browser":
        raise Refused("Not found.", 404)
    if run.started_by_id != user.pk:
        raise Refused("This run belongs to another admin.", 403)
    if run.status != "running":
        raise Refused("The run is no longer open; start the sync again to resume it.", 409,
                      run_status=run.status)
    return run


def _save(run: SyncRun) -> None:
    SyncRun.objects.filter(pk=run.pk).update(progress=run.progress, counts=run.counts,
                                             plan=run.plan, updated_at=timezone.now())


def _errors(run: SyncRun, messages) -> None:
    log = run.progress.setdefault("errors", [])
    for m in messages:
        if len(log) >= imports.ERROR_SAMPLE:
            break
        log.append(str(m)[:300])


def _int(value, field: str, lo: int = 0, hi: int = 10_000_000) -> int:
    if isinstance(value, bool):
        raise Refused("A whole number.", 400, field)
    try:
        n = int(str(value))
    except (TypeError, ValueError):
        raise Refused("A whole number.", 400, field) from None
    if not lo <= n <= hi:
        raise Refused(f"Between {lo} and {hi}.", 400, field)
    return n


# ─── NVD ─────────────────────────────────────────────────────────────────────


def ingest_nvd(run_id, user, product: str, start_index, reader) -> dict:
    """One NVD API page, verbatim, for ``product`` at ``start_index``.
    ``reader`` is the request body (already capped by the view)."""
    start_index = _int(start_index, "start_index")
    if not isinstance(product, str) or not 0 < len(product) <= 400:
        raise Refused("A product of the run's plan (part:vendor:product).", 400, "product")
    header: dict = {}
    errors = imports.ErrorLog()
    try:
        records = list(sources.iter_nvd(CappedReader(reader, NVD_POST_MAX, "An NVD page"),
                                        header=header, errors=errors))
    except ImportFormatError as exc:
        raise Refused(str(exc), 400, "page") from None
    total, start = header.get("totalResults"), header.get("startIndex")
    per_page = header.get("resultsPerPage")
    if start != start_index:
        raise Refused("The page's startIndex is not the posted start_index.", 400, "page")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        raise Refused("The page has no totalResults.", 400, "page")
    if not isinstance(per_page, int) or isinstance(per_page, bool) \
            or not 0 <= per_page <= NVD_RESULTS_MAX:
        raise Refused(f"resultsPerPage must be at most {NVD_RESULTS_MAX}.", 400, "page")
    got = len(records) + errors.count
    if got > per_page:
        raise Refused("The page holds more records than its resultsPerPage.", 400, "page")
    with transaction.atomic():
        run = _locked(run_id, user)
        entry = next((e for e in (run.plan or {}).get("nvd") or []
                      if e.get("product") == product), None)
        key = _key_of(entry) if entry else None
        if key is None:
            raise Refused("This product is not in the run's plan.", 400, "product")
        name = entry["product"]
        nvd = run.progress.setdefault("nvd", {})
        p = nvd.setdefault(name, {"start_index": 0, "total": None, "done": False})
        if p.get("done") or start_index < p["start_index"]:
            return {"product": name, "duplicate": True, **p}
        if start_index > p["start_index"]:
            raise Refused(f"Expected the page at start_index {p['start_index']}.", 409,
                          "start_index", expected=p["start_index"])
        if got == 0 and start_index < total:
            # Kept on the product (the block commits), refused after it.
            p["error"] = "NVD stopped returning records before the last page."
            _save(run)
            stalled = p["error"]
        else:
            stalled = ""
            stored = _store_nvd_page(run, key, name, entry, p, records, errors, start_index,
                                     got, total)
    if stalled:
        raise Refused(stalled, 422, "page")
    return {"product": name, "duplicate": False, **p, **stored, "invalid": errors.count}


def _store_nvd_page(run, key, name, entry, p, records, errors, start_index, got,
                    total) -> dict:
    """Store an accepted page (inside the run's lock) and move the product on."""
    counts = run.counts.setdefault("nvd", {})
    if counts.get("records", 0) + len(records) > RUN_CVE_MAX:
        raise Refused(f"A run stores at most {RUN_CVE_MAX} records.", 413, "page")
    before = {k: counts.get(k, 0) for k in ("not_tracked", "cvss_mismatch", "created",
                                            "updated")}
    # Only records naming the posted product are kept: a page cannot write
    # CVEs under a product it was not asked for.
    store.store_records(records, source="browser", tracked=products.TrackedProducts({key}),
                        counts=counts)
    counts["invalid"] = counts.get("invalid", 0) + errors.count
    _errors(run, (f"NVD {name}: {m}" for m in errors.sample))
    p.update(start_index=start_index + got, total=total)
    p.pop("error", None)
    if p["start_index"] >= total:
        p["done"] = True
        fetch.mark_product(key, ok=True, until=entry.get("until"))
    _save(run)
    return {k: counts.get(k, 0) - v for k, v in before.items()}


# ─── EPSS ────────────────────────────────────────────────────────────────────


def epss_plan(run_id, user) -> dict:
    """The EPSS batches, computed once the NVD part has stored its records
    (and kept for the run, so a resume asks for the same batches)."""
    with transaction.atomic():
        run = _locked(run_id, user)
        plan = run.plan
        done = (run.progress.get("epss") or {}).get("done") or []
        if "epss" not in plan or not done:
            ids = fetch.epss_candidates(timezone.now().date()) if plan.get("sync_epss", True) \
                else []
            ids = ids[:RUN_EPSS_MAX]
            batch = fetch.EPSS_BATCH
            plan["epss"] = {"batches": [ids[i:i + batch] for i in range(0, len(ids), batch)]}
            _save(run)
        return {"batches": plan["epss"]["batches"], "done": done}


def ingest_epss(run_id, user, batch, reader) -> dict:
    """One FIRST EPSS API answer, verbatim, for batch number ``batch``."""
    batch = _int(batch, "batch", 0, RUN_EPSS_MAX)
    try:
        raw = read_all(CappedReader(reader, EPSS_POST_MAX, "An EPSS answer"))
        payload = json.loads(raw)
    except ImportFormatError as exc:
        raise Refused(str(exc), 413, "page") from None
    except (ValueError, UnicodeDecodeError):
        raise Refused("An EPSS answer is JSON.", 400, "page") from None
    today = timezone.now().date()
    errors = imports.ErrorLog()
    try:
        rows = sources.parse_epss_api(payload, today=today, errors=errors)
    except ImportFormatError as exc:
        raise Refused(str(exc), 400, "page") from None
    with transaction.atomic():
        run = _locked(run_id, user)
        batches = ((run.plan or {}).get("epss") or {}).get("batches")
        if batches is None:
            raise Refused("Ask for the EPSS plan first.", 409, "batch")
        if batch >= len(batches):
            raise Refused("No such batch in the run's plan.", 400, "batch")
        p = run.progress.setdefault("epss", {})
        done = p.setdefault("done", [])
        if batch in done:
            return {"batch": batch, "duplicate": True, "done": len(done),
                    "batches": len(batches)}
        wanted = set(batches[batch])
        kept, foreign, stale = [], 0, 0
        for r in rows:
            if r["vuln_id"] not in wanted:
                foreign += 1
            elif r["date"] < today - EPSS_MAX_AGE:
                stale += 1
            else:
                kept.append(r)
        if wanted and not kept:
            p["failed"] = sorted({*p.get("failed", []), batch})
            _save(run)
            empty = len(wanted)
        else:
            empty = 0
            counts = run.counts.setdefault("epss", {})
            store.store_epss(kept, counts=counts)
            counts["invalid"] = counts.get("invalid", 0) + errors.count + foreign + stale
            _errors(run, (f"EPSS: {m}" for m in errors.sample))
            done.append(batch)
            p["failed"] = [b for b in p.get("failed", []) if b != batch]
            _save(run)
    if empty:
        raise Refused(f"EPSS answered no usable scores for a batch of {empty} CVEs.",
                      422, "page")
    return {"batch": batch, "duplicate": False, "stored": len(kept), "dropped": foreign,
            "stale": stale, "invalid": errors.count, "done": len(done),
            "batches": len(batches)}


# ─── OSV ─────────────────────────────────────────────────────────────────────


def osv_ids(run_id, user, reader) -> dict:
    """``{"vulns": {id: modified}}`` - what the page's querybatch rounds
    found. Answers which advisories to fetch (new or changed since they were
    stored); the records themselves are validated when they are posted."""
    try:
        raw = read_all(CappedReader(reader, OSV_IDS_POST_MAX, "The OSV id list"))
        payload = json.loads(raw)
    except ImportFormatError as exc:
        raise Refused(str(exc), 413, "vulns") from None
    except (ValueError, UnicodeDecodeError):
        raise Refused("A JSON object.", 400, "vulns") from None
    vulns = payload.get("vulns") if isinstance(payload, dict) else None
    if not isinstance(vulns, dict) or len(vulns) > OSV_IDS_MAX:
        raise Refused(f"An object of at most {OSV_IDS_MAX} advisory ids.", 400, "vulns")
    seen = {k: str(v)[:40] for k, v in vulns.items() if is_vuln_id(k) and isinstance(v, str)}
    with transaction.atomic():
        run = _locked(run_id, user)
        if not ((run.plan or {}).get("osv") or {}).get("queries"):
            raise Refused("No package in this run's plan is answered by OSV.", 409)
        need = fetch._osv_stale(seen)
        capped = len(need) > fetch.OSV_FETCH_MAX
        need = need[:fetch.OSV_FETCH_MAX]
        run.plan.setdefault("osv", {})["to_fetch"] = need
        p = run.progress.setdefault("osv", {})
        p.update({"advisories": len(seen), "to_fetch": len(need), "posted": [],
                  "done": not need})
        run.counts.setdefault("osv", {})["advisories"] = len(seen)
        if capped:
            _errors(run, [f"OSV: more than {fetch.OSV_FETCH_MAX} advisories changed; the "
                          "rest follow next run."])
        _save(run)
    return {"to_fetch": need, "advisories": len(seen)}


def ingest_osv(run_id, user, reader) -> dict:
    """A JSON list of OSV records (the ``/v1/vulns/<id>`` answers), verbatim."""
    errors = imports.ErrorLog()
    try:
        records = list(sources.iter_osv_json(
            CappedReader(reader, OSV_POST_MAX, "The OSV records"), errors=errors))
    except ImportFormatError as exc:
        raise Refused(str(exc), 400, "records") from None
    if len(records) + errors.count > OSV_POST_RECORDS:
        raise Refused(f"At most {OSV_POST_RECORDS} records per post.", 400, "records")
    with transaction.atomic():
        run = _locked(run_id, user)
        osv_plan = (run.plan or {}).get("osv") or {}
        wanted = set(osv_plan.get("to_fetch") or [])
        if "to_fetch" not in osv_plan:
            raise Refused("Post the OSV id list first.", 409, "records")
        keys = {tuple(k) for k in osv_plan.get("keys") or []}
        kept, foreign = [], 0
        for r in records:
            if r["osv"]["id"] in wanted:
                kept.append(r)
            else:
                foreign += 1
        counts = run.counts.setdefault("osv", {})
        store.store_records(kept, source="osv", tracked=products.TrackedProducts(keys),
                            counts=counts)
        counts["invalid"] = counts.get("invalid", 0) + errors.count + foreign
        _errors(run, (f"OSV: {m}" for m in errors.sample))
        p = run.progress.setdefault("osv", {})
        posted = set(p.get("posted") or []) | {r["osv"]["id"] for r in kept}
        p["posted"] = sorted(posted)
        p["done"] = wanted <= posted
        _save(run)
    return {"stored": len(kept), "dropped": foreign, "invalid": errors.count,
            "posted": len(posted), "to_fetch": len(wanted), "done": p["done"]}


# ─── finish ──────────────────────────────────────────────────────────────────


def finish(run_id, user, *, client_errors=None, stop: bool = False) -> SyncRun:
    """End the run. ``stop`` leaves it abandoned (resumable); otherwise it is
    ``ok`` when every product, EPSS batch and OSV record arrived and the page
    reported no failure, else ``failed`` with what is missing (a later start
    resumes it). Either way the tenants' matches are recomputed."""
    from .jobs import enqueue_all

    messages = [str(m)[:300] for m in (client_errors or [])[:imports.ERROR_SAMPLE]
                if isinstance(m, str)]
    with transaction.atomic():
        run = _locked(run_id, user)
        if stop:
            imports._finish(run, "abandoned", error="Stopped in the browser.",
                            counts=run.counts)
        else:
            missing = []
            nvd = run.progress.get("nvd") or {}
            for e in run.plan.get("nvd") or []:
                p = nvd.get(e["product"]) or {}
                if not p.get("done"):
                    missing.append(f"NVD {e['product']}: not finished"
                                   + (f" ({p['error']})" if p.get("error") else ""))
                    key = _key_of(e)
                    if key is not None:
                        fetch.mark_product(key, ok=False)
            epss = run.plan.get("epss")
            if run.plan.get("sync_epss", True) and epss is not None:
                left = len(epss["batches"]) - len((run.progress.get("epss") or {})
                                                  .get("done") or [])
                if left:
                    missing.append(f"EPSS: {left} batches not posted.")
            osv = run.progress.get("osv") or {}
            if "to_fetch" in (run.plan.get("osv") or {}) and not osv.get("done"):
                missing.append("OSV: not every advisory was posted.")
            lines = [*messages, *missing, *(run.progress.get("errors") or [])]
            imports._finish(run, "failed" if messages or missing else "ok",
                            error="\n".join(lines), counts=run.counts)
        transaction.on_commit(enqueue_all)
    run.refresh_from_db()
    return run
