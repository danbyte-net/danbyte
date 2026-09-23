"""Figures over a window, read from the rollups.

Every page that shows availability, incidents or latency for more than one
check at a time - the checks list, the explore view, the latency page, and
later SLAs and dashboards - reads it from here, so they agree.

A window is the last N hours (hourly rows) or the last N days, day-aligned:
N-1 closed days from the daily rows plus today so far from the hourly rows.
Percentiles over a window are the sample-weighted mean of the buckets'
percentiles - close to, but not the same as, the percentile of every probe.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from django.db.models import F, Max, Q, Sum
from django.utils import timezone

from .models import CheckRollupDaily, CheckRollupHourly
from .rollups import DAY, HOUR, CountingRules, _floor, classify

#: The longest window the hourly rows can answer (they are kept 30 days).
MAX_HOURS = 48
MAX_DAYS = 366

_SECONDS = ("up_s", "down_s", "degraded_s", "stale_s", "unknown_s")


@dataclass(frozen=True)
class Window:
    since: datetime
    until: datetime
    #: (model, bucket >=, bucket <) - one or two slices of rollup rows.
    parts: tuple

    @property
    def daily(self) -> bool:
        return any(m is CheckRollupDaily for m, _a, _b in self.parts)


def window(*, days: int | None = None, hours: int | None = None, now=None) -> Window:
    """The rollup rows that cover the last ``hours`` or ``days``."""
    now = now or timezone.now()
    if hours:
        hours = max(1, min(int(hours), MAX_HOURS))
        since = _floor(now, HOUR) - timedelta(hours=hours - 1)
        return Window(since, now, ((CheckRollupHourly, since, now + HOUR),))
    days = max(1, min(int(days or 7), MAX_DAYS))
    today = _floor(now, DAY)
    since = today - timedelta(days=days - 1)
    parts = [(CheckRollupHourly, today, now + HOUR)]
    if days > 1:
        parts.insert(0, (CheckRollupDaily, since, today))
    return Window(since, now, tuple(parts))


def window_from_params(params, now=None) -> Window:
    hours = params.get("hours")
    if hours and str(hours).isdigit():
        return window(hours=int(hours), now=now)
    days = params.get("days")
    return window(days=int(days) if days and str(days).isdigit() else 7, now=now)


#: Aggregate aliases carry this prefix: Django refuses an alias that
#: shadows a field (``samples`` summed as ``samples``).
_P = "t_"


def _aggregates() -> dict:
    has_lat = Q(lat_p50__isnull=False)
    return {_P + k: v for k, v in {
        **{k: Sum(k) for k in _SECONDS},
        "incidents": Sum("incidents"),
        "samples": Sum("samples"),
        "spikes": Sum("spikes"),
        "lat_n": Sum("samples", filter=has_lat),
        "p50_w": Sum(F("lat_p50") * F("samples"), filter=has_lat),
        "p95_w": Sum(F("lat_p95") * F("samples"), filter=has_lat),
        "p99_w": Sum(F("lat_p99") * F("samples"), filter=has_lat),
        "lat_max": Max("lat_max"),
    }.items()}


def _fold(acc: dict, row: dict) -> None:
    """Add one aggregated row (prefixed aliases) into ``acc``."""
    for k, v in row.items():
        if not k.startswith(_P) or v is None:
            continue
        k = k[len(_P):]
        acc[k] = max(acc.get(k) or 0, v) if k == "lat_max" else acc.get(k, 0) + v


def sums(win: Window, narrow, group_by: tuple = ()) -> dict:
    """``{group key: summed row}`` over the window.

    ``narrow(qs)`` applies tenant, RBAC scope and filters to one rollup
    queryset; it is called once per slice. ``group_by`` names fields or
    annotations on the rollup rows; the key is a tuple of their values
    (``()`` for no grouping)."""
    out: dict = {}
    for model, start, stop in win.parts:
        qs = narrow(model.objects.filter(bucket__gte=start, bucket__lt=stop))
        for row in qs.values(*group_by).annotate(**_aggregates()).order_by():
            _fold(out.setdefault(tuple(row[g] for g in group_by), {}), row)
    return out


def figures(row: dict, rules: CountingRules = CountingRules()) -> dict:
    """What a summed row says: availability, coverage, incidents, time to
    recover, latency."""
    c = classify(row, rules)
    incidents = int(row.get("incidents") or 0)
    n = row.get("lat_n") or 0

    def pct(key):
        return round(row[key] / n, 2) if n and row.get(key) is not None else None

    return {
        "availability": round(100 * c["availability"], 3) if c["availability"] is not None else None,
        "coverage": round(100 * c["coverage"], 1) if c["coverage"] is not None else None,
        "up_s": round(c["up_s"]),
        "down_s": round(c["down_s"]),
        "unmeasured_s": round(c["unmeasured_s"]),
        "incidents": incidents,
        # Down time per incident: the mean time to recover, for incidents
        # that ended inside the window or are still open.
        "mttr_s": round(c["down_s"] / incidents) if incidents else None,
        "samples": int(row.get("samples") or 0),
        "spikes": int(row.get("spikes") or 0),
        "p50": pct("p50_w"),
        "p95": pct("p95_w"),
        "p99": pct("p99_w"),
        "max": round(row["lat_max"], 2) if row.get("lat_max") is not None else None,
    }


def series(win: Window, narrow) -> list[dict]:
    """One point per bucket of the window - hourly for an hours window,
    daily for a days window (today as one point summed from its hours)."""
    points: dict = {}
    for model, start, stop in win.parts:
        qs = narrow(model.objects.filter(bucket__gte=start, bucket__lt=stop))
        for row in qs.values("bucket").annotate(**_aggregates()).order_by("bucket"):
            b = row.pop("bucket")
            if win.daily:
                b = _floor(b, DAY)
            _fold(points.setdefault(b, {}), row)
    return [{"t": b.isoformat(), **figures(points[b])} for b in sorted(points)]
