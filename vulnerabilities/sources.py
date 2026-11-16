"""Parsers for vulnerability data (#451): NVD CVE API 2.0 pages and JSON 2.0
feeds, OSV records, the CISA KEV catalog and FIRST EPSS scores.

One set of parsers for every update source: an uploaded file today, the
server fetch and the browser sync later. Each parser validates what it reads
and yields normalised dicts; nothing here touches the database. A record that
fails validation raises :class:`RecordError`, which the caller counts and
skips; a file whose envelope is wrong raises
:class:`~vulnerabilities.streaming.ImportFormatError` and is refused whole.

Normalised vulnerability record (``kind`` ``nvd`` or ``osv``)::

    {"kind", "vuln_id", "aliases": [...], "summary", "published",
     "last_modified", "vuln_status", "rejected", "cvss": {...} | None,
     "cvss_mismatch": bool, "cwes", "references", "configurations",
     "fixed_in", "kev": {...} | None, "products": {(kind, part, vendor, product)},
     "osv": {"id", "modified", "affected", "fixed_in"} | None}

Severity always comes from the score; a CVSS 3.x score is recomputed from its
vector (:mod:`vulnerabilities.cvss`) and a score that does not match is
dropped rather than stored.
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Iterable, Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from . import cvss
from .identifiers import cpe_product, is_cve_id, is_vuln_id, package_key
from .streaming import ImportFormatError, JsonStream, LimitExceeded

# ── limits ──
SUMMARY_MAX = 8 * 1024
CONFIGURATIONS_MAX = 512 * 1024
OSV_AFFECTED_MAX = 512 * 1024
REFERENCES_MAX = 50
#: One record, as JSON text. NVD's largest records (hundreds of CPE matches)
#: stay well under this.
RECORD_MAX = 8 * 1024 * 1024
#: Envelope fields other than the record list.
HEADER_MAX = 64 * 1024
#: Records in one NVD page or feed file.
RECORDS_MAX = 500_000
KEV_ROWS_MAX = 50_000
EPSS_ROWS_MAX = 1_000_000

NVD_FORMAT = "NVD_CVE"
NVD_VERSION = "2.0"

_CWE = re.compile(r"^(CWE-\d{1,6}|NVD-CWE-Other|NVD-CWE-noinfo)$")
_VECTOR_CHARS = re.compile(r"^[A-Za-z0-9:/.()]+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_RANGE_KEYS = ("versionStartIncluding", "versionStartExcluding",
               "versionEndIncluding", "versionEndExcluding")
_METRIC_KEYS = (("cvssMetricV40", "4.0"), ("cvssMetricV31", "3.1"),
                ("cvssMetricV30", "3.0"), ("cvssMetricV2", "2.0"))
_OSV_SEVERITY = {"CVSS_V4": "4.0", "CVSS_V3": "3", "CVSS_V2": "2.0"}
_OSV_RANGE_TYPES = ("ECOSYSTEM", "SEMVER")
_OSV_EVENTS = ("introduced", "fixed", "last_affected", "limit")


class RecordError(ValueError):
    """One record is unusable; the rest of the file still counts."""


# ─── small validators ────────────────────────────────────────────────────────


def _text(value, cap: int) -> str:
    return value[:cap] if isinstance(value, str) else ""


def parse_datetime(value) -> datetime | None:
    """An NVD/OSV timestamp (``2023-10-16T16:15:09.457``, ``...Z``) as an
    aware UTC datetime; NVD's own timestamps carry no zone and are UTC."""
    if not isinstance(value, str) or not _DATE.match(value) or len(value) > 40:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_date(value) -> date | None:
    if not isinstance(value, str) or not _DATE.match(value):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _decimal(value, lo: float, hi: float, places: str) -> Decimal | None:
    if isinstance(value, bool):
        return None
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not d.is_finite() or not lo <= d <= hi:
        return None
    return d.quantize(Decimal(places))


def _json_size(value) -> int:
    return len(json.dumps(value, separators=(",", ":")))


# ─── CVSS ────────────────────────────────────────────────────────────────────


def _metric(version: str, vector, claimed) -> tuple[dict | None, bool]:
    """``(cvss, mismatch)`` for one metric. 3.x is recomputed from the
    vector; 4.0 and 2.0 are kept as given (``verified`` False)."""
    if not isinstance(vector, str) or not vector or len(vector) > 200 \
            or not _VECTOR_CHARS.match(vector):
        return None, False
    if version in ("3.0", "3.1"):
        if not vector.startswith(f"CVSS:{version}/"):
            return None, True
        if claimed is None:
            try:
                score = cvss.base_score(vector)
            except cvss.CvssError:
                return None, True
        else:
            ok, score = cvss.matches(vector, claimed)
            if not ok:
                return None, True
        verified = True
    else:
        score = _decimal(claimed, 0, 10, "0.1")
        if score is None:
            return None, False
        verified = False
    return {
        "version": version,
        "score": score,
        "severity": cvss.severity(score, version),
        "vector": vector,
        "attack_vector": cvss.attack_vector(vector),
        "verified": verified,
    }, False


def _nvd_cvss(metrics) -> tuple[dict | None, bool]:
    """The record's primary metric: NVD's own (``type: Primary``) of the
    newest CVSS version, else the newest secondary one."""
    if not isinstance(metrics, dict):
        return None, False
    chosen = None
    for wanted in ("Primary", "Secondary"):
        for key, version in _METRIC_KEYS:
            for m in metrics.get(key) or []:
                if isinstance(m, dict) and m.get("type") == wanted \
                        and isinstance(m.get("cvssData"), dict):
                    chosen = (version, m["cvssData"])
                    break
            if chosen:
                break
        if chosen:
            break
    if chosen is None:
        return None, False
    version, data = chosen
    return _metric(version, data.get("vectorString"), data.get("baseScore"))


# ─── NVD ─────────────────────────────────────────────────────────────────────


def _clean_match(m) -> dict | None:
    if not isinstance(m, dict) or not isinstance(m.get("vulnerable"), bool):
        return None
    criteria = m.get("criteria")
    if not isinstance(criteria, str) or cpe_product(criteria) is None:
        return None
    out = {"vulnerable": m["vulnerable"], "criteria": criteria}
    for key in _RANGE_KEYS:
        v = m.get(key)
        if isinstance(v, str) and v and len(v) <= 64:
            out[key] = v
    return out


def _clean_configurations(raw) -> tuple[list, bool]:
    """NVD configurations with only the keys matching reads, capped; and
    whether entries were left out for size."""
    if not isinstance(raw, list):
        return [], False
    out, size, truncated = [], 2, False
    for config in raw:
        if not isinstance(config, dict) or not isinstance(config.get("nodes"), list):
            continue
        nodes = []
        for node in config["nodes"]:
            if not isinstance(node, dict):
                continue
            matches = [c for c in map(_clean_match, node.get("cpeMatch") or []) if c]
            if not matches:
                continue
            nodes.append({
                "operator": "AND" if node.get("operator") == "AND" else "OR",
                "negate": node.get("negate") is True,
                "cpeMatch": matches,
            })
        if not nodes:
            continue
        entry = {"nodes": nodes}
        if config.get("operator") in ("AND", "OR"):
            entry["operator"] = config["operator"]
        if config.get("negate") is True:
            entry["negate"] = True
        entry_size = _json_size(entry) + 1
        if size + entry_size > CONFIGURATIONS_MAX:
            truncated = True
            continue
        size += entry_size
        out.append(entry)
    return out, truncated


def cpe_products(configurations: list) -> set[tuple[str, str, str, str]]:
    """``("cpe", part, vendor, product)`` of every vulnerable CPE match."""
    out = set()
    for config in configurations or []:
        for node in config.get("nodes") or []:
            for m in node.get("cpeMatch") or []:
                if m.get("vulnerable"):
                    key = cpe_product(m.get("criteria", ""))
                    if key:
                        out.add(("cpe", *key))
    return out


def _nvd_fixed_in(configurations: list) -> list[dict]:
    seen = set()
    for config in configurations:
        for node in config["nodes"]:
            for m in node["cpeMatch"]:
                end = m.get("versionEndExcluding")
                key = cpe_product(m["criteria"])
                if m["vulnerable"] and end and key:
                    seen.add((*key, end))
    return [{"part": p, "vendor": v, "product": pr, "version": ver}
            for p, v, pr, ver in sorted(seen)[:200]]


def _references(raw, tags_key: str = "tags") -> list[dict]:
    out = []
    for ref in raw if isinstance(raw, list) else []:
        if not isinstance(ref, dict):
            continue
        url = ref.get("url")
        if not isinstance(url, str) or len(url) > 2000 \
                or not url.lower().startswith(("https://", "http://")):
            continue
        tags = ref.get(tags_key)
        if isinstance(tags, str):
            tags = [tags]
        tags = [t[:64] for t in tags if isinstance(t, str)][:10] if isinstance(tags, list) else []
        out.append({"url": url, "tags": tags})
        if len(out) >= REFERENCES_MAX:
            break
    return out


def _nvd_kev(cve: dict) -> dict | None:
    added = parse_date(cve.get("cisaExploitAdd"))
    if added is None:
        return None
    due = parse_date(cve.get("cisaActionDue"))
    if due is not None and due < added:
        due = None
    return {"added": added, "due": due,
            "action": _text(cve.get("cisaRequiredAction"), 2000)}


def normalise_nvd(cve) -> dict:
    """One NVD CVE (the ``cve`` object of a ``vulnerabilities[]`` item)."""
    if not isinstance(cve, dict):
        raise RecordError("A record is not an object.")
    vuln_id = cve.get("id")
    if not is_cve_id(vuln_id):
        raise RecordError(f"Not a CVE id: {str(vuln_id)[:40]!r}.")
    published = parse_datetime(cve.get("published"))
    modified = parse_datetime(cve.get("lastModified"))
    if published is None or modified is None:
        raise RecordError(f"{vuln_id}: published/lastModified missing or not a date.")
    if modified < published:
        raise RecordError(f"{vuln_id}: lastModified is before published.")
    status = _text(cve.get("vulnStatus"), 32)
    summary = ""
    for d in cve.get("descriptions") or []:
        if isinstance(d, dict) and d.get("lang") == "en" and isinstance(d.get("value"), str):
            summary = d["value"][:SUMMARY_MAX]
            break
    metric, mismatch = _nvd_cvss(cve.get("metrics"))
    cwes = []
    for w in cve.get("weaknesses") or []:
        for d in (w.get("description") or []) if isinstance(w, dict) else []:
            v = d.get("value") if isinstance(d, dict) else None
            if isinstance(v, str) and _CWE.match(v) and v not in cwes:
                cwes.append(v)
    configurations, truncated = _clean_configurations(cve.get("configurations"))
    return {
        "kind": "nvd",
        "vuln_id": vuln_id,
        "aliases": [],
        "summary": summary,
        "published": published,
        "last_modified": modified,
        "vuln_status": status,
        "rejected": status == "Rejected",
        "cvss": metric,
        "cvss_mismatch": mismatch,
        "cwes": cwes[:20],
        "references": _references(cve.get("references")),
        "configurations": configurations,
        "configurations_truncated": truncated,
        "fixed_in": _nvd_fixed_in(configurations),
        "kev": _nvd_kev(cve),
        "products": cpe_products(configurations),
        "osv": None,
    }


def _check_nvd_header(header: dict) -> None:
    if header.get("format") != NVD_FORMAT or header.get("version") != NVD_VERSION:
        raise ImportFormatError(
            "Not an NVD CVE API 2.0 response or JSON 2.0 feed "
            "(format NVD_CVE, version 2.0).")


def iter_nvd(reader, *, header: dict | None = None,
             errors: list | None = None) -> Iterator[dict]:
    """Each normalised record of an NVD envelope (API page or feed file),
    streamed. ``header`` receives the envelope fields; a record that fails
    validation is appended to ``errors`` (when given) and skipped."""
    header = {} if header is None else header
    stream = JsonStream(reader, value_cap=RECORD_MAX)
    if stream.peek() != "{":
        raise ImportFormatError("Not an NVD JSON document.")
    checked = False
    for _key, item in stream.iter_object(stream_keys={"vulnerabilities"},
                                         header_cap=HEADER_MAX, max_items=RECORDS_MAX,
                                         header=header):
        if not checked:
            _check_nvd_header(header)
            checked = True
        try:
            if not isinstance(item, dict):
                raise RecordError("A record is not an object.")
            yield normalise_nvd(item.get("cve"))
        except RecordError as exc:
            if errors is not None:
                errors.append(str(exc))
    stream.end()
    if not checked:
        _check_nvd_header(header)


def parse_nvd_page(payload: dict, *, errors: list | None = None) -> list[dict]:
    """An already-decoded API 2.0 response (the browser sync posts these)."""
    if not isinstance(payload, dict):
        raise ImportFormatError("Not an NVD JSON document.")
    _check_nvd_header(payload)
    items = payload.get("vulnerabilities")
    if not isinstance(items, list) or len(items) > 2000:
        raise ImportFormatError("'vulnerabilities' must be a list of at most 2000.")
    out = []
    for item in items:
        try:
            if not isinstance(item, dict):
                raise RecordError("A record is not an object.")
            out.append(normalise_nvd(item.get("cve")))
        except RecordError as exc:
            if errors is not None:
                errors.append(str(exc))
    return out


# ─── OSV ─────────────────────────────────────────────────────────────────────


def _osv_affected(raw) -> tuple[list[dict], set, list[dict]]:
    """``(affected, products, fixed_in)`` of an OSV record."""
    affected, products, fixed, size = [], set(), [], 2
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict) or not isinstance(a.get("package"), dict):
            continue
        pkg = a["package"]
        eco, name = pkg.get("ecosystem"), pkg.get("name")
        purl = pkg.get("purl") if isinstance(pkg.get("purl"), str) else ""
        if not isinstance(eco, str) or not isinstance(name, str) \
                or not eco or not name or len(eco) > 64 or len(name) > 255:
            continue
        key = package_key(eco, name, purl)
        if key is None:
            continue
        ranges = []
        for r in a.get("ranges") or []:
            if not isinstance(r, dict) or r.get("type") not in _OSV_RANGE_TYPES:
                continue
            events = []
            for e in (r.get("events") or [])[:200]:
                if not isinstance(e, dict) or len(e) != 1:
                    continue
                (k, v), = e.items()
                if k in _OSV_EVENTS and isinstance(v, str) and v and len(v) <= 128:
                    events.append({k: v})
                    if k == "fixed":
                        fixed.append({"ecosystem": eco, "name": name, "version": v})
            if events:
                ranges.append({"type": r["type"], "events": events})
        versions = [v for v in (a.get("versions") or []) if isinstance(v, str)
                    and v and len(v) <= 128][:2000]
        if not ranges and not versions:
            continue
        entry = {"ecosystem": eco, "name": name, "purl_type": key[0],
                 "package": key[1], "ranges": ranges, "versions": versions}
        entry_size = _json_size(entry) + 1
        if size + entry_size > OSV_AFFECTED_MAX:
            break
        size += entry_size
        affected.append(entry)
        products.add(("purl", "", key[0], key[1]))
    return affected, products, fixed[:200]


def _osv_cvss(severity) -> tuple[dict | None, bool]:
    best = None
    for s in severity if isinstance(severity, list) else []:
        if not isinstance(s, dict) or s.get("type") not in _OSV_SEVERITY:
            continue
        vector = s.get("score")
        version = _OSV_SEVERITY[s["type"]]
        if version == "3":
            version = "3.1" if str(vector).startswith("CVSS:3.1/") else "3.0"
        order = ("4.0", "3.1", "3.0", "2.0").index(version)
        if best is None or order < best[0]:
            best = (order, version, vector)
    if best is None:
        return None, False
    _, version, vector = best
    if version in ("3.0", "3.1"):
        return _metric(version, vector, None)
    # OSV carries only the vector; 4.0 and 2.0 are not recomputed, so they
    # are kept without a score.
    if not isinstance(vector, str) or len(vector) > 200 or not _VECTOR_CHARS.match(vector):
        return None, False
    return {"version": version, "score": None, "severity": "", "vector": vector,
            "attack_vector": cvss.attack_vector(vector), "verified": False}, False


def normalise_osv(rec) -> dict:
    """One OSV record. A record with a CVE id, or a CVE alias, is filed under
    that CVE (so KEV and EPSS apply); others under their own id."""
    if not isinstance(rec, dict):
        raise RecordError("A record is not an object.")
    osv_id = rec.get("id")
    if not is_vuln_id(osv_id):
        raise RecordError(f"Not an OSV id: {str(osv_id)[:40]!r}.")
    modified = parse_datetime(rec.get("modified"))
    if modified is None:
        raise RecordError(f"{osv_id}: modified missing or not a date.")
    published = parse_datetime(rec.get("published")) if rec.get("published") else None
    aliases = sorted({a for a in (rec.get("aliases") or []) if is_vuln_id(a)} - {osv_id})
    cve_aliases = [a for a in aliases if is_cve_id(a)]
    if is_cve_id(osv_id):
        vuln_id = osv_id
    elif cve_aliases:
        vuln_id = cve_aliases[0]
    else:
        vuln_id = osv_id
    all_ids = sorted(({osv_id, *aliases}) - {vuln_id})
    affected, products, fixed = _osv_affected(rec.get("affected"))
    metric, mismatch = _osv_cvss(rec.get("severity"))
    summary = _text(rec.get("summary"), SUMMARY_MAX) or _text(rec.get("details"), SUMMARY_MAX)
    db = rec.get("database_specific") if isinstance(rec.get("database_specific"), dict) else {}
    cwes = [c for c in (db.get("cwe_ids") or []) if isinstance(c, str) and _CWE.match(c)]
    return {
        "kind": "osv",
        "vuln_id": vuln_id,
        "aliases": all_ids,
        "summary": summary,
        "published": published,
        "last_modified": modified,
        "vuln_status": "Withdrawn" if rec.get("withdrawn") else "",
        "rejected": bool(parse_datetime(rec.get("withdrawn"))),
        "cvss": metric,
        "cvss_mismatch": mismatch,
        "cwes": cwes[:20],
        "references": _references(rec.get("references"), tags_key="type"),
        "configurations": [],
        "configurations_truncated": False,
        "fixed_in": [],
        "kev": None,
        "products": products,
        "osv": {"id": osv_id, "modified": modified.isoformat(),
                "affected": affected, "fixed_in": fixed},
    }


def iter_osv_json(reader, *, errors: list | None = None) -> Iterator[dict]:
    """One OSV record, a JSON list of records, or an API response with a
    ``vulns`` list, streamed."""
    stream = JsonStream(reader, value_cap=RECORD_MAX)
    first = stream.peek()
    if first == "[":
        items: Iterable = stream.iter_array(RECORDS_MAX)
    elif first == "{":
        # A whole record decodes as one value; an API response streams its
        # ``vulns``. Peeking cannot tell them apart, so stream the object and
        # rebuild a record from its fields when no ``vulns`` key appears.
        header: dict = {}
        for _k, item in stream.iter_object(stream_keys={"vulns"}, header_cap=RECORD_MAX,
                                           max_items=RECORDS_MAX, header=header):
            try:
                yield normalise_osv(item)
            except RecordError as exc:
                if errors is not None:
                    errors.append(str(exc))
        stream.end()
        if "vulns" not in header:
            try:
                yield normalise_osv(header)
            except RecordError as exc:
                if "id" not in header:
                    raise ImportFormatError("Not an OSV record or list of records.") from exc
                if errors is not None:
                    errors.append(str(exc))
        return
    else:
        raise ImportFormatError("Not an OSV JSON document.")
    for item in items:
        try:
            yield normalise_osv(item)
        except RecordError as exc:
            if errors is not None:
                errors.append(str(exc))
    stream.end()


# ─── Microsoft (MSRC CVRF) ───────────────────────────────────────────────────

#: Envelope fields of a monthly CVRF document (the product tree of a busy
#: month is about 150 KB).
MSRC_HEADER_MAX = 4 * 1024 * 1024
MSRC_PRODUCTS_MAX = 50_000
MSRC_MONTH = re.compile(r"^(\d{4})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$")
_KB = re.compile(r"^(?:KB)?(\d{6,8})$")
#: CVRF remediation type 2: a vendor fix (the update and its fixed build).
_VENDOR_FIX = 2
#: CVRF product status type 3: known affected.
_KNOWN_AFFECTED = 3


def msrc_month(value) -> str | None:
    """``2026-Nov`` when ``value`` is a CVRF month id."""
    return value if isinstance(value, str) and MSRC_MONTH.match(value) else None


def _value(obj) -> str:
    """CVRF wraps most strings as ``{"Value": ...}``."""
    v = obj.get("Value") if isinstance(obj, dict) else obj
    return v if isinstance(v, str) else ""


def _msrc_header(header: dict) -> tuple[str, datetime | None, dict[str, str]]:
    """``(month, current release, {product id: product key})`` of a CVRF
    document's envelope, or :class:`ImportFormatError`."""
    from .msrc_products import key_for_name

    tracking = header.get("DocumentTracking")
    ident = tracking.get("Identification") if isinstance(tracking, dict) else None
    month = msrc_month(_value(ident.get("ID")) if isinstance(ident, dict) else "")
    tree = header.get("ProductTree")
    names = tree.get("FullProductName") if isinstance(tree, dict) else None
    if month is None or not isinstance(names, list):
        raise ImportFormatError(
            "Not a Microsoft security update document (CVRF JSON with "
            "DocumentTracking and ProductTree before Vulnerability).")
    if len(names) > MSRC_PRODUCTS_MAX:
        raise LimitExceeded(f"More than {MSRC_PRODUCTS_MAX} products.")
    ids: dict[str, str] = {}
    for p in names:
        if not isinstance(p, dict):
            continue
        pid, key = p.get("ProductID"), key_for_name(p.get("Value"))
        if isinstance(pid, str) and 0 < len(pid) <= 32 and key:
            ids[pid] = key
    return month, parse_datetime(tracking.get("CurrentReleaseDate")), ids


def _pids(entry) -> list[str]:
    raw = entry.get("ProductID") if isinstance(entry, dict) else None
    return [p for p in raw if isinstance(p, str)][:5000] if isinstance(raw, list) else []


def _msrc_cvss(sets, wanted: set[str]) -> tuple[dict | None, bool]:
    """Microsoft's CVSS for the products this store keeps: the highest base
    score among the score sets naming one of them."""
    best = None
    for s in sets if isinstance(sets, list) else []:
        if not isinstance(s, dict) or not wanted & set(_pids(s)):
            continue
        vector = s.get("Vector")
        version = "3.1" if str(vector).startswith("CVSS:3.1/") else "3.0"
        metric, mismatch = _metric(version, vector, s.get("BaseScore"))
        if metric is None:
            if best is None and mismatch:
                best = (None, True)
            continue
        if best is None or best[0] is None or metric["score"] > best[0]["score"]:
            best = (metric, False)
    return best if best is not None else (None, False)


def normalise_msrc(v, *, month: str, ids: dict[str, str],
                   released: datetime | None) -> dict:
    """One ``Vulnerability`` of a CVRF document. Only the Windows products of
    :mod:`vulnerabilities.msrc_products` are kept: per product its fixed
    builds on the product's own build line and the KB numbers."""
    from . import versions
    from .msrc_products import PRODUCTS

    if not isinstance(v, dict):
        raise RecordError("A record is not an object.")
    vuln_id = v.get("CVE")
    if not is_cve_id(vuln_id):
        raise RecordError(f"Not a CVE id: {str(vuln_id)[:40]!r}.")
    affected: set[str] = set()
    for status in v.get("ProductStatuses") or []:
        if isinstance(status, dict) and status.get("Type") == _KNOWN_AFFECTED:
            affected.update(p for p in _pids(status) if p in ids)
    products: dict[str, dict] = {ids[p]: {"fixed": set(), "kbs": set()} for p in affected}
    for r in v.get("Remediations") or []:
        if not isinstance(r, dict) or r.get("Type") != _VENDOR_FIX:
            continue
        build = r.get("FixedBuild")
        key = versions.parse(build, "winbuild") if isinstance(build, str) else None
        kb = _KB.match(_value(r.get("Description")).strip())
        for pid in _pids(r):
            if pid not in affected:
                continue
            pkey = ids[pid]
            if key is not None and key.group == PRODUCTS[pkey].line:
                products[pkey]["fixed"].add(key.text)
                if kb:
                    products[pkey]["kbs"].add(kb[1])
    dates = [d for d in (parse_datetime(h.get("Date")) for h in v.get("RevisionHistory") or []
                         if isinstance(h, dict)) if d is not None and d.year > 1900]
    revised = max(dates) if dates else released
    if revised is None:
        raise RecordError(f"{vuln_id}: no revision date.")
    metric, mismatch = _msrc_cvss(v.get("CVSSScoreSets"), affected)
    cwes = []
    for w in v.get("CWE") or []:
        cid = w.get("ID") if isinstance(w, dict) else None
        if isinstance(cid, str) and _CWE.match(cid) and cid not in cwes:
            cwes.append(cid)
    from .msrc_products import product_key

    return {
        "kind": "msrc",
        "vuln_id": vuln_id,
        "aliases": [],
        "summary": _text(_value(v.get("Title")), SUMMARY_MAX),
        "published": min(dates) if dates else released,
        "last_modified": revised,
        "vuln_status": "",
        "rejected": False,
        "cvss": metric,
        "cvss_mismatch": mismatch,
        "cwes": cwes[:20],
        "references": [],
        "configurations": [],
        "configurations_truncated": False,
        "fixed_in": [],
        "kev": None,
        "products": {product_key(k) for k in products},
        "osv": None,
        "msrc": {"month": month, "revised": revised.isoformat(), "products": {
            k: {"fixed": sorted(p["fixed"], key=lambda b: versions.parse(b, "winbuild").sort),
                "kbs": sorted(p["kbs"])}
            for k, p in sorted(products.items())}},
    }


def iter_msrc(reader, *, header: dict | None = None,
              errors: list | None = None) -> Iterator[dict]:
    """Each normalised record of one monthly CVRF JSON document, streamed.
    ``header`` receives ``month`` and ``current_release`` (and the envelope
    fields). The product tree must come before the vulnerabilities, as
    Microsoft writes it."""
    header = {} if header is None else header
    stream = JsonStream(reader, value_cap=RECORD_MAX)
    if stream.peek() != "{":
        raise ImportFormatError("Not a Microsoft CVRF JSON document.")
    parsed = None
    for _key, item in stream.iter_object(stream_keys={"Vulnerability"},
                                         header_cap=MSRC_HEADER_MAX,
                                         max_items=RECORDS_MAX, header=header):
        if parsed is None:
            parsed = _msrc_header(header)
            header["month"], header["current_release"] = parsed[0], parsed[1]
        if isinstance(item, dict) and str(item.get("CVE", "")).startswith("ADV"):
            # Microsoft's own advisories (ADV260001) have no CVE id: skipped.
            continue
        try:
            yield normalise_msrc(item, month=parsed[0], ids=parsed[2], released=parsed[1])
        except RecordError as exc:
            if errors is not None:
                errors.append(str(exc))
    stream.end()
    if parsed is None:
        month, current, _ids = _msrc_header(header)
        header["month"], header["current_release"] = month, current


# ─── CISA KEV ────────────────────────────────────────────────────────────────


def _kev_row(row: dict) -> dict:
    cve_id = row.get("cveID")
    if not is_cve_id(cve_id):
        raise RecordError(f"Not a CVE id: {str(cve_id)[:40]!r}.")
    added = parse_date(row.get("dateAdded"))
    if added is None:
        raise RecordError(f"{cve_id}: dateAdded missing.")
    due = parse_date(row.get("dueDate"))
    if due is not None and due < added:
        raise RecordError(f"{cve_id}: dueDate is before dateAdded.")
    ransomware = _text(row.get("knownRansomwareCampaignUse"), 16).strip().lower()
    return {"vuln_id": cve_id, "added": added, "due": due,
            "action": _text(row.get("requiredAction"), 2000),
            "ransomware": ransomware}


def iter_kev(reader, *, errors: list | None = None) -> Iterator[dict]:
    """The KEV catalog, JSON (``vulnerabilities`` list) or CSV."""
    head = reader.read(1 << 16)
    rest = io.BufferedReader(_Prepend(head, reader))
    first = head.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    if first == b"{":
        stream = JsonStream(rest, value_cap=RECORD_MAX)
        header: dict = {}
        count = 0
        for _k, item in stream.iter_object(stream_keys={"vulnerabilities"},
                                           header_cap=HEADER_MAX, max_items=KEV_ROWS_MAX,
                                           header=header):
            count += 1
            try:
                if not isinstance(item, dict):
                    raise RecordError("A row is not an object.")
                yield _kev_row(item)
            except RecordError as exc:
                if errors is not None:
                    errors.append(str(exc))
        stream.end()
        if not count and "catalogVersion" not in header:
            raise ImportFormatError("Not the CISA KEV catalog (no vulnerabilities list).")
        return
    text = io.TextIOWrapper(rest, encoding="utf-8-sig", newline="")
    reader_csv = csv.DictReader(text)
    try:
        fields = reader_csv.fieldnames or []
    except (csv.Error, UnicodeDecodeError) as exc:
        raise ImportFormatError("Not a readable CSV file.") from exc
    if not {"cveID", "dateAdded"} <= set(fields):
        raise ImportFormatError("Not the CISA KEV catalog (cveID, dateAdded columns).")
    yield from _csv_rows(reader_csv, _kev_row, KEV_ROWS_MAX, errors)


# ─── FIRST EPSS ──────────────────────────────────────────────────────────────


def _epss_row(cve_id, epss, percentile, day: date, today: date) -> dict:
    if not is_cve_id(cve_id):
        raise RecordError(f"Not a CVE id: {str(cve_id)[:40]!r}.")
    score = _decimal(epss, 0, 1, "0.00001")
    pct = _decimal(percentile, 0, 1, "0.00001")
    if score is None or pct is None:
        raise RecordError(f"{cve_id}: epss and percentile must be 0 to 1.")
    if day > today + timedelta(days=1):
        raise RecordError(f"{cve_id}: score date is in the future.")
    return {"vuln_id": cve_id, "epss": score, "percentile": pct, "date": day}


def iter_epss_csv(reader, *, errors: list | None = None,
                  today: date | None = None) -> Iterator[dict]:
    """The EPSS CSV: ``#model_version:...,score_date:YYYY-MM-DD...`` then
    ``cve,epss,percentile`` rows."""
    today = today or datetime.now(UTC).date()
    text = io.TextIOWrapper(io.BufferedReader(reader), encoding="utf-8-sig", newline="")
    try:
        first = text.readline(4096)
    except UnicodeDecodeError as exc:
        raise ImportFormatError("The file is not UTF-8 text.") from exc
    day = None
    if first.startswith("#"):
        for part in first[1:].strip().split(","):
            key, _, value = part.partition(":")
            if key.strip() == "score_date":
                day = parse_date(value.strip())
        header_line = text.readline(4096)
    else:
        header_line = first
    columns = [c.strip() for c in header_line.strip().split(",")]
    if columns[:3] != ["cve", "epss", "percentile"]:
        raise ImportFormatError("Not an EPSS file (cve,epss,percentile columns).")
    if day is None:
        raise ImportFormatError("The EPSS file has no score_date header line.")
    if day > today + timedelta(days=1):
        raise ImportFormatError("The EPSS score date is in the future.")
    rows = csv.reader(text)
    yield from _csv_rows(
        rows, lambda r: _epss_row(*(list(r) + ["", "", ""])[:3], day, today),
        EPSS_ROWS_MAX, errors)


def parse_epss_api(payload, *, today: date | None = None,
                   errors: list | None = None) -> list[dict]:
    """A FIRST EPSS API response (``{"data": [{cve, epss, percentile, date}]}``)."""
    today = today or datetime.now(UTC).date()
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ImportFormatError("Not an EPSS API response.")
    out = []
    for row in payload["data"][:EPSS_ROWS_MAX]:
        try:
            if not isinstance(row, dict):
                raise RecordError("A row is not an object.")
            day = parse_date(row.get("date"))
            if day is None:
                raise RecordError("A row has no date.")
            out.append(_epss_row(row.get("cve"), row.get("epss"), row.get("percentile"),
                                 day, today))
        except RecordError as exc:
            if errors is not None:
                errors.append(str(exc))
    return out


# ─── helpers ─────────────────────────────────────────────────────────────────


def _csv_rows(rows, convert, cap: int, errors) -> Iterator[dict]:
    count = 0
    try:
        for row in rows:
            if not row:
                continue
            count += 1
            if count > cap:
                raise LimitExceeded(f"More than {cap} rows.")
            try:
                yield convert(row)
            except RecordError as exc:
                if errors is not None:
                    errors.append(str(exc))
    except (csv.Error, UnicodeDecodeError) as exc:
        raise ImportFormatError("Not a readable CSV file.") from exc


class _Prepend(io.RawIOBase):
    """``head`` followed by the rest of ``raw``."""

    def __init__(self, head: bytes, raw):
        self._head = head
        self._raw = raw

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        if self._head:
            n = min(len(b), len(self._head))
            b[:n] = self._head[:n]
            self._head = self._head[n:]
            return n
        data = self._raw.read(len(b))
        b[: len(data)] = data
        return len(data)
