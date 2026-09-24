"""The SLA analysis view: one agreement over any window, sliced any way.

Computed live from status changes (monitoring.sla.compute with ``detail``),
never from the stored period result, so every filter and bucket size works:
a group, a site, one member, one check kind, a redundancy group; per day or
per hour. What comes back is shaped for charts:

* ``series`` - availability, down time and incidents per bucket;
* ``burn`` - error budget spent against the pace that would spend it exactly;
* ``by_member`` / ``by_group`` / ``by_site`` / ``by_kind`` - where the down
  time went;
* ``strips`` - each member's up / down / unmeasured runs, for a timeline;
* ``heatmap`` - down time by weekday and hour, to show patterns;
* ``durations`` - incidents bucketed by length, and the mean time to recover;
* ``latency`` - p95 per check kind per bucket, against the objectives;
* ``options`` - what the filter rail can offer, unfiltered.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from . import sla
from . import sla_time as st

DURATION_BUCKETS = [
    ("< 5 min", 5 * 60), ("5-30 min", 30 * 60), ("30 min-2 h", 2 * 3600),
    ("2-8 h", 8 * 3600), ("> 8 h", None),
]
MAX_STRIPS = 150


def _av(up, down):
    return round(100 * up / (up + down), 4) if up + down else None


def _bounds(start, until, tz, bucket):
    zone = ZoneInfo(tz)
    local = start.astimezone(zone)
    if bucket == "hour":
        cur = local.replace(minute=0, second=0, microsecond=0)
        step = timedelta(hours=1)
    else:
        cur = datetime.combine(local.date(), time(0), zone)
        step = None
    out = []
    while cur < until:
        nxt = cur + step if step else datetime.combine(cur.date() + timedelta(days=1), time(0), zone)
        out.append((max(cur, start), min(nxt, until)))
        cur = nxt
    return out


def _split(tl, bounds):
    """``[[up, down, unmeasured] per bucket]`` for one timeline."""
    acc = [[0.0, 0.0, 0.0] for _ in bounds]
    i = 0
    for s, e, c in tl:
        while i < len(bounds) and bounds[i][1] <= s:
            i += 1
        j = i
        while j < len(bounds) and bounds[j][0] < e:
            lo, hi = max(s, bounds[j][0]), min(e, bounds[j][1])
            if hi > lo:
                acc[j][0 if c == st.UP else 1 if c == st.DOWN else 2] += (hi - lo).total_seconds()
            j += 1
    return acc


def options(agreement, now) -> dict:
    """The filter rail's choices - from the agreement's current members."""
    from api.models import Site

    members = sla.resolve_members(agreement, now - timedelta(days=1), now)
    objects = sla._objects(members)
    groups, sites, redundancy, rows = {}, defaultdict(int), defaultdict(int), []
    kinds = set()
    for g in agreement.check_groups.prefetch_related("items__template"):
        for it in g.items.all():
            kinds.add(it.template.kind)
    for m in members:
        g = m["group"]
        groups.setdefault(str(g.id), {"id": str(g.id), "name": g.name, "count": 0})["count"] += 1
        if m["site_id"]:
            sites[str(m["site_id"])] += 1
        if m["redundancy_group"]:
            redundancy[m["redundancy_group"]] += 1
        rows.append({
            "id": str(m["object_id"]), "object_type": m["object_type"],
            "name": sla._name(objects.get((m["object_type"], m["object_id"])), m["object_type"]),
        })
    names = {str(k): v for k, v in Site.objects.filter(pk__in=list(sites)).values_list("pk", "name")}
    return {
        "groups": sorted(groups.values(), key=lambda x: x["name"]),
        "sites": sorted(
            ({"id": k, "name": names.get(k, k), "count": n} for k, n in sites.items()),
            key=lambda x: str(x["name"]),
        ),
        "members": sorted(rows, key=lambda x: x["name"]),
        "kinds": sorted(kinds),
        "redundancy": [{"name": k, "count": n} for k, n in sorted(redundancy.items())],
    }


def _site_names(ids):
    from api.models import Site

    return {str(k): v for k, v in Site.objects.filter(pk__in=ids).values_list("pk", "name")}


def analyse(agreement, start, end, *, rules=None, filters=None, bucket="day", now=None) -> dict:
    from django.utils import timezone

    now = now or timezone.now()
    rules = rules or agreement.rules()
    data = sla.compute(agreement, start, end, rules=rules, now=now, filters=filters, detail=True)
    figures = data["figures"]
    detail = data.get("_detail")
    body = {"figures": figures, "bucket": bucket, "since": start.isoformat(),
            "until": min(end, now).isoformat(), "period_end": end.isoformat()}
    if detail is None:
        return {**body, "series": [], "burn": [], "by_member": [], "by_group": [],
                "by_site": [], "by_kind": [], "strips": [], "heatmap": [],
                "durations": [], "latency": [], "incidents": [], "objectives": []}

    tz = detail["tz"]
    zone = ZoneInfo(tz)
    unit_tls = detail["unit_tls"]
    members = [u for u in data["units"] if u.get("member")]
    worst = rules.get("aggregation") == "worst"
    bounds = _bounds(detail["start"], detail["until"], tz, bucket)
    # "All must be up": the series is one timeline, down while any unit is.
    series_tls = (
        {"all": st.combine(list(unit_tls.values()), "all")}
        if rules.get("aggregation") == "all" else unit_tls
    )

    # ── series and burn-down ────────────────────────────────────────────────
    per_unit = {k: _split(tl, bounds) for k, tl in series_tls.items()}
    series, burn = [], []
    starts = [datetime.fromisoformat(i["start"]) for i in data["incidents"]]
    spent = defaultdict(float)
    budget = figures.get("budget_s") or 0
    span = (detail["end"] - detail["start"]).total_seconds() or 1
    n_units = max(1, len(per_unit))
    for i, (lo, hi) in enumerate(bounds):
        cols = [per_unit[k][i] for k in per_unit]
        up = sum(c[0] for c in cols)
        down = sum(c[1] for c in cols)
        if worst:
            avs = [_av(c[0], c[1]) for c in cols if c[0] + c[1]]
            av = min(avs) if avs else None
        else:
            av = _av(up, down)
        for k in per_unit:
            spent[k] += per_unit[k][i][1]
        used = max(spent.values(), default=0) if worst else sum(spent.values()) / n_units
        series.append({
            "t": lo.isoformat(), "end": hi.isoformat(), "availability": av,
            "down_s": round(down / (1 if worst else n_units)),
            "measured_s": round(up + down),
            "incidents": sum(1 for t0 in starts if lo <= t0 < hi),
        })
        burn.append({
            "t": hi.isoformat(), "spent_s": round(used),
            "pace_s": round(budget * (hi - detail["start"]).total_seconds() / span),
            "budget_s": round(budget),
        })

    # ── where the down time went ────────────────────────────────────────────
    by_member = sorted(
        ({"key": m["key"], "member_id": m["member_id"], "object_type": m["object_type"],
          "object_id": m["object_id"], "name": m["name"], "group": m["group"],
          "group_id": m["group_id"], "site_id": m["site_id"], "availability": m["availability"],
          "coverage": m["coverage"], "down_s": m["down_s"], "incidents": m["incidents"],
          "worst_item": m["worst_item"], "items": m["items"]} for m in members),
        key=lambda x: (-x["down_s"], x["name"]),
    )
    agg = {"group": defaultdict(lambda: [0, 0, 0, ""]), "site": defaultdict(lambda: [0, 0, 0, ""])}
    for m in members:
        g = agg["group"][m["group_id"]]
        g[0] += m["up_s"]; g[1] += m["down_s"]; g[2] += m["incidents"]; g[3] = m["group"]  # noqa: E702
        sk = m["site_id"] or ""
        s_ = agg["site"][sk]
        s_[0] += m["up_s"]; s_[1] += m["down_s"]; s_[2] += m["incidents"]  # noqa: E702
    names = _site_names([k for k in agg["site"] if k])
    by_group = [{"key": k, "name": v[3], "availability": _av(v[0], v[1]), "down_s": v[1],
                 "incidents": v[2]} for k, v in agg["group"].items()]
    by_site = [{"key": k or None, "name": names.get(k, "No site") if k else "No site",
                "availability": _av(v[0], v[1]), "down_s": v[1], "incidents": v[2]}
               for k, v in agg["site"].items()]
    kinds = defaultdict(lambda: [0, 0, 0])
    for m in members:
        for it in m["items"]:
            if not it["counts"]:
                continue
            k = kinds[it["kind"]]
            k[0] += it.get("up_s", 0); k[1] += it["down_s"]; k[2] += it["incidents"]  # noqa: E702
    by_kind = [{"key": k, "name": k, "availability": _av(v[0], v[1]), "down_s": v[1],
                "incidents": v[2]} for k, v in kinds.items()]
    for rows in (by_group, by_site, by_kind):
        rows.sort(key=lambda x: (-x["down_s"], str(x["name"])))

    # ── strips ──────────────────────────────────────────────────────────────
    strips = []
    for m in by_member[:MAX_STRIPS]:
        tl = detail["member_tls"].get(m["key"], [])
        strips.append({
            "key": m["key"], "name": m["name"], "availability": m["availability"],
            "segments": [[s.isoformat(), e.isoformat(), c] for s, e, c in tl],
        })

    # ── when down time happens ─────────────────────────────────────────────
    heat = defaultdict(float)
    for tl in series_tls.values():
        for s, e, c in tl:
            if c != st.DOWN:
                continue
            cur = s
            while cur < e:
                local = cur.astimezone(zone)
                nxt = min(e, (local.replace(minute=0, second=0, microsecond=0)
                              + timedelta(hours=1)).astimezone(cur.tzinfo))
                heat[(local.weekday(), local.hour)] += (nxt - cur).total_seconds()
                cur = nxt
    heatmap = [{"dow": d, "hour": h, "down_s": round(v)} for (d, h), v in sorted(heat.items())]

    # ── incident lengths ────────────────────────────────────────────────────
    counts = [0] * len(DURATION_BUCKETS)
    for inc in data["incidents"]:
        for i, (_label, upper) in enumerate(DURATION_BUCKETS):
            if upper is None or inc["seconds"] < upper:
                counts[i] += 1
                break
    durations = [{"label": label, "count": c} for (label, _u), c in zip(DURATION_BUCKETS, counts, strict=True)]

    return {
        **body,
        "series": series, "burn": burn, "by_member": by_member, "by_group": by_group,
        "by_site": by_site, "by_kind": by_kind, "strips": strips, "heatmap": heatmap,
        "durations": durations, "incidents": data["incidents"],
        "latency": _latency(agreement, bounds, filters or {}, tz, bucket, rules),
        "objectives": _objectives(agreement, rules, detail["start"], detail["until"],
                                  filters or {}),
    }


def _window_ips(agreement, start, end, filters) -> set:
    """The addresses whose checks the window reads: every member's, or only
    those the filters keep - by group, site, member or redundancy group, and
    never a member a limited viewer can't see."""
    narrowing = ("group", "site", "member", "redundancy", "visible")
    if not any(filters.get(k) is not None and filters.get(k) != [] for k in narrowing):
        return sla.member_ip_ids([agreement.id])
    members = [m for m in sla.resolve_members(agreement, start, end)
               if sla._keep_member(m, filters)]
    objs = sla._objects(members)
    return {ip for v in sla._addresses(members, objs).values() for ip in v}


def _objectives(agreement, rules, start, until, filters) -> list[dict]:
    from . import sla_objectives

    objectives = rules.get("objectives") or []
    if filters.get("kind"):
        objectives = [o for o in objectives if o["kind"] in filters["kind"]]
    if not objectives:
        return []
    ips = _window_ips(agreement, start, until, filters)
    return sla_objectives.evaluate(agreement.tenant_id, objectives, ips, start, until)


def _latency(agreement, bounds, filters, tz, bucket, rules=None) -> list[dict]:
    """p95 per kind per bucket over the (filtered) members' checks."""
    from .figures import _aggregates, _fold, figures, share_within
    from .models import CheckRollupDaily, CheckRollupHourly

    if not bounds:
        return []
    ips = _window_ips(agreement, bounds[0][0], bounds[-1][1], filters)
    if not ips:
        return []
    model = CheckRollupHourly if bucket == "hour" else CheckRollupDaily
    qs = model.objects.filter(
        tenant_id=agreement.tenant_id, target_ip_id__in=ips,
        bucket__gte=bounds[0][0], bucket__lt=bounds[-1][1],
    )
    if filters.get("kind"):
        qs = qs.filter(kind__in=filters["kind"])
    acc: dict = defaultdict(dict)
    for row in qs.values("kind", "bucket").annotate(**_aggregates()).order_by():
        acc[row["kind"]].setdefault(row["bucket"], {})
        _fold(acc[row["kind"]][row["bucket"]], row)
    objectives = agreement.latency_objectives or {}
    # Each latency objective on a kind: its share within the threshold, per bucket.
    within = defaultdict(list)
    for o in (rules or {}).get("objectives") or []:
        within[o["kind"]].append(o)
    return [
        {"kind": kind, "objective": objectives.get(kind),
         "objectives": [{"threshold_ms": o["threshold_ms"], "target_pct": o["target_pct"]}
                        for o in within[kind]],
         "points": [{"t": b.isoformat(), "p95": figures(r)["p95"], "p50": figures(r)["p50"],
                     "within": {str(o["threshold_ms"]): share_within(r, o["threshold_ms"])
                                for o in within[kind]}}
                    for b, r in sorted(points.items())]}
        for kind, points in sorted(acc.items())
    ]
