"""Hysteresis state machine.

``apply_outcome`` folds a single ``CheckOutcome`` into a ``CheckState``,
updating the consecutive counters and deciding whether the rolled-up status
changes. It mutates the ``CheckState`` in place (the caller bulk-saves) and
returns a ``StateTransition`` to persist when the status actually changed, else
``None``.

Rules:

* ``up`` after ``rise`` consecutive successes (a *success* is any reachable
  result — ``up`` or ``degraded``).
* ``down`` after ``fall`` consecutive failures.
* ``degraded`` surfaces immediately when reachable-but-impaired — impairment
  shouldn't wait out the rise count.
* ``unknown`` (internal/config error) never flips a known status to ``down`` —
  it leaves the counters and the current status untouched, so a transient
  misconfiguration doesn't read as an outage.
"""
from __future__ import annotations

from datetime import timedelta

from .checkers import CheckOutcome
from .models import CheckState, StateTransition


def apply_outcome(
    state: CheckState,
    *,
    rise: int,
    fall: int,
    outcome: CheckOutcome,
    now,
    stale_after_scans: int = 0,
    stale_after_days: int = 0,
) -> StateTransition | None:
    state.last_checked = now
    state.last_latency_ms = outcome.latency_ms

    s = outcome.status
    if s in ("up", "degraded"):
        state.consecutive_success += 1
        state.consecutive_fail = 0
    elif s == "down":
        state.consecutive_fail += 1
        state.consecutive_success = 0
    # 'unknown' leaves both counters as-is.

    old = state.status
    new = old
    if s == "degraded":
        new = "degraded"
    elif s == "up":
        if old in ("up", "degraded") or state.consecutive_success >= max(rise, 1):
            new = "up"
    elif s == "down":
        if state.consecutive_fail >= max(fall, 1):
            new = "down"
    elif s == "unknown":
        new = "unknown" if old == "unknown" else old

    # Stale = chronic down. Escalate a down result once it has failed for enough
    # consecutive scans, or (if already down) been down long enough. The
    # by-days check only applies while already down, so ``since`` is the
    # down-start time and a long prior uptime can't falsely flip it stale.
    if new == "down":
        if stale_after_scans and state.consecutive_fail >= stale_after_scans:
            new = "stale"
        elif (
            stale_after_days
            and old in ("down", "stale")
            and state.since is not None
            and (now - state.since) >= timedelta(days=stale_after_days)
        ):
            new = "stale"

    if new != old:
        state.status = new
        state.since = now
        return StateTransition(
            tenant_id=state.tenant_id,
            target_ip_id=state.target_ip_id,
            template_id=state.template_id,
            kind=state.kind,
            from_status=old,
            to_status=new,
            at=now,
            detail=outcome.detail or {},
        )
    if state.since is None:
        state.since = now
    return None
