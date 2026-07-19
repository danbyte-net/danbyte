"""RQ worker jobs — run a batch of checks and roll up state.

Two entry points, both designed so a single job runs entirely in one asyncio
event loop and all ORM writes happen *after* the loop:

* ``run_icmp_sweep`` — the fast path for large prefixes. Pings every target in
  the shard with **one** ``icmplib.async_multiping`` call, internally bounded by
  ``MONITORING_CONCURRENCY``. This is what lets a `/15` complete in seconds
  rather than minutes.
* ``run_generic`` — TCP/HTTP/SNMP/… checks run concurrently under a semaphore.

Both honour per-tenant ``MonitoringSettings``: IPs whose status is in the skip
list are marked ``skipped`` (never dialed); the hysteresis state machine gets
the tenant's stale thresholds; ``next_run`` respects the tenant's global switch
and default interval.
"""
from __future__ import annotations

import asyncio
import logging
import socket
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from .checkers import CheckOutcome, get_checker
from .models import CheckResult, CheckState, StateTransition
from .resolver import ResolvedCheck
from .runner import run_resolved
from .state import apply_outcome

log = logging.getLogger("monitoring.worker")

# Fallback policy for a tenant with no MonitoringSettings row yet.
_DEFAULT_CFG = {
    "stale_after_scans": 10,
    "stale_after_days": 0,
    "skip_ids": frozenset(),
    "global_enabled": True,
    "default_interval": 300,
}


def _concurrency() -> int:
    return max(int(getattr(settings, "MONITORING_CONCURRENCY", 100)), 1)


def _sweep_concurrency() -> int:
    """ICMP sweeps fire many cheap echo probes — far higher concurrency than the
    generic-check limit (which guards heavier TCP/HTTP/SSH connections). At 100
    a 2000-host shard takes ~20s; at 2000 it's ~1s.

    Hard-capped to the process's file-descriptor limit: icmplib opens one socket
    per concurrent probe, so asking for more than the fd ceiling raises EMFILE
    ("Too many open files") on every probe — and icmplib's unretrieved asyncio
    task exceptions then flood stderr→syslog (this once wrote a 400 GB syslog and
    filled the disk). We leave headroom for the DB/Redis/file descriptors the
    process also needs, so discovery degrades to slower-but-safe instead of
    melting down when a unit forgets to raise LimitNOFILE.
    """
    import resource

    configured = max(int(getattr(settings, "MONITORING_SWEEP_CONCURRENCY", 2000)), 1)
    try:
        soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft and soft > 0:
            return max(min(configured, soft - 128), 1)
    except Exception:  # noqa: BLE001 — getrlimit unavailable → trust the config
        pass
    return configured


def _load_settings(tenant_ids) -> dict:
    """Per-tenant monitoring policy, keyed by tenant id (with prefetch)."""
    from .models import MonitoringSettings

    out: dict = {}
    qs = MonitoringSettings.objects.filter(
        tenant_id__in=list(tenant_ids)
    ).prefetch_related("skip_ip_statuses")
    for s in qs:
        out[s.tenant_id] = {
            "stale_after_scans": s.stale_after_scans,
            "stale_after_days": s.stale_after_days,
            "skip_ids": frozenset(s.skip_ip_statuses.values_list("id", flat=True)),
            "global_enabled": s.global_enabled,
            "default_interval": s.default_interval_seconds,
            "dns_sync": s.dns_sync_enabled,
            "dns_clear_on_missing": s.dns_clear_on_missing,
            "dns_preserve_if_alive": s.dns_preserve_if_alive,
        }
    return out


def _cfg(settings_map: dict, tenant_id):
    return settings_map.get(tenant_id, _DEFAULT_CFG)


# ─── scheduling helper ────────────────────────────────────────────────────


def effective_interval(state: CheckState, cfg: dict | None = None) -> int | None:
    """Seconds until this check should run again, or ``None`` to stop scheduling
    it (``custom_off``, or ``follow_global`` while the tenant's global switch is
    off)."""
    cfg = cfg or _DEFAULT_CFG
    a = state.assignment
    # Policy-sourced checks (no assignment) follow the two-level frequency model:
    # the per-scope override persisted on the state (from the most-specific
    # MonitoringPolicy that set one), else the tenant's global default.
    if a is None:
        return int(state.interval_seconds or cfg["default_interval"])
    mode = a.schedule_mode
    if mode == "custom_off":
        return None
    if mode == "follow_global":
        if not cfg["global_enabled"]:
            return None
        return int(cfg["default_interval"])
    overrides = (a.overrides if a else {}) or {}
    return int(overrides.get("interval_seconds", state.template.interval_seconds))


def _resolved_from_state(state: CheckState) -> ResolvedCheck:
    return ResolvedCheck(
        template=state.template,
        assignment=state.assignment,
        source="direct" if state.assignment and state.assignment.ip_address_id else "inherited",
        prefix=None,
        _overrides=(state.assignment.overrides if state.assignment else {}) or {},
    )


# ─── ICMP fast path ───────────────────────────────────────────────────────


def _icmp_outcome(host, template) -> CheckOutcome:
    detail = {
        "packets_sent": host.packets_sent,
        "packets_received": host.packets_received,
        "packet_loss": host.packet_loss,
        "avg_rtt": host.avg_rtt,
    }
    if not host.is_alive:
        return CheckOutcome("down", None, detail)
    latency = host.avg_rtt
    threshold = (template.params or {}).get("latency_degraded_ms")
    loss_threshold = (template.params or {}).get("loss_degraded_pct")
    degraded = template.degraded_enabled and (
        (threshold is not None and latency is not None and latency > threshold)
        or (loss_threshold is not None and host.packet_loss * 100 > loss_threshold)
    )
    return CheckOutcome("degraded" if degraded else "up", latency, detail)


async def _multiping(addresses: list[str], count: int, timeout_ms: int):
    from icmplib import async_multiping

    return await async_multiping(
        addresses,
        count=count,
        interval=0.05,
        timeout=max(timeout_ms / 1000, 0.1),
        concurrent_tasks=_sweep_concurrency(),
        privileged=False,
    )


def run_icmp_sweep(state_ids: list[str], timeout_ms: int, count: int = 2) -> dict:
    states = list(
        CheckState.objects.filter(id__in=state_ids)
        .select_related("target_ip", "template", "assignment")
    )
    if not states:
        return {"checked": 0}
    settings_map = _load_settings({s.tenant_id for s in states})
    runnable, skipped = _partition_skipped(states, settings_map)
    _mark_skipped(skipped, settings_map)

    if runnable:
        addresses = [s.target_ip.ip_address for s in runnable]
        try:
            hosts = asyncio.run(_multiping(addresses, count, timeout_ms))
        except Exception as e:  # noqa: BLE001
            log.warning("icmp sweep failed: %s", e)
            outcomes = [CheckOutcome.unknown(f"icmp sweep error: {e}") for _ in runnable]
        else:
            outcomes = [_icmp_outcome(h, s.template) for h, s in zip(hosts, runnable)]
        _finalise(runnable, outcomes, settings_map)
    return {"checked": len(runnable), "skipped": len(skipped)}


# ─── generic path ─────────────────────────────────────────────────────────


def run_generic(state_ids: list[str]) -> dict:
    states = list(
        CheckState.objects.filter(id__in=state_ids)
        .select_related("target_ip", "template", "assignment")
    )
    if not states:
        return {"checked": 0}
    settings_map = _load_settings({s.tenant_id for s in states})
    runnable, skipped = _partition_skipped(states, settings_map)
    _mark_skipped(skipped, settings_map)

    if runnable:
        outcomes = asyncio.run(_run_generic_batch(runnable))
        _finalise(runnable, outcomes, settings_map)
    return {"checked": len(runnable), "skipped": len(skipped)}


async def _run_generic_batch(states: list[CheckState]) -> list[CheckOutcome]:
    sem = asyncio.Semaphore(_concurrency())

    async def _one(state: CheckState) -> CheckOutcome:
        async with sem:
            rc = _resolved_from_state(state)
            if get_checker(rc.kind) is None:
                return CheckOutcome.unknown(f"no checker for kind '{rc.kind}'")
            return await run_resolved(rc, state.target_ip.ip_address)

    return await asyncio.gather(*(_one(s) for s in states))


# ─── skip handling ────────────────────────────────────────────────────────


def _partition_skipped(states, settings_map):
    """Split states into (runnable, skipped) by each tenant's skip-status set."""
    runnable, skipped = [], []
    for s in states:
        skip_ids = _cfg(settings_map, s.tenant_id)["skip_ids"]
        if skip_ids and s.target_ip.status_id in skip_ids:
            skipped.append(s)
        else:
            runnable.append(s)
    return runnable, skipped


def _mark_skipped(states, settings_map) -> None:
    """Mark skipped states without running anything; record the transition the
    first time and reschedule (so a later status change re-enables checking)."""
    if not states:
        return
    now = timezone.now()
    transitions: list[StateTransition] = []
    for state in states:
        old = state.status
        if old != "skipped":
            state.status = "skipped"
            state.since = now
            transitions.append(
                StateTransition(
                    tenant_id=state.tenant_id,
                    target_ip_id=state.target_ip_id,
                    template_id=state.template_id,
                    kind=state.kind,
                    from_status=old,
                    to_status="skipped",
                    at=now,
                    detail={"reason": "ip status in skip list"},
                )
            )
        state.in_flight = False
        state.in_flight_since = None
        interval = effective_interval(state, _cfg(settings_map, state.tenant_id))
        state.next_run = now + timedelta(seconds=interval) if interval else None
    if transitions:
        StateTransition.objects.bulk_create(transitions, batch_size=2000)
    CheckState.objects.bulk_update(
        states,
        ["status", "since", "in_flight", "in_flight_since", "next_run"],
        batch_size=2000,
    )
    if transitions:
        from .alerts import process_transitions

        process_transitions(transitions, now)


# ─── shared finalise ──────────────────────────────────────────────────────


def _finalise(states: list[CheckState], outcomes: list[CheckOutcome], settings_map: dict) -> None:
    now = timezone.now()
    results: list[CheckResult] = []
    transitions: list[StateTransition] = []

    for state, oc in zip(states, outcomes):
        results.append(
            CheckResult(
                tenant_id=state.tenant_id,
                target_ip_id=state.target_ip_id,
                template_id=state.template_id,
                assignment_id=state.assignment_id,
                kind=state.kind,
                status=oc.status,
                latency_ms=oc.latency_ms,
                detail=oc.detail or {},
                timestamp=now,
            )
        )
        overrides = (state.assignment.overrides if state.assignment else {}) or {}
        rise = int(overrides.get("rise", state.template.rise))
        fall = int(overrides.get("fall", state.template.fall))
        cfg = _cfg(settings_map, state.tenant_id)
        tr = apply_outcome(
            state,
            rise=rise,
            fall=fall,
            outcome=oc,
            now=now,
            stale_after_scans=cfg["stale_after_scans"],
            stale_after_days=cfg["stale_after_days"],
        )
        if tr is not None:
            transitions.append(tr)

        state.in_flight = False
        state.in_flight_since = None
        interval = effective_interval(state, cfg)
        state.next_run = now + timedelta(seconds=interval) if interval else None

    CheckResult.objects.bulk_create(results, batch_size=2000)
    if transitions:
        StateTransition.objects.bulk_create(transitions, batch_size=2000)
    CheckState.objects.bulk_update(
        states,
        [
            "status",
            "since",
            "last_checked",
            "last_latency_ms",
            "consecutive_success",
            "consecutive_fail",
            "in_flight",
            "in_flight_since",
            "next_run",
        ],
        batch_size=2000,
    )

    # Stamp last_seen on every IP that was reachable this run.
    seen_ids = {s.target_ip_id for s in states if s.status in ("up", "degraded")}
    if seen_ids:
        from api.models import IPAddress

        IPAddress.objects.filter(id__in=seen_ids).update(last_seen=now)

    if transitions:
        from .alerts import process_transitions

        process_transitions(transitions, now)
    _sync_dns(states, settings_map)


def ingest_results(outcome_by_id: dict, *, engine_id=None, tenant_id=None) -> int:
    """Fold externally-run check outcomes into state — the single seam a remote
    **Outpost** reports through, reusing the exact local finalise path
    (hysteresis, CheckResult/StateTransition, alerts, DNS, last_seen).

    ``outcome_by_id`` maps ``CheckState`` id (str) → ``CheckOutcome``. Only
    **claimed** (``in_flight``) states are accepted — a report for a state the
    engine wasn't handed is ignored — optionally scoped to ``engine_id`` /
    ``tenant_id``. Returns the number ingested.
    """
    if not outcome_by_id:
        return 0
    qs = CheckState.objects.filter(
        id__in=list(outcome_by_id), in_flight=True
    ).select_related("target_ip", "template", "assignment")
    if engine_id is not None:
        qs = qs.filter(engine_id=engine_id)
    if tenant_id is not None:
        qs = qs.filter(tenant_id=tenant_id)
    states = list(qs)
    if not states:
        return 0
    outcomes = [outcome_by_id[str(s.id)] for s in states]
    settings_map = _load_settings({s.tenant_id for s in states})
    _finalise(states, outcomes, settings_map)
    return len(states)


# ─── reverse-DNS enrichment ───────────────────────────────────────────────


def _ptr_sockaddr(addr: str):
    return (addr, 0, 0, 0) if ":" in addr else (addr, 0)


async def _resolve_ptrs(addresses: list[str]) -> dict:
    """Reverse-resolve a list of IPs to hostnames (or None when there's no
    PTR), bounded by the concurrency limit. Uses the system resolver async."""
    loop = asyncio.get_running_loop()
    sem = asyncio.Semaphore(_concurrency())

    async def _one(addr: str):
        async with sem:
            try:
                host, _ = await asyncio.wait_for(
                    loop.getnameinfo(_ptr_sockaddr(addr), socket.NI_NAMEREQD),
                    timeout=3,
                )
                return addr, host
            except (socket.gaierror, OSError, asyncio.TimeoutError):
                return addr, None

    return dict(await asyncio.gather(*(_one(a) for a in addresses)))


def _sync_dns(states: list[CheckState], settings_map: dict) -> None:
    """For tenants with DNS sync on, resolve each checked IP's PTR and update
    ``IPAddress.dns_name`` per the preserve/clear policy."""
    targets: dict = {}  # ip_id -> (ip, cfg)
    reachable: dict = {}  # ip_id -> bool (any check up/degraded this run)
    for s in states:
        cfg = _cfg(settings_map, s.tenant_id)
        if not cfg.get("dns_sync"):
            continue
        targets.setdefault(s.target_ip_id, (s.target_ip, cfg))
        if s.status in ("up", "degraded"):
            reachable[s.target_ip_id] = True
    if not targets:
        return

    addresses = [ip.ip_address for ip, _ in targets.values()]
    try:
        resolved = asyncio.run(_resolve_ptrs(addresses))
    except Exception as e:  # noqa: BLE001 — DNS must never fail the check run
        log.warning("dns sync failed: %s", e)
        return

    to_update = []
    for ip_id, (ip, cfg) in targets.items():
        host = resolved.get(ip.ip_address)
        current = ip.dns_name or ""
        if host:
            target = host
        elif cfg["dns_preserve_if_alive"] and reachable.get(ip_id):
            continue  # transient lookup failure on a live host — keep the name
        else:
            target = "" if cfg["dns_clear_on_missing"] else current
        if target != current:
            ip.dns_name = target
            to_update.append(ip)

    if to_update:
        from api.models import IPAddress

        IPAddress.objects.bulk_update(to_update, ["dns_name"], batch_size=1000)
