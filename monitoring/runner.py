"""Check execution core.

Runs resolved checks against a target inside a single asyncio event loop, with:

* per-attempt timeout + immediate ``retries`` before recording a failure,
* central ``degraded`` → ``up`` downgrade when the template disables degraded,
* a bounded semaphore (``MONITORING_CONCURRENCY``) so a wide fan-out can't
  exhaust file descriptors.

DB work happens *after* the loop finishes — outcomes are collected in memory and
written synchronously — so no blocking ORM call ever runs on the event loop.

``check_now(ip)`` is the user-facing "run this IP's checks now" entry point. It
persists ``CheckResult`` rows (history) **and** folds each outcome into the
``CheckState`` through the same hysteresis state machine the scheduled worker
uses — so a manual check moves the rolled-up status, logs ``StateTransition``s,
and fires alerts just like an automatic scan.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

from django.conf import settings
from django.utils import timezone

from .checkers import CheckOutcome, get_checker
from .models import CheckResult, CheckState, StateTransition
from .resolver import ResolvedCheck, resolve_effective_checks


@dataclass
class RunItem:
    """A resolved check paired with the outcome of running it."""

    resolved: ResolvedCheck
    outcome: CheckOutcome


async def _attempt(
    checker, target: str, params: dict, secret_params: dict, timeout_ms: int
) -> CheckOutcome:
    """One attempt, hardened so any unexpected error becomes ``unknown``."""
    try:
        return await asyncio.wait_for(
            checker.run(target, params, secret_params, timeout_ms),
            # Hard ceiling slightly above the checker's own timeout, in case a
            # checker forgets to bound something.
            timeout=max(timeout_ms / 1000, 0.1) + 2,
        )
    except asyncio.TimeoutError:
        return CheckOutcome("down", None, {"error": "timeout"})
    except Exception as e:  # noqa: BLE001
        return CheckOutcome.unknown(f"{type(e).__name__}: {e}")


async def run_resolved(resolved: ResolvedCheck, target: str) -> CheckOutcome:
    """Run one resolved check against ``target``, applying retries + the
    degraded gate. Retries only on a *failure* (down/unknown); a reachable
    result (up/degraded) returns immediately."""
    checker = get_checker(resolved.kind)
    if checker is None:
        return CheckOutcome.unknown(f"no checker for kind '{resolved.kind}'")

    outcome = CheckOutcome.unknown("not run")
    for _ in range(max(resolved.template.retries, 0) + 1):
        outcome = await _attempt(
            checker,
            target,
            resolved.params,
            resolved.secret_params,
            resolved.timeout_ms,
        )
        if outcome.status in ("up", "degraded"):
            break

    # Central degraded gate: keep degraded only if the template enables it.
    if outcome.status == "degraded" and not resolved.degraded_enabled:
        outcome = CheckOutcome("up", outcome.latency_ms, outcome.detail)
    return outcome


async def _run_all(resolved: list[ResolvedCheck], target: str) -> list[RunItem]:
    sem = asyncio.Semaphore(getattr(settings, "MONITORING_CONCURRENCY", 100))

    async def _guarded(rc: ResolvedCheck) -> RunItem:
        async with sem:
            return RunItem(rc, await run_resolved(rc, target))

    return await asyncio.gather(*(_guarded(rc) for rc in resolved))


def record_results(ip, items: list[RunItem]) -> list[CheckResult]:
    """Persist a CheckResult per run item (append-only history).

    Synchronous — called after the event loop has finished. The CheckState
    rollup + StateTransition logging happen in ``_rollup_states`` (called by
    ``check_now`` right after this).
    """
    rows = [
        CheckResult(
            tenant_id=ip.tenant_id,
            target_ip=ip,
            template=item.resolved.template,
            assignment=item.resolved.assignment,
            kind=item.resolved.kind,
            status=item.outcome.status,
            latency_ms=item.outcome.latency_ms,
            detail=item.outcome.detail,
        )
        for item in items
    ]
    if rows:
        CheckResult.objects.bulk_create(rows)
    return rows


def _serialise(item: RunItem) -> dict:
    rc, oc = item.resolved, item.outcome
    return {
        "template_id": str(rc.template.id),
        "template_name": rc.template.name,
        "kind": rc.kind,
        "source": rc.source,
        "prefix_id": str(rc.prefix.id) if rc.prefix else None,
        "status": oc.status,
        "latency_ms": oc.latency_ms,
        "detail": oc.detail,
    }


def check_now(ip) -> list[dict]:
    """Resolve this IP's effective checks, run them all concurrently in one
    event loop, persist the results + roll up state, and return the outcomes."""
    resolved = resolve_effective_checks(ip)
    if not resolved:
        return []
    items = asyncio.run(_run_all(resolved, ip.ip_address))
    now = timezone.now()
    record_results(ip, items)
    _rollup_states(ip, items, now)
    return [_serialise(item) for item in items]


def _rollup_states(ip, items: list[RunItem], now) -> None:
    """Fold check-now outcomes into ``CheckState`` (status, counters,
    last_checked), log transitions, and fire alerts — the same rollup the
    scheduled worker's ``_finalise`` does, so a manual check is authoritative."""
    from .state import apply_outcome
    from .worker import _cfg, _load_settings

    cfg = _cfg(_load_settings({ip.tenant_id}), ip.tenant_id)
    states: list[CheckState] = []
    transitions: list[StateTransition] = []
    for item in items:
        state, _ = CheckState.objects.get_or_create(
            target_ip=ip,
            template=item.resolved.template,
            defaults={
                "tenant_id": ip.tenant_id,
                "assignment": item.resolved.assignment,
                "kind": item.resolved.kind,
                "status": "unknown",
            },
        )
        overrides = (state.assignment.overrides if state.assignment_id else {}) or {}
        rise = int(overrides.get("rise", item.resolved.template.rise))
        fall = int(overrides.get("fall", item.resolved.template.fall))
        tr = apply_outcome(
            state,
            rise=rise,
            fall=fall,
            outcome=item.outcome,
            now=now,
            stale_after_scans=cfg["stale_after_scans"],
            stale_after_days=cfg["stale_after_days"],
        )
        if tr is not None:
            transitions.append(tr)
        states.append(state)

    if states:
        CheckState.objects.bulk_update(
            states,
            [
                "status",
                "since",
                "last_checked",
                "last_latency_ms",
                "consecutive_success",
                "consecutive_fail",
            ],
            batch_size=500,
        )
    # Stamp last_seen on a reachable result, mirroring the scheduled path.
    if any(item.outcome.status in ("up", "degraded") for item in items):
        type(ip).objects.filter(id=ip.id).update(last_seen=now)
    if transitions:
        StateTransition.objects.bulk_create(transitions, batch_size=500)
        from .alerts import process_transitions

        process_transitions(transitions, now)
