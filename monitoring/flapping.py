"""Flapping-IP monitor (M22).

A *proactive* surface — "hey, this IP is flapping a lot, maybe go check on it" —
distinct from A5 flap **dampening** (which only quiets renotify for a currently
firing alert). Here we look at the raw ``StateTransition`` history per
(IP, check) over the configured flap window and rank the noisiest, regardless of
the IP's current up/down state.

Exclusions keep expected churn out of the list:
* IPs whose status is in ``MonitoringSettings.flap_exclude_ip_statuses``
  (e.g. a DHCP-scope status), and
* IPs individually flagged ``IPAddress.flap_exclude``.
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Count, Max
from django.utils import timezone

# A "flap" = a transition *into* a bad status. Repeated bad transitions in a
# short window is the bounce signal (down → up → down …).
_BAD = ("down", "degraded", "stale")


def flapping_ips(tenant, now=None, limit: int = 50, viewable_ips=None) -> list[dict]:
    """Return the tenant's flapping (IP, check) pairs, noisiest first.

    ``viewable_ips`` (an ``IPAddress`` queryset) restricts the result to the
    caller's site-scoped view; ``None`` means unrestricted (superuser / unscoped
    grant). The caller must handle "no view grant at all" before calling."""
    from api.models import IPAddress

    from .models import MonitoringSettings, StateTransition

    ms = MonitoringSettings.for_tenant(tenant)
    threshold = ms.flap_threshold
    if not threshold:  # 0 = flap detection disabled
        return []

    now = now or timezone.now()
    since = now - timedelta(minutes=ms.flap_window_minutes)

    transitions = StateTransition.objects.filter(
        tenant=tenant, at__gte=since, to_status__in=_BAD
    )
    if viewable_ips is not None:
        transitions = transitions.filter(target_ip__in=viewable_ips)
    rows = (
        transitions
        .values("target_ip_id", "template_id", "kind")
        .annotate(flap_count=Count("id"), last_at=Max("at"))
        .filter(flap_count__gte=threshold)
        .order_by("-flap_count", "-last_at")
    )
    rows = list(rows[: limit * 3])  # over-fetch; some get excluded below
    if not rows:
        return []

    excluded_status_ids = set(
        ms.flap_exclude_ip_statuses.values_list("id", flat=True)
    )
    ip_ids = {r["target_ip_id"] for r in rows}
    ips = {
        ip.id: ip
        for ip in IPAddress.objects.filter(id__in=ip_ids).only(
            "id", "ip_address", "dns_name", "status_id", "flap_exclude"
        )
    }

    from .models import CheckTemplate

    template_ids = {r["template_id"] for r in rows if r["template_id"]}
    names = {
        t.id: t.name
        for t in CheckTemplate.objects.filter(id__in=template_ids).only("id", "name")
    }

    out: list[dict] = []
    for r in rows:
        ip = ips.get(r["target_ip_id"])
        if ip is None or ip.flap_exclude:
            continue
        if ip.status_id and ip.status_id in excluded_status_ids:
            continue
        out.append(
            {
                "ip_id": str(ip.id),
                "ip_address": ip.ip_address,
                "dns_name": ip.dns_name or None,
                "template_id": str(r["template_id"]) if r["template_id"] else None,
                "template_name": names.get(r["template_id"]),
                "kind": r["kind"],
                "flap_count": r["flap_count"],
                "window_minutes": ms.flap_window_minutes,
                "last_at": r["last_at"],
            }
        )
        if len(out) >= limit:
            break
    return out
