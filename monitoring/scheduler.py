"""Materialisation + dispatch.

**Materialisation** (``materialise_states``) turns assignments into concrete
``CheckState`` rows - one per (target IP, template) effective check - by running
the resolver over each candidate IP. It runs *periodically*, not per tick, so
the minute-resolution dispatcher never has to re-walk the CIDR tree: for a huge
prefix the expensive resolution is amortised here, and the dispatcher just reads
flat ``CheckState`` rows by ``next_run``.

**Dispatch** (``dispatch``) selects due states and enqueues worker jobs. ICMP
states are grouped by (timeout, count) and sharded into large multiping batches;
everything else is sharded into smaller generic batches. Each shard is one RQ
job, so fan-out parallelises across worker processes - the second half of the
large-prefix performance story (multiping being the first).
"""
from __future__ import annotations

import logging
from datetime import timedelta

import django_rq
from django.conf import settings
from django.db import models, transaction
from django.utils import timezone

from api.models import IPAddress
from core.models import Tenant

from .engine_drivers import driver_claims_kind, driver_for, engine_usable
from .engines import engine_for_ip
from .models import (
    CheckAssignment, CheckState, MonitoringEngine, MonitoringPolicy,
    MonitoringSettings,
)
from .resolver import PrefixIndex, resolve_effective_checks
from .worker import effective_interval, run_generic, run_icmp_sweep

log = logging.getLogger("monitoring.scheduler")


def _icmp_shard_size() -> int:
    return max(int(getattr(settings, "MONITORING_SHARD_SIZE", 2000)), 1)


def _generic_shard_size() -> int:
    return max(int(getattr(settings, "MONITORING_GENERIC_SHARD_SIZE", 200)), 1)


def _chunk(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


# ─── materialisation ──────────────────────────────────────────────────────


def _candidate_ips(tenant: Tenant) -> set:
    """Every IP in the tenant that some assignment could touch: directly
    targeted IPs, plus IPs enclosed by a prefix assignment."""
    ips: set = set()
    direct = CheckAssignment.objects.filter(
        tenant=tenant, ip_address__isnull=False
    ).values_list("ip_address_id", flat=True)
    ips.update(direct)

    prefix_assignments = (
        CheckAssignment.objects.filter(tenant=tenant, prefix__isnull=False)
        .select_related("prefix")
    )
    # The tenant's addresses once, tested against every assignment's
    # prefix - not one load of every address per assignment (#198).
    nets = []
    for a in prefix_assignments:
        if not a.apply_to_children:
            continue
        net = a.prefix.network
        if net is not None:
            nets.append((a.prefix.vrf_id, net))
    if nets:
        import ipaddress as _ip

        rows = IPAddress.objects.filter(tenant=tenant).values_list("id", "ip_address", "vrf_id")
        for ip_id, addr, vrf_id in rows:
            try:
                parsed = _ip.ip_address(addr)
            except (ValueError, TypeError):
                continue
            for net_vrf, net in nets:
                if net_vrf == vrf_id and parsed.version == net.version and parsed in net:
                    ips.add(ip_id)
                    break
    if MonitoringPolicy.objects.filter(tenant=tenant, enabled=True).exists():
        ips.update(IPAddress.objects.filter(tenant=tenant).values_list("id", flat=True))
    return ips


def materialise_ip(ip: IPAddress, now=None, prefix_index=None) -> int:
    """Sync ``CheckState`` rows for one IP to its current effective checks.
    Returns the number of effective checks. New states are scheduled to run
    immediately; stale states (check no longer effective) are deleted.
    ``prefix_index`` is the tenant's :class:`PrefixIndex` when a caller
    materialises many addresses in one pass."""
    now = now or timezone.now()
    resolved = resolve_effective_checks(ip, prefix_index)
    keep_template_ids = set()
    engine = engine_for_ip(ip) if resolved else None
    for rc in resolved:
        keep_template_ids.add(rc.template.id)
        # Persist the resolved per-target frequency override for policy checks
        # (assignment-sourced checks keep their own schedule → leave null).
        interval_override = (
            rc._overrides.get("interval_seconds") if rc.assignment is None else None
        )
        state, created = CheckState.objects.update_or_create(
            target_ip=ip,
            template=rc.template,
            defaults={
                "tenant_id": ip.tenant_id,
                "assignment": rc.assignment,
                "kind": rc.kind,
                "engine": engine,
                "interval_seconds": interval_override,
                # Resolved here so the lane and the beat can select on a
                # column rather than re-resolving overrides per tick.
                "interval_ms": rc.interval_ms,
            },
        )
        if created:
            state.next_run = now
            state.save(update_fields=["next_run"])
    CheckState.objects.filter(target_ip=ip).exclude(
        template_id__in=keep_template_ids
    ).delete()
    return len(resolved)


def materialise_states(tenant: Tenant | None = None, now=None) -> dict:
    now = now or timezone.now()
    tenants = [tenant] if tenant else list(Tenant.objects.all())
    total_ips = 0
    total_checks = 0
    for t in tenants:
        ids = _candidate_ips(t)
        total_ips += len(ids)
        index = PrefixIndex(t.id) if ids else None
        for ip in IPAddress.objects.filter(id__in=ids).select_related(
            "tenant", "prefix", "assigned_device"
        ):
            total_checks += materialise_ip(ip, now=now, prefix_index=index)
    return {"tenants": len(tenants), "ips": total_ips, "effective_checks": total_checks}


# ─── reaper ───────────────────────────────────────────────────────────────


def _inflight_deadline_seconds() -> int:
    # A healthy run clears ``in_flight`` within seconds; anything still claimed
    # this long after it started is from a dead/restarted worker.
    return int(getattr(settings, "MONITORING_INFLIGHT_DEADLINE_SECONDS", 600))


def reap_stale_in_flight(now=None) -> dict:
    """Reclaim states orphaned by a dead/restarted worker.

    A worker only clears ``in_flight`` when a job finishes; if it dies mid-run,
    the flag is stuck True forever and the dispatcher (which skips
    ``in_flight=True``) never retries - the check stays ``unknown``. This resets
    those rows so the next dispatch picks them up. Rows with a NULL
    ``in_flight_since`` (claimed before this field existed) are always reclaimed.
    """
    now = now or timezone.now()
    cutoff = now - timedelta(seconds=_inflight_deadline_seconds())
    stuck = CheckState.objects.filter(in_flight=True).filter(
        models.Q(in_flight_since__isnull=True) | models.Q(in_flight_since__lt=cutoff)
    )
    n = stuck.update(in_flight=False, in_flight_since=None, next_run=now)
    if n:
        log.warning("reaped %s stale in-flight check states", n)
    return {"reaped": n}


# ─── engine health (issue #154) ───────────────────────────────────────────


def check_engine_health(now=None) -> dict:
    """Flag remote engines that stopped polling.

    A remote engine with assigned checks that hasn't been seen within
    ~3× its poll interval (min 3 minutes) is marked stale: ``stale_since`` is
    stamped and a one-off notification goes to the tenant's channels. Recovery
    clears the stamp and notifies again. Engines with no assigned checks are
    ignored (a freshly-created, never-enrolled Outpost shouldn't page anyone).

    Runs on every dispatcher tick - cheap: one query over the handful of
    remote engines + one count over their states.
    """
    from .notify import notify_event

    now = now or timezone.now()
    flagged = recovered = 0
    engines = MonitoringEngine.objects.filter(enabled=True).exclude(
        kind=MonitoringEngine.LOCAL
    )
    for eng in engines:
        # An engine whose driver cannot answer right now - the tenant switched
        # its integration off, the connection is gone - is not unreachable, it
        # is not being asked. Calling that an outage pages somebody for doing
        # exactly what the switch is for.
        if not engine_usable(eng):
            if eng.stale_since:
                eng.stale_since = None
                eng.save(update_fields=["stale_since"])
            continue
        assigned = CheckState.objects.filter(engine=eng).count()
        if assigned == 0:
            # Nothing depends on it - quietly clear any leftover flag.
            if eng.stale_since:
                eng.stale_since = None
                eng.save(update_fields=["stale_since"])
            continue
        # Configurable per tenant (#129); 0 = automatic 3x poll interval.
        minutes = MonitoringSettings.for_tenant(
            eng.tenant
        ).engine_offline_after_minutes
        if minutes:
            threshold = timedelta(minutes=minutes)
        elif driver_for(eng) is not None:
            # A driver has no heartbeat: it is seen each time it answers, and
            # it answers on its checks' cadence. Judging it by an Outpost's
            # poll interval (15 s here, so a 3 minute threshold) against
            # checks that run every 5 minutes flagged it stale two minutes out
            # of every five, with a notification each way.
            shortest = (
                CheckState.objects.filter(engine=eng)
                .aggregate(m=models.Min("interval_seconds"))["m"]
                or 300
            )
            threshold = timedelta(seconds=max(3 * shortest, 180))
        else:
            threshold = timedelta(
                seconds=max(3 * (eng.poll_interval_seconds or 60), 180)
            )
        # Never-seen engines age from creation, so a just-enrolled Outpost
        # gets the same grace window before it's called unreachable.
        basis = eng.last_seen_at or eng.created_at
        is_stale = basis is None or (now - basis) > threshold
        if is_stale and not eng.stale_since:
            eng.stale_since = now
            eng.save(update_fields=["stale_since"])
            flagged += 1
            stalled = CheckState.objects.filter(
                engine=eng, next_run__lte=now
            ).count()
            log.warning(
                "engine %s unreachable - %s checks stalled", eng.name, stalled
            )
            when = f"{basis:%Y-%m-%d %H:%M} UTC" if basis else "enrollment"
            notify_event(
                eng.tenant_id,
                f"Monitoring engine '{eng.name}' unreachable",
                f"No contact since {when} - {stalled} check(s) are overdue "
                "and will not run until the engine reconnects.",
                {
                    "type": "engine_stale",
                    "engine_id": str(eng.id),
                    "engine": eng.name,
                    "last_seen_at": basis.isoformat() if basis else None,
                    "stalled_checks": stalled,
                },
            )
        elif not is_stale and eng.stale_since:
            outage = now - eng.stale_since
            eng.stale_since = None
            eng.save(update_fields=["stale_since"])
            recovered += 1
            log.info("engine %s recovered after %s", eng.name, outage)
            notify_event(
                eng.tenant_id,
                f"Monitoring engine '{eng.name}' recovered",
                f"Back in contact after {int(outage.total_seconds() // 60)} "
                "minute(s); stalled checks will resume.",
                {
                    "type": "engine_recovered",
                    "engine_id": str(eng.id),
                    "engine": eng.name,
                    "outage_seconds": int(outage.total_seconds()),
                },
            )
    return {"flagged": flagged, "recovered": recovered}


# ─── dispatch ─────────────────────────────────────────────────────────────


def dispatch_drivers(now=None) -> int:
    """Let every driver-backed engine claim the states it answers for.

    Danbyte does not run a driver's checks, so there is nothing to enqueue -
    the driver reaches its own system and folds what it finds through
    ``ingest_results``. A driver with no ``claim`` yet (one that is still only
    a connection) simply reports nothing, which is the correct behaviour while
    it is being built.

    One driver failing never stops the others, or the local dispatch below it:
    a monitoring loop that stops because one integration is sulking is worse
    than the integration being down.
    """
    now = now or timezone.now()
    total = 0
    engines = MonitoringEngine.objects.filter(enabled=True).exclude(
        kind__in=(MonitoringEngine.LOCAL, MonitoringEngine.REMOTE)
    )
    for eng in engines:
        if not engine_usable(eng):
            continue
        driver = driver_for(eng)
        claim = getattr(driver, "claim", None)
        if claim is None:
            continue
        try:
            total += claim(eng, now) or 0
        except Exception:
            log.exception("engine driver %r (%s) failed to claim", eng.name, eng.kind)
    return total


def _unclaimed_driver_states(now) -> list:
    """Due states on a driver engine that its driver does not answer for.

    Which kinds a driver claims is the driver's to say, so the final word is a
    Python pass. The query first drops the ones matching the default rule -
    a Zabbix engine's ``zabbix`` states, which is nearly all of them - so a
    thousand-host engine does not haul its whole due batch into memory every
    tick just to discard it.

    The prefilter assumes a driver always claims the kind named after it. A
    driver that disowned its own kind would strand those states, but that kind
    exists *because* the driver registered it, so there is nothing to disown.
    """
    states = list(
        CheckState.objects.filter(next_run__lte=now, in_flight=False)
        .exclude(engine__isnull=True)
        .exclude(engine__kind__in=(MonitoringEngine.LOCAL, MonitoringEngine.REMOTE))
        .exclude(kind=models.F("engine__kind"))
        .select_related("template", "assignment", "engine")
    )
    return [s for s in states if not driver_claims_kind(s.engine, s.kind)]


def claim_states(due: list, now) -> list:
    """Claim these due states for exactly one dispatcher, and return the ones
    this caller won.

    Selecting due rows and then writing ``in_flight=True`` over them is two
    statements: two dispatchers (the beat and a "Check now" click, or an
    Outpost's retried pull) could both select the same rows before either
    write landed, and both would run them (#221). The claim is taken under
    ``SELECT ... FOR UPDATE SKIP LOCKED`` and re-checks ``in_flight=False``
    on the locked row, so a row another dispatcher is claiming is skipped,
    and one it has already claimed no longer matches.
    """
    if not due:
        return []
    by_id = {s.id: s for s in due}
    with transaction.atomic():
        won = set(
            CheckState.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(pk__in=list(by_id), in_flight=False)
            .values_list("pk", flat=True)
        )
        claimed = [s for pk, s in by_id.items() if pk in won]
        for s in claimed:
            s.in_flight = True
            s.in_flight_since = now
            s.next_run = now + timedelta(seconds=effective_interval(s) or 300)
        CheckState.objects.bulk_update(
            claimed, ["in_flight", "in_flight_since", "next_run"], batch_size=2000
        )
    lost = len(due) - len(claimed)
    if lost:
        log.info("claim: %d due check(s) already taken by another dispatcher", lost)
    return claimed


def dispatch(now=None, sync: bool = False) -> dict:
    """Enqueue worker jobs for every due check. ``sync=True`` runs them inline
    (for tests / a no-worker box) instead of via RQ."""
    now = now or timezone.now()
    # Engine health first - if an Outpost died, flag it and notify instead of
    # quietly dispatching zero of its checks for the Nth tick (issue #154).
    check_engine_health(now)
    # Reclaim anything a crashed worker left claimed, then dispatch as usual.
    reaped = reap_stale_in_flight(now)["reaped"]
    # Give every driver kind a chance to claim its own states first. A driver
    # answers for checks Danbyte does not run, so it materialises and claims
    # them itself rather than being handed a shard of work.
    claimed = dispatch_drivers(now)
    # Only LOCAL-engine work runs on the core's RQ workers. Remote (Outpost)
    # states are left unclaimed for their Outpost to pull via /api/outpost/work,
    # and driver states were just handled above.
    due = (
        CheckState.objects.filter(next_run__lte=now, in_flight=False)
        .filter(
            models.Q(engine__isnull=True)
            | models.Q(engine__kind=MonitoringEngine.LOCAL)
        )
        .select_related("template", "assignment")
    )
    # Sub-minute checks belong to the fast lane while it is alive; when it is
    # not, they run here at their fallback interval rather than not at all.
    from .fastlane import lane_alive

    if lane_alive(now):
        due = due.filter(models.Q(interval_ms__isnull=True) | models.Q(fast_owned=False))
    due = list(due)
    # Plus the orphans: a target bound to a driver engine still has its other
    # checks, and a driver only answers its own kind. Nobody was claiming an
    # ICMP ping on a Zabbix-bound device, so it simply never ran - which reads
    # as a monitoring system quietly going blind. The core runs them.
    due += _unclaimed_driver_states(now)
    if not due:
        return {"due": 0, "jobs": 0, "reaped": reaped, "claimed": claimed}

    # Claim the due states up front so a second dispatcher can't run them
    # too; stamp the claim time (the reaper, and the worker's write guard,
    # use it) and push next_run forward tentatively. The worker resets
    # in_flight on completion; if it dies, the reaper reclaims the row once
    # the in-flight deadline passes.
    due = claim_states(due, now)
    if not due:
        return {"due": 0, "jobs": 0, "reaped": reaped, "claimed": claimed}

    queue = None if sync else django_rq.get_queue("default")
    jobs = 0

    # ICMP: group by (timeout, count) → big multiping shards.
    icmp = [s for s in due if s.kind == "icmp"]
    groups: dict[tuple[int, int], list[str]] = {}
    for s in icmp:
        key = (int(s.template.timeout_ms), int((s.template.params or {}).get("count", 2)))
        groups.setdefault(key, []).append(str(s.id))
    for (timeout_ms, count), ids in groups.items():
        for shard in _chunk(ids, _icmp_shard_size()):
            if sync:
                run_icmp_sweep(shard, timeout_ms, count)
            else:
                queue.enqueue(run_icmp_sweep, shard, timeout_ms, count)
            jobs += 1

    # Everything else: smaller generic shards.
    others = [str(s.id) for s in due if s.kind != "icmp"]
    for shard in _chunk(others, _generic_shard_size()):
        if sync:
            run_generic(shard)
        else:
            queue.enqueue(run_generic, shard)
        jobs += 1

    # `claimed` on both exits, not just the empty one: a caller reading the
    # tick's numbers should not have to know that a driver-only tick reports a
    # different shape from a busy one.
    return {"due": len(due), "jobs": jobs, "reaped": reaped, "claimed": claimed}
