"""End-of-life data (#8): status, catalog cache, refresh and import.

The status of a platform is derived from its :class:`EolMapping` at read time,
never stored, so "support ending" moves with the calendar:

``eol``       the end-of-life date has passed, or the source says the cycle is
              end of life and gives no date;
``ending``    the end-of-life date falls within the warning window;
``supported`` the date is beyond the window, or the source says the cycle is
              maintained and gives no date;
``unknown``   no mapping, never refreshed, or the source says nothing.

When the feature is off every status payload is ``None`` and the filters do
nothing: the stored mappings stay, but nothing reads them.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .eol_sources import SOURCES, EolSourceError, get_source

log = logging.getLogger("danbyte.eol")

STATUSES = ("supported", "ending", "eol", "unknown")


@dataclass(frozen=True)
class EolConfig:
    enabled: bool
    warning_days: int


def load_config() -> EolConfig:
    from .models import EolSettings

    row = EolSettings.objects.filter(pk=1).only("enabled", "warning_days").first()
    if row is None:
        return EolConfig(False, 180)
    return EolConfig(bool(row.enabled), int(row.warning_days))


def config_for(request) -> EolConfig:
    """The config, read once per request however many rows serialize."""
    if request is None:
        return load_config()
    cfg = getattr(request, "_eol_config", None)
    if cfg is None:
        cfg = load_config()
        try:
            request._eol_config = cfg
        except AttributeError:
            pass
    return cfg


def mapping_of(platform):
    """The platform's mapping or ``None`` - from the select_related cache when
    the caller joined it."""
    if platform is None:
        return None
    try:
        return platform.eol_mapping
    except ObjectDoesNotExist:
        return None


def status_of(mapping, warning_days: int, today: date | None = None) -> str:
    if mapping is None or mapping.synced_at is None:
        return "unknown"
    today = today or timezone.localdate()
    if mapping.eol_date:
        if mapping.eol_date <= today:
            return "eol"
        if mapping.eol_date <= today + timedelta(days=warning_days):
            return "ending"
        return "supported"
    if mapping.eol_reached is True:
        return "eol"
    if mapping.eol_reached is False:
        return "supported"
    return "unknown"


def payload(platform, cfg: EolConfig) -> dict | None:
    """The ``eol`` block serialized on platforms and on the nested platform
    of devices and VMs. ``None`` when the feature is off."""
    if not cfg.enabled:
        return None
    m = mapping_of(platform)
    out = {"status": status_of(m, cfg.warning_days)}
    if m is not None:
        out.update({
            "source": m.source,
            "product": m.product,
            "cycle": m.cycle,
            "release_date": m.release_date,
            "support_until": m.support_until,
            "eol_date": m.eol_date,
            "lts": m.lts,
            "latest_version": m.latest_version,
            "synced_at": m.synced_at,
            "missing": m.missing,
        })
    return out


def status_q(status: str, cfg: EolConfig, prefix: str = "") -> Q:
    """A filter for rows whose mapping (reached through ``prefix``, e.g.
    ``"platform__eol_mapping__"``) has ``status``. Same rules as
    :func:`status_of`."""
    today = timezone.localdate()
    edge = today + timedelta(days=cfg.warning_days)
    f = lambda **kw: Q(**{f"{prefix}{k}": v for k, v in kw.items()})  # noqa: E731
    synced = f(synced_at__isnull=False)
    eol = synced & (f(eol_date__lte=today)
                    | (f(eol_date__isnull=True) & f(eol_reached=True)))
    ending = synced & f(eol_date__gt=today) & f(eol_date__lte=edge)
    supported = synced & (f(eol_date__gt=edge)
                          | (f(eol_date__isnull=True) & f(eol_reached=False)))
    if status == "eol":
        return eol
    if status == "ending":
        return ending
    if status == "supported":
        return supported
    if status == "unknown":
        return ~(eol | ending | supported)
    raise ValueError(status)


def apply_status_filter(qs, request, prefix: str):
    """``?eol=<status>[,<status>]`` on a list. A no-op while the feature is
    off; an unknown value is a 400."""
    raw = request.query_params.get("eol") if request else None
    if not raw:
        return qs
    from rest_framework.exceptions import ValidationError

    wanted = [s for s in raw.split(",") if s]
    bad = [s for s in wanted if s not in STATUSES]
    if bad:
        raise ValidationError({"eol": f"One of {', '.join(STATUSES)}."})
    cfg = config_for(request)
    if not cfg.enabled:
        return qs
    q = Q()
    for s in wanted:
        q |= status_q(s, cfg, prefix)
    return qs.filter(q)


# ─── catalog cache ───────────────────────────────────────────────────────────


def store_catalog(source_key: str, products: list[dict]) -> dict:
    """Make the cached catalog of ``source_key`` mirror ``products``."""
    from .models import EolProduct

    get_source(source_key)
    by_name = {p["name"]: p for p in products}
    existing = {
        name: pk for pk, name in EolProduct.objects.filter(
            source=source_key).values_list("id", "name")
    }
    rows = [
        EolProduct(
            source=source_key, name=name, label=p["label"],
            category=p["category"], aliases=p["aliases"], releases=p["releases"],
        )
        for name, p in by_name.items()
    ]
    gone = [pk for name, pk in existing.items() if name not in by_name]
    with transaction.atomic():
        EolProduct.objects.bulk_create(
            rows, batch_size=500, update_conflicts=True,
            unique_fields=["source", "name"],
            update_fields=["label", "category", "aliases", "releases", "updated_at"],
        )
        if gone:
            EolProduct.objects.filter(id__in=gone).delete()
    return {
        "products": len(by_name),
        "added": len(set(by_name) - set(existing)),
        "removed": len(gone),
    }


def find_release(product, cycle: str) -> dict | None:
    if product is None:
        return None
    return next((r for r in product.releases or [] if r.get("name") == cycle), None)


def _parse_date(value):
    return date.fromisoformat(value) if value else None


def fill_mapping(mapping, product, now=None) -> bool:
    """Copy the cycle's facts from the cached ``product`` onto ``mapping``.
    Returns whether anything changed. A product or cycle that has left the
    catalog keeps its last facts and is flagged ``missing``."""
    rel = find_release(product, mapping.cycle)
    before = _facts(mapping)
    if rel is None:
        mapping.missing = True
    else:
        mapping.missing = False
        mapping.release_date = _parse_date(rel.get("release_date"))
        mapping.support_until = _parse_date(rel.get("support_until"))
        mapping.eol_date = _parse_date(rel.get("eol_date"))
        mapping.eol_reached = rel.get("eol")
        mapping.lts = bool(rel.get("lts"))
        mapping.latest_version = rel.get("latest") or ""
    changed = _facts(mapping) != before
    # ``synced_at`` dates the facts: set when they are first taken and when
    # they change, so an unchanged refresh writes nothing.
    if rel is not None and (changed or mapping.synced_at is None):
        mapping.synced_at = now or timezone.now()
        return True
    return changed


def _facts(m) -> tuple:
    return (m.release_date, m.support_until, m.eol_date, m.eol_reached, m.lts,
            m.latest_version, m.missing)


def apply_mappings(source_key: str | None = None) -> dict:
    """Refresh every mapping's facts from the cached catalog - one query for
    the products the mappings name, a save only for a mapping that changed (so
    the change log shows real changes, not every refresh)."""
    from .models import EolMapping, EolProduct

    mappings = EolMapping.objects.all()
    if source_key:
        mappings = mappings.filter(source=source_key)
    mappings = list(mappings)
    keys = {(m.source, m.product) for m in mappings}
    products = {}
    if keys:
        q = Q()
        for src, name in keys:
            q |= Q(source=src, name=name)
        products = {(p.source, p.name): p for p in EolProduct.objects.filter(q)}
    now = timezone.now()
    changed = 0
    for m in mappings:
        if fill_mapping(m, products.get((m.source, m.product)), now):
            m.save()
            changed += 1
    return {"mappings": len(mappings), "changed": changed}


def _set_status(status: str, *, via: str = "", error: str = "", at=None) -> None:
    from .models import EolSettings

    # An UPDATE, not save(): run bookkeeping is not a settings change, so it
    # stays out of the change log.
    EolSettings.load()
    fields = {"last_refresh_status": status, "last_refresh_error": error[:2000],
              "updated_at": timezone.now()}
    if via:
        fields["last_refresh_via"] = via
    if at is not None:
        fields["last_refresh_at"] = at
    EolSettings.objects.filter(pk=1).update(**fields)


def refresh() -> dict:
    """Fetch every enabled source, cache its catalog, update the mappings.
    A failing source does not stop the others; the run fails if any did."""
    from .models import EolSettings

    row = EolSettings.load()
    if not row.enabled:
        return {"skipped": "off"}
    _set_status("running", via="online")
    results, errors = {}, []
    for key in row.sources or []:
        try:
            src = get_source(key)
            products = src.fetch((row.source_urls or {}).get(key, ""))
            results[key] = store_catalog(key, products)
            results[key].update(apply_mappings(key))
        except Exception as exc:  # noqa: BLE001 - lands on the settings row
            log.warning("end-of-life refresh from %s failed: %s", key, exc)
            errors.append(f"{key}: {exc}")
    _set_status("failed" if errors else "ok", error="; ".join(errors),
                at=timezone.now())
    return {"sources": results, "errors": errors}


def import_payload(source_key: str, raw: bytes) -> dict:
    """The offline path: the source's catalog JSON saved to a file."""
    from .eol_sources import MAX_BYTES, load_json

    src = get_source(source_key)
    if len(raw) > MAX_BYTES:
        raise EolSourceError("The file is larger than 64 MB.")
    products = src.parse(load_json(raw))
    result = store_catalog(source_key, products)
    result.update(apply_mappings(source_key))
    _set_status("ok", via="import", at=timezone.now())
    return result


# ─── suggestions ─────────────────────────────────────────────────────────────

_TOKEN = re.compile(r"[a-z0-9]+")
_VERSION = re.compile(r"\d+(?:\.\d+)*")


def _tokens(*texts) -> set[str]:
    out = set()
    for t in texts:
        out.update(_TOKEN.findall((t or "").lower()))
    return out


def suggest_cycle(product, platform_name: str) -> str:
    """The cycle a platform's name points at ("Ubuntu 22.04" → "22.04"), the
    longest version in the name that a release starts. Blank when none."""
    names = [r.get("name", "") for r in product.releases or []]
    for version in sorted(_VERSION.findall(platform_name or ""), key=len, reverse=True):
        parts = version.split(".")
        for n in range(len(parts), 0, -1):
            cand = ".".join(parts[:n])
            if cand in names:
                return cand
    return ""


def suggest_products(platform, products, limit: int = 5) -> list[dict]:
    """Rank cached products against a platform's name, slug and manufacturer.
    A suggestion only - the caller still picks."""
    words = _tokens(platform.name, platform.slug.replace("-", " "),
                    getattr(platform.manufacturer, "name", ""))
    slug = (platform.slug or "").lower()
    scored = []
    for p in products:
        names = {p.name.lower(), *(a.lower() for a in p.aliases or [])}
        score = 0
        if names & {slug, (platform.name or "").lower()}:
            score += 10
        if names & words:
            score += 6
        overlap = words & _tokens(p.label, p.name.replace("-", " "))
        score += 2 * len(overlap)
        if score:
            scored.append((score, p))
    scored.sort(key=lambda sp: (-sp[0], sp[1].name))
    return [
        {"source": p.source, "name": p.name, "label": p.label, "score": s,
         "cycle": suggest_cycle(p, platform.name)}
        for s, p in scored[:limit]
    ]


def known_sources() -> list[dict]:
    return [{"key": s.key, "label": s.label, "default_url": s.default_url,
             "homepage": s.homepage} for s in SOURCES.values()]


__all__ = [
    "EolSourceError", "STATUSES", "apply_mappings", "apply_status_filter",
    "config_for", "import_payload", "load_config", "payload", "refresh",
    "status_of", "status_q", "store_catalog", "suggest_products",
]
