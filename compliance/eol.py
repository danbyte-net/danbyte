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

from .eol_sources import CUSTOM, SOURCES, EolSourceError, get_source

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


def date_status(end: date | None, warning_days: int, today: date | None = None,
                eol_reached: bool | None = None) -> str:
    """The status of an end-of-life date, by the rules of the module
    docstring: ``eol`` on or after the date, ``ending`` within the warning
    window, ``supported`` beyond it. Without a date the source's own flag
    (``eol_reached``) decides, else ``unknown``. Plain values, so a mapping,
    a platform's effective date, a device type's end of support and the
    Lifecycle page all read one rule."""
    if end:
        today = today or timezone.localdate()
        if end <= today:
            return "eol"
        if end <= today + timedelta(days=warning_days):
            return "ending"
        return "supported"
    if eol_reached is True:
        return "eol"
    if eol_reached is False:
        return "supported"
    return "unknown"


def status_of(mapping, warning_days: int, today: date | None = None) -> str:
    if mapping is None or mapping.synced_at is None:
        return "unknown"
    return date_status(mapping.eol_date, warning_days, today, mapping.eol_reached)


# ─── the effective OS date ───────────────────────────────────────────────────

#: ``effective_source`` of dates someone entered on the platform.
ENTERED = "entered"


@dataclass(frozen=True)
class Effective:
    """A platform's OS lifetime as the bars and the Lifecycle page read it."""

    start: date | None
    end: date | None
    #: The source's end-of-life flag, for a mapped cycle without a date.
    eol_reached: bool | None
    #: Where the end came from (else the start): ``ENTERED`` or a source key.
    source: str | None


def effective_dates(release_date, end_of_support, mapping, enabled: bool) -> Effective:
    """What someone entered wins, field by field; the end-of-life mapping
    fills what is blank, while the feature is on and once the mapping has
    been synced. ``mapping`` is anything carrying the mapping's ``source``,
    ``release_date``, ``eol_date``, ``eol_reached`` and ``synced_at``, or
    None. Fetched data never overwrites entered data - this only reads."""
    m = mapping if enabled and mapping is not None and mapping.synced_at is not None else None
    end, reached, end_src = None, None, None
    if end_of_support:
        end, end_src = end_of_support, ENTERED
    elif m is not None and (m.eol_date or m.eol_reached is not None):
        end, end_src = m.eol_date, m.source
        reached = None if m.eol_date else m.eol_reached
    start, start_src = None, None
    if release_date:
        start, start_src = release_date, ENTERED
    elif m is not None and m.release_date:
        start, start_src = m.release_date, m.source
    return Effective(start, end, reached, end_src or start_src)


def effective_of(platform, cfg: EolConfig) -> Effective:
    """:func:`effective_dates` of a platform - the mapping from the
    select_related cache when the caller joined it, and never read while
    the feature is off."""
    return effective_dates(
        platform.release_date, platform.end_of_support,
        mapping_of(platform) if cfg.enabled else None, cfg.enabled,
    )


def effective_payload(platform, cfg: EolConfig) -> dict:
    """``effective_release`` / ``effective_end`` / ``effective_source`` on
    platforms and on the nested platform of devices and VMs."""
    e = effective_of(platform, cfg)
    return {"effective_release": e.start, "effective_end": e.end,
            "effective_source": e.source}


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
    """Make the cached catalog of ``source_key`` mirror ``products``. Only
    the source's own rows (``tenant`` NULL): a tenant's custom products are
    never written or deleted here."""
    from audit.context import suspended

    from .models import EolProduct

    get_source(source_key)
    by_name = {p["name"]: p for p in products}
    existing = {
        p.name: p for p in EolProduct.objects.filter(
            source=source_key, tenant__isnull=True).only("id", "name")
    }
    fields = ["label", "category", "aliases", "releases"]
    now = timezone.now()
    new, changed = [], []
    for name, p in by_name.items():
        row = existing.get(name)
        if row is None:
            row = EolProduct(source=source_key, name=name)
            new.append(row)
        else:
            changed.append(row)
        for f in fields:
            setattr(row, f, p[f])
        row.updated_at = now
    gone = [row.pk for name, row in existing.items() if name not in by_name]
    with transaction.atomic():
        EolProduct.objects.bulk_create(new, batch_size=500)
        EolProduct.objects.bulk_update(changed, [*fields, "updated_at"], batch_size=500)
        if gone:
            # Cached public data, not a tenant's record: kept out of the
            # change log like the bulk writes above.
            with suspended():
                EolProduct.objects.filter(id__in=gone, tenant__isnull=True).delete()
    return {
        "products": len(by_name),
        "added": len(new),
        "removed": len(gone),
    }


def is_source(key: str) -> bool:
    """A source key a product may name: a registered source or ``custom``."""
    return key in SOURCES or key == CUSTOM


def source_label(key: str) -> str | None:
    if key == CUSTOM:
        return "Custom"
    src = SOURCES.get(key)
    return src.label if src else None


def products_for(tenant_id):
    """The products a tenant picks from: every source's catalog and its own
    custom products - never another tenant's."""
    from .models import EolProduct

    return EolProduct.objects.filter(Q(tenant__isnull=True) | Q(tenant_id=tenant_id))


def find_product(source: str, name: str, tenant_id):
    """The product ``(source, name)`` as ``tenant_id`` sees it, or None. A
    custom product is looked up in that tenant alone."""
    from .models import EolProduct

    if not (source and name):
        return None
    qs = EolProduct.objects.filter(source=source, name=name)
    if source == CUSTOM:
        qs = qs.filter(tenant_id=tenant_id)
    else:
        qs = qs.filter(tenant__isnull=True)
    return qs.first()


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
    keys = {_product_key(m.source, m.product, m.tenant_id) for m in mappings}
    products = {}
    if keys:
        q = Q()
        for src, name, tenant_id in keys:
            q |= Q(source=src, name=name, tenant_id=tenant_id)
        products = {
            _product_key(p.source, p.name, p.tenant_id): p
            for p in EolProduct.objects.filter(q)
        }
    now = timezone.now()
    changed = 0
    for m in mappings:
        if fill_mapping(m, products.get(_product_key(m.source, m.product, m.tenant_id)), now):
            m.save()
            changed += 1
    return {"mappings": len(mappings), "changed": changed}


def _product_key(source: str, name: str, tenant_id) -> tuple:
    """How a mapping finds its product: a source's by (source, name), a
    custom one in the mapping's own tenant."""
    return (source, name, tenant_id if source == CUSTOM else None)


def apply_custom(product) -> dict:
    """After a custom product's cycles change: redo the cycles of the
    installs of every application that names it (a version may match a new
    cycle, or no longer match a removed one) and refill the platform
    mappings on it - in the product's tenant only, as a refresh would."""
    from api.applications import set_product
    from api.models import Application

    from .models import EolMapping

    apps = Application.objects.filter(
        tenant_id=product.tenant_id, eol_source=CUSTOM, eol_product=product.name)
    n_apps = 0
    for app in apps:
        set_product(app, CUSTOM, product.name)
        n_apps += 1
    # The mappings set_product kept, and the platforms', take the new facts.
    changed = 0
    for m in EolMapping.objects.filter(
        tenant_id=product.tenant_id, source=CUSTOM, product=product.name,
    ):
        if fill_mapping(m, product):
            m.save()
            changed += 1
    return {"applications": n_apps, "changed": changed}


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
    "ENTERED", "Effective", "EolSourceError", "STATUSES", "apply_mappings",
    "apply_status_filter", "config_for", "date_status", "effective_dates",
    "effective_of", "effective_payload", "import_payload", "load_config",
    "payload", "refresh", "status_of", "status_q", "store_catalog",
    "suggest_products",
]
