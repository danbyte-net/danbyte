"""Live interface traffic: bps rates from the stored SNMP counter samples.

Every SNMP poll - Poll now, the scheduled polls (``snmp_schedule``), an
Outpost's ingest - appends one ``SnmpInterfaceSample`` per interface with the
HC octet counters. The rate is the difference of an interface's last two
samples: ``Δoctets · 8 / Δt``, in and out, with the speed the agent reported
(ifHighSpeed) on the newer one.

The resolver is shared: the site map's Utilization colouring reads it
through ``GET /api/monitoring/interfaces/live/``, and anything else that wants
"how busy is this port now" should too, so one port reads the same
everywhere.

It is batched. A page of interfaces costs a fixed handful of queries: the
interfaces, their devices' observed state, the interfaces those devices own
(to map ifIndex to interface as drift and MAC tracking do), and one windowed
read of the newest two samples per port. Only a stack's members cost a query
each, to place its observed rows on the right member.

No rate - ``None`` - when the interface is not mapped to an observed port,
has fewer than two samples, its newest sample is stale, or a counter went
backwards (a reset or a wrap) on that direction.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from django.db.models import F, Window
from django.db.models.functions import RowNumber
from django.utils import timezone

#: A rate older than this is history, not live traffic.
STALE_AFTER = timedelta(hours=2)


def stale_after(tenant) -> timedelta:
    """How old the newest sample may be: two hours, or three scheduled poll
    intervals when the tenant polls less often than that."""
    from .models import MonitoringSettings

    minutes = (
        MonitoringSettings.objects.filter(tenant=tenant)
        .values_list("snmp_poll_interval_minutes", flat=True)
        .first()
    ) or 0
    return max(STALE_AFTER, timedelta(minutes=3 * minutes))


def _rate(cur, prev, dt: float) -> int | None:
    delta = int(cur) - int(prev)
    if delta < 0:
        return None  # counter reset or wrap: no honest rate this interval
    return round(delta * 8 / dt)


def _owners(tenant, devices) -> tuple[dict, dict]:
    """``({device id: owner id}, {owner id: [members]})`` - a standalone device
    owns itself; a stack's owner is the member SNMP polls."""
    from .vc_stack import stacks

    owner_of: dict = {}
    members: dict = {}
    by_vc = stacks({d.virtual_chassis_id for d in devices}, tenant.id)
    for d in devices:
        group = by_vc.get(d.virtual_chassis_id) if d.virtual_chassis_id else None
        if group:
            owner_of[d.id] = group[0].id
            members[group[0].id] = group
        else:
            owner_of[d.id] = d.id
            members.setdefault(d.id, [d])
    return owner_of, members


def _if_index_map(tenant, owners: dict) -> dict:
    """``{interface id: (owner id, ifIndex)}`` for every interface of
    ``owners``' members that the owner's last poll observed."""
    from api.models import Interface

    from .models import DeviceSnmp
    from .snmp_drift import _intent_by_observed_name, _match_observed
    from .vc_stack import partition_observed

    observed = dict(
        DeviceSnmp.objects.filter(tenant=tenant, device_id__in=list(owners))
        .values_list("device_id", "interfaces")
    )
    member_ids = {m.id for group in owners.values() for m in group}
    by_member: dict = defaultdict(list)
    for iface in Interface.objects.filter(device_id__in=member_ids).only(
        "id", "device_id", "name", "snmp_name"
    ):
        by_member[iface.device_id].append(iface)

    out: dict = {}
    for owner_id, group in owners.items():
        rows = [
            o for o in observed.get(owner_id) or []
            if isinstance(o, dict) and str(o.get("if_index") or "").strip()
        ]
        if not rows:
            continue
        if len(group) > 1:
            owner = next(m for m in group if m.id == owner_id)
            parts = partition_observed(rows, group, owner)
        else:
            parts = {owner_id: rows}
        for member_id, member_rows in parts.items():
            names = _intent_by_observed_name(by_member.get(member_id, []))
            for o in member_rows:
                iface = _match_observed(o, names)
                if iface is not None and iface.id not in out:
                    out[iface.id] = (owner_id, str(o.get("if_index")).strip())
    return out


def live_rates(tenant, interfaces, now=None) -> dict:
    """``{interface id: rate | None}`` for ``interfaces`` (already scoped to
    ``tenant`` and the caller), where a rate is ``{in_bps, out_bps,
    speed_mbps, at, interval_s}``. ``in_bps``/``out_bps`` are each ``None``
    when that counter went backwards."""
    from .models import SnmpInterfaceSample

    interfaces = list(interfaces)
    out: dict = {i.id: None for i in interfaces}
    if not interfaces:
        return out
    now = now or timezone.now()
    devices = {i.device.id: i.device for i in interfaces}
    owner_of, owners = _owners(tenant, list(devices.values()))
    index = _if_index_map(tenant, {o: owners[o] for o in set(owner_of.values())})
    wanted = {index[i.id] for i in interfaces if i.id in index}
    if not wanted:
        return out

    since = now - stale_after(tenant)
    samples = (
        SnmpInterfaceSample.objects.filter(
            tenant=tenant,
            device_id__in={o for o, _ in wanted},
            if_index__in={idx for _, idx in wanted},
            sampled_at__gte=since - timedelta(days=1),
        )
        .annotate(
            rn=Window(
                RowNumber(),
                partition_by=[F("device_id"), F("if_index")],
                order_by=F("sampled_at").desc(),
            )
        )
        .filter(rn__lte=2)
        .values_list("device_id", "if_index", "in_octets", "out_octets", "speed_mbps", "sampled_at")
    )
    pairs: dict = defaultdict(list)
    for dev_id, idx, i_oct, o_oct, speed, at in samples:
        if (dev_id, idx) in wanted:
            pairs[(dev_id, idx)].append((at, i_oct, o_oct, speed))

    for iface in interfaces:
        key = index.get(iface.id)
        series = sorted(pairs.get(key) or [], key=lambda s: s[0], reverse=True)
        if len(series) < 2:
            continue
        (at, i1, o1, speed), (prev_at, i0, o0, _s) = series[0], series[1]
        dt = (at - prev_at).total_seconds()
        if dt <= 0 or at < since:
            continue
        out[iface.id] = {
            "in_bps": _rate(i1, i0, dt),
            "out_bps": _rate(o1, o0, dt),
            "speed_mbps": speed or None,
            "at": at,
            "interval_s": round(dt),
        }
    return out
