"""SLA incident follow-up: cause, ticket link, note and a disputed flag on an
incident, joined onto the incidents a period or an analysis window lists.

An incident is not a row of its own: it is a run of down time in a stored
period (``SlaPeriodResult.incidents``), identified by its unit and its start.
Follow-up never changes a figure - a disputed incident still counts, and
excluding time stays an explicit exclusion.
"""
from __future__ import annotations

from datetime import datetime

#: The label for incidents nobody has given a cause.
NO_CAUSE = "No cause"


def _key(unit: str, start) -> tuple[str, float]:
    if isinstance(start, str):
        start = datetime.fromisoformat(start)
    return unit, start.timestamp()


def follow_ups_for(agreement, incidents: list[dict]) -> dict:
    """``{(unit, start ts): SlaIncidentFollowUp}`` for these incidents."""
    from .models import SlaIncidentFollowUp

    if not incidents:
        return {}
    starts = [datetime.fromisoformat(i["start"]) for i in incidents]
    rows = SlaIncidentFollowUp.objects.filter(
        agreement=agreement, started_at__gte=min(starts), started_at__lte=max(starts),
        unit__in={i["unit"] for i in incidents},
    ).select_related("cause")
    return {_key(r.unit, r.started_at): r for r in rows}


def serialize(fu) -> dict | None:
    if fu is None:
        return None
    c = fu.cause
    return {
        "id": str(fu.id),
        "cause": str(c.id) if c else None,
        "cause_detail": {"id": str(c.id), "name": c.name, "color": c.color} if c else None,
        "ticket_url": fu.ticket_url, "note": fu.note, "disputed": fu.disputed,
        "updated_at": fu.updated_at.isoformat() if fu.updated_at else None,
        "updated_by": getattr(fu.updated_by, "username", None),
    }


def attach(agreement, incidents: list[dict]) -> list[dict]:
    """The incidents, each with a ``follow_up`` (or None). Copies; the
    stored rows are left alone."""
    found = follow_ups_for(agreement, incidents)
    return [{**i, "follow_up": serialize(found.get(_key(i["unit"], i["start"])))}
            for i in incidents]


def by_cause(incidents: list[dict]) -> list[dict]:
    """Down time per cause over attached incidents, most first. Incidents
    without a cause share one row; ``disputed_s`` is the disputed share."""
    rows: dict = {}
    for i in incidents:
        fu = i.get("follow_up") or {}
        c = fu.get("cause_detail")
        key = c["id"] if c else None
        r = rows.setdefault(key, {
            "cause": key, "name": c["name"] if c else NO_CAUSE,
            "color": c["color"] if c else "", "down_s": 0, "incidents": 0, "disputed_s": 0,
        })
        r["down_s"] += i.get("seconds") or 0
        r["incidents"] += 1
        if fu.get("disputed"):
            r["disputed_s"] += i.get("seconds") or 0
    return sorted(rows.values(), key=lambda r: (r["cause"] is None, -r["down_s"], r["name"]))
