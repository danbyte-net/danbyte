"""Background recompute of a tenant's matches (#451), on RQ ``low``.

* ``enqueue_recompute(tenant_id)`` - the whole tenant, after a store (new or
  changed records, EPSS, KEV), a mapping change or a policy change.
  Debounced by a Redis key per tenant (60 s): a burst of stores (browser
  pages, an upload in batches) queues one job; the job clears the key when
  it starts, so a store after that queues the next.
* ``enqueue_objects(tenant_id, {"device": ids, "virtual_machine": ids})`` -
  some hosts, after a version, platform, device type or install change.

Each run ends with the tenant's one notification about what it found
(``notifications.after_recompute``).

Each job re-reads its scope when it runs: the feature must still be on, the
tenant must still exist and be active, and the hosts are looked up inside
the tenant again (an id that left it only resolves its rows). With Redis
down the work runs inline, as the end-of-life refresh does.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

QUEUE = "low"
DEBOUNCE_SECONDS = 60
JOB_TIMEOUT = 3600


def _debounce_key(tenant_id) -> str:
    return f"danbyte:vuln:recompute:{tenant_id}"


def _push(func, *args) -> None:
    """Queue ``func(*args)`` on ``low``; inline when RQ is unavailable."""
    try:
        import django_rq

        django_rq.get_queue(QUEUE).enqueue(func, *args, job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down
        log.warning("RQ unavailable; recomputing vulnerability matches inline")
        func(*args)


def _claim(tenant_id) -> bool:
    """True when no recompute is waiting for this tenant (and now one is)."""
    try:
        import django_rq

        conn = django_rq.get_connection(QUEUE)
        return bool(conn.set(_debounce_key(tenant_id), "1", nx=True, ex=DEBOUNCE_SECONDS))
    except Exception:  # noqa: BLE001 - Redis down: no debounce
        return True


def _release(tenant_id) -> None:
    try:
        import django_rq

        django_rq.get_connection(QUEUE).delete(_debounce_key(tenant_id))
    except Exception:  # noqa: BLE001
        pass


def enqueue_recompute(tenant_id) -> None:
    if _claim(tenant_id):
        _push(run_recompute, str(tenant_id))


def enqueue_objects(tenant_id, objects: dict) -> None:
    payload = {k: sorted(str(i) for i in v) for k, v in objects.items() if v}
    if payload:
        _push(run_objects, str(tenant_id), payload)


def _tenant(tenant_id):
    from core.models import Tenant

    from .models import VulnerabilitySettings

    if not VulnerabilitySettings.load().enabled:
        return None
    return Tenant.objects.filter(pk=tenant_id, is_active=True).first()


def run_recompute(tenant_id: str) -> dict | None:
    from . import matching

    _release(tenant_id)
    tenant = _tenant(tenant_id)
    if tenant is None:
        return None
    counts = matching.recompute(tenant)
    counts["notified"] = _notify(tenant)
    log.info("vulnerability matches for tenant %s: %s", tenant_id, counts)
    return counts


def run_objects(tenant_id: str, objects: dict) -> dict | None:
    from . import matching

    tenant = _tenant(tenant_id)
    if tenant is None:
        return None
    counts = matching.recompute(tenant, objects=objects)
    counts["notified"] = _notify(tenant)
    return counts


def run_reprioritise(tenant_id: str) -> int | None:
    from . import matching

    tenant = _tenant(tenant_id)
    if tenant is None:
        return None
    n = matching.reprioritise(tenant)
    _notify(tenant)
    return n


def _notify(tenant) -> int:
    """One message for what this run found (``notifications``); never
    fails the run."""
    from . import notifications

    try:
        return notifications.after_recompute(tenant)
    except Exception:  # noqa: BLE001
        log.exception("vulnerability notifications for tenant %s failed", tenant.pk)
        return 0


def tenants_for(vuln_ids) -> set:
    """Tenants whose enabled mappings name a product of these records."""
    from django.db.models import Q

    from .models import CveProduct, ProductMapping

    keys = set(CveProduct.objects.filter(cve__vuln_id__in=list(vuln_ids)).values_list(
        "kind", "part", "vendor", "product").distinct())
    if not keys:
        return set()
    q = Q()
    for kind, part, vendor, product in keys:
        q |= Q(kind=kind, part=part, vendor=vendor, product=product)
    return set(ProductMapping.objects.filter(q, enabled=True)
               .values_list("tenant_id", flat=True).distinct())


def after_store(changed: set[str]) -> None:
    """``store.register_after_store`` hook: recompute every tenant a changed
    record can reach. Chunked so a large import does not build one huge
    query."""
    ids = list(changed)
    tenants: set = set()
    for i in range(0, len(ids), 5000):
        tenants |= tenants_for(ids[i:i + 5000])
    for tenant_id in tenants:
        enqueue_recompute(tenant_id)


def enqueue_all() -> None:
    """Every tenant with a mapping (the feature was just switched on)."""
    from .models import ProductMapping

    for tenant_id in set(ProductMapping.objects.filter(enabled=True)
                         .values_list("tenant_id", flat=True)):
        enqueue_recompute(tenant_id)


def tracked_keys():
    """``products.register_provider`` hook: every product an enabled
    mapping names, hardware excepted (context only, never fetched)."""
    from .models import ProductMapping

    return set(ProductMapping.objects.filter(enabled=True).exclude(part="h").values_list(
        "kind", "part", "vendor", "product").distinct())
