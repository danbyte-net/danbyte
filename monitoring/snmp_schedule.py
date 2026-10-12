"""Scheduled SNMP polling from the core (#284 P4b).

A tenant opts in with **Poll devices every** (``MonitoringSettings.
snmp_poll_interval_minutes``, off by default). ``dispatch_snmp_polls`` runs on
the scheduler every five minutes and enqueues one RQ job per SNMP target - a
device or a VM (``snmp_target``) - that is due, so the interface samples
behind utilisation and live traffic, and the learned MACs, stay current
without anyone pressing Poll now.

Which targets:

* one per stack - its owner, the member Poll now polls (#148);
* every device, and the VMs that are SNMP targets (``snmp_target.candidates``);
* only targets the core polls: one whose resolved engine is an Outpost is the
  agent's to poll (#325). A driver engine such as Zabbix answers its own
  check kind and nothing else, so a target bound to one polls from the core,
  as Poll now and ``poll_snmp`` do;
* only targets last polled longer ago than the interval (a never-polled one
  is due at once).

Spreading: each tick takes at most ``ceil(devices × tick / interval)`` of the
due devices, oldest poll first, so a tenant's estate is polled across the
whole interval instead of all at once on the first tick after it is switched
on, and the polls stay spread from then on.

Each enqueued target is claimed in Redis until shortly before it is next
due. The claim keeps a slow job from being enqueued twice and stops a target
that cannot be polled (no profile, no address) from being retried every tick.
The job reloads the target by kind, id and tenant, re-checks the interval and
the engine, and shares the Refresh MACs single-flight key, so a manual
refresh and a scheduled poll never read the same device at once.
"""
from __future__ import annotations

import logging
import math
import uuid
from datetime import timedelta

from django.utils import timezone

log = logging.getLogger("monitoring.snmp_schedule")

#: The scheduler's beat for ``dispatch_snmp_polls`` (``core.schedule``).
TICK_SECONDS = 5 * 60
#: A poll's RQ timeout - the full MAC read's budget, as Refresh MACs.
JOB_TIMEOUT = 15 * 60


def claim_key(device_id) -> str:
    return f"snmp-poll:claim:{device_id}"


def _conn():
    import django_rq

    return django_rq.get_connection("default")


def _queue():
    import django_rq

    return django_rq.get_queue("default")


def _interval_by_tenant() -> dict:
    """``{tenant_id: minutes}`` for active tenants that switched polling on."""
    from .models import MonitoringSettings

    return dict(
        MonitoringSettings.objects.filter(
            snmp_poll_interval_minutes__gt=0, tenant__is_active=True
        ).values_list("tenant_id", "snmp_poll_interval_minutes")
    )


def pollable(tenant) -> list:
    """Every SNMP target the tenant has, one per stack: stack owners,
    standalone devices and SNMP-target VMs (``snmp_target.candidates``),
    whoever polls them."""
    from .snmp_target import DEVICE, VM, SnmpTarget
    from .snmp_target import candidates as of_kind
    from .vc_stack import stacks

    devices = list(
        of_kind(tenant, DEVICE).only(
            "id", "tenant_id", "site_id", "location_id", "virtual_chassis_id"
        )
    )
    owners = {
        vc: members[0].id
        for vc, members in stacks(
            {d.virtual_chassis_id for d in devices}, tenant.id
        ).items()
        if members
    }
    targets = [
        SnmpTarget(DEVICE, d) for d in devices
        if not d.virtual_chassis_id or owners.get(d.virtual_chassis_id) == d.id
    ]
    targets += [
        SnmpTarget(VM, v)
        for v in of_kind(tenant, VM).only("id", "tenant_id", "site_id", "cluster_id")
    ]
    return targets


def split_by_poller(tenant, targets) -> tuple[list, list]:
    """``(core, remote)``: the targets the core polls, and those an enabled
    Outpost does."""
    from .engines import engines_for_targets
    from .models import MonitoringEngine

    engines = engines_for_targets(tenant, targets)
    core, remote = [], []
    for t in targets:
        (remote if _outpost(engines[t.key], MonitoringEngine) else core).append(t)
    return core, remote


def candidates(tenant) -> list:
    """The SNMP targets the core polls for ``tenant``."""
    return split_by_poller(tenant, pollable(tenant))[0]


def _outpost(engine, model) -> bool:
    """An enabled Outpost polls the target itself (``views._snmp_outpost``)."""
    return engine.kind == model.REMOTE and engine.enabled


def due_targets(tenant, interval_minutes: int, now=None) -> tuple[list, int]:
    """``(due, total)``: the candidate targets due a poll, oldest poll first
    (never polled before all), and how many candidates there are."""
    from django.db.models import Q

    from .models import DeviceSnmp

    now = now or timezone.now()
    pool = candidates(tenant)
    if not pool:
        return [], 0
    last: dict = {}
    for device_id, vm_id, polled_at in DeviceSnmp.objects.filter(
        Q(device_id__in=[t.id for t in pool if not t.is_vm])
        | Q(vm_id__in=[t.id for t in pool if t.is_vm]),
        tenant=tenant,
    ).values_list("device_id", "vm_id", "polled_at"):
        last[device_id or vm_id] = polled_at
    # Half a tick of slack: a target polled just after the last tick is due
    # on the tick one interval later, not the one after that.
    cutoff = now - timedelta(minutes=interval_minutes) + timedelta(seconds=TICK_SECONDS // 2)
    epoch = now - timedelta(days=36500)
    due = [t for t in pool if last.get(t.id) is None or last[t.id] <= cutoff]
    due.sort(key=lambda t: (last.get(t.id) or epoch, str(t.id)))
    return due, len(pool)


def tick_budget(total: int, interval_minutes: int) -> int:
    """How many polls one tick may start: the share of the estate one tick
    covers, at least one."""
    if total <= 0 or interval_minutes <= 0:
        return 0
    return max(1, math.ceil(total * TICK_SECONDS / (interval_minutes * 60)))


def _claim_ttl(interval_minutes: int) -> int:
    return max(60, interval_minutes * 60 - TICK_SECONDS // 2)


def dispatch(now=None) -> dict:
    """Enqueue every tenant's due polls for this tick. Returns counts for the
    run log: ``{tenants, enqueued, due, claimed}``."""
    intervals = _interval_by_tenant()
    out = {"tenants": 0, "enqueued": 0, "due": 0, "claimed": 0}
    if not intervals:
        out["enabled"] = False
        return out
    from core.models import Tenant

    from .mac_jobs import lock_key

    conn = _conn()
    queue = _queue()
    for tenant in Tenant.objects.filter(pk__in=list(intervals)):
        minutes = intervals[tenant.pk]
        due, total = due_targets(tenant, minutes, now)
        out["tenants"] += 1
        out["due"] += len(due)
        if not due:
            continue
        budget = tick_budget(total, minutes)
        ttl = _claim_ttl(minutes)
        # One round trip for every due target's claim and refresh lock.
        pipe = conn.pipeline()
        for d in due:
            pipe.exists(claim_key(d.id))
            pipe.exists(lock_key(d.id))
        flags = pipe.execute()
        for i, d in enumerate(due):
            if budget <= 0:
                break
            if flags[2 * i] or flags[2 * i + 1]:
                out["claimed"] += 1
                continue
            if not conn.set(claim_key(d.id), "1", nx=True, ex=ttl):
                out["claimed"] += 1
                continue
            queue.enqueue(
                poll_scheduled, str(d.id), str(tenant.pk), d.kind,
                job_timeout=JOB_TIMEOUT,
            )
            out["enqueued"] += 1
            budget -= 1
    return out


def poll_scheduled(device_id, tenant_id, kind="device") -> str:
    """The RQ job: poll one target on the schedule - ``device_id`` names a
    device, or a VM when ``kind`` is ``"vm"`` (jobs enqueued before VMs were
    scheduled carry no kind). Returns a status for the worker log. Everything
    is re-read here - the tenant may have switched polling off, or the target
    moved to an Outpost, since the enqueue."""
    from core.models import Tenant

    from .engines import engine_for_target
    from .mac_jobs import _release, lock_key
    from .models import MonitoringEngine, MonitoringSettings
    from .snmp_poll import poll_target
    from .snmp_target import load

    tenant = Tenant.objects.filter(pk=tenant_id, is_active=True).first()
    if tenant is None:
        return "skipped"
    minutes = (
        MonitoringSettings.objects.filter(tenant=tenant)
        .values_list("snmp_poll_interval_minutes", flat=True)
        .first()
    )
    if not minutes:
        return "off"
    target = load(kind, device_id, tenant)
    if target is None or target.owner().id != target.id:
        return "skipped"
    if _outpost(engine_for_target(target), MonitoringEngine):
        return "remote"
    run_id = uuid.uuid4().hex
    try:
        if not _conn().set(lock_key(target.id), run_id, nx=True, ex=JOB_TIMEOUT):
            return "busy"  # a Refresh MACs run is reading it now
    except Exception as exc:  # noqa: BLE001 - poll anyway; the claim still spaces it
        log.warning("scheduled poll %s: no single-flight lock: %s", device_id, exc)
        run_id = None
    try:
        state, reason = poll_target(target, tenant)
    except Exception:  # noqa: BLE001 - one target must not fail the worker
        log.exception("scheduled SNMP poll of %s failed", device_id)
        return "error"
    finally:
        if run_id:
            _release(target.id, run_id)
    if reason is not None:
        return reason
    return "polled" if state is not None and state.reachable else "unreachable"
