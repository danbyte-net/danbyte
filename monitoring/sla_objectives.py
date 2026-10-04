"""Latency objectives: "99 % of ICMP probes answered within 20 ms".

An objective is counted in probes, not time, from the rollups' cumulative
latency histogram (monitoring.models.LATENCY_EDGES), so a threshold is one of
those edges. Each objective gets its own figure, error budget and state, like
availability: the budget is the share of probes allowed to be slow, spent by
the slow ones. Unanswered probes are down time, which availability already
counts; an objective only judges the probes that answered.

The objectives cover the whole period, every hour: the histogram lives in
hourly and daily rows, and a daily row cannot be cut to service hours.
"""
from __future__ import annotations

from .models import LATENCY_EDGES

MAX_OBJECTIVES = 8
STATE_RANK = {"no_data": -1, "ok": 0, "at_risk": 1, "breached": 2}


def validate(value) -> list[dict]:
    """Normalise ``objectives``; raises ValueError with a readable message."""
    if not isinstance(value, list) or len(value) > MAX_OBJECTIVES:
        raise ValueError(f"A list of up to {MAX_OBJECTIVES} objectives.")
    out, seen = [], set()
    for raw in value:
        try:
            kind = str(raw["kind"]).strip().lower()
            threshold = int(raw["threshold_ms"])
            target = float(raw["target_pct"])
        except (TypeError, KeyError, ValueError):
            raise ValueError("Each objective is {kind, threshold_ms, target_pct}.") from None
        if threshold not in LATENCY_EDGES:
            raise ValueError(
                f"The threshold is one of {', '.join(map(str, LATENCY_EDGES))} ms.")
        if not 0 < target < 100:
            raise ValueError("The target is between 0 and 100 %, not either end.")
        if (kind, threshold) in seen:
            raise ValueError(f"{kind} within {threshold} ms is there twice.")
        seen.add((kind, threshold))
        out.append({"kind": kind, "threshold_ms": threshold, "target_pct": target})
    return out


def evaluate(tenant_id, objectives: list[dict], ip_ids, since, until) -> list[dict]:
    """Each objective's figure over ``[since, until)`` for these addresses."""
    from .figures import span_window, sums

    if not objectives:
        return []
    got = {}
    if ip_ids and until > since:
        got = sums(
            span_window(since, until),
            lambda qs: qs.filter(tenant_id=tenant_id, target_ip_id__in=ip_ids,
                                 kind__in={o["kind"] for o in objectives}),
            ("kind",),
        )
    out = []
    for o in objectives:
        row = got.get((o["kind"],)) or {}
        n = int(row.get("lat_hist_n") or 0)
        within = int(row.get(f"lat_le_{o['threshold_ms']}") or 0)
        target = float(o["target_pct"])
        allowed = (100 - target) / 100 * n
        slow = n - within
        pct = round(100 * within / n, 3) if n else None
        spent = round(100 * slow / allowed, 1) if allowed else (100.0 if slow else 0.0)
        state = ("no_data" if not n else "breached" if pct < target
                 else "at_risk" if spent >= 75 else "ok")
        out.append({
            "kind": o["kind"], "threshold_ms": o["threshold_ms"], "target_pct": target,
            "probes": n, "within": within, "pct": pct,
            "budget_probes": round(allowed), "slow": slow, "budget_spent_pct": spent,
            "state": state,
        })
    return out


def worst_state(availability_state: str, objectives: list[dict]) -> str:
    """The agreement's state when objectives count: the worst of them all.
    An objective without data never makes it worse."""
    worst = availability_state
    for o in objectives:
        if STATE_RANK.get(o["state"], -1) > STATE_RANK.get(worst, -1):
            worst = o["state"]
    return worst
