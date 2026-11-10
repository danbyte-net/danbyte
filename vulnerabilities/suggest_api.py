"""Suggest mappings (#451): products for what is already documented.

``GET /api/vulnerabilities/mappings/suggestions/`` lists every platform,
application and device type of the active tenant that the caller may
change, that has no enabled mapping and that is in use (hosts, installs or
devices the caller may see), each with candidate products, best first:

=========  =====================================================  ==========
source     where from                                             confidence
=========  =====================================================  ==========
``sbom``   the subject's own package URL or CPE template          high
``known``  :mod:`vulnerabilities.known_products`                  high/medium
``local``  products the CVE store already holds, by name words    medium/low
``nvd``    NVD's CPE dictionary, server mode only, on ``nvd=1``   medium/low
=========  =====================================================  ==========

Nothing is created here. ``POST …/mappings/bulk-create/`` creates the
chosen ones (``match_api.ProductMappingViewSet.bulk_create``).

NVD is asked only in server mode, only for the rows of the page that have
no candidate yet, only when the caller asks (``nvd=true``), and through the
CPE search's cache and budget (``fetch_api``): a cached answer is free, a
live one counts against the same per-user and deployment limits as the
picker, at most ``NVD_PER_REQUEST`` per request. What was not asked is
counted in ``nvd_pending``.
"""
from __future__ import annotations

import time

from django.core.cache import cache
from django.db.models import Count, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import viewsets
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated

from auth_api import rbac

from . import fetch, fetch_api, known_products, versions
from .match_api import (
    _bool,
    _paginate,
    _restricted,
    _subject_template,
    _tenant,
    _values,
    parse_identifier,
)
from .models import CveProduct, ProductMapping, VulnerabilitySettings

SUBJECT_TYPES = ("platform", "application", "device_type")
_SLUG = {"platform": "platform", "application": "application", "device_type": "devicetype"}
#: Which CPE parts each subject may map to (``match_api._check_kind``).
PARTS = {"platform": ("o", "a"), "application": ("a", "o"), "device_type": ("h",)}
CONFIDENCES = ("high", "medium", "low", "none")
_CONF_RANK = {c: i for i, c in enumerate(CONFIDENCES)}
_SOURCE_RANK = {"sbom": 0, "known": 1, "local": 2, "nvd": 3}
MAX_SUBJECTS = 5000
MAX_CANDIDATES = 5
#: Distinct store products read for the ``local`` source.
LOCAL_SCAN = 50_000
NVD_PER_REQUEST = 3
NVD_PER_ROW = 3


# ─── candidates ──────────────────────────────────────────────────────────────


def _candidate(kind, part, vendor, product, source, confidence, title="", **extra) -> dict:
    identifier = f"pkg:{vendor}/{product}" if kind == "purl" else \
        f"cpe:2.3:{part}:{vendor}:{product}"
    return {"kind": kind, "part": part, "vendor": vendor, "product": product,
            "identifier": identifier, "source": source, "confidence": confidence,
            "title": title, "version_scheme": "auto",
            "scheme": versions.resolve_scheme("auto", kind, part, vendor, product), **extra}


def sbom_candidate(subject, subject_type: str) -> dict | None:
    template = _subject_template(subject)
    if not template:
        return None
    try:
        kind, part, vendor, product = parse_identifier(template)
    except ValidationError:
        return None
    if kind == "cpe" and part not in PARTS[subject_type]:
        return None
    if kind == "purl" and subject_type == "device_type":
        return None
    return _candidate(kind, part, vendor, product, "sbom", "high", template)


def known_candidates(names, manufacturer, subject_type) -> list[dict]:
    return [_candidate("cpe", h.entry.part, h.entry.vendor, h.entry.product, "known",
                       h.confidence, h.entry.title)
            for h in known_products.lookup(names, manufacturer, PARTS[subject_type])]


class LocalIndex:
    """The store's CPE products, read once per request, found by name words:
    a product whose name is a run of the subject's words (``ios xe`` ->
    ``ios_xe``) is a candidate; medium when its vendor is one too (or is the
    manufacturer), low otherwise."""

    def __init__(self, parts: set[str]):
        rows = (CveProduct.objects.filter(kind="cpe", part__in=sorted(parts))
                .values("part", "vendor", "product").annotate(n=Count("cve_id"))
                .order_by("-n")[:LOCAL_SCAN])
        self.by_product: dict[str, list[dict]] = {}
        for r in rows:
            key = known_products.compact(r["product"])
            if len(key) >= 3:
                self.by_product.setdefault(key, []).append(r)

    def find(self, names, manufacturer, subject_type) -> list[dict]:
        own: set[str] = set()
        for n in names:
            own |= known_products.runs(known_products.words(n))
        maker = known_products.runs(known_products.words(manufacturer))
        out = []
        for key in own & set(self.by_product):
            for r in self.by_product[key]:
                if r["part"] not in PARTS[subject_type]:
                    continue
                vendor = known_products.compact(r["vendor"])
                conf = "medium" if vendor in own or vendor in maker else "low"
                out.append(_candidate("cpe", r["part"], r["vendor"], r["product"], "local",
                                      conf, records=r["n"]))
        return out


def rank(candidates: list[dict]) -> list[dict]:
    """Best first, one per identifier (the best source keeps it)."""
    ordered = sorted(candidates, key=lambda c: (
        _CONF_RANK[c["confidence"]], _SOURCE_RANK[c["source"]], -(c.get("records") or 0),
        c["identifier"]))
    seen: set[str] = set()
    out = []
    for c in ordered:
        if c["identifier"] in seen:
            continue
        seen.add(c["identifier"])
        out.append(c)
    return out[:MAX_CANDIDATES]


def best_confidence(row: dict) -> str:
    return row["candidates"][0]["confidence"] if row["candidates"] else "none"


# ─── subjects ────────────────────────────────────────────────────────────────


def _blank() -> Q:
    return Q(software_version__regex=r"^\s*$")


def _usage(request, tenant) -> dict[str, dict]:
    """``{subject_type: {id: (in use, without a version)}}`` over the hosts,
    installs and devices the caller may see."""
    from api.models import Device, InstalledSoftware, VirtualMachine

    devices = _restricted(Device, request, tenant, "device")
    vms = _restricted(VirtualMachine, request, tenant, "virtualmachine")
    installs = _restricted(InstalledSoftware, request, tenant, "installedsoftware")
    use: dict[str, dict] = {t: {} for t in SUBJECT_TYPES}

    def add(kind, rows):
        for pk, n, blank in rows:
            if pk is None:
                continue
            was = use[kind].get(pk, (0, 0))
            use[kind][pk] = (was[0] + n, was[1] + blank)

    count = {"n": Count("id"), "blank": Count("id", filter=_blank())}
    add("platform", devices.filter(platform__isnull=False).values("platform_id")
        .annotate(**count).values_list("platform_id", "n", "blank"))
    add("platform", devices.filter(platform__isnull=True)
        .values("device_type__platform_id").annotate(**count)
        .values_list("device_type__platform_id", "n", "blank"))
    add("platform", vms.values("platform_id").annotate(**count)
        .values_list("platform_id", "n", "blank"))
    add("application", installs.values("application_id").annotate(
        n=Count("id"), blank=Count("id", filter=Q(version__regex=r"^\s*$")))
        .values_list("application_id", "n", "blank"))
    # Hardware has no version to test: nothing "lacks" one.
    add("device_type", ((pk, n, 0) for pk, n in devices.values("device_type_id")
                        .annotate(n=Count("id")).values_list("device_type_id", "n")))
    return use


def _subjects(request, tenant, types):
    """The unmapped, in-use subjects of ``types`` the caller may change."""
    from api.models import Application, DeviceType, Platform

    models = {"platform": Platform, "application": Application, "device_type": DeviceType}
    use = _usage(request, tenant)
    out = []
    for t in types:
        if not rbac.has_action(request.user, tenant, _SLUG[t], "change"):
            continue
        ids = list(use[t])
        if not ids:
            continue
        qs = (_restricted(models[t], request, tenant, _SLUG[t], "change")
              .filter(pk__in=ids)
              .exclude(pk__in=ProductMapping.objects.filter(
                  tenant=tenant, enabled=True, **{f"{t}__isnull": False}).values(f"{t}_id"))
              .select_related("manufacturer").order_by("name")[:MAX_SUBJECTS])
        for obj in qs:
            n, blank = use[t][obj.pk]
            out.append((t, obj, n, blank))
    return out


def _names(obj, t) -> list[str]:
    names = [obj.name, getattr(obj, "slug", "") or ""]
    if t == "device_type":
        names += [obj.model or "", obj.part_number or ""]
    return [n for n in names if n]


def _row(t, obj, n, blank, local: LocalIndex) -> dict:
    maker = obj.manufacturer.name if obj.manufacturer_id else ""
    names = _names(obj, t)
    cands = []
    sbom = None if t == "device_type" else sbom_candidate(obj, t)
    if sbom:
        cands.append(sbom)
    if t != "device_type":
        cands += known_candidates(names, maker, t)
    cands += local.find(names, maker, t)
    return {
        "subject_type": t,
        "id": str(obj.pk),
        "name": obj.name,
        "manufacturer": maker,
        "purl_template": getattr(obj, "purl_template", "") or "",
        "cpe_template": getattr(obj, "cpe_template", "") or "",
        "in_use": n,
        "without_version": blank,
        "candidates": rank(cands),
    }


# ─── NVD ─────────────────────────────────────────────────────────────────────


def nvd_query(row: dict) -> str:
    """The subject's name without its version numbers, its maker in front
    when the name lacks it (``Cisco`` + ``IOS XE 17``)."""
    ws = [w for w in known_products.words(row["name"]) if not w.isdigit()]
    maker = [w for w in known_products.words(row["manufacturer"]) if not w.isdigit()]
    if maker and not set(maker) & set(ws):
        ws = maker[:2] + ws
    return " ".join(ws)[:fetch_api.Q_MAX]


def _nvd_rows(row: dict, hits: list[dict]) -> list[dict]:
    own: set[str] = known_products.runs(known_products.words(row["name"]))
    maker = known_products.runs(known_products.words(row["manufacturer"]))
    out = []
    for h in hits:
        if h.get("deprecated") or h.get("part") not in PARTS[row["subject_type"]]:
            continue
        product = known_products.compact(h["product"])
        vendor = known_products.compact(h["vendor"])
        conf = "medium" if product in own and (vendor in own or vendor in maker) else "low"
        out.append(_candidate("cpe", h["part"], h["vendor"], h["product"], "nvd", conf,
                              h.get("example_title") or ""))
        if len(out) >= NVD_PER_ROW:
            break
    return out


def add_nvd(request, rows: list[dict]) -> dict:
    """Fill the rows without a candidate from NVD's CPE dictionary: cached
    answers always, live ones within the picker's limits. Never outside
    server mode."""
    row_settings = VulnerabilitySettings.load()
    if not fetch.server_mode(row_settings):
        return {"nvd_status": "off", "nvd_pending": 0}
    try:
        cfg = fetch.config(row_settings)
    except (fetch.Off, fetch.FetchError) as exc:
        return {"nvd_status": "error", "nvd_error": str(exc)[:300], "nvd_pending": 0}
    budget = fetch_api.NVD_BUDGET_KEY if cfg.api_key else fetch_api.NVD_BUDGET
    live = 0
    pending = 0
    status = "ok"
    retry_after = None
    for row in rows:
        if row["candidates"]:
            continue
        q = nvd_query(row)
        if len(q) < fetch_api.Q_MIN:
            continue
        key = fetch.cpe_cache_key(cfg, q)
        hits = cache.get(key)
        if hits is None:
            now = int(time.time())
            if live >= NVD_PER_REQUEST or status != "ok":
                pending += 1
                continue
            if fetch_api._bump(f"vuln:cpe-search:user:{request.user.pk}:{now // 60}",
                               60) > fetch_api.USER_LIMIT \
                    or fetch_api._bump(f"vuln:cpe-search:nvd:{now // 30}", 30) > budget:
                status, retry_after = "limited", 30 - now % 30
                pending += 1
                continue
            live += 1
            try:
                hits = fetch.search_cpes(cfg, q)
            except (fetch.FetchError, ValueError) as exc:
                status = "error"
                pending += 1
                row["nvd_error"] = str(exc)[:300]
                continue
            cache.set(key, hits, fetch_api.CPE_CACHE_TTL)
        row["candidates"] = rank(_nvd_rows(row, hits))
    out = {"nvd_status": "limited" if pending and status == "ok" else status,
           "nvd_pending": pending}
    if retry_after is not None:
        out["retry_after"] = retry_after
    return out


# ─── endpoint ────────────────────────────────────────────────────────────────


class MappingSuggestionViewSet(viewsets.ViewSet):
    """Candidate products for the unmapped, in-use platforms, applications
    and device types the caller may change. Filters: ``subject_type``
    (``platform``, ``application``, ``device_type``), ``confidence`` of the
    best candidate (``high``, ``medium``, ``low``, ``none``), ``q`` (name)
    and ``nvd`` (``true``: look the page's rows without a candidate up in
    NVD's CPE dictionary, server mode only). Best confidence first, then the
    most used. ``totals`` counts what every filtered row would cover."""

    permission_classes = [IsAuthenticated]

    @extend_schema(summary="Suggested product mappings", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def list(self, request):
        tenant = _tenant(request)
        types = _values(request, "subject_type") or list(SUBJECT_TYPES)
        bad = [t for t in types if t not in SUBJECT_TYPES]
        if bad:
            raise ValidationError({"subject_type": f"One of: {', '.join(SUBJECT_TYPES)}."})
        confidences = _values(request, "confidence")
        if any(c not in CONFIDENCES for c in confidences):
            raise ValidationError({"confidence": f"One of: {', '.join(CONFIDENCES)}."})
        q = (request.query_params.get("q") or "").strip().lower()
        nvd = _bool(request, "nvd") or False
        subjects = _subjects(request, tenant, types)
        if q:
            subjects = [s for s in subjects if q in s[1].name.lower()]
        local = LocalIndex({p for t in types for p in PARTS[t]} if subjects else set())
        rows = [_row(t, obj, n, blank, local) for t, obj, n, blank in subjects]
        if confidences:
            rows = [r for r in rows if best_confidence(r) in confidences]
        rows.sort(key=lambda r: (_CONF_RANK[best_confidence(r)], -r["in_use"],
                                 r["name"].lower(), r["id"]))
        totals = {"subjects": len(rows), "in_use": sum(r["in_use"] for r in rows),
                  "without_version": sum(r["without_version"] for r in rows),
                  "with_candidate": sum(1 for r in rows if r["candidates"])}
        extra: dict = {"nvd_status": "off", "nvd_pending": 0}

        def page_rows(page):
            nonlocal extra
            page = list(page)
            if nvd:
                extra = add_nvd(request, page)
            elif fetch.server_mode():
                extra = {"nvd_status": "not_asked",
                         "nvd_pending": sum(1 for r in page if not r["candidates"])}
            return page

        resp = _paginate(request, rows, page_rows)
        resp.data.update({"totals": totals,
                          "update_source": VulnerabilitySettings.load().update_source,
                          **extra})
        return resp
