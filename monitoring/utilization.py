"""Prefix utilization alerts.

Periodically evaluates each prefix's ``utilisation_pct`` and fires a
notification (via the tenant's channels) when it crosses the alert threshold.
Uses hysteresis so an alert isn't re-sent every tick: a prefix is "armed" again
only after it drops back below the clear threshold. The armed/alerted flag lives
in the Django cache (redis) — no schema change, and it self-expires.

Thresholds are settings (``MONITORING_UTIL_ALERT_THRESHOLD`` /
``MONITORING_UTIL_ALERT_CLEAR``). Only IPv4, non-container prefixes report a
utilisation, so the rest are skipped.
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.core.cache import cache

from .notify import notify_event

log = logging.getLogger("monitoring.utilization")

# Cache key marking a prefix as already-alerted (so we don't re-spam). Held for
# a week; cleared early when the prefix drops below the clear threshold.
_TTL = 7 * 24 * 3600


def _key(prefix_id) -> str:
    return f"monitoring:util_alerted:{prefix_id}"


def evaluate_utilization(tenant=None) -> dict:
    from api.models import Prefix

    threshold = int(getattr(settings, "MONITORING_UTIL_ALERT_THRESHOLD", 90))
    clear = int(getattr(settings, "MONITORING_UTIL_ALERT_CLEAR", 80))

    qs = Prefix.objects.all()
    if tenant is not None:
        qs = qs.filter(tenant=tenant)

    fired = 0
    cleared = 0
    for prefix in qs.select_related("tenant"):
        pct = prefix.utilisation_pct
        if pct is None:
            continue
        key = _key(prefix.id)
        already = cache.get(key)

        if pct >= threshold and not already:
            cache.set(key, pct, _TTL)
            fired += 1
            subject = f"[Danbyte] Prefix {prefix.cidr} is {pct}% full"
            body = (
                f"Prefix {prefix.cidr} has reached {pct}% utilisation "
                f"(threshold {threshold}%).\n"
            )
            notify_event(
                prefix.tenant_id,
                subject,
                body,
                {
                    "type": "prefix_utilization",
                    "prefix_id": str(prefix.id),
                    "cidr": prefix.cidr,
                    "utilisation_pct": pct,
                    "threshold": threshold,
                },
                # Site-bound event → the site's SMTP override (if any) applies.
                site_id=prefix.site_id,
            )
        elif pct <= clear and already:
            cache.delete(key)  # re-arm for the next time it climbs
            cleared += 1

    return {"fired": fired, "rearmed": cleared, "threshold": threshold}
