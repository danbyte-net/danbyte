"""Interval arithmetic for SLA figures - no database, no Django models.

An SLA figure is time: the seconds a thing was up, down or unmeasured inside
the hours the contract covers, minus the time it excuses. Everything here
works on sorted, non-overlapping intervals of aware datetimes:

* a **window** is ``[(start, end), ...]`` - service hours, maintenance;
* a **timeline** is ``[(start, end, cls), ...]`` with ``cls`` one of
  ``up`` / ``down`` / ``unmeasured``, covering a span without gaps.

The engine in :mod:`monitoring.sla` turns check segments into timelines with
:func:`classify`, cuts them to service hours with :func:`restrict`, forgives
blips with :func:`apply_grace`, merges an object's checks and a redundancy
group's members with :func:`combine`, and counts with :func:`tally`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

UP, DOWN, UNMEASURED = "up", "down", "unmeasured"
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


# ─── windows ────────────────────────────────────────────────────────────────


def normalize(ivs) -> list[tuple]:
    """Sorted, merged, empty intervals dropped."""
    out: list[list] = []
    for s, e in sorted(ivs):
        if e <= s:
            continue
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def subtract(a, b) -> list[tuple]:
    """``a`` minus ``b`` (both normalized)."""
    out = []
    j = 0
    for s, e in a:
        cur = s
        while j < len(b) and b[j][1] <= cur:
            j += 1
        k = j
        while k < len(b) and b[k][0] < e:
            if b[k][0] > cur:
                out.append((cur, b[k][0]))
            cur = max(cur, b[k][1])
            k += 1
        if cur < e:
            out.append((cur, e))
    return out


def total(ivs) -> float:
    return sum((e - s).total_seconds() for s, e in ivs)


def service_windows(
    start: datetime, end: datetime, tz: str, weekly: dict | None = None,
    holidays=(),
) -> list[tuple]:
    """The covered hours inside ``[start, end)``.

    ``weekly`` is ``{"mon": [["08:00", "17:00"]], ...}`` in the agreement's
    timezone; empty or None means around the clock. A day in ``holidays``
    (dates, or ISO strings) is not covered at all. "24:00" ends at midnight.
    """
    hol = {d if isinstance(d, date) else date.fromisoformat(str(d)) for d in holidays}
    if not weekly and not hol:
        return [(start, end)] if end > start else []
    zone = ZoneInfo(tz or "UTC")
    day = start.astimezone(zone).date() - timedelta(days=1)
    last = end.astimezone(zone).date() + timedelta(days=1)
    out = []
    while day <= last:
        if day not in hol:
            spans = (weekly or {}).get(WEEKDAYS[day.weekday()]) if weekly else [["00:00", "24:00"]]
            for a, b in spans or []:
                lo = _at(day, a, zone)
                hi = _at(day, b, zone)
                out.append((max(lo, start), min(hi, end)))
        day += timedelta(days=1)
    return normalize(out)


def _at(day: date, hhmm: str, zone: ZoneInfo) -> datetime:
    if hhmm in ("24:00", "24:00:00"):
        return datetime.combine(day + timedelta(days=1), time(0), zone)
    h, m = (int(x) for x in hhmm.split(":")[:2])
    return datetime.combine(day, time(h, m), zone)


# ─── timelines ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rules:
    """How each check status counts. Mirrors the agreement's fields."""

    degraded: str = UP        # up | down
    stale: str = UNMEASURED   # unmeasured | down
    unknown: str = UNMEASURED  # unmeasured | down


def classify(segments, rules: Rules = Rules()) -> list[tuple]:
    """Check segments ``[{start, end, status}]`` into a timeline."""
    table = {
        "up": UP, "down": DOWN, "degraded": rules.degraded,
        "stale": rules.stale, "unknown": rules.unknown, "skipped": UNMEASURED,
    }
    return _merge_runs(
        (s["start"], s["end"], table.get(s["status"], UNMEASURED))
        for s in segments if s["end"] > s["start"]
    )


def _merge_runs(tl) -> list[tuple]:
    out: list[list] = []
    for s, e, c in tl:
        if out and out[-1][2] == c and out[-1][1] == s:
            out[-1][1] = e
        else:
            out.append([s, e, c])
    return [tuple(x) for x in out]


def restrict(tl, window) -> list[tuple]:
    """The parts of a timeline inside ``window`` (normalized)."""
    out = []
    j = 0
    for s, e, c in tl:
        while j < len(window) and window[j][1] <= s:
            j += 1
        k = j
        while k < len(window) and window[k][0] < e:
            lo, hi = max(s, window[k][0]), min(e, window[k][1])
            if hi > lo:
                out.append((lo, hi, c))
            k += 1
    return out


def apply_grace(tl, seconds: float) -> list[tuple]:
    """Down runs shorter than ``seconds`` count as up - the contract's
    minimum outage. A run is contiguous down time, however many segments."""
    if not seconds:
        return list(tl)
    out = []
    i = 0
    tl = list(tl)
    while i < len(tl):
        s, e, c = tl[i]
        if c != DOWN:
            out.append(tl[i])
            i += 1
            continue
        j = i
        while j + 1 < len(tl) and tl[j + 1][2] == DOWN and tl[j + 1][0] == tl[j][1]:
            j += 1
        run_end = tl[j][1]
        cls = UP if (run_end - s).total_seconds() < seconds else DOWN
        out.extend((a, b, cls) for a, b, _ in tl[i:j + 1])
        i = j + 1
    return _merge_runs(out)


def combine(timelines, mode: str = "all") -> list[tuple]:
    """Several timelines into one.

    ``all`` - an object's checks: down while any is down, else up while any
    is up, else unmeasured. ``any`` - a redundancy group's members: up while
    any is up, else down while any is down, else unmeasured.
    """
    timelines = [t for t in timelines if t]
    if not timelines:
        return []
    if len(timelines) == 1:
        return list(timelines[0])
    cuts = sorted({p for t in timelines for s, e, _ in t for p in (s, e)})
    idx = [0] * len(timelines)
    out = []
    for lo, hi in zip(cuts, cuts[1:], strict=False):
        present = set()
        for n, t in enumerate(timelines):
            while idx[n] < len(t) and t[idx[n]][1] <= lo:
                idx[n] += 1
            if idx[n] < len(t) and t[idx[n]][0] <= lo:
                present.add(t[idx[n]][2])
        if not present:
            continue
        first, second = (DOWN, UP) if mode == "all" else (UP, DOWN)
        cls = first if first in present else second if second in present else UNMEASURED
        out.append((lo, hi, cls))
    return _merge_runs(out)


def tally(tl) -> dict:
    """Seconds per class, and incidents (runs of down that begin inside)."""
    up = down = unmeasured = 0.0
    incidents = 0
    prev_end, prev_cls = None, None
    for s, e, c in tl:
        n = (e - s).total_seconds()
        if c == UP:
            up += n
        elif c == DOWN:
            down += n
            if not (prev_cls == DOWN and prev_end == s):
                incidents += 1
        else:
            unmeasured += n
        prev_end, prev_cls = e, c
    return {"up_s": up, "down_s": down, "unmeasured_s": unmeasured, "incidents": incidents}


def down_runs(tl) -> list[tuple]:
    """``[(start, end)]`` of each contiguous down run - the incidents."""
    return normalize((s, e) for s, e, c in tl if c == DOWN)
