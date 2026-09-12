"""The fast lane - sub-minute and sub-second checks.

The minute beat boots a process, selects due states and enqueues RQ jobs;
its floor is a minute, and every run writes a ``CheckResult``. Neither suits
a one-second ping on a core switch. This lane is a long-lived asyncio
process (``manage.py fastlane``) - or the Outpost's own loop, reporting in
through :func:`ingest_samples` - that probes from an in-memory schedule and
writes only what matters:

* a **status change** at once - the probe that caused it, the transition,
  and everything a transition sets off (alerts, notifications, history);
* otherwise one **aggregated** result per ``record_every_seconds`` - the
  window's min/avg/max latency and loss - so a 1 s check costs the database
  what a 60 s check does.

The hysteresis is the same :func:`monitoring.state.apply_outcome` the
workers use, applied per probe in memory; rise and fall mean what they always
meant, they just add up faster. The persistence is the same ``_persist`` the
workers use, so what a change sets off cannot differ by lane.

What is *not* here: the lane never touches a state on the minute beat, and
the beat never touches a state the lane owns while the lane's heartbeat is
fresh. When the heartbeat goes stale, the beat runs fast states at their
fallback ``interval_seconds`` rather than leaving them blind.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime, timedelta

from django.db.models import Q
from django.utils import timezone

from .checkers import CheckOutcome
from .models import CheckResult, CheckState, MonitoringEngine, MonitoringSettings
from .state import apply_outcome

log = logging.getLogger("monitoring.fastlane")

#: Floors, per kind. ICMP is a datagram; the rest open a connection.
MIN_INTERVAL_MS = {"icmp": 200}
MIN_INTERVAL_MS_DEFAULT = 1000
MAX_INTERVAL_MS = 59_999
MIN_RECORD_EVERY = 5

#: How often the lane re-reads its set from the database.
RELOAD_SECONDS = 10
#: The scheduling tick - the finest interval the lane can honour.
TICK_SECONDS = 0.05
#: Persistence is batched: rows are written this often, in a thread.
FLUSH_SECONDS = 1.0
#: The heartbeat the beat and the UI read.
HEARTBEAT_KEY = "danbyte:fastlane:stats"
HEARTBEAT_TTL = 60
STALE_AFTER = 45  # seconds without a heartbeat → the beat takes over

_REACHABLE = {"up", "degraded"}


def min_interval_ms(kind: str) -> int:
    return MIN_INTERVAL_MS.get(kind, MIN_INTERVAL_MS_DEFAULT)


# ─── heartbeat ────────────────────────────────────────────────────────────


def _redis():
    from django_redis import get_redis_connection

    return get_redis_connection("default")


def heartbeat(stats: dict) -> None:
    """``{checks, probes_per_s, at}`` - written by the lane every few seconds."""
    try:
        _redis().set(
            HEARTBEAT_KEY,
            json.dumps({**stats, "at": timezone.now().isoformat()}),
            ex=HEARTBEAT_TTL,
        )
    except Exception:  # noqa: BLE001 - a heartbeat must never stop the lane
        log.debug("fast lane heartbeat failed", exc_info=True)


def lane_stats() -> dict | None:
    """The last heartbeat, or None when the lane is not running."""
    try:
        raw = _redis().get(HEARTBEAT_KEY)
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def lane_alive(now=None) -> bool:
    stats = lane_stats()
    if not stats:
        return False
    try:
        at = datetime.fromisoformat(stats["at"])
    except (KeyError, ValueError):
        return False
    return ((now or timezone.now()) - at).total_seconds() < STALE_AFTER


# ─── the fold ─────────────────────────────────────────────────────────────


class Sample:
    """One probe's outcome, as the fold consumes it."""

    __slots__ = ("at", "status", "latency_ms", "detail")

    def __init__(self, at, status, latency_ms=None, detail=None):
        self.at = at
        self.status = status
        self.latency_ms = latency_ms
        self.detail = detail or {}


_RANK = {"up": 0, "degraded": 1, "unknown": 2, "down": 3}


class Window:
    """What has been probed since the last recorded result, per state.

    Running totals rather than a list of latencies: a window is at most a
    few thousand probes but there may be a thousand of them, and an
    Outpost's window has to survive between batches - it round-trips
    through ``CheckState.fast_window`` as a small dict.
    """

    __slots__ = ("count", "lat_max", "lat_min", "lat_n", "lat_sum", "reachable", "worst")

    def __init__(self, saved: dict | None = None):
        saved = saved or {}
        self.count = int(saved.get("count", 0))
        self.reachable = int(saved.get("reachable", 0))
        self.lat_n = int(saved.get("lat_n", 0))
        self.lat_sum = float(saved.get("lat_sum", 0.0))
        self.lat_min = saved.get("lat_min")
        self.lat_max = saved.get("lat_max")
        self.worst = saved.get("worst", "up")

    def add(self, sample: Sample) -> None:
        self.count += 1
        if sample.status in _REACHABLE:
            self.reachable += 1
            if sample.latency_ms is not None:
                lat = float(sample.latency_ms)
                self.lat_n += 1
                self.lat_sum += lat
                self.lat_min = lat if self.lat_min is None else min(self.lat_min, lat)
                self.lat_max = lat if self.lat_max is None else max(self.lat_max, lat)
        if _RANK.get(sample.status, 0) > _RANK.get(self.worst, 0):
            self.worst = sample.status

    @property
    def avg(self) -> float | None:
        return self.lat_sum / self.lat_n if self.lat_n else None

    def detail(self, seconds: float) -> dict:
        return {
            "agg": {
                "samples": self.count,
                "loss_pct": round(100.0 * (1 - self.reachable / self.count), 1) if self.count else 0,
                "min_ms": round(self.lat_min, 2) if self.lat_min is not None else None,
                "avg_ms": round(self.avg, 2) if self.avg is not None else None,
                "max_ms": round(self.lat_max, 2) if self.lat_max is not None else None,
                "window_s": round(seconds),
            }
        }

    def reset(self) -> None:
        self.count = self.reachable = self.lat_n = 0
        self.lat_sum = 0.0
        self.lat_min = self.lat_max = None
        self.worst = "up"

    def to_dict(self) -> dict:
        if not self.count:
            return {}
        return {
            "count": self.count, "reachable": self.reachable, "lat_n": self.lat_n,
            "lat_sum": round(self.lat_sum, 3), "lat_min": self.lat_min, "lat_max": self.lat_max,
            "worst": self.worst,
        }


def fold(state: CheckState, samples, *, rise: int, fall: int, cfg: dict, engine_id,
         window: Window, record_every: int, now=None):
    """Apply probes to a state in memory. Returns ``(results, transitions)``
    to persist - the probe behind each status change, plus one aggregated
    row when the recording window has elapsed. The state is mutated in
    place; the caller writes it back with ``_persist``.

    ``samples`` must be in time order: a transition depends on the run of
    outcomes before it, and an Outpost's buffer arrives in one batch.
    """
    results: list[CheckResult] = []
    transitions = []
    for sample in samples:
        oc = CheckOutcome(sample.status, sample.latency_ms, sample.detail)
        tr = apply_outcome(
            state,
            rise=rise, fall=fall, outcome=oc, now=sample.at,
            stale_after_scans=cfg.get("stale_after_scans", 0),
            stale_after_days=cfg.get("stale_after_days", 0),
            engine_id=engine_id,
        )
        window.add(sample)
        if tr is not None:
            transitions.append(tr)
            results.append(_result(state, sample.status, sample.latency_ms, sample.detail,
                                   sample.at, engine_id))
            # The window restarts on a change: what follows is a new run.
            window.reset()
    now = now or (samples[-1].at if samples else timezone.now())
    last = state.last_recorded_at
    if last is None:
        # The clock starts with the first probe; the first row lands a
        # window later, not at once.
        state.last_recorded_at = samples[0].at if samples else now
        return results, transitions
    if window.count and (now - last).total_seconds() >= record_every:
        seconds = (now - last).total_seconds()
        results.append(_result(
            state, state.status if state.status in ("up", "down", "degraded", "stale")
            else window.worst,
            window.avg, window.detail(seconds), now, engine_id,
        ))
        state.last_recorded_at = now
        window.reset()
    return results, transitions


def _result(state, status, latency_ms, detail, at, engine_id) -> CheckResult:
    return CheckResult(
        tenant_id=state.tenant_id,
        target_ip_id=state.target_ip_id,
        template_id=state.template_id,
        assignment_id=state.assignment_id,
        kind=state.kind,
        status=status,
        latency_ms=latency_ms,
        detail=detail or {},
        timestamp=at,
        engine_id=engine_id,
    )


# ─── the set ──────────────────────────────────────────────────────────────


def fast_states(engine=None):
    """The states with a fast interval: the core's own (no engine, or the
    local one) by default, or one remote engine's."""
    qs = CheckState.objects.filter(interval_ms__isnull=False).select_related(
        "target_ip", "template", "assignment", "engine"
    )
    if engine is None:
        qs = qs.filter(Q(engine__isnull=True) | Q(engine__kind=MonitoringEngine.LOCAL))
    else:
        qs = qs.filter(engine=engine)
    return qs.order_by("created_at", "id")


def claim_within_caps(states) -> tuple[list, list]:
    """Split by each tenant's cap: ``(owned, over)``. Over-cap states are
    released to the beat (``fast_owned=False``) and run at their fallback
    interval; the split is stable (oldest first) so the same checks stay on
    the lane from one reload to the next."""
    caps = {
        ms.tenant_id: ms.fast_lane_max_checks
        for ms in MonitoringSettings.objects.filter(
            tenant_id__in={s.tenant_id for s in states}
        )
    }
    seen: dict = {}
    owned, over = [], []
    for s in states:
        cap = caps.get(s.tenant_id, 500)
        n = seen.get(s.tenant_id, 0)
        if n < cap:
            owned.append(s)
            seen[s.tenant_id] = n + 1
        else:
            over.append(s)
    return owned, over


def _rise_fall(state) -> tuple[int, int]:
    overrides = (state.assignment.overrides if state.assignment else {}) or {}
    return (
        int(overrides.get("rise", state.template.rise)),
        int(overrides.get("fall", state.template.fall)),
    )


def lane_cfg(state, cfg: dict) -> dict:
    """The tenant policy as the lane applies it.

    ``stale_after_scans`` counts scans at the normal cadence: ten failed
    five-minute scans is a chronic outage, ten failed one-second probes is
    ten seconds. Scale it by the fallback interval so *stale* keeps meaning
    what the setting says it means.
    """
    from .worker import _DEFAULT_CFG, effective_interval

    scans = int(cfg.get("stale_after_scans") or 0)
    if scans and state.interval_ms:
        fallback_s = effective_interval(state, {**_DEFAULT_CFG, **cfg}) or 60
        scans = max(scans, round(scans * fallback_s * 1000 / int(state.interval_ms)))
    return {**cfg, "stale_after_scans": scans}


def _record_every(state) -> int:
    overrides = (state.assignment.overrides if state.assignment else {}) or {}
    return max(int(overrides.get("record_every_seconds", state.template.record_every_seconds)),
               MIN_RECORD_EVERY)


# ─── the Outpost seam ─────────────────────────────────────────────────────


def ingest_samples(engine, payload: dict, now=None) -> int:
    """Fold an Outpost's buffered probes into its fast states.

    ``payload`` is ``{results: [{state_id, samples: [{t, status, latency_ms,
    detail}]}]}`` with ``t`` in epoch milliseconds. Only the engine's own
    fast states are touched; samples for anything else are dropped. Returns
    how many samples were folded.
    """
    from .worker import _cfg, _load_settings, _persist

    now = now or timezone.now()
    import uuid

    wanted: dict[str, list] = {}
    for item in payload.get("results") or []:
        sid = str(item.get("state_id") or "")
        samples = item.get("samples") or []
        try:
            uuid.UUID(sid)
        except ValueError:
            continue
        if isinstance(samples, list):
            wanted.setdefault(sid, []).extend(samples)
    if not wanted:
        return 0
    states = list(fast_states(engine).filter(id__in=list(wanted)))
    if not states:
        return 0
    settings_map = _load_settings({s.tenant_id for s in states})
    results, transitions, dirty = [], [], []
    folded = 0
    for state in states:
        samples = []
        for raw in wanted[str(state.id)]:
            status = raw.get("status")
            if status not in ("up", "down", "degraded", "unknown"):
                continue
            try:
                at = datetime.fromtimestamp(float(raw["t"]) / 1000, tz=UTC)
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            samples.append(Sample(at, status, raw.get("latency_ms"), raw.get("detail") or {}))
        if not samples:
            continue
        samples.sort(key=lambda x: x.at)
        rise, fall = _rise_fall(state)
        # The window outlives the batch: an Outpost reports every few
        # seconds and the aggregate covers the whole recording window.
        window = Window(state.fast_window)
        # The recording clock runs on the probes' own time, not on when the
        # batch arrived: an agent that was offline for a while reports old
        # probes, and those belong to the windows they were taken in.
        r, t = fold(
            state, samples, rise=rise, fall=fall,
            cfg=lane_cfg(state, _cfg(settings_map, state.tenant_id)),
            engine_id=engine.id, window=window, record_every=_record_every(state),
            now=samples[-1].at,
        )
        # An Outpost reports in batches, so the window rarely lines up with
        # the recording clock; what it did not record this time is simply
        # part of the next batch's window. A batch that produced no row
        # still refreshes the state's last-seen fields.
        results.extend(r)
        transitions.extend(t)
        state.fast_owned = True
        state.fast_window = window.to_dict()
        dirty.append(state)
        folded += len(samples)
    _persist(results, transitions, dirty, now)
    return folded


# ─── the lane process ─────────────────────────────────────────────────────


class Entry:
    """One owned state and its in-memory schedule."""

    __slots__ = ("state", "rc", "interval", "due", "window", "record_every", "rise", "fall",
                 "cfg", "running")

    def __init__(self, state, rc, cfg):
        self.state = state
        self.rc = rc
        self.cfg = cfg
        self.refresh(state, rc, cfg)
        self.due = time.monotonic()
        self.window = Window()
        self.running = False

    def refresh(self, state, rc, cfg) -> None:
        # Keep the counters and status the lane has been building; take the
        # template, params and interval as they are now.
        self.state.template = state.template
        self.state.assignment = state.assignment
        self.state.target_ip = state.target_ip
        self.state.interval_ms = state.interval_ms
        self.rc = rc
        self.cfg = cfg
        self.interval = max(int(state.interval_ms or 1000), min_interval_ms(state.kind)) / 1000
        self.record_every = _record_every(state)
        self.rise, self.fall = _rise_fall(state)


class FastLane:
    """The long-lived loop. One instance per process; ``run()`` never returns."""

    def __init__(self):
        self.entries: dict[str, Entry] = {}
        self.pending_results: list = []
        self.pending_transitions: list = []
        self.dirty: dict[str, CheckState] = {}
        self.samples: dict[str, tuple] = {}
        self.probes = 0
        self._probe_window_started = time.monotonic()
        self.probes_per_s = 0.0
        self.stopping = False

    # -- the set --------------------------------------------------------------

    def reload(self) -> None:
        from .worker import (
            _cfg,
            _load_settings,
            _partition_skipped,
            _resolved_from_state,
            effective_interval,
        )

        rows = list(fast_states())
        settings_map = _load_settings({s.tenant_id for s in rows})
        owned, over = claim_within_caps(rows)
        runnable, skipped = _partition_skipped(owned, settings_map)
        # A check switched off (custom_off, or global off) is not probed.
        runnable = [s for s in runnable if effective_interval(s, _cfg(settings_map, s.tenant_id))]
        keep = set()
        for s in runnable:
            sid = str(s.id)
            keep.add(sid)
            rc = _resolved_from_state(s)
            cfg = lane_cfg(s, _cfg(settings_map, s.tenant_id))
            entry = self.entries.get(sid)
            if entry is None:
                self.entries[sid] = Entry(s, rc, cfg)
            else:
                entry.refresh(s, rc, cfg)
        for sid in list(self.entries):
            if sid not in keep:
                del self.entries[sid]
        # Ownership on the rows, so the beat knows what to leave alone.
        CheckState.objects.filter(id__in=[str(s.id) for s in runnable]).exclude(
            fast_owned=True
        ).update(fast_owned=True)
        release = [str(s.id) for s in over + skipped] + [
            str(s.id) for s in owned if not effective_interval(s, _cfg(settings_map, s.tenant_id))
        ]
        if release:
            CheckState.objects.filter(id__in=release, fast_owned=True).update(fast_owned=False)
        if over:
            log.info("fast lane: %d check(s) over the tenant cap run on the beat", len(over))

    # -- probing --------------------------------------------------------------

    async def tick(self) -> None:
        now_m = time.monotonic()
        due = [e for e in self.entries.values() if e.due <= now_m and not e.running]
        if not due:
            return
        icmp = [e for e in due if e.state.kind == "icmp"]
        others = [e for e in due if e.state.kind != "icmp"]
        for e in due:
            e.running = True
            # Schedule the next probe from *this* one, not from when it
            # finished, so a slow answer does not stretch the cadence.
            e.due = now_m + e.interval
        groups: dict = {}
        for e in icmp:
            key = (e.rc.timeout_ms, int((e.rc.params or {}).get("count", 1) or 1))
            groups.setdefault(key, []).append(e)
        for (timeout_ms, count), entries in groups.items():
            asyncio.create_task(self._ping(entries, timeout_ms, count))
        for e in others:
            asyncio.create_task(self._generic(e))

    async def _ping(self, entries, timeout_ms, count) -> None:
        from .worker import _icmp_outcome, _multiping

        at = timezone.now()
        try:
            hosts = await _multiping([e.state.target_ip.ip_address for e in entries], count, timeout_ms)
        except Exception as exc:  # noqa: BLE001
            log.warning("fast lane ping failed: %s", exc)
            for e in entries:
                e.running = False
            return
        for host, e in zip(hosts, entries, strict=False):
            oc = _icmp_outcome(host, e.state.template)
            self._fold(e, Sample(at, oc.status, oc.latency_ms, oc.detail))
            e.running = False

    async def _generic(self, e: Entry) -> None:
        from .runner import run_resolved

        at = timezone.now()
        try:
            oc = await run_resolved(e.rc, e.state.target_ip.ip_address)
        except Exception as exc:  # noqa: BLE001
            oc = CheckOutcome.unknown(str(exc))
        self._fold(e, Sample(at, oc.status, oc.latency_ms, oc.detail))
        e.running = False

    def _fold(self, e: Entry, sample: Sample) -> None:
        self.probes += 1
        results, transitions = fold(
            e.state, [sample], rise=e.rise, fall=e.fall, cfg=e.cfg, engine_id=None,
            window=e.window, record_every=e.record_every, now=sample.at,
        )
        self.pending_results.extend(results)
        self.pending_transitions.extend(transitions)
        if results or transitions:
            self.dirty[str(e.state.id)] = e.state
        # Every probe is a word for a page that is watching, even the ones
        # that never become a row; the flush decides who is watching. All of
        # them, not the last one a second - a 200 ms check makes five.
        sid = str(e.state.id)
        self.samples.setdefault(sid, (e.state, []))[1].append(
            {"status": sample.status, "latency_ms": sample.latency_ms, "at": sample.at.isoformat()}
        )

    # -- persistence ----------------------------------------------------------

    def flush(self) -> None:
        """Write the batch. Runs in a thread; the loop keeps probing."""
        from .worker import _persist, effective_interval

        results, self.pending_results = self.pending_results, []
        transitions, self.pending_transitions = self.pending_transitions, []
        dirty, self.dirty = list(self.dirty.values()), {}
        samples, self.samples = self.samples, {}
        # The probes that became nothing still reach an open page - one
        # message a second per watched address, none for the rest.
        dirty_ids = {str(d.id) for d in dirty}
        quiet = [st for sid, (st, _) in samples.items() if sid not in dirty_ids]
        if samples:
            from .live import interested, publish, push_probes

            watched = interested(st.target_ip_id for st, _ in samples.values())
            push_probes({
                sid: sms for sid, (st, sms) in samples.items()
                if str(st.target_ip_id) in watched
            })
        if quiet:
            publish(quiet, (), {sid: sms for sid, (_, sms) in samples.items()})
        if not (results or transitions or dirty):
            return
        now = timezone.now()
        for s in dirty:
            s.in_flight = False
            s.in_flight_since = None
            # The beat's clock, kept in the future while the lane owns it,
            # so a stale-heartbeat takeover starts at the fallback interval
            # rather than finding every row overdue at once.
            s.next_run = now + timedelta(seconds=effective_interval(s) or 60)
        _persist(results, transitions, dirty, now)

    def _beat(self) -> None:
        now_m = time.monotonic()
        span = now_m - self._probe_window_started
        if span >= 5:
            self.probes_per_s = round(self.probes / span, 1)
            self.probes = 0
            self._probe_window_started = now_m
        heartbeat({"checks": len(self.entries), "probes_per_s": self.probes_per_s})

    # -- the loop -------------------------------------------------------------

    async def run(self) -> None:
        from asgiref.sync import sync_to_async

        reload = sync_to_async(self.reload, thread_sensitive=True)
        flush = sync_to_async(self.flush, thread_sensitive=True)
        beat = sync_to_async(self._beat, thread_sensitive=True)
        await reload()
        await beat()
        next_reload = time.monotonic() + RELOAD_SECONDS
        next_flush = time.monotonic() + FLUSH_SECONDS
        next_beat = time.monotonic() + 5
        log.info("fast lane up: %d check(s)", len(self.entries))
        while not self.stopping:
            await self.tick()
            now_m = time.monotonic()
            if now_m >= next_flush:
                next_flush = now_m + FLUSH_SECONDS
                try:
                    await flush()
                except Exception:  # noqa: BLE001
                    log.exception("fast lane flush failed")
            if now_m >= next_beat:
                next_beat = now_m + 5
                await beat()
            if now_m >= next_reload:
                next_reload = now_m + RELOAD_SECONDS
                try:
                    await reload()
                except Exception:  # noqa: BLE001
                    log.exception("fast lane reload failed")
            await asyncio.sleep(TICK_SECONDS)
        await flush()
        await sync_to_async(self.release_all, thread_sensitive=True)()

    @staticmethod
    def release_all() -> None:
        """On a clean stop the beat takes the fast states back at once."""
        CheckState.objects.filter(fast_owned=True).update(fast_owned=False)
        try:
            _redis().delete(HEARTBEAT_KEY)
        except Exception:  # noqa: BLE001
            pass
