"""The aggregations behind the monitoring charts.

Everything here is a GROUP BY over rows that already exist - results,
transitions, alerts - shaped for a chart. Nothing is sampled or estimated:
a latency bucket is the sample-weighted mean of every probe in it (a
fast-lane window row counts as the probes it stands for), a percentile is
PostgreSQL's ``percentile_cont`` over the bucket, an availability figure is
up over up-plus-down.

Bucket sizes follow the window so a chart has a sensible number of points
whatever the cadence: five minutes over a day, an hour over a week, six
hours over a month.
"""
from __future__ import annotations

from datetime import timedelta
from zoneinfo import ZoneInfo

from django.db.models import (
    Aggregate,
    Case,
    Count,
    F,
    FloatField,
    Func,
    Max,
    Min,
    Q,
    Sum,
    Value,
    When,
)
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast, Coalesce, ExtractHour, ExtractWeekDay, Floor, TruncDay

from .models import Alert

#: Window → bucket, in seconds.
BUCKETS = {24: 300, 168: 3600, 720: 6 * 3600}


class Percentile(Aggregate):
    """``percentile_cont(p) WITHIN GROUP (ORDER BY expr)`` - PostgreSQL only,
    which this application is."""

    function = "PERCENTILE_CONT"
    name = "percentile"
    template = "%(function)s(%(percentile)s) WITHIN GROUP (ORDER BY %(expressions)s)"
    output_field = FloatField()

    def __init__(self, expression, percentile, **extra):
        super().__init__(expression, percentile=percentile, **extra)


def _epoch(field: str):
    return Func(
        F(field), function="EXTRACT",
        template="EXTRACT(EPOCH FROM %(expressions)s)", output_field=FloatField(),
    )


def _bucket(field: str, seconds: int):
    """The bucket's start, as epoch seconds."""
    return Floor(_epoch(field) / Value(float(seconds))) * Value(float(seconds))


def _agg_num(key: str):
    """A number from a fast-lane row's ``detail.agg``, or NULL."""
    return Cast(KeyTextTransform(key, KeyTextTransform("agg", "detail")), FloatField())


def viewer_tz(request, tenant) -> ZoneInfo:
    """Day and hour boundaries in the viewer's timezone - a heatmap that
    says 03:00 must mean the operator's 03:00."""
    from auth_api.user_prefs import datetime_prefs

    try:
        return ZoneInfo(datetime_prefs(request.user, tenant).get("timezone") or "UTC")
    except Exception:  # noqa: BLE001 - a bad preference is not a chart outage
        return ZoneInfo("UTC")


def bucket_seconds(hours: int) -> int:
    return BUCKETS.get(hours, 3600)


def latency_series(qs, since, until, bucket_s: int) -> list[dict]:
    """``[{t, avg, min, max, loss, samples}]`` per bucket.

    A normal result is one probe; a fast-lane row is the probes its window
    held, with the window's own min/max and loss - so a bucket's average is
    weighted by how much each row stands for and a one-second ping and a
    five-minute one chart the same way.
    """
    samples = Coalesce(_agg_num("samples"), Value(1.0))
    lat = F("latency_ms")
    lat_min = Coalesce(_agg_num("min_ms"), lat)
    lat_max = Coalesce(_agg_num("max_ms"), lat)
    # Loss per row, in percent: a fast-lane window carries its own; a plain
    # probe is 100 when it came back down, else the ICMP loss it reported.
    loss = Coalesce(
        _agg_num("loss_pct"),
        Case(
            When(status__in=["down", "stale"], then=Value(100.0)),
            default=Coalesce(
                Cast(KeyTextTransform("packet_loss", "detail"), FloatField()) * Value(100.0),
                Value(0.0),
            ),
            output_field=FloatField(),
        ),
    )
    rows = (
        qs.filter(timestamp__gte=since, timestamp__lte=until)
        .annotate(b=_bucket("timestamp", bucket_s))
        .values("b")
        .annotate(
            n=Sum(samples),
            lat_n=Sum(Case(When(latency_ms__isnull=False, then=samples), default=Value(0.0),
                           output_field=FloatField())),
            lat_sum=Sum(Case(When(latency_ms__isnull=False, then=lat * samples),
                             default=Value(0.0), output_field=FloatField())),
            lat_min=Min(lat_min),
            lat_max=Max(lat_max),
            loss_sum=Sum(loss * samples),
        )
        .order_by("b")
    )
    out = []
    for r in rows:
        n = float(r["n"] or 0)
        lat_n = float(r["lat_n"] or 0)
        out.append({
            "t": _iso(r["b"]),
            "avg": round(r["lat_sum"] / lat_n, 2) if lat_n else None,
            "min": round(r["lat_min"], 2) if r["lat_min"] is not None else None,
            "max": round(r["lat_max"], 2) if r["lat_max"] is not None else None,
            "loss": round((r["loss_sum"] or 0) / n, 1) if n else 0,
            "samples": int(n),
        })
    return out


def latency_percentiles(qs, since, until, bucket_s: int) -> list[dict]:
    """``[{t, p50, p95}]`` per bucket across every result in ``qs`` - the
    estate's latency, not one host's. Row-weighted: a fast-lane window row
    contributes its average once, which is what keeps this one query."""
    rows = (
        qs.filter(timestamp__gte=since, timestamp__lte=until, latency_ms__isnull=False)
        .annotate(b=_bucket("timestamp", bucket_s))
        .values("b")
        .annotate(p50=Percentile("latency_ms", 0.5), p95=Percentile("latency_ms", 0.95))
        .order_by("b")
    )
    return [
        {"t": _iso(r["b"]), "p50": round(r["p50"], 2) if r["p50"] is not None else None,
         "p95": round(r["p95"], 2) if r["p95"] is not None else None}
        for r in rows
    ]


def latency_by_kind(qs, since, until, bucket_s: int) -> list[dict]:
    """``[{kind, samples, series: [{t, p50, p95}]}]``, the busiest kind first.

    The estate-wide line in :func:`latency_percentiles` mixes a 1 ms ping with
    a 300 ms HTTPS fetch, and whichever kind has more checks sets the curve.
    Split by kind, each line means something. One query, like its sibling."""
    rows = (
        qs.filter(timestamp__gte=since, timestamp__lte=until, latency_ms__isnull=False)
        .annotate(b=_bucket("timestamp", bucket_s))
        .values("kind", "b")
        .annotate(
            n=Count("id"),
            p50=Percentile("latency_ms", 0.5),
            p95=Percentile("latency_ms", 0.95),
        )
        .order_by("kind", "b")
    )
    out: dict = {}
    for r in rows:
        k = out.setdefault(r["kind"], {"kind": r["kind"], "samples": 0, "series": []})
        k["samples"] += r["n"]
        k["series"].append({
            "t": _iso(r["b"]),
            "p50": round(r["p50"], 2) if r["p50"] is not None else None,
            "p95": round(r["p95"], 2) if r["p95"] is not None else None,
        })
    return sorted(out.values(), key=lambda k: (-k["samples"], k["kind"]))


def transition_heatmap(qs, tz: ZoneInfo) -> list[dict]:
    """``[{dow, hour, n}]`` - when changes happen, in the viewer's week.
    ``dow`` is 0 = Monday."""
    rows = (
        qs.annotate(dow=ExtractWeekDay("at", tzinfo=tz), hour=ExtractHour("at", tzinfo=tz))
        .values("dow", "hour")
        .annotate(n=Count("id"))
    )
    # Django's ExtractWeekDay is 1 = Sunday … 7 = Saturday.
    return [
        {"dow": (int(r["dow"]) + 5) % 7, "hour": int(r["hour"]), "n": r["n"]}
        for r in rows
    ]


def transition_top(qs, limit: int = 10) -> list[dict]:
    """The addresses and checks that changed most in the window."""
    rows = (
        qs.values("target_ip_id", "target_ip__ip_address", "target_ip__dns_name",
                  "template_id", "template__name", "kind")
        .annotate(n=Count("id"), bad=Count("id", filter=_bad()))
        .order_by("-n", "target_ip__ip_address")[:limit]
    )
    return [
        {
            "ip_id": str(r["target_ip_id"]),
            "ip_address": r["target_ip__ip_address"],
            "dns_name": r["target_ip__dns_name"] or None,
            "template_id": str(r["template_id"]) if r["template_id"] else None,
            "template_name": r["template__name"] or r["kind"],
            "changes": r["n"],
            "bad": r["bad"],
        }
        for r in rows
    ]


def _bad():
    return Q(to_status__in=["down", "degraded", "stale"])


def alerts_per_day(tenant, since, until, tz: ZoneInfo, ip_filter=None) -> list[dict]:
    """``[{t, opened, resolved}]`` per day - whether you are keeping up."""
    base = Alert.objects.filter(tenant=tenant)
    if ip_filter is not None:
        base = base.filter(target_ip__in=ip_filter)
    opened = {
        r["d"]: r["n"]
        for r in base.filter(opened_at__gte=since, opened_at__lte=until)
        .annotate(d=TruncDay("opened_at", tzinfo=tz)).values("d").annotate(n=Count("id"))
    }
    resolved = {
        r["d"]: r["n"]
        for r in base.filter(resolved_at__gte=since, resolved_at__lte=until)
        .annotate(d=TruncDay("resolved_at", tzinfo=tz)).values("d").annotate(n=Count("id"))
    }
    days = sorted(set(opened) | set(resolved))
    return [
        {"t": d.isoformat(), "opened": opened.get(d, 0), "resolved": resolved.get(d, 0)}
        for d in days
    ]


def per_day(segments, since, until, tz: ZoneInfo) -> list[dict]:
    """Daily availability from a run of segments: ``[{date, uptime_pct,
    up_s, down_s, incidents}]``, days in the viewer's calendar. A day with
    nothing measured (all unknown) has ``uptime_pct: None``."""
    from .timeline import integrate

    up, down = {"up", "degraded"}, {"down", "stale"}
    out = []
    day = since.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    while day < until:
        nxt = day + timedelta(days=1)
        lo, hi = max(day, since), min(nxt, until)
        clipped = [
            {"start": max(s["start"], lo), "end": min(s["end"], hi), "status": s["status"]}
            for s in segments
            if s["end"] > lo and s["start"] < hi
        ]
        totals = integrate(clipped, up=up, down=down)
        measured = totals["up"] + totals["down"]
        out.append({
            "date": day.date().isoformat(),
            "uptime_pct": round(100.0 * totals["up"] / measured, 2) if measured else None,
            "up_s": round(totals["up"]),
            "down_s": round(totals["down"]),
            "incidents": totals["incidents"],
        })
        day = nxt
    return out


def _iso(epoch) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(float(epoch), tz=UTC).isoformat()


__all__ = [
    "alerts_per_day",
    "bucket_seconds",
    "latency_percentiles",
    "latency_series",
    "per_day",
    "transition_heatmap",
    "transition_top",
    "viewer_tz",
]
