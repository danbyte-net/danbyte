"""SLA metrics export: the stored figures of each period as rows, for CSV or
JSON. Built from what the viewer may see (``_viewer_figures`` in the API), so
a limited viewer's rows are their partial figures and carry no credit."""
from __future__ import annotations

import io

#: Periods per agreement, newest first - the same window as the periods list.
MAX_PERIODS = 60

COLUMNS = (
    "agreement_id", "agreement", "for", "period", "period_state", "period_start",
    "period_end", "revision", "availability_pct", "target_pct", "state", "coverage_pct",
    "down_s", "budget_s", "budget_left_s", "budget_spent_pct", "burn_rate", "incidents",
    "units", "hidden_members", "credit_pct", "credit_amount", "currency", "computed_at",
)


def row(agreement, result, view: dict) -> dict:
    f = view.get("figures") or {}
    c = f.get("credit") or {}
    limited = view.get("limited") or {}
    return {
        "agreement_id": str(agreement.id), "agreement": agreement.name,
        "for": agreement.for_label, "period": result.period_key,
        "period_state": result.state, "period_start": result.period_start.isoformat(),
        "period_end": result.period_end.isoformat(), "revision": result.revision,
        "availability_pct": f.get("availability"), "target_pct": f.get("target"),
        "state": f.get("state"), "coverage_pct": f.get("coverage"),
        "down_s": f.get("down_s"), "budget_s": f.get("budget_s"),
        "budget_left_s": f.get("budget_left_s"), "budget_spent_pct": f.get("budget_spent_pct"),
        "burn_rate": f.get("burn_rate"), "incidents": f.get("incidents"),
        "units": f.get("units"), "hidden_members": limited.get("hidden_members"),
        "credit_pct": c.get("pct"), "credit_amount": c.get("amount"),
        "currency": c.get("currency"), "computed_at": result.computed_at.isoformat(),
        "objectives": [
            {k: o.get(k) for k in ("kind", "threshold_ms", "target_pct", "pct", "probes",
                                   "budget_spent_pct", "state")}
            for o in f.get("objectives") or []
        ],
    }


def to_csv(rows: list[dict]) -> str:
    """One line per agreement and period. Objectives are in the JSON only."""
    from .sla_report import _SafeWriter

    out = io.StringIO()
    w = _SafeWriter(out)
    w.writerow(COLUMNS)
    for r in rows:
        w.writerow(["" if r[k] is None else r[k] for k in COLUMNS])
    return out.getvalue()
