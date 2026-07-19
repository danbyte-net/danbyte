"""Subnet discovery (M12) + stale auto-cleanup (M13).

Both are **opt-in** and conservative:

* **Discovery** ICMP-sweeps prefixes a tenant flagged ``auto_discover`` (and only
  when ``MonitoringSettings.discovery_enabled``), creating an ``IPAddress`` for
  every responder not already recorded. Marked ``discovered=True`` so cleanup can
  tell auto-created rows from user-entered ones. Bounded by
  ``discovery_min_prefix_length`` so nobody accidentally sweeps a /8.
* **Cleanup** deletes **discovered** IPs that have been unreachable longer than
  ``cleanup_after_days`` — user-created IPs are never touched.

IPv4 only: a meaningful ICMP sweep of a large IPv6 range is infeasible.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import uuid
from datetime import timedelta

from django.conf import settings as dj_settings
from django.db import IntegrityError
from django.db.models import Q
from django.utils import timezone

log = logging.getLogger("monitoring.discovery")


def _shard_size() -> int:
    return getattr(dj_settings, "MONITORING_SHARD_SIZE", 2000)


def auto_discovered_status(tenant):
    """The tenant's "Auto-discovered" IP status, created on first use.

    Not seeded at install (zero-pre-filled-data): it's a normal, fully editable
    Status row, created the first time discovery finds a new responder. New
    discovered IPs get this status so a human must review and promote them to a
    real status (Active, etc.) — discovery never silently marks hosts active.
    """
    from api.models import Status

    status, _ = Status.objects.get_or_create(
        tenant=tenant,
        slug="auto-discovered",
        defaults={
            "name": "Auto-discovered",
            "color": "#f59e0b",  # amber — "needs review"
            "is_available": False,
            "available_to": ["ipaddress"],
            "description": "Found by subnet discovery — review and set a real "
            "status (e.g. Active).",
        },
    )
    return status


def _sweep_hosts(hosts: list[str], cidr: str = "") -> list[str]:
    """ICMP-sweep a list of host strings (sharded) → the alive addresses."""
    from .worker import _multiping

    alive: list[str] = []
    for i in range(0, len(hosts), _shard_size()):
        shard = hosts[i : i + _shard_size()]
        try:
            results = asyncio.run(_multiping(shard, count=1, timeout_ms=1000))
        except Exception as e:  # noqa: BLE001 — a failed shard mustn't abort the rest
            log.warning("discovery sweep failed for %s: %s", cidr or "shard", e)
            continue
        alive.extend(h.address for h in results if h.is_alive)
    return alive


def _create_for_alive(prefix, alive: list[str], now) -> int:
    """Create auto-discovered IPs for responders not already recorded. Safe to
    run concurrently across shard jobs — disjoint host sets, and the unique
    constraint + IntegrityError guard cover any race with a user-created row."""
    from api.models import IPAddress

    if not alive:
        return 0
    existing = set(
        IPAddress.objects.filter(prefix=prefix, ip_address__in=alive).values_list(
            "ip_address", flat=True
        )
    )
    created = 0
    status = None  # created lazily only when there's a new IP to assign it to
    for addr in alive:
        if addr in existing:
            continue
        if status is None:
            status = auto_discovered_status(prefix.tenant)
        try:
            IPAddress.objects.create(
                tenant=prefix.tenant,
                vrf=prefix.vrf,
                prefix=prefix,
                ip_address=addr,
                status=status,
                discovered=True,
                last_seen=now,
                description="Auto-discovered",
            )
            created += 1
        except IntegrityError:
            # Raced with another creator (or a unique-constraint edge); skip.
            continue
    return created


def discover_prefix(prefix, settings, now=None) -> dict:
    """Sweep one prefix and create IPs for new responders. Returns counts.
    Used inline (small prefixes) and by the periodic timer."""
    now = now or timezone.now()
    try:
        net = ipaddress.ip_network(prefix.cidr, strict=False)
    except ValueError:
        return {"skipped": "bad_cidr", "created": 0}

    # IPv6 can only be swept when small enough to enumerate (a /64 is 2⁶⁴
    # hosts). IPv4 keeps its existing size gate + sharding for big blocks.
    from api.models import is_enumerable

    if net.version == 6 and not is_enumerable(net):
        return {"skipped": "too_large", "created": 0}
    if net.prefixlen < settings.discovery_min_prefix_length:
        return {"skipped": "too_large", "created": 0}

    hosts = [str(h) for h in net.hosts()]
    if not hosts:
        return {"skipped": "no_hosts", "created": 0}

    alive = _sweep_hosts(hosts, prefix.cidr)
    created = _create_for_alive(prefix, alive, now)

    # Stamp the sweep time so run_discovery can honour the interval.
    type(prefix).objects.filter(pk=prefix.pk).update(last_discovered_at=now)
    return {"scanned": len(hosts), "responders": len(alive), "created": created}


def _host_total(net) -> int:
    """Number of host addresses net.hosts() will yield (excludes net/broadcast
    for prefixes shorter than /31)."""
    return net.num_addresses if net.prefixlen >= 31 else max(net.num_addresses - 2, 0)


# ─── Live progress (Redis-backed, ephemeral) ─────────────────────────────────
# A discovery run's progress lives in a Redis hash so the UI can poll it while
# shards drain across the worker pool. Keyed by an opaque run id; self-expiring.
_RUN_TTL = 3600


def _run_key(run_id: str) -> str:
    return f"disc:run:{run_id}"


def _run_conn():
    import django_rq

    return django_rq.get_connection("default")


def _bump_run(run_id, *, hosts: int, responders: int, created: int) -> None:
    """One shard finished — atomically advance the run's counters and flip
    ``done`` once every shard has reported. Never raises into the job."""
    try:
        conn = _run_conn()
        key = _run_key(run_id)
        pipe = conn.pipeline()
        pipe.hincrby(key, "shards_done", 1)
        pipe.hincrby(key, "hosts_done", hosts)
        pipe.hincrby(key, "responders", responders)
        pipe.hincrby(key, "created", created)
        shards_done = pipe.execute()[0]
        total = int(conn.hget(key, "shards_total") or 0)
        if total and shards_done >= total:
            conn.hset(key, "done", 1)
        conn.expire(key, _RUN_TTL)
    except Exception as e:  # noqa: BLE001 — progress is best-effort
        log.warning("discovery progress update failed for run %s: %s", run_id, e)


def run_progress(run_id: str) -> dict | None:
    """Snapshot of a run's progress, or None if the key is unknown/expired."""
    try:
        raw = _run_conn().hgetall(_run_key(run_id))
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    g = {
        (k.decode() if isinstance(k, bytes) else k): (
            v.decode() if isinstance(v, bytes) else v
        )
        for k, v in raw.items()
    }
    shards_total = int(g.get("shards_total", 0) or 0)
    shards_done = int(g.get("shards_done", 0) or 0)
    return {
        "run_id": run_id,
        "tenant": g.get("tenant", ""),
        "owner": g.get("owner", ""),
        "cidr": g.get("cidr", ""),
        "shards_total": shards_total,
        "shards_done": shards_done,
        "hosts_total": int(g.get("hosts_total", 0) or 0),
        "hosts_done": int(g.get("hosts_done", 0) or 0),
        "responders": int(g.get("responders", 0) or 0),
        "created": int(g.get("created", 0) or 0),
        "done": g.get("done") in ("1", 1),
        "percent": round(shards_done / shards_total * 100) if shards_total else 100,
    }


def discover_shard_job(prefix_id, start: int, count: int, run_id=None) -> dict:
    """RQ entry point: sweep one **shard** of a prefix (the host slice
    ``[start : start+count]``) and create IPs for responders. The manual
    "Discover now" path fans these out so shards run in parallel across the
    worker pool instead of one job grinding the whole range sequentially.
    ``run_id`` ties the shard to a live-progress record the UI polls."""
    from itertools import islice

    from api.models import Prefix

    prefix = Prefix.objects.select_related("vrf", "tenant").filter(pk=prefix_id).first()
    if prefix is None:
        return {"skipped": "gone", "created": 0}
    try:
        net = ipaddress.ip_network(prefix.cidr, strict=False)
    except ValueError:
        return {"skipped": "bad_cidr", "created": 0}
    from api.models import is_enumerable

    if net.version == 6 and not is_enumerable(net):
        return {"skipped": "too_large", "created": 0}

    hosts = [str(h) for h in islice(net.hosts(), start, start + count)]
    if not hosts:
        if run_id:
            _bump_run(run_id, hosts=0, responders=0, created=0)
        return {"scanned": 0, "responders": 0, "created": 0}
    alive = _sweep_hosts(hosts, prefix.cidr)
    created = _create_for_alive(prefix, alive, timezone.now())
    if run_id:
        _bump_run(run_id, hosts=len(hosts), responders=len(alive), created=created)
    return {"scanned": len(hosts), "responders": len(alive), "created": created}


def enqueue_prefix_discovery(prefix, owner_id=None) -> dict:
    """Split a prefix into shards and enqueue one ``discover_shard_job`` per
    shard onto the default queue, so the sweep parallelises across the worker
    pool. Seeds a Redis progress record the UI can poll. Returns
    ``{run_id, shards, scanned}``. Stamps ``last_discovered_at`` up front
    (best-effort) so the periodic timer won't immediately re-sweep."""
    import django_rq

    try:
        net = ipaddress.ip_network(prefix.cidr, strict=False)
    except ValueError:
        return {"skipped": "bad_cidr"}
    from api.models import is_enumerable

    if net.version == 6 and not is_enumerable(net):
        return {"skipped": "too_large"}

    total = _host_total(net)
    ss = _shard_size()
    starts = list(range(0, total, ss))
    run_id = uuid.uuid4().hex

    # Seed the progress record before enqueuing so the first poll always sees it.
    try:
        conn = _run_conn()
        conn.hset(
            _run_key(run_id),
            mapping={
                "cidr": prefix.cidr,
                # Bind the run to its tenant so another tenant can't poll it.
                "tenant": str(prefix.tenant_id),
                "owner": str(owner_id) if owner_id is not None else "",
                "shards_total": len(starts),
                "shards_done": 0,
                "hosts_total": total,
                "hosts_done": 0,
                "responders": 0,
                "created": 0,
                "done": 0,
            },
        )
        conn.expire(_run_key(run_id), _RUN_TTL)
    except Exception as e:  # noqa: BLE001
        log.warning("discovery progress seed failed: %s", e)

    queue = django_rq.get_queue("default")
    for start in starts:
        queue.enqueue(discover_shard_job, str(prefix.id), start, ss, run_id)

    type(prefix).objects.filter(pk=prefix.pk).update(last_discovered_at=timezone.now())
    return {"run_id": run_id, "shards": len(starts), "scanned": total}


def enqueue_bulk_discovery(prefixes, settings, owner_id=None) -> dict:
    """Fan out discovery for **many** prefixes under one shared progress run, so
    a bulk 'Discover now' shows a single aggregate bar. Skips IPv6 / too-large
    (per the min-prefix-length guard) prefixes. Returns
    ``{run_id, shards, scanned, skipped, prefixes}``."""
    import django_rq

    ss = _shard_size()
    plan = []  # (prefix, [shard starts])
    shards_total = hosts_total = skipped = 0
    for prefix in prefixes:
        try:
            net = ipaddress.ip_network(prefix.cidr, strict=False)
        except ValueError:
            skipped += 1
            continue
        if net.version != 4 or net.prefixlen < settings.discovery_min_prefix_length:
            skipped += 1
            continue
        total = _host_total(net)
        starts = list(range(0, total, ss))
        plan.append((prefix, starts))
        shards_total += len(starts)
        hosts_total += total

    if not plan:
        return {"run_id": None, "shards": 0, "scanned": 0, "skipped": skipped, "prefixes": 0}

    run_id = uuid.uuid4().hex
    try:
        conn = _run_conn()
        conn.hset(
            _run_key(run_id),
            mapping={
                "cidr": f"{len(plan)} prefix{'es' if len(plan) != 1 else ''}",
                # All prefixes came from one tenant's scoped queryset — bind it.
                "tenant": str(plan[0][0].tenant_id),
                "owner": str(owner_id) if owner_id is not None else "",
                "shards_total": shards_total,
                "shards_done": 0,
                "hosts_total": hosts_total,
                "hosts_done": 0,
                "responders": 0,
                "created": 0,
                "done": 0,
            },
        )
        conn.expire(_run_key(run_id), _RUN_TTL)
    except Exception as e:  # noqa: BLE001
        log.warning("bulk discovery progress seed failed: %s", e)

    queue = django_rq.get_queue("default")
    now = timezone.now()
    for prefix, starts in plan:
        for start in starts:
            queue.enqueue(discover_shard_job, str(prefix.id), start, ss, run_id)
        type(prefix).objects.filter(pk=prefix.pk).update(last_discovered_at=now)

    return {
        "run_id": run_id,
        "shards": shards_total,
        "scanned": hosts_total,
        "skipped": skipped,
        "prefixes": len(plan),
    }


def discovery_candidates(tenant, settings):
    """Prefixes enrolled in discovery for a tenant.

    * Global switch ``discovery_all_prefixes`` → every prefix.
    * Otherwise, each prefix flagged ``auto_discover`` (a "master") **plus its
      descendant prefixes** (containment within the same VRF) — so marking a
      parent subnet enrols all its children.

    Containment is matched in python over the tenant's prefixes (modest counts);
    the per-prefix size guard in ``discover_prefix`` still skips oversize ranges.
    """
    from api.models import Prefix

    all_prefixes = list(Prefix.objects.filter(tenant=tenant).select_related("vrf"))
    if settings.discovery_all_prefixes:
        return all_prefixes

    masters = [(p.network, p.vrf_id) for p in all_prefixes if p.auto_discover]
    masters = [(net, vrf) for net, vrf in masters if net is not None]
    out = []
    for p in all_prefixes:
        if p.auto_discover:
            out.append(p)
            continue
        net = p.network
        if net is None:
            continue
        for mnet, mvrf in masters:
            if mvrf != p.vrf_id or mnet.version != net.version:
                continue
            try:
                if net.subnet_of(mnet):
                    out.append(p)
                    break
            except (TypeError, ValueError):
                continue
    return out


def _deny_networks(tenant, vrf_id):
    import ipaddress

    from .models import MonitoringDenySubnet

    nets = []
    for row in MonitoringDenySubnet.objects.filter(tenant=tenant, vrf_id=vrf_id):
        try:
            nets.append(ipaddress.ip_network(row.cidr, strict=False))
        except ValueError:
            continue
    return nets


def _prefix_denied(prefix) -> bool:
    net = prefix.network
    if net is None:
        return False
    return any(
        net.version == deny.version and net.overlaps(deny)
        for deny in _deny_networks(prefix.tenant, prefix.vrf_id)
    )


def _filter_denied_alive(prefix, alive):
    import ipaddress

    denies = _deny_networks(prefix.tenant, prefix.vrf_id)
    if not denies:
        return alive or []
    out = []
    for raw in alive or []:
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if any(addr.version == deny.version and addr in deny for deny in denies):
            continue
        out.append(raw)
    return out


def _prefix_due(prefix, settings, now) -> bool:
    """Has this prefix's discovery interval elapsed (or never scanned)?"""
    if prefix.last_discovered_at is None:
        return True
    due_before = now - timedelta(minutes=settings.discovery_interval_minutes)
    return prefix.last_discovered_at < due_before


def sweep_work_for_engine(engine, now=None) -> list[dict]:
    """The discovery prefixes a remote Outpost should sweep — those resolving to
    this engine, due, and small enough. Returns ``[{prefix_id, cidr}]``; the
    agent sweeps each locally and posts back live IPs to ``ingest_discovered``."""
    from .engines import engine_for_prefix
    from .models import MonitoringSettings

    now = now or timezone.now()
    s = MonitoringSettings.for_tenant(engine.tenant)
    if not s.discovery_enabled:
        return []
    work = []
    for prefix in discovery_candidates(engine.tenant, s):
        if not _prefix_due(prefix, s, now):
            continue
        if engine_for_prefix(prefix).id != engine.id:
            continue
        net = prefix.network
        if net is None or net.prefixlen < s.discovery_min_prefix_length:
            continue
        if _prefix_denied(prefix):
            continue
        work.append({"prefix_id": str(prefix.id), "cidr": prefix.cidr})
    return work


def ingest_discovered(prefix_id, alive, tenant, now=None) -> int:
    """Persist an Outpost's sweep result — create IPs for new responders (the
    same path a local sweep uses) and stamp the sweep time."""
    from api.models import Prefix

    now = now or timezone.now()
    prefix = Prefix.objects.filter(pk=prefix_id, tenant=tenant).first()
    if prefix is None:
        return 0
    created = _create_for_alive(prefix, _filter_denied_alive(prefix, alive), now)
    Prefix.objects.filter(pk=prefix.pk).update(last_discovered_at=now)
    return created


def run_discovery(now=None) -> dict:
    """Discover across every tenant that has it enabled. Returns a summary.
    Prefixes assigned to a **remote** engine are left for that Outpost to sweep."""
    from .engines import engine_for_prefix
    from .models import MonitoringEngine, MonitoringSettings

    now = now or timezone.now()
    total = {"prefixes": 0, "created": 0}
    enabled = MonitoringSettings.objects.filter(discovery_enabled=True)
    for s in enabled.select_related("tenant"):
        for prefix in discovery_candidates(s.tenant, s):
            if not _prefix_due(prefix, s, now):
                continue
            # A remote Outpost sweeps its own prefixes; skip them here.
            if engine_for_prefix(prefix).kind == MonitoringEngine.REMOTE:
                continue
            res = discover_prefix(prefix, s, now=now)
            total["prefixes"] += 1
            total["created"] += res.get("created", 0)
    if total["created"]:
        log.info(
            "discovery: created %s IPs across %s prefixes",
            total["created"],
            total["prefixes"],
        )
    return total


def cleanup_stale_ips(now=None) -> dict:
    """Delete discovered IPs unreachable past each tenant's grace period."""
    from datetime import timedelta

    from api.models import IPAddress

    from .models import MonitoringSettings

    now = now or timezone.now()
    total = {"deleted": 0}
    enabled = MonitoringSettings.objects.filter(cleanup_enabled=True)
    for s in enabled.select_related("tenant"):
        cutoff = now - timedelta(days=s.cleanup_after_days)
        qs = IPAddress.objects.filter(tenant=s.tenant, discovered=True).filter(
            Q(last_seen__lt=cutoff) | Q(last_seen__isnull=True, created_at__lt=cutoff)
        )
        deleted, _ = qs.delete()
        total["deleted"] += deleted
    if total["deleted"]:
        log.info("cleanup: deleted %s stale discovered IPs", total["deleted"])
    return total
