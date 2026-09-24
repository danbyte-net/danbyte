"""SLA figures: from status changes to an agreement's number for a period.

Per check → per object → per unit → per agreement:

* **check**: its status segments (:func:`monitoring.timeline.segments_for_pairs`)
  classified by the agreement's counting rules, cut to service hours and the
  member's time in the agreement, minus maintenance and exclusions, with
  short outages forgiven (:mod:`monitoring.sla_time`);
* **object**: its counted checks combined - *all must pass* (down while any
  is down) or *weighted* (the weighted mean of their seconds, a required
  check's down time always counting);
* **unit**: a member, or a redundancy group of members, which is down only
  while all of them are;
* **agreement**: the units' time-weighted mean (sum up / sum measured), or
  the worst unit.

Every figure carries its coverage - measured time over service time - and
the agreement carries an error budget: the down time the target allows over
the whole period, and how much of it is spent.

Results are stored per period in :class:`SlaPeriodResult`; :func:`refresh`
keeps the open period current, closes the one that ended, recomputes it
while exclusions may still be added, and freezes it after ``GRACE``.
"""
from __future__ import annotations

import fnmatch
import logging
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from . import sla_time as st
from .timeline import segments_for_pairs

log = logging.getLogger("monitoring.sla")

#: How long after a period ends exclusions may still be added.
GRACE = timedelta(days=7)
#: Maintenance events in these states never happened, or were never agreed.
_NOT_MAINTENANCE = ("cancelled", "rescheduled", "tentative")
MAX_INCIDENTS = 500


# ─── periods ────────────────────────────────────────────────────────────────


def agreement_tz(agreement) -> str:
    if agreement.timezone:
        return agreement.timezone
    try:
        from core.effective_settings import effective_datetime_values

        tz = effective_datetime_values(agreement.tenant).get("timezone")
    except Exception:  # noqa: BLE001 - a settings hiccup must not stop figures
        tz = None
    return tz or settings.TIME_ZONE or "UTC"


def period_for(agreement, when: datetime) -> tuple[str, datetime, datetime]:
    """``(key, start, end)`` of the period containing ``when``."""
    p = agreement.period
    if p.startswith("rolling_"):
        days = int(p.split("_")[1])
        return "rolling", when - timedelta(days=days), when
    zone = ZoneInfo(agreement_tz(agreement))
    local = when.astimezone(zone)
    y, m = local.year, local.month
    if p == "year":
        a, b, key = date(y, 1, 1), date(y + 1, 1, 1), f"{y}"
    elif p == "quarter":
        q = (m - 1) // 3
        a = date(y, 3 * q + 1, 1)
        b = date(y + 1, 1, 1) if q == 3 else date(y, 3 * q + 4, 1)
        key = f"{y}-Q{q + 1}"
    else:
        a = date(y, m, 1)
        b = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
        key = f"{y}-{m:02d}"
    return key, datetime.combine(a, time(0), zone), datetime.combine(b, time(0), zone)


def previous_period(agreement, when: datetime):
    """The calendar period before the one containing ``when``; None for a
    rolling agreement, which has no closed periods."""
    if agreement.period.startswith("rolling_"):
        return None
    _key, start, _end = period_for(agreement, when)
    return period_for(agreement, start - timedelta(microseconds=1))


def period_by_key(agreement, key: str):
    """``(key, start, end)`` for a stored key like "2026-09" or "2026-Q3"."""
    if key == "rolling":
        return period_for(agreement, timezone.now())
    zone = ZoneInfo(agreement_tz(agreement))
    try:
        if "-Q" in key:
            y, q = key.split("-Q")
            when = datetime(int(y), 3 * (int(q) - 1) + 1, 15, tzinfo=zone)
        elif "-" in key:
            y, m = key.split("-")
            when = datetime(int(y), int(m), 15, tzinfo=zone)
        else:
            when = datetime(int(key), 6, 15, tzinfo=zone)
    except ValueError:
        return None
    return period_for(agreement, when)


# ─── rules ──────────────────────────────────────────────────────────────────


def rules_for(agreement, result=None) -> dict:
    """The rules a period runs under: the revision stored on its result once
    it is closed, else the agreement's current ones."""
    if result is not None and result.revision != agreement.revision:
        rev = agreement.revisions.filter(number=result.revision).first()
        if rev is not None:
            return rev.rules
    return agreement.rules()


def _time_rules(r: dict) -> st.Rules:
    return st.Rules(
        degraded=st.DOWN if r.get("count_degraded_as") == "down" else st.UP,
        stale=st.DOWN if r.get("count_stale_as") == "down" else st.UNMEASURED,
        unknown=st.DOWN if r.get("count_unknown_as") == "down" else st.UNMEASURED,
    )


# ─── members ────────────────────────────────────────────────────────────────


def _selector_devices(group):
    """Devices a group's selector matches (empty when it has no selector)."""
    from api.models import Device

    if not group.use_selector:
        return []
    qs = Device.objects.filter(tenant_id=group.tenant_id)
    sites = list(group.match_sites.values_list("pk", flat=True))
    roles = list(group.match_roles.values_list("pk", flat=True))
    types = list(group.match_device_types.values_list("pk", flat=True))
    platforms = list(group.match_platforms.values_list("pk", flat=True))
    if not (sites or roles or types or platforms or group.match_tags or group.match_name):
        return []  # a selector with nothing set must not mean "every device"
    if sites:
        qs = qs.filter(site_id__in=sites)
    if roles:
        qs = qs.filter(role_id__in=roles)
    if types:
        qs = qs.filter(device_type_id__in=types)
    if platforms:
        qs = qs.filter(platform_id__in=platforms)
    for slug in group.match_tags or []:
        qs = qs.filter(tags__slug=slug)
    devices = list(qs.distinct().only("id", "name", "site_id", "primary_ip_id"))
    if group.match_name:
        pat = group.match_name.lower()
        devices = [d for d in devices if fnmatch.fnmatch((d.name or "").lower(), pat)]
    return devices


def resolve_members(agreement, start: datetime, end: datetime) -> list[dict]:
    """Every member in the agreement at some point in ``[start, end)``:
    explicit ones (minus those that left before) and selector matches (minus
    explicit exclusions). Each with the part of the period it was in."""
    from .models import SlaMember

    rows = list(
        SlaMember.objects.filter(agreement=agreement)
        .filter(Q(left_at__isnull=True) | Q(left_at__gt=start))
        .filter(joined_at__lt=end)
        .select_related("group")
    )
    excluded = {(m.group_id, m.object_type, m.object_id) for m in rows if m.excluded}
    out = []
    seen = set()
    for m in rows:
        if m.excluded:
            continue
        seen.add((m.group_id, m.object_type, m.object_id))
        out.append({
            "member_id": str(m.id), "group": m.group, "object_type": m.object_type,
            "object_id": m.object_id, "site_id": m.object_site_id,
            "redundancy_group": m.redundancy_group,
            "active": (max(start, m.joined_at), min(end, m.left_at or end)),
        })
    for group in agreement.check_groups.all():
        for d in _selector_devices(group):
            key = (group.id, "api.device", d.id)
            if key in seen or key in excluded:
                continue
            seen.add(key)
            out.append({
                "member_id": None, "group": group, "object_type": "api.device",
                "object_id": d.id, "site_id": d.site_id, "redundancy_group": "",
                "active": (start, end),
            })
    return out


def _objects(members) -> dict:
    """``{(object_type, id): object}`` for names, sites and addresses."""
    from api.models import Device, IPAddress, VirtualMachine

    by_type = defaultdict(set)
    for m in members:
        by_type[m["object_type"]].add(m["object_id"])
    out = {}
    for label, model in (
        ("api.device", Device), ("api.virtualmachine", VirtualMachine),
        ("api.ipaddress", IPAddress),
    ):
        if by_type[label]:
            for o in model.objects.filter(pk__in=by_type[label]):
                out[(label, o.pk)] = o
    return out


def _addresses(members, objects) -> dict:
    """``{(object_type, id, target): [ip_id, ...]}`` - the addresses whose
    checks stand for each object."""
    from api.models import IPAddress

    need_all = defaultdict(set)
    for m in members:
        if m["group"].target == "all" and m["object_type"] != "api.ipaddress":
            need_all[m["object_type"]].add(m["object_id"])
    all_ips = defaultdict(list)
    if need_all["api.device"]:
        for ip_id, dev_id in IPAddress.objects.filter(
            assigned_device_id__in=need_all["api.device"]
        ).values_list("id", "assigned_device_id"):
            all_ips[("api.device", dev_id)].append(ip_id)
    if need_all["api.virtualmachine"]:
        for ip_id, vm_id in IPAddress.objects.filter(
            assigned_vm_id__in=need_all["api.virtualmachine"]
        ).values_list("id", "assigned_vm_id"):
            all_ips[("api.virtualmachine", vm_id)].append(ip_id)
    out = {}
    for m in members:
        key = (m["object_type"], m["object_id"])
        o = objects.get(key)
        if o is None:
            ips = []
        elif m["object_type"] == "api.ipaddress":
            ips = [o.pk]
        elif m["group"].target == "all":
            ips = all_ips.get(key, [])
        else:
            ips = [o.primary_ip_id] if getattr(o, "primary_ip_id", None) else []
        out[(m["object_type"], m["object_id"], m["group"].target)] = ips
    return out


def _name(o, object_type) -> str:
    if o is None:
        return "(deleted)"
    if object_type == "api.ipaddress":
        return str(o.ip_address)
    return o.name or str(o.pk)


# ─── excused time ───────────────────────────────────────────────────────────


def _maintenance(agreement, start, end, members, objects) -> dict:
    """``{(object_type, id): [(start, end)]}`` of planned maintenance on each
    member - on the device itself, or the device an address sits on."""
    from .models import EventImpact

    device_of = {}
    for m in members:
        o = objects.get((m["object_type"], m["object_id"]))
        if m["object_type"] == "api.device":
            device_of[(m["object_type"], m["object_id"])] = m["object_id"]
        elif m["object_type"] == "api.ipaddress" and o is not None and o.assigned_device_id:
            device_of[(m["object_type"], m["object_id"])] = o.assigned_device_id
    if not device_of:
        return {}
    windows = defaultdict(list)
    for dev_id, s, e in (
        EventImpact.objects.filter(
            tenant_id=agreement.tenant_id, object_type="api.device",
            object_id__in=set(device_of.values()),
            event__kind="maintenance", event__starts_at__lt=end,
        )
        .exclude(level="no_impact")
        .exclude(event__status__slug__in=_NOT_MAINTENANCE)
        .filter(Q(event__ends_at__isnull=True) | Q(event__ends_at__gt=start))
        .values_list("object_id", "event__starts_at", "event__ends_at")
    ):
        windows[dev_id].append((s, e or end))
    return {
        key: st.normalize(windows[dev]) for key, dev in device_of.items() if windows.get(dev)
    }


def _exclusions(agreement, start, end) -> tuple[list, dict]:
    """Agreement-wide excluded windows, and per member id."""
    from .models import SlaExclusion

    everyone, per = [], defaultdict(list)
    for member_id, s, e in SlaExclusion.objects.filter(
        agreement=agreement, starts_at__lt=end, ends_at__gt=start
    ).values_list("member_id", "starts_at", "ends_at"):
        (per[str(member_id)] if member_id else everyone).append((s, e))
    return st.normalize(everyone), {k: st.normalize(v) for k, v in per.items()}


# ─── the computation ────────────────────────────────────────────────────────


def _figure(up: float, down: float, service: float) -> dict:
    measured = up + down
    return {
        "availability": round(100 * up / measured, 4) if measured else None,
        "coverage": round(100 * measured / service, 2) if service else None,
    }


def compute(agreement, start: datetime, end: datetime, *, rules: dict | None = None,
            now: datetime | None = None) -> dict:
    """The agreement's figures over ``[start, end)``, up to ``now``."""
    from .models import CheckState, SlaCheckItem

    now = now or timezone.now()
    rules = rules or agreement.rules()
    tz = rules.get("timezone") or agreement_tz(agreement)
    target = float(rules["target_pct"])
    warning = float(rules["warning_pct"]) if rules.get("warning_pct") not in (None, "") else None
    if rules.get("effective_from"):
        eff = datetime.combine(date.fromisoformat(str(rules["effective_from"])), time(0), ZoneInfo(tz))
        start = max(start, eff)
    until = min(end, now)
    holidays = []
    if rules.get("holiday_calendar_id"):
        from .models import HolidayCalendar

        cal = HolidayCalendar.objects.filter(pk=rules["holiday_calendar_id"]).first()
        holidays = cal.dates if cal else []
    weekly = rules.get("service_hours") or None
    full_service = st.total(st.service_windows(start, end, tz, weekly, holidays)) if end > start else 0
    base = {
        "target": target, "warning": warning, "since": start.isoformat(),
        "until": until.isoformat(), "period_end": end.isoformat(),
    }
    if until <= start:
        return {"figures": {**base, "state": "not_started"}, "units": [], "incidents": [], "days": []}

    service = st.service_windows(start, until, tz, weekly, holidays)
    time_rules = _time_rules(rules)
    grace = int(rules.get("min_outage_seconds") or 0)

    members = resolve_members(agreement, start, until)
    objects = _objects(members)
    addresses = _addresses(members, objects)
    groups = {m["group"].id: m["group"] for m in members}
    items = defaultdict(list)
    for it in SlaCheckItem.objects.filter(group_id__in=groups).select_related("template"):
        items[it.group_id].append(it)
    # A group without items counts every check its members' addresses have.
    all_ips = {ip for ips in addresses.values() for ip in ips}
    states = defaultdict(list)
    for ip_id, tmpl_id, tname, kind in CheckState.objects.filter(
        tenant_id=agreement.tenant_id, target_ip_id__in=all_ips
    ).values_list("target_ip_id", "template_id", "template__name", "kind"):
        states[ip_id].append((tmpl_id, tname, kind))

    plan = []  # per member: [(ip, template_id, name, kind, counts, weight, required)]
    pairs = set()
    for m in members:
        ips = addresses[(m["object_type"], m["object_id"], m["group"].target)]
        checks = []
        for ip in ips:
            if items[m["group"].id]:
                for it in items[m["group"].id]:
                    checks.append((ip, it.template_id, it.template.name, it.template.kind,
                                   it.counts, it.weight, it.required))
            else:
                for tmpl_id, tname, kind in states.get(ip, []):
                    checks.append((ip, tmpl_id, tname, kind, True, 1.0, False))
        pairs.update((c[0], c[1]) for c in checks)
        plan.append(checks)

    segments = segments_for_pairs(agreement.tenant_id, pairs, start, until) if pairs else {}
    maint = (
        _maintenance(agreement, start, until, members, objects)
        if rules.get("exclude_maintenance", True) else {}
    )
    everyone_off, member_off = _exclusions(agreement, start, until)

    member_rows = []
    timelines = {}
    for m, checks in zip(members, plan, strict=True):
        key = (m["object_type"], m["object_id"])
        excused = st.normalize(
            everyone_off + maint.get(key, []) + member_off.get(m["member_id"] or "", [])
        )
        window = st.subtract(
            st.normalize(
                (max(a, m["active"][0]), min(b, m["active"][1])) for a, b in service
            ),
            excused,
        )
        service_s = st.total(window)
        item_rows, counted = [], []
        for ip, tmpl_id, tname, kind, counts, weight, required in checks:
            segs = segments.get((str(ip), str(tmpl_id)), [])
            tl = st.apply_grace(st.restrict(st.classify(segs, time_rules), window), grace)
            t = st.tally(tl)
            item_rows.append({
                "template_id": str(tmpl_id), "name": tname, "kind": kind, "ip_id": str(ip),
                "counts": counts, "incidents": t["incidents"], "down_s": round(t["down_s"]),
                **_figure(t["up_s"], t["down_s"], service_s),
            })
            if counts:
                counted.append((tl, t, weight, required))
        if not counted:
            tl = [(a, b, st.UNMEASURED) for a, b in window]
            t = st.tally(tl)
        elif m["group"].combine == "weighted":
            tl = st.combine([c[0] for c in counted], "all")  # for redundancy and days
            wsum = sum(c[2] for c in counted) or 1.0
            up = sum(c[1]["up_s"] * c[2] for c in counted) / wsum
            down = sum(c[1]["down_s"] * c[2] for c in counted) / wsum
            req = [c[0] for c in counted if c[3]]
            if req:
                down = max(down, st.tally(st.combine(req, "all"))["down_s"])
                up = min(up, max(0.0, service_s - down))
            t = {**st.tally(tl), "up_s": up, "down_s": down,
                 "unmeasured_s": max(0.0, service_s - up - down)}
        else:
            tl = st.combine([c[0] for c in counted], "all")
            t = st.tally(tl)
        timelines[m["member_id"] or f"sel:{m['group'].id}:{m['object_id']}"] = tl
        worst = min(
            (i for i in item_rows if i["counts"] and i["availability"] is not None),
            key=lambda i: i["availability"], default=None,
        )
        member_rows.append({
            "member_id": m["member_id"],
            "key": m["member_id"] or f"sel:{m['group'].id}:{m['object_id']}",
            "object_type": m["object_type"], "object_id": str(m["object_id"]),
            "name": _name(objects.get(key), m["object_type"]),
            "site_id": str(m["site_id"]) if m["site_id"] else None,
            "group_id": str(m["group"].id), "group": m["group"].name,
            "redundancy_group": m["redundancy_group"], "selected": m["member_id"] is None,
            "up_s": round(t["up_s"]), "down_s": round(t["down_s"]),
            "unmeasured_s": round(t["unmeasured_s"]), "service_s": round(service_s),
            "incidents": t["incidents"], "items": item_rows,
            "worst_item": worst["name"] if worst else None,
            **_figure(t["up_s"], t["down_s"], service_s),
        })

    # Units: a redundancy group is one unit, down only while all are down.
    by_unit = defaultdict(list)
    for row in member_rows:
        by_unit[f"rg:{row['redundancy_group']}" if row["redundancy_group"] else row["key"]].append(row)
    units = []
    unit_tls = {}
    for ukey, rows in by_unit.items():
        if len(rows) == 1 and not ukey.startswith("rg:"):
            r = rows[0]
            up, down, service_s, incidents = r["up_s"], r["down_s"], r["service_s"], r["incidents"]
            tl = timelines[r["key"]]
        else:
            tl = st.combine([timelines[r["key"]] for r in rows], "any")
            t = st.tally(tl)
            up, down, incidents = t["up_s"], t["down_s"], t["incidents"]
            service_s = max(r["service_s"] for r in rows)
        unit_tls[ukey] = tl
        units.append({
            "key": ukey, "label": ukey[3:] if ukey.startswith("rg:") else rows[0]["name"],
            "members": [r["key"] for r in rows],
            "up_s": round(up), "down_s": round(down), "service_s": round(service_s),
            "incidents": incidents, **_figure(up, down, service_s),
        })

    figures = headline(units, rules, full_service, start, until, end)
    figures.update(base)
    figures["members"] = len(member_rows)
    figures["full_service_s"] = round(full_service)
    return {
        "figures": figures,
        "units": units + [{"member": True, **r} for r in member_rows],
        "incidents": _incidents(unit_tls, units, member_rows, timelines),
        "days": _days(unit_tls, service, tz, rules.get("aggregation", "mean")),
    }


def headline(units, rules, full_service, start, until, end) -> dict:
    """The agreement's figure from its units. Also used to recompute a
    partial figure over the units a scoped viewer may see."""
    target = float(rules["target_pct"])
    warning = rules.get("warning_pct")
    warning = float(warning) if warning not in (None, "") else None
    measured = [u for u in units if u["up_s"] + u["down_s"] > 0]
    service = sum(u["service_s"] for u in units)
    if rules.get("aggregation") == "worst":
        worst = min(measured, key=lambda u: u["availability"], default=None)
        availability = worst["availability"] if worst else None
        used = max((u["down_s"] for u in units), default=0)
    else:
        up = sum(u["up_s"] for u in measured)
        down = sum(u["down_s"] for u in measured)
        availability = round(100 * up / (up + down), 4) if up + down else None
        used = down / len(units) if units else 0
    covered = sum(u["up_s"] + u["down_s"] for u in units)
    budget = (1 - target / 100) * full_service
    elapsed = (until - start).total_seconds() / max(1.0, (end - start).total_seconds())
    spent = used / budget if budget else (1.0 if used else 0.0)
    if availability is None:
        state = "no_data"
    elif availability < target:
        state = "breached"
    elif (warning is not None and availability < warning) or (warning is None and spent >= 0.75):
        state = "at_risk"
    else:
        state = "ok"
    return {
        "availability": availability,
        "coverage": round(100 * covered / service, 2) if service else None,
        "state": state,
        "units": len(units),
        "down_s": round(used),
        "budget_s": round(budget),
        "budget_left_s": round(budget - used),
        "budget_spent_pct": round(100 * spent, 1),
        "elapsed_pct": round(100 * min(1.0, elapsed), 1),
        # Spending faster than time passes: above 1.0 ends the period over budget.
        "burn_rate": round(spent / elapsed, 2) if elapsed > 0 else None,
        "incidents": sum(u["incidents"] for u in units),
    }


def partial(result, visible_units: list, rules: dict) -> dict:
    """The headline over only the units a scoped viewer may see."""
    f = result.figures
    parse = datetime.fromisoformat
    out = headline(
        visible_units, rules, f.get("full_service_s") or 0,
        parse(f["since"]), parse(f["until"]), parse(f["period_end"]),
    )
    out["members"] = sum(len(u["members"]) for u in visible_units)
    return {**f, **out}


def _incidents(unit_tls, units, member_rows, timelines) -> list[dict]:
    """Each run of unit down time, newest first, with the checks that were
    down as it began."""
    by_key = {r["key"]: r for r in member_rows}
    label = {u["key"]: u["label"] for u in units}
    members_of = {u["key"]: u["members"] for u in units}
    out = []
    for ukey, tl in unit_tls.items():
        for a, b in st.down_runs(tl):
            causes = []
            for mkey in members_of[ukey]:
                for s, e, c in timelines.get(mkey, []):
                    if c == st.DOWN and s <= a < e:
                        causes.append(by_key[mkey]["name"])
                        break
            out.append({
                "unit": ukey, "label": label[ukey], "start": a.isoformat(),
                "end": b.isoformat(), "seconds": round((b - a).total_seconds()),
                "members": sorted(causes),
            })
    out.sort(key=lambda x: x["start"], reverse=True)
    return out[:MAX_INCIDENTS]


def _days(unit_tls, service, tz, aggregation) -> list[dict]:
    """Availability per local day across the units."""
    zone = ZoneInfo(tz)
    per_day: dict = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for ukey, tl in unit_tls.items():
        for s, e, c in tl:
            cur = s
            while cur < e:
                local = cur.astimezone(zone)
                nxt = datetime.combine(local.date() + timedelta(days=1), time(0), zone)
                hi = min(e, nxt)
                n = (hi - cur).total_seconds()
                if c == st.UP:
                    per_day[local.date()][ukey][0] += n
                elif c == st.DOWN:
                    per_day[local.date()][ukey][1] += n
                cur = hi
    out = []
    for d in sorted(per_day):
        vals = per_day[d].values()
        if aggregation == "worst":
            avs = [100 * u / (u + dn) for u, dn in vals if u + dn]
            av = round(min(avs), 4) if avs else None
        else:
            up = sum(v[0] for v in vals)
            down = sum(v[1] for v in vals)
            av = round(100 * up / (up + down), 4) if up + down else None
        out.append({"date": d.isoformat(), "availability": av,
                    "down_s": round(sum(v[1] for v in vals))})
    return out


# ─── storage ────────────────────────────────────────────────────────────────


def store(agreement, key: str, start, end, *, state: str, now=None, result=None):
    """Compute and write one period's result."""
    from .models import SlaPeriodResult

    now = now or timezone.now()
    rules = rules_for(agreement, result)
    data = compute(agreement, start, end, rules=rules, now=now)
    defaults = {
        "tenant_id": agreement.tenant_id, "period_start": start, "period_end": end,
        "state": state, "figures": data["figures"], "units": data["units"],
        "incidents": data["incidents"], "days": data["days"], "computed_at": now,
    }
    if result is None:
        defaults["revision"] = agreement.revision
    if state == "closed" and (result is None or result.closed_at is None):
        defaults["closed_at"] = now
    if state == "frozen":
        defaults["frozen_at"] = now
    obj, _ = SlaPeriodResult.objects.update_or_create(
        agreement=agreement, period_key=key, defaults=defaults
    )
    return obj


def refresh_agreement(agreement, now=None) -> list:
    """Bring an agreement's stored results up to date. Frozen results are
    never recomputed."""
    from .models import SlaPeriodResult

    now = now or timezone.now()
    done = []
    key, start, end = period_for(agreement, now)
    existing = {
        r.period_key: r for r in SlaPeriodResult.objects.filter(agreement=agreement)
        .exclude(state="frozen")
    }
    state = "rolling" if key == "rolling" else "open"
    done.append(store(agreement, key, start, end, state=state, now=now,
                      result=existing.get(key)))
    # Every closed, unfrozen period: recompute until the grace passes, then
    # freeze. The one that just ended is created here if it is missing.
    prev = previous_period(agreement, now)
    if prev is not None and prev[0] not in existing and not SlaPeriodResult.objects.filter(
        agreement=agreement, period_key=prev[0]
    ).exists():
        existing[prev[0]] = None
    for pkey, res in existing.items():
        if pkey in (key, "rolling"):
            continue
        bounds = (
            (pkey, res.period_start, res.period_end) if res is not None
            else prev if prev and prev[0] == pkey else period_by_key(agreement, pkey)
        )
        if bounds is None:
            continue
        final = bounds[2] + GRACE <= now
        done.append(store(agreement, pkey, bounds[1], bounds[2],
                          state="frozen" if final else "closed", now=now, result=res))
    return done


def refresh(now=None) -> dict:
    """Every active agreement, every tenant. Re-reads each agreement from the
    database - an id queued earlier may be gone or archived by now."""
    from .models import SlaAgreement

    now = now or timezone.now()
    n = failed = 0
    for agreement in SlaAgreement.objects.filter(status="active").select_related("tenant"):
        try:
            refresh_agreement(agreement, now)
            n += 1
        except Exception:  # noqa: BLE001 - one broken agreement must not stop the rest
            failed += 1
            log.exception("SLA refresh failed for agreement %s", agreement.pk)
    return {"agreements": n, "failed": failed}
