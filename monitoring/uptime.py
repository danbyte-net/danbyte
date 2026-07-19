"""Uptime / SLA reporting (A6).

Computes **time-weighted** availability from the ``StateTransition`` log: we
walk the status changes for a check over a window and integrate how long it
spent reachable vs. down, rather than counting raw samples (which would bias
toward whatever interval happened to be in effect).

Definitions:

* **up**  — time in ``up`` or ``degraded`` (degraded is still reachable).
* **down** — time in ``down`` or ``stale``.
* **excluded** — time in ``unknown`` (no verdict) or ``skipped`` (deliberately
  not checked). Excluded from the SLA denominator, and reported separately so a
  100%-looking number can't hide a check that simply wasn't running.

``uptime_pct = up / (up + down)``. Also returned: number of **incidents** (downs
opened in the window) and **MTTR** (mean time to recovery — average duration of
a down period).
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from .models import CheckState, StateTransition

_UP = {"up", "degraded"}
_DOWN = {"down", "stale"}
# unknown / skipped → excluded from the denominator.


def _status_at(tenant_id, ip_id, template_id, when) -> str:
    """The status in effect at ``when`` — the to_status of the last transition
    before it, or 'unknown' if the check has no prior history."""
    tr = (
        StateTransition.objects.filter(
            tenant_id=tenant_id,
            target_ip_id=ip_id,
            template_id=template_id,
            at__lt=when,
        )
        .order_by("-at")
        .values_list("to_status", flat=True)
        .first()
    )
    return tr or "unknown"


def check_uptime(state: CheckState, since, now) -> dict:
    """Time-weighted uptime for one CheckState over ``[since, now]``."""
    start_status = _status_at(state.tenant_id, state.target_ip_id, state.template_id, since)
    transitions = list(
        StateTransition.objects.filter(
            tenant_id=state.tenant_id,
            target_ip_id=state.target_ip_id,
            template_id=state.template_id,
            at__gte=since,
            at__lte=now,
        )
        .order_by("at")
        .values_list("at", "to_status")
    )

    up = down = excluded = 0.0
    incidents = 0
    cursor, status = since, start_status
    for at, to_status in transitions:
        seg = (at - cursor).total_seconds()
        if status in _UP:
            up += seg
        elif status in _DOWN:
            down += seg
        else:
            excluded += seg
        if to_status in _DOWN and status not in _DOWN:
            incidents += 1
        cursor, status = at, to_status
    # tail segment from the last transition to now
    seg = (now - cursor).total_seconds()
    if status in _UP:
        up += seg
    elif status in _DOWN:
        down += seg
    else:
        excluded += seg

    measured = up + down
    pct = round(100.0 * up / measured, 3) if measured > 0 else None
    mttr = round(down / incidents, 1) if incidents else None
    return {
        "template_id": str(state.template_id),
        "template_name": state.template.name if state.template_id else None,
        "kind": state.kind,
        "current_status": state.status,
        "uptime_pct": pct,
        "up_seconds": round(up),
        "down_seconds": round(down),
        "excluded_seconds": round(excluded),
        "incidents": incidents,
        "mttr_seconds": mttr,
    }


def ip_uptime(ip, days: int = 30) -> dict:
    """Per-check + aggregate uptime for an IP over the last ``days``."""
    now = timezone.now()
    since = now - timedelta(days=days)
    states = list(
        CheckState.objects.filter(target_ip=ip).select_related("template")
    )
    checks = [check_uptime(s, since, now) for s in states]

    measured = [c for c in checks if c["uptime_pct"] is not None]
    up = sum(c["up_seconds"] for c in checks)
    down = sum(c["down_seconds"] for c in checks)
    total = up + down
    overall = round(100.0 * up / total, 3) if total > 0 else None
    return {
        "days": days,
        "overall_uptime_pct": overall,
        "total_incidents": sum(c["incidents"] for c in checks),
        "checks": checks,
        "measured_checks": len(measured),
    }
