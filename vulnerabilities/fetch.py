"""Server mode (#451): the Danbyte server fetches the vulnerability data.

Runs only while a deployment admin has turned the feature on **and** picked
``update_source == "server"``; every entry point re-reads the settings and
does nothing otherwise, so an airgapped install (the default is ``upload``)
never makes a request. What is contacted, in order:

1. **NVD CVE API 2.0** - per tracked CPE product, every CVE whose
   configurations name it (``virtualMatchString``), 2000 per page. A product
   fetched less than 110 days ago asks only for records modified since
   (``lastModStartDate``/``lastModEndDate``, the API allows 120 days);
   older or never fetched, the product is fetched whole. The cursor is
   :class:`~vulnerabilities.models.CpeProductSync`.
2. **OSV** - one ``querybatch`` for the tracked packages (1000 per call,
   paged by ``next_page_token``), then ``/v1/vulns/<id>`` for each advisory
   that is new or modified since it was stored.
3. **Microsoft (MSRC CVRF)** - only when discovery has read a Windows host:
   the index of monthly security update documents, then each document of
   the last :data:`MSRC_MONTHS` months that Microsoft revised since it was
   read, or that was read for fewer Windows products than are tracked now.
   Only month ids (``2026-Nov``) are in the requests.
4. **CISA KEV** - the catalog JSON, one request.
5. **FIRST EPSS** - the scores of the stored CVEs, 100 per request, for
   CVEs without a score from yesterday or today.

Every request goes through :class:`core.ssrf.SafeSession` (public address,
pinned connection, no redirects) with a timeout and a size cap, and is
parsed by the same streaming parsers as an upload. NVD is paced to its
limits (5 requests per rolling 30 s without a key, 50 with one); 403, 429
and 5xx answers back off and retry, then the product or batch is marked
failed and the run goes on. Progress is saved on the
:class:`~vulnerabilities.models.SyncRun` after every page, so a run that
failed or was abandoned is resumed by the next start within 20 hours. The
NVD API key is sent only to the NVD host, as the ``apiKey`` header, and is
never logged, stored on a run or returned.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlparse

import requests
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from core.ssrf import SafeSession, SSRFError

from . import imports, products, sources, store
from .identifiers import cpe_product, is_vuln_id, osv_ecosystems
from .models import CpeProductSync, Cve, CveProduct, SyncRun, VulnerabilitySettings
from .streaming import CappedReader, ImportFormatError

log = logging.getLogger(__name__)

NVD_BASE = "https://services.nvd.nist.gov"
NVD_CVES = "/rest/json/cves/2.0"
NVD_CPES = "/rest/json/cpes/2.0"
OSV_BASE = "https://api.osv.dev"
EPSS_BASE = "https://api.first.org"
EPSS_PATH = "/data/v1/epss"
KEV_URL = ("https://www.cisa.gov/sites/default/files/feeds/"
           "known_exploited_vulnerabilities.json")
MSRC_BASE = "https://api.msrc.microsoft.com/cvrf/v3.0"
#: Monthly documents kept: builds are cumulative, so a host behind by more
#: than this still matches every month in the window.
MSRC_MONTHS = 12
MSRC_SPACING = 2.0
#: A monthly document is 4 to 30 MB of JSON (2026-Oct: 30 MB, 3,491 CVEs).
MSRC_DOC_MAX_BYTES = 192 * 1024 * 1024
MSRC_INDEX_MAX_BYTES = 8 * 1024 * 1024

NVD_PAGE = 2000
#: Younger cursors fetch only what changed; the API refuses a window over 120 days.
NVD_WINDOW = timedelta(days=110)
CURSOR_OVERLAP = timedelta(minutes=10)
NVD_MAX_PAGES = 250
#: Seconds between requests: NVD allows 5 per 30 s without a key, 50 with one.
NVD_SPACING = 6.5
NVD_SPACING_KEY = 0.7
OSV_SPACING = 0.2
EPSS_SPACING = 1.0
KEV_SPACING = 0.0

OSV_BATCH = 1000
OSV_MAX_ROUNDS = 50
OSV_FETCH_MAX = 20_000
OSV_STORE_CHUNK = 50
EPSS_BATCH = 100

NVD_PAGE_MAX_BYTES = 256 * 1024 * 1024
OSV_BATCH_MAX_BYTES = 32 * 1024 * 1024
EPSS_MAX_BYTES = 4 * 1024 * 1024
CPE_MAX_BYTES = 16 * 1024 * 1024

#: (connect, read) seconds.
TIMEOUT = (10, 120)
RETRY_STATUSES = frozenset({403, 429, 500, 502, 503, 504})
BACKOFF = (30, 60, 120)
RETRY_AFTER_MAX = 300
#: A failed or abandoned server run younger than this is resumed, not restarted.
RESUME_WINDOW = timedelta(hours=20)
JOB_TIMEOUT = 6 * 3600

#: Swapped by tests; nothing else should touch them.
_sleep = time.sleep
_monotonic = time.monotonic


class FetchError(Exception):
    """A request or its answer failed; the message is for the run log and
    never carries a request header."""


class Off(Exception):
    """The feature is off or not in server mode: nothing may be fetched."""


class Busy(Exception):
    """Another update is running."""


class Stopped(Exception):
    """The run was ended elsewhere (abandoned) while this job worked."""


# ─── configuration ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Config:
    nvd: str
    osv: str
    epss: str
    kev: str
    sync_epss: bool
    sync_kev: bool
    msrc: str = MSRC_BASE
    sync_msrc: bool = True
    #: Kept out of ``repr`` so a traceback or a log line never prints it.
    api_key: str = ""

    def __repr__(self) -> str:
        return f"Config(nvd={self.nvd!r}, key_set={bool(self.api_key)})"


def server_mode(row: VulnerabilitySettings | None = None) -> bool:
    row = row or VulnerabilitySettings.load()
    return bool(row.enabled and row.update_source == "server")


def _https(configured: str, default: str, what: str) -> str:
    url = (configured or default).strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise FetchError(f"The {what} URL must use https.")
    return url


def config(row: VulnerabilitySettings | None = None) -> Config:
    """The fetch configuration, or :class:`Off` unless the feature is on in
    server mode (fail closed)."""
    row = row or VulnerabilitySettings.load()
    if not server_mode(row):
        raise Off("Vulnerability data is not set to update from this server.")
    return Config(
        nvd=_https(row.nvd_url, NVD_BASE, "NVD"),
        osv=_https(row.osv_url, OSV_BASE, "OSV"),
        epss=_https(row.epss_url, EPSS_BASE, "EPSS"),
        kev=_https(row.kev_url, KEV_URL, "KEV"),
        sync_epss=row.sync_epss,
        sync_kev=row.sync_kev,
        msrc=_https(row.msrc_url, MSRC_BASE, "Microsoft"),
        sync_msrc=row.sync_msrc,
        api_key=str((row.secrets or {}).get("nvd_api_key") or ""),
    )


def _gate() -> None:
    """Re-check before each product or batch: switching the feature off or
    away from server mode stops a run at the next request."""
    if not server_mode():
        raise Off("Vulnerability data was turned off or moved off server mode.")


# ─── HTTP ────────────────────────────────────────────────────────────────────


class Pacer:
    """At most one request per ``spacing`` seconds."""

    def __init__(self, spacing: float):
        self.spacing = spacing
        self._last: float | None = None

    def wait(self) -> None:
        now = _monotonic()
        if self._last is not None:
            delay = self._last + self.spacing - now
            if delay > 0:
                _sleep(delay)
                now += delay
        self._last = now


class _Body(io.RawIOBase):
    """A response body as a binary reader (decoded, streamed)."""

    def __init__(self, resp):
        self._it = resp.iter_content(1 << 16)
        self._buf = b""

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while not self._buf:
            try:
                self._buf = next(self._it)
            except StopIteration:
                return 0
            except requests.RequestException as exc:
                raise FetchError(f"The answer broke off ({exc.__class__.__name__}).") from None
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        self._buf = self._buf[n:]
        return n


def body(resp, max_bytes: int, what: str):
    return CappedReader(_Body(resp), max_bytes, what)


def read_json(resp, max_bytes: int, what: str):
    try:
        raw = body(resp, max_bytes, what).read(max_bytes + 1)
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        if isinstance(exc, ImportFormatError):
            raise
        raise FetchError(f"{what} is not JSON.") from None
    finally:
        resp.close()


def _retry_after(resp) -> float | None:
    try:
        value = float(resp.headers.get("Retry-After", ""))
    except (TypeError, ValueError):
        return None
    return max(0.0, min(value, RETRY_AFTER_MAX))


class Client:
    """One SSRF-guarded session for a run, paced per source."""

    def __init__(self, cfg: Config, *, session=None):
        self.cfg = cfg
        self.session = session or SafeSession()
        self.pacers = {
            "nvd": Pacer(NVD_SPACING_KEY if cfg.api_key else NVD_SPACING),
            "osv": Pacer(OSV_SPACING),
            "epss": Pacer(EPSS_SPACING),
            "kev": Pacer(KEV_SPACING),
            "msrc": Pacer(MSRC_SPACING),
        }
        self.requests = 0
        self.retries = 0

    def close(self) -> None:
        self.session.close()

    def request(self, source: str, url: str, *, method: str = "GET", params=None,
                json_body=None, retries: tuple[int, ...] = BACKOFF):
        headers = {"Accept": "application/json", "User-Agent": "Danbyte"}
        if source == "nvd" and self.cfg.api_key:
            headers["apiKey"] = self.cfg.api_key
        host = urlparse(url).hostname or url
        problem = ""
        for attempt in range(len(retries) + 1):
            self.pacers[source].wait()
            self.requests += 1
            delay = None
            try:
                resp = self.session.request(method, url, params=params, json=json_body,
                                            headers=headers, timeout=TIMEOUT, stream=True)
            except SSRFError as exc:
                raise FetchError(str(exc)) from None
            except requests.RequestException as exc:
                problem = f"{host} could not be reached ({exc.__class__.__name__})"
            else:
                if resp.status_code == 200:
                    return resp
                code = resp.status_code
                message = str(resp.headers.get("message", ""))[:200]
                delay = _retry_after(resp)
                resp.close()
                if 300 <= code < 400:
                    raise FetchError(f"{host} answered a redirect (HTTP {code}); "
                                     "redirects are not followed.")
                problem = f"{host} answered HTTP {code}" + (f": {message}" if message else "")
                if code not in RETRY_STATUSES:
                    raise FetchError(problem)
            if attempt >= len(retries):
                break
            self.retries += 1
            _sleep(retries[attempt] if delay is None else delay)
        raise FetchError(f"{problem} (after {len(retries) + 1} tries).")


# ─── runs ────────────────────────────────────────────────────────────────────


def start_run(user=None, *, only: list | None = None) -> SyncRun:
    """Open a server run: resume the latest failed or abandoned one from the
    last 20 hours (``only`` runs never resume or get resumed), else a new
    one. Raises :class:`Off` or :class:`Busy`."""
    config()
    imports.abandon_stale()
    now = timezone.now()
    prev = None
    if not only:
        prev = (SyncRun.objects.filter(via="server", status__in=("failed", "abandoned"),
                                       started_at__gte=now - RESUME_WINDOW,
                                       plan__resumable=True)
                .order_by("-started_at").first())
    try:
        with transaction.atomic():
            if prev is not None:
                progress = {**(prev.progress or {}),
                            "resumed": int((prev.progress or {}).get("resumed", 0)) + 1}
                if SyncRun.objects.filter(pk=prev.pk, status=prev.status).update(
                        status="running", finished_at=None, error="", progress=progress,
                        updated_at=now):
                    prev.refresh_from_db()
                    return prev
            plan = {"resumable": not only}
            if only:
                plan["only"] = [list(k) for k in only]
            return SyncRun.objects.create(
                via="server", started_by=user if getattr(user, "is_authenticated", False)
                else None, started_at=now, status="running", plan=plan)
    except IntegrityError:
        raise Busy("An update is already running.") from None


class _State:
    """The run's progress and counts, saved after every page."""

    def __init__(self, run: SyncRun):
        self.run_id = run.pk
        self.progress: dict = dict(run.progress or {})
        self.counts: dict = dict(run.counts or {})
        self.errors: list[str] = []

    def section(self, name: str) -> dict:
        return self.counts.setdefault(name, {})

    def save(self, *_args) -> None:
        self.progress["errors"] = self.errors[:imports.ERROR_SAMPLE]
        n = SyncRun.objects.filter(pk=self.run_id, status="running").update(
            progress=self.progress, counts=self.counts, updated_at=timezone.now())
        if not n:
            raise Stopped("The run was ended while it worked.")


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000+00:00")


def _parse_iso(value) -> datetime | None:
    return sources.parse_datetime(value) if value else None


def _cursor(key, *, status: str, until: datetime | None = None) -> None:
    _, part, vendor, product = key
    row, _ = CpeProductSync.objects.get_or_create(part=part, vendor=vendor[:128],
                                                  product=product[:255])
    fields = {"last_status": status, "cve_count": CveProduct.objects.filter(
        kind="cpe", part=part, vendor=vendor, product=product).values("cve").distinct().count()}
    if until is not None:
        fields["last_synced_at"] = until
    CpeProductSync.objects.filter(pk=row.pk).update(**fields)


def _nvd_product(client: Client, key, p: dict, tracked, state: _State) -> None:
    counts = state.section("nvd")
    errors = imports.ErrorLog()
    pages = 0
    while True:
        params = {**nvd_params(key, p.get("since"), p["until"]),
                  "resultsPerPage": NVD_PAGE, "startIndex": p["start_index"]}
        resp = client.request("nvd", f"{client.cfg.nvd}{NVD_CVES}", params=params)
        header: dict = {}
        before = counts.get("records", 0)
        try:
            store.store_records(
                sources.iter_nvd(body(resp, NVD_PAGE_MAX_BYTES, "An NVD page"),
                                 header=header, errors=errors),
                source="nvd_api", tracked=tracked, counts=counts)
        finally:
            resp.close()
        # Records that failed validation still occupy their place in the
        # page; the next page starts after them.
        got = counts.get("records", 0) - before + errors.count
        total, start = header.get("totalResults"), header.get("startIndex")
        if not isinstance(total, int) or start != p["start_index"]:
            raise FetchError("NVD answered a page that does not fit the request.")
        p["total"] = total
        p["start_index"] += got
        counts["invalid"] = counts.get("invalid", 0) + errors.count
        errors.count = 0
        state.save()
        if p["start_index"] >= total:
            return
        pages += 1
        if got == 0 or pages >= NVD_MAX_PAGES:
            raise FetchError("NVD stopped returning records before the last page.")
        _gate()


def nvd_window(key, now: datetime) -> tuple[str | None, str]:
    """``(since, until)`` for a product: only what changed since its cursor
    when that is younger than 110 days, else ``since`` is None (the whole
    product). Server and browser mode share it, and the cursor it reads."""
    cursor = CpeProductSync.objects.filter(
        part=key[1], vendor=key[2], product=key[3]).values_list(
        "last_synced_at", flat=True).first()
    since = None
    if cursor is not None and now - cursor < NVD_WINDOW:
        since = _iso(cursor - CURSOR_OVERLAP)
    return since, _iso(now)


def nvd_params(key, since: str | None, until: str) -> dict:
    """The NVD query for a product, without paging."""
    _, part, vendor, product = key
    params = {"virtualMatchString": f"cpe:2.3:{part}:{vendor}:{product}"}
    if since:
        params["lastModStartDate"] = since
        params["lastModEndDate"] = until
    return params


def mark_product(key, *, ok: bool, until: str | None = None) -> None:
    """Record a product's fetch outcome; ``until`` moves its cursor."""
    _cursor(key, status="ok" if ok else "failed",
            until=_parse_iso(until) if ok and until else None)


def _sync_nvd(client: Client, tracked, state: _State, now: datetime) -> None:
    keys = sorted(k for k in tracked.keys if k[0] == "cpe")
    nvd = state.progress.setdefault("nvd", {})
    for key in keys:
        name = ":".join(key[1:])
        p = nvd.get(name)
        if p and p.get("done"):
            continue
        if p is None:
            since, until = nvd_window(key, now)
            p = nvd[name] = {"start_index": 0, "total": None, "since": since,
                             "until": until, "done": False}
            state.save()
        _gate()
        try:
            _nvd_product(client, key, p, tracked, state)
        except (FetchError, ImportFormatError) as exc:
            p["error"] = str(exc)[:300]
            state.errors.append(f"NVD {name}: {exc}")
            _cursor(key, status="failed")
        else:
            p["done"] = True
            p.pop("error", None)
            _cursor(key, status="ok", until=_parse_iso(p["until"]))
        state.save()


def _purl(ptype: str, product: str) -> str:
    return f"pkg:{ptype}/" + "/".join(quote(s, safe="") for s in product.split("/"))


def _ecosystem_queries(ptype: str, product: str, releases) -> list[dict]:
    """``{ecosystem, name}`` queries for a deb or apk package whose hosts'
    releases are all known (``Debian:12``); ``[]`` to ask by purl instead.
    A purl with ``distro=debian-12`` answers nothing, so the release is never
    sent as a qualifier. RPM names keep their case at OSV, so RPM packages
    are still asked for by purl."""
    if ptype not in ("deb", "apk") or not releases or None in releases:
        return []
    ecosystems = set()
    for release in releases:
        names = osv_ecosystems(release)
        if not names:
            return []
        ecosystems.update(names)
    name = product.rpartition("/")[2]
    return [{"package": {"ecosystem": e, "name": name}} for e in sorted(ecosystems)]


def osv_queries(keys, releases: dict | None = None) -> tuple[list[dict], int]:
    """``(querybatch queries, packages OSV cannot answer)`` for purl keys.
    ``releases`` (``matching.package_releases``) narrows a distro package to
    its hosts' releases."""
    queries, unsupported = [], 0
    releases = releases or {}
    for key in sorted(keys):
        _, _, ptype, product = key
        if ptype == "generic":
            unsupported += 1  # OSV has no ecosystem for a generic package
            continue
        by_release = _ecosystem_queries(ptype, product, releases.get(tuple(key)))
        queries.extend(by_release or [{"package": {"purl": _purl(ptype, product)}}])
    return queries, unsupported


def package_releases() -> dict:
    """The tracked distro packages' releases; ``{}`` when they cannot be read
    (the fetch then asks by purl, as before)."""
    from . import products
    from .matching import package_releases as releases

    try:
        out = {k: set(v) for k, v in releases().items()}
        # Inventoried packages (discovery) bring their hosts' releases.
        for key, more in products.provided_releases().items():
            out.setdefault(key, set()).update(more)
        return out
    except Exception:  # noqa: BLE001 - never stop a fetch over the narrowing
        log.exception("vulnerabilities: reading distro releases failed")
        return {}


def epss_candidates(today) -> list[str]:
    """The stored CVEs whose EPSS score is missing or older than yesterday."""
    return list(Cve.objects.filter(vuln_id__startswith="CVE-", rejected=False)
                .filter(Q(epss_date__isnull=True) | Q(epss_date__lt=today - timedelta(days=1)))
                .order_by("vuln_id").values_list("vuln_id", flat=True))


def _osv_ids(client: Client, queries: list[dict], counts: dict) -> dict[str, str]:
    """``{advisory id: modified}`` for every query, following page tokens."""
    seen: dict[str, str] = {}
    for i in range(0, len(queries), OSV_BATCH):
        pending = queries[i:i + OSV_BATCH]
        for _round in range(OSV_MAX_ROUNDS):
            if not pending:
                break
            _gate()
            resp = client.request("osv", f"{client.cfg.osv}/v1/querybatch", method="POST",
                                  json_body={"queries": pending})
            payload = read_json(resp, OSV_BATCH_MAX_BYTES, "An OSV answer")
            results = payload.get("results") if isinstance(payload, dict) else None
            if not isinstance(results, list) or len(results) != len(pending):
                raise FetchError("OSV answered a batch that does not fit the request.")
            nxt = []
            for query, result in zip(pending, results, strict=True):
                if not isinstance(result, dict):
                    continue
                for v in result.get("vulns") or []:
                    if isinstance(v, dict) and is_vuln_id(v.get("id")):
                        seen[v["id"]] = str(v.get("modified") or "")[:40]
                token = result.get("next_page_token")
                if isinstance(token, str) and token and len(token) < 4096:
                    nxt.append({"package": query["package"], "page_token": token})
            pending = nxt
        counts["packages_queried"] = counts.get("packages_queried", 0) + len(queries[i:i + OSV_BATCH])
    return seen


def _osv_stale(seen: dict[str, str]) -> list[str]:
    """The advisories that are new or modified since they were stored."""
    stored: dict[str, str] = {}
    ids = sorted(seen)
    for i in range(0, len(ids), 1000):
        chunk = ids[i:i + 1000]
        for osv in Cve.objects.filter(osv__has_any_keys=chunk).values_list("osv", flat=True):
            for k, v in (osv or {}).items():
                if k in seen and isinstance(v, dict):
                    stored[k] = v.get("modified", "")
    out = []
    for vid in ids:
        new, old = _parse_iso(seen[vid]), _parse_iso(stored.get(vid))
        if old is None or new is None or new > old:
            out.append(vid)
    return out


def _sync_osv(client: Client, tracked, state: _State) -> None:
    keys = sorted(k for k in tracked.keys if k[0] == "purl")
    p = state.progress.setdefault("osv", {})
    if not keys or p.get("done"):
        return
    counts = state.section("osv")
    queries, unsupported = osv_queries(keys, package_releases())
    counts["unsupported"] = unsupported
    if not queries:
        p["done"] = True
        return
    try:
        seen = _osv_ids(client, queries, counts)
    except (FetchError, ImportFormatError) as exc:
        state.errors.append(f"OSV query: {exc}")
        p["error"] = str(exc)[:300]
        state.save()
        return
    need = _osv_stale(seen)
    counts["advisories"] = len(seen)
    p.update({"advisories": len(seen), "to_fetch": len(need), "fetched": 0})
    if len(need) > OSV_FETCH_MAX:
        state.errors.append(f"OSV: {len(need)} advisories changed; fetched the first "
                            f"{OSV_FETCH_MAX}, the rest follow next run.")
        need = need[:OSV_FETCH_MAX]
    state.save()
    failed = 0
    errors = imports.ErrorLog()
    for i in range(0, len(need), OSV_STORE_CHUNK):
        _gate()
        records = []
        for vid in need[i:i + OSV_STORE_CHUNK]:
            try:
                resp = client.request("osv", f"{client.cfg.osv}/v1/vulns/{quote(vid, safe='')}")
                try:
                    records.extend(sources.iter_osv_json(
                        body(resp, sources.RECORD_MAX, "An OSV record"), errors=errors))
                finally:
                    resp.close()
            except (FetchError, ImportFormatError) as exc:
                failed += 1
                if failed <= 5:
                    state.errors.append(f"OSV {vid}: {exc}")
        store.store_records(records, source="osv", tracked=tracked, counts=counts)
        p["fetched"] = min(len(need), i + OSV_STORE_CHUNK)
        counts["invalid"] = errors.count
        state.save()
    counts["failed"] = failed
    if failed:
        state.errors.append(f"OSV: {failed} advisories could not be fetched.")
    else:
        p["done"] = True
    state.save()


def msrc_index(payload, now: datetime) -> list[tuple[str, datetime | None]]:
    """``(month, current release)`` of the index's monthly documents of the
    last :data:`MSRC_MONTHS` months, newest first. Entries that are not a
    month id are skipped."""
    from .store import month_start

    values = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        raise FetchError("Microsoft answered an index without a 'value' list.")
    first = now.date().replace(day=1)
    for _ in range(MSRC_MONTHS - 1):
        first = (first - timedelta(days=1)).replace(day=1)
    out = {}
    for v in values[:5000]:
        month = sources.msrc_month(v.get("ID")) if isinstance(v, dict) else None
        if month is None or month_start(month) < first or month_start(month) > now.date():
            continue
        out[month] = sources.parse_datetime(v.get("CurrentReleaseDate"))
    return sorted(out.items(), key=lambda kv: month_start(kv[0]), reverse=True)


def msrc_stale(index, keys: set[str]) -> list[str]:
    """The months to read: never read, revised by Microsoft since, or read
    for fewer of the tracked Windows products than now."""
    from .models import MsrcMonth

    have = {m.month: m for m in MsrcMonth.objects.filter(month__in=[k for k, _ in index])}
    out = []
    for month, current in index:
        row = have.get(month)
        if row is None or not keys <= set(row.products or []) \
                or (current is not None and (row.current_release is None
                                             or current > row.current_release)):
            out.append(month)
    return out


def _sync_msrc(client: Client, tracked, state: _State, now: datetime) -> None:
    """Microsoft's monthly documents, for the tracked Windows products only.
    The requests name months, never a host or a product."""
    keys = {k[3] for k in tracked.keys if k[0] == "msrc"}
    p = state.progress.setdefault("msrc", {})
    if not keys or p.get("done"):
        return
    counts = state.section("msrc")
    _gate()
    try:
        resp = client.request("msrc", f"{client.cfg.msrc}/updates")
        index = msrc_index(read_json(resp, MSRC_INDEX_MAX_BYTES, "The Microsoft index"), now)
    except (FetchError, ImportFormatError) as exc:
        state.errors.append(f"Microsoft index: {exc}")
        p["error"] = str(exc)[:300]
        state.save()
        return
    todo = p.get("todo")
    if todo is None:
        todo = p["todo"] = msrc_stale(index, keys)
    done = p.setdefault("months", [])
    counts["months"] = len(todo)
    state.save()
    failed = 0
    errors = imports.ErrorLog()
    for month in todo:
        if month in done:
            continue
        _gate()
        header: dict = {}
        doc_counts: dict = {}
        try:
            resp = client.request("msrc", f"{client.cfg.msrc}/cvrf/{quote(month, safe='')}")
            try:
                store.store_records(
                    sources.iter_msrc(body(resp, MSRC_DOC_MAX_BYTES, f"Microsoft {month}"),
                                      header=header, errors=errors),
                    source="msrc", tracked=tracked, counts=doc_counts)
            finally:
                resp.close()
            if header.get("month") != month:
                raise FetchError(f"Microsoft answered another document for {month}.")
        except (FetchError, ImportFormatError) as exc:
            failed += 1
            state.errors.append(f"Microsoft {month}: {exc}")
        else:
            store.record_msrc_month(
                month, current_release=header.get("current_release"), via="server",
                products=keys, records=doc_counts["records"] - doc_counts["not_tracked"])
            done.append(month)
        for k, v in doc_counts.items():
            counts[k] = counts.get(k, 0) + v
        counts["invalid"] = errors.count
        state.save()
    if not failed:
        p["done"] = True
    state.save()


def _sync_kev(client: Client, state: _State) -> None:
    p = state.progress.setdefault("kev", {})
    if p.get("done"):
        return
    _gate()
    counts = state.section("kev")
    errors = imports.ErrorLog()
    try:
        resp = client.request("kev", client.cfg.kev)
        try:
            store.store_kev(sources.iter_kev(body(resp, imports.KEV_MAX_BYTES, "The KEV catalog"),
                                             errors=errors), counts=counts)
        finally:
            resp.close()
    except (FetchError, ImportFormatError) as exc:
        state.errors.append(f"KEV: {exc}")
        p["error"] = str(exc)[:300]
    else:
        p["done"] = True
        p.pop("error", None)
    counts["invalid"] = errors.count
    state.save()


def _sync_epss(client: Client, state: _State, today) -> None:
    p = state.progress.setdefault("epss", {})
    counts = state.section("epss")
    ids = epss_candidates(today)
    p.update({"to_fetch": len(ids), "batches_failed": 0})
    errors = imports.ErrorLog()
    for i in range(0, len(ids), EPSS_BATCH):
        _gate()
        batch = ids[i:i + EPSS_BATCH]
        try:
            resp = client.request("epss", f"{client.cfg.epss}{EPSS_PATH}",
                                  params={"cve": ",".join(batch)})
            rows = sources.parse_epss_api(read_json(resp, EPSS_MAX_BYTES, "An EPSS answer"),
                                          today=today, errors=errors)
            if not rows:
                raise FetchError("EPSS answered no scores for a batch of "
                                 f"{len(batch)} CVEs.")
            store.store_epss(rows, counts=counts)
        except (FetchError, ImportFormatError) as exc:
            p["batches_failed"] += 1
            if p["batches_failed"] <= 5:
                state.errors.append(f"EPSS batch {i // EPSS_BATCH + 1}: {exc}")
        counts["invalid"] = errors.count
        state.save()


def execute(run_id, *, session=None) -> SyncRun | None:
    """Do the run. Never raises; the outcome lands on the run (and on the
    settings' last-sync fields). Returns the finished run."""
    run = SyncRun.objects.filter(pk=run_id).first()
    if run is None or run.status != "running" or run.via != "server":
        return run
    state = _State(run)
    client = None
    try:
        cfg = config()
        only = {tuple(k) for k in (run.plan or {}).get("only") or []}
        tracked = products.tracked()
        if only:
            tracked = products.TrackedProducts(tracked.keys & only)
        now = timezone.now()
        client = Client(cfg, session=session)
        _sync_nvd(client, tracked, state, now)
        _sync_osv(client, tracked, state)
        if cfg.sync_msrc:
            _sync_msrc(client, tracked, state, now)
        if cfg.sync_kev:
            _sync_kev(client, state)
        if cfg.sync_epss:
            _sync_epss(client, state, now.date())
        state.counts["requests"] = state.counts.get("requests", 0) + client.requests
        state.counts["retries"] = state.counts.get("retries", 0) + client.retries
        state.save()
        status = "failed" if state.errors else "ok"
        imports._finish(run, status, error="\n".join(state.errors), counts=state.counts)
    except Stopped:
        return SyncRun.objects.filter(pk=run_id).first()
    except Off as exc:
        imports._finish(run, "failed", error=str(exc), counts=state.counts)
    except FetchError as exc:
        imports._finish(run, "failed", error=str(exc), counts=state.counts)
    except Exception as exc:  # noqa: BLE001 - the run must end, whatever broke
        log.exception("vulnerability server sync %s failed", run_id)
        imports._finish(run, "failed", error=f"Sync failed: {exc.__class__.__name__}.",
                        counts=state.counts)
    finally:
        if client is not None:
            client.close()
    return SyncRun.objects.filter(pk=run_id).first()


def run_job(run_id: str) -> None:
    """RQ entry point for Refresh now."""
    execute(run_id)


def run_products_job(keys: list) -> None:
    """RQ entry point: fetch newly mapped products at once. Skips quietly when
    the feature is not in server mode or another update is running (the next
    daily run covers them)."""
    try:
        run = start_run(None, only=[tuple(k) for k in keys])
    except (Off, Busy, FetchError):
        return
    execute(run.pk)


def enqueue(run: SyncRun) -> None:
    """Queue Refresh now; on a queue that is down, fail the run cleanly."""
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(run_job, str(run.pk), job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down: say so, do not fetch inline
        imports._finish(run, "failed", error="The job queue is not reachable.")
        raise


def enqueue_products(keys) -> bool:
    """For the mapping phase: fetch these product keys now, in the background,
    when the server fetches the data. Returns whether a job was queued."""
    keys = sorted({tuple(k) for k in keys})
    if not keys or not server_mode():
        return False
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(run_products_job, [list(k) for k in keys],
                                           job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - best effort; the daily run covers it
        log.warning("could not queue a vulnerability product fetch")
        return False
    return True


# ─── CPE search (picker proxy) ───────────────────────────────────────────────


def cpe_cache_key(cfg: Config, q: str) -> str:
    digest = hashlib.sha256(f"{cfg.nvd}\n{q.strip().lower()}".encode()).hexdigest()
    return f"vuln:cpe-search:{digest}"


def search_cpes(cfg: Config, q: str, *, session=None) -> list[dict]:
    """NVD CPE dictionary ``keywordSearch``, folded to one row per
    ``part:vendor:product`` with an example title and how many CPE names
    (versions) NVD has for it. One request, no retries (interactive)."""
    client = Client(cfg, session=session)
    client.pacers["nvd"] = Pacer(0)
    try:
        resp = client.request("nvd", f"{cfg.nvd}{NVD_CPES}",
                              params={"keywordSearch": q, "resultsPerPage": 500}, retries=())
        payload = read_json(resp, CPE_MAX_BYTES, "The NVD CPE answer")
    finally:
        client.close()
    items = payload.get("products") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise FetchError("NVD answered something other than a CPE list.")
    rows: dict[tuple, dict] = {}
    for item in items[:5000]:
        cpe = item.get("cpe") if isinstance(item, dict) else None
        if not isinstance(cpe, dict):
            continue
        key = cpe_product(cpe.get("cpeName"))
        if key is None:
            continue
        part, vendor, product = key
        row = rows.get(key)
        if row is None:
            title = ""
            for t in cpe.get("titles") or []:
                if isinstance(t, dict) and t.get("lang") == "en" and isinstance(t.get("title"), str):
                    title = t["title"][:200]
                    break
            row = rows[key] = {"part": part, "vendor": vendor, "product": product,
                               "cpe": f"cpe:2.3:{part}:{vendor}:{product}",
                               "example_title": title, "names": 0, "deprecated": True}
        row["names"] += 1
        row["deprecated"] = row["deprecated"] and bool(cpe.get("deprecated"))
    return sorted(rows.values(), key=lambda r: (-r["names"], r["vendor"], r["product"]))[:50]
