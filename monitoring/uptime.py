"""Uptime / SLA reporting (A6).

Computes **time-weighted** availability from the ``StateTransition`` log: we
walk the status changes for a check over a window and integrate how long it
spent reachable vs. down, rather than counting raw samples (which would bias
toward whatever interval happened to be in effect).

Definitions:

* **up**  - time in ``up`` or ``degraded`` (degraded is still reachable).
* **down** - time in ``down`` or ``stale``.
* **excluded** - time in ``unknown`` (no verdict) or ``skipped`` (deliberately
  not checked). Excluded from the SLA denominator, and reported separately so a
  100%-looking number can't hide a check that simply wasn't running.

``uptime_pct = up / (up + down)``. Also returned: number of **incidents** (downs
opened in the window) and **MTTR** (mean time to recovery - average duration of
a down period).
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from .models import CheckState
from .timeline import integrate, segments_for_pairs

_UP = {"up", "degraded"}
_DOWN = {"down", "stale"}
# unknown / skipped → excluded from the denominator.


def _summary(state: CheckState, segments) -> dict:
    """The figures for one check from its segments - shared by the single-check
    path and the bulk one so they cannot drift."""
    totals = integrate(segments, up=_UP, down=_DOWN)
    up, down, excluded = totals["up"], totals["down"], totals["excluded"]
    incidents = totals["incidents"]
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


def check_uptime(state: CheckState, since, now) -> dict:
    """Time-weighted uptime for one CheckState over ``[since, now]``.

    The segments come from :mod:`timeline`, which is also what draws the
    status strip - so the percentage and the picture always agree.
    """
    key = (str(state.target_ip_id), str(state.template_id))
    segments = segments_for_pairs(state.tenant_id, [key], since, now).get(key, [])
    return _summary(state, segments)


def ip_uptime(ip, days: int = 30) -> dict:
    """Per-check + aggregate uptime for an IP over the last ``days``."""
    now = timezone.now()
    since = now - timedelta(days=days)
    states = list(
        CheckState.objects.filter(target_ip=ip).select_related("template")
    )
    # Two queries for every check on the address, not two per check.
    by_pair = segments_for_pairs(
        ip.tenant_id, [(s.target_ip_id, s.template_id) for s in states], since, now
    )
    checks = [
        _summary(s, by_pair.get((str(s.target_ip_id), str(s.template_id)), []))
        for s in states
    ]

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
