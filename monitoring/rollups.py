"""Durable rollups of check history, and the rules for reading them.

Raw ``CheckResult`` rows live 30 days and ``StateTransition`` rows a year,
so any figure that must still read the same next year - an SLA period above
all - cannot be computed from them. This module folds them into
:class:`CheckRollupHourly` and :class:`CheckRollupDaily` rows: seconds per
status, incidents, and this check's own latency (min / avg / p50 / p95 / p99
/ max, spikes against its own baseline).

* :func:`roll` computes one window size over a range of buckets, for one
  tenant, and upserts the rows. Re-running it is always safe.
* :func:`refresh` is the periodic entry point: the open hour, and each day
  once it has ended.
* :func:`classify` is the one place that says what counts as up, down or
  unmeasured. Everything that turns rollups into a percentage goes through it.

Buckets are UTC hours and UTC days.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from django.db.models import Avg, Count, Max, Min, Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from .charts import Percentile
from .charts import _agg_num as _agg
from .models import (
    LATENCY_EDGES,
    CheckResult,
    CheckRollupDaily,
    CheckRollupHourly,
    CheckState,
    MonitoringSettings,
)
from .timeline import segments_for_pairs

_HIST_FIELDS = tuple(f"lat_le_{e}" for e in LATENCY_EDGES)

log = logging.getLogger("monitoring.rollups")

EDGE = timedelta(microseconds=1)
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)

#: Built-in spike floors per kind (ms); MonitoringSettings.spike_floor_ms
#: overrides any of them. A kind not listed uses DEFAULT_FLOOR_MS.
SPIKE_FLOORS_MS = {"icmp": 5.0, "tcp": 20.0, "udp": 20.0, "snmp": 50.0,
                   "http": 50.0, "ssh": 50.0, "telnet": 50.0, "tls_cert": 50.0}
DEFAULT_FLOOR_MS = 20.0
#: How far back a check's baseline looks.
BASELINE_WINDOW = timedelta(days=7)

_SECONDS_FIELD = {
    "up": "up_s", "down": "down_s", "degraded": "degraded_s",
    "stale": "stale_s", "unknown": "unknown_s", "skipped": "unknown_s",
}
_DOWN_CLASS = {"down", "stale"}


# ─── counting rules ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CountingRules:
    """What each status counts as, for availability.

    The defaults are today's history strip: degraded counts as up. Stale -
    the probe went blind - is *unmeasured*, not down: a contract should not
    charge the customer for our Outpost losing its network. (The live
    history strip still draws stale as down; that is a picture of now, this
    is an account.)
    """

    degraded: str = "up"      # "up" | "down"
    stale: str = "unmeasured"  # "down" | "unmeasured"


def classify(row, rules: CountingRules = CountingRules()) -> dict:
    """Seconds up, down and unmeasured, and availability, from rollup-shaped
    numbers (a row, or a dict with the same *_s keys).

    ``availability`` is up / (up + down), or None when nothing was measured;
    ``coverage`` is measured time over all time - a 99.99 % over three
    measured days out of thirty is not a result, and this says so.
    """
    get = (lambda k: float(row.get(k) or 0)) if isinstance(row, dict) \
        else (lambda k: float(getattr(row, k) or 0))
    up = get("up_s")
    down = get("down_s")
    unmeasured = get("unknown_s")
    if rules.degraded == "down":
        down += get("degraded_s")
    else:
        up += get("degraded_s")
    if rules.stale == "down":
        down += get("stale_s")
    else:
        unmeasured += get("stale_s")
    measured = up + down
    total = measured + unmeasured
    return {
        "up_s": up, "down_s": down, "unmeasured_s": unmeasured,
        "availability": (up / measured) if measured else None,
        "coverage": (measured / total) if total else None,
    }


# ─── computing buckets ──────────────────────────────────────────────────────


def _floor(dt: datetime, size: timedelta) -> datetime:
    dt = dt.astimezone(UTC)
    if size == DAY:
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return dt.replace(minute=0, second=0, microsecond=0)


def _spike_rules(tenant_id) -> tuple[float, dict]:
    s = MonitoringSettings.objects.filter(tenant_id=tenant_id).only(
        "spike_factor", "spike_floor_ms"
    ).first()
    factor = float(s.spike_factor) if s else 3.0
    floors = dict(SPIKE_FLOORS_MS)
    if s and isinstance(s.spike_floor_ms, dict):
        for k, v in s.spike_floor_ms.items():
            try:
                floors[str(k)] = float(v)
            except (TypeError, ValueError):
                continue
    return factor, floors


def baselines(tenant_id, before: datetime, pairs=None) -> dict:
    """``{(ip_id, template_id): median latency}`` over the week before
    ``before``, from the hourly rollups - each check's own normal.
    ``pairs=(ip_ids, template_ids)`` narrows it to a page of checks."""
    qs = CheckRollupHourly.objects.filter(
        tenant_id=tenant_id, bucket__gte=before - BASELINE_WINDOW,
        bucket__lt=before, lat_p50__isnull=False,
    )
    if pairs is not None:
        qs = qs.filter(target_ip_id__in=pairs[0], template_id__in=pairs[1])
    rows = (
        qs.values("target_ip_id", "template_id")
        .annotate(m=Percentile("lat_p50", 0.5))
    )
    return {(str(r["target_ip_id"]), str(r["template_id"])): r["m"] for r in rows}


def _samples_expr():
    """Probes per row: a fast-lane row folds many into detail.agg.samples,
    and its own min/max into detail.agg (latency_ms holds the average)."""
    return Coalesce(_agg("samples"), 1.0)


def roll(tenant_id, size: timedelta, start: datetime, end: datetime,
         *, now: datetime | None = None) -> int:
    """Compute every ``size`` bucket in ``[start, end)`` for one tenant and
    upsert it. Returns the rows written. Buckets that have not ended by
    ``now`` are written open, and rewritten on the next run."""
    now = now or timezone.now()
    model = CheckRollupDaily if size == DAY else CheckRollupHourly
    states = list(
        CheckState.objects.filter(tenant_id=tenant_id)
        .values_list("target_ip_id", "template_id", "kind")
    )
    if not states:
        return 0
    kind_of = {(str(ip), str(t)): kind for ip, t, kind in states}
    pairs = list(kind_of)
    factor, floors = _spike_rules(tenant_id)
    written = 0
    bucket = _floor(start, size)
    while bucket < end:
        stop = bucket + size
        until = min(stop, now)
        if until <= bucket:
            break
        # Open a microsecond early so the first segment carries the status
        # the bucket inherited: a check that went down on the bucket edge is
        # an incident in this bucket, one that was already down is not.
        segs = segments_for_pairs(tenant_id, pairs, bucket - EDGE, until)
        base = baselines(tenant_id, bucket) if size == HOUR else {}
        lat = {
            (str(r["target_ip_id"]), str(r["template_id"])): r
            for r in (
                CheckResult.objects.filter(
                    tenant_id=tenant_id, timestamp__gte=bucket,
                    timestamp__lt=until, template_id__isnull=False,
                )
                .values("target_ip_id", "template_id")
                .annotate(
                    rows=Count("id"),
                    samples=Sum(_samples_expr()),
                    lat_min=Min(Coalesce(_agg("min_ms"), "latency_ms")),
                    lat_avg=Avg("latency_ms"),
                    lat_max=Max(Coalesce(_agg("max_ms"), "latency_ms")),
                    lat_p50=Percentile("latency_ms", 0.5),
                    lat_p95=Percentile("latency_ms", 0.95),
                    lat_p99=Percentile("latency_ms", 0.99),
                    lat_hist_n=Sum(_samples_expr(), filter=Q(latency_ms__isnull=False)),
                    **{f"lat_le_{e}": Sum(_samples_expr(), filter=Q(latency_ms__lte=e))
                       for e in LATENCY_EDGES},
                )
            )
        }
        spikes = _count_spikes(tenant_id, bucket, until, base, kind_of, factor, floors) \
            if base else {}
        rows = []
        for key in pairs:
            ip_id, tmpl_id = key
            secs = dict.fromkeys(set(_SECONDS_FIELD.values()), 0.0)
            incidents = 0
            prev = None
            for seg in segs.get(key, []):
                length = (seg["end"] - max(seg["start"], bucket)).total_seconds()
                if length > 0:
                    secs[_SECONDS_FIELD.get(seg["status"], "unknown_s")] += length
                if seg["status"] in _DOWN_CLASS and prev is not None \
                        and prev not in _DOWN_CLASS:
                    incidents += 1
                prev = seg["status"]
            s = lat.get(key) or {}
            rows.append(model(
                tenant_id=tenant_id, target_ip_id=ip_id, template_id=tmpl_id,
                kind=kind_of[key], bucket=bucket, incidents=incidents,
                samples=int(s.get("samples") or 0),
                lat_min=s.get("lat_min"), lat_avg=s.get("lat_avg"),
                lat_p50=s.get("lat_p50"), lat_p95=s.get("lat_p95"),
                lat_p99=s.get("lat_p99"), lat_max=s.get("lat_max"),
                spikes=spikes.get(key, 0), closed=stop <= now,
                lat_hist_n=int(s.get("lat_hist_n") or 0),
                **{f: int(s.get(f) or 0) for f in _HIST_FIELDS},
                **secs,
            ))
        model.objects.bulk_create(
            rows, batch_size=2000, update_conflicts=True,
            unique_fields=["target_ip", "template", "bucket"],
            update_fields=[
                "kind", "up_s", "down_s", "degraded_s", "stale_s", "unknown_s",
                "incidents", "samples", "lat_min", "lat_avg", "lat_p50", "lat_p95",
                "lat_p99", "lat_max", "spikes", "closed", "lat_hist_n", *_HIST_FIELDS,
            ],
        )
        written += len(rows)
        bucket = stop
    return written


def _count_spikes(tenant_id, since, until, base, kind_of, factor, floors) -> dict:
    """Probes slower than max(factor x baseline, baseline + floor), per check."""
    out: dict = {}
    for ip_id, tmpl_id, lat in (
        CheckResult.objects.filter(
            tenant_id=tenant_id, timestamp__gte=since, timestamp__lt=until,
            latency_ms__isnull=False, template_id__isnull=False,
        ).values_list("target_ip_id", "template_id", "latency_ms")
        .iterator(chunk_size=5000)
    ):
        key = (str(ip_id), str(tmpl_id))
        b = base.get(key)
        if not b:
            continue
        floor = floors.get(kind_of.get(key, ""), DEFAULT_FLOOR_MS)
        if lat > max(factor * b, b + floor):
            out[key] = out.get(key, 0) + 1
    return out


# ─── the periodic entry point ───────────────────────────────────────────────

#: How far back a run looks for buckets a missed run left unwritten.
CATCH_UP = {HOUR: timedelta(hours=6), DAY: timedelta(days=2)}
#: Days written before the latency histogram existed are rebuilt a few at a
#: time, but only this far back: well inside the 30 days raw results are
#: kept, so a rebuilt day always has every raw result it had.
HISTOGRAM_REACH = timedelta(days=27)
HISTOGRAM_DAYS_PER_RUN = 3


def refresh(now: datetime | None = None) -> dict:
    """Rewrite the open hour, close the hour that just ended, and write
    yesterday's day once it has ended. Cheap enough to run every few minutes.

    The open day is deliberately not kept: rewriting it would re-read a whole
    day of raw results every run. "Today so far" is the sum of today's hours.
    A bucket a missed run left open is caught up, within ``CATCH_UP``.
    """
    now = now or timezone.now()
    tenants = set(CheckState.objects.values_list("tenant_id", flat=True).distinct())
    out = {"tenants": len(tenants), "hourly": 0, "daily": 0}
    this_hour, today = _floor(now, HOUR), _floor(now, DAY)
    for t in tenants:
        start = this_hour - HOUR
        stale = CheckRollupHourly.objects.filter(
            tenant_id=t, closed=False, bucket__lt=start,
            bucket__gte=this_hour - CATCH_UP[HOUR],
        ).order_by("bucket").values_list("bucket", flat=True).first()
        out["hourly"] += roll(t, HOUR, stale or start, now, now=now)
        # Every recent day without a closed row: normally just yesterday,
        # once, on the first run after midnight.
        day = today - CATCH_UP[DAY]
        while day < today:
            if not CheckRollupDaily.objects.filter(tenant_id=t, bucket=day, closed=True).exists():
                out["daily"] += roll(t, DAY, day, day + DAY, now=now)
            day += DAY
        out["histogram_days"] = out.get("histogram_days", 0) + _fill_histograms(t, now)
    return out


def _fill_histograms(tenant_id, now: datetime) -> int:
    """Rebuild recent days whose rows have latency but no histogram - the
    rows written before 0.17 - so latency objectives read the past too.
    A few days per run, oldest first; once none are left this is one query.
    Returns the days rebuilt."""
    today = _floor(now, DAY)
    since = today - HISTOGRAM_REACH
    missing = {
        _floor(b, DAY)
        for model in (CheckRollupDaily, CheckRollupHourly)
        for b in model.objects.filter(
            tenant_id=tenant_id, bucket__gte=since, bucket__lt=today, closed=True,
            lat_p50__isnull=False, lat_hist_n=0,
        ).order_by("bucket").values_list("bucket", flat=True).distinct()[:500]
    }
    days = sorted(missing)[:HISTOGRAM_DAYS_PER_RUN]
    for day in days:
        roll(tenant_id, HOUR, day, day + DAY, now=now)
        roll(tenant_id, DAY, day, day + DAY, now=now)
    return len(days)


def backfill(days: int, now: datetime | None = None) -> dict:
    """Rebuild closed buckets from history: daily for ``days`` back (as far
    as transitions reach), hourly for as long as hourly rows are kept.
    Latency is only there as far back as raw results are."""
    from django.conf import settings

    now = now or timezone.now()
    hourly_days = min(days, int(getattr(settings, "MONITORING_ROLLUP_HOURLY_RETENTION_DAYS", 30)))
    tenants = set(CheckState.objects.values_list("tenant_id", flat=True).distinct())
    out = {"tenants": len(tenants), "hourly": 0, "daily": 0}
    for t in tenants:
        # Hourly first: the daily spike counts are not computed, but the
        # hourly ones read the baseline from earlier hours.
        out["hourly"] += roll(t, HOUR, now - timedelta(days=hourly_days), now, now=now)
        out["daily"] += roll(t, DAY, now - timedelta(days=days), _floor(now, DAY), now=now)
    return out


def prune(now: datetime | None = None) -> int:
    """Hourly rows past their retention. Daily rows are never pruned."""
    from django.conf import settings

    now = now or timezone.now()
    days = int(getattr(settings, "MONITORING_ROLLUP_HOURLY_RETENTION_DAYS", 30))
    deleted, _ = CheckRollupHourly.objects.filter(
        bucket__lt=now - timedelta(days=days)
    ).delete()
    return deleted

