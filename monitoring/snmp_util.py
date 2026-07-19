"""Interface-counter sampling + utilisation maths (#84, Phase 2).

Counters are rates, not values: we store HC octet counters on each poll and
derive utilisation between consecutive samples (rate = Δoctets·8 / Δt, as a %
of ifHighSpeed). A counter that goes backwards (reset/wrap) yields a 0 delta
rather than a negative rate.
"""
from __future__ import annotations

from collections import defaultdict

from .models import SnmpInterfaceSample


def record_samples(device, tenant, interfaces, sampled_at) -> int:
    """Persist one ``SnmpInterfaceSample`` per interface that reported counters."""
    rows = []
    for iface in interfaces or []:
        if not iface.get("in_octets") and not iface.get("out_octets"):
            continue
        try:
            in_octets = int(iface.get("in_octets") or 0)
            out_octets = int(iface.get("out_octets") or 0)
            speed = int(iface.get("speed_mbps") or 0)
        except (ValueError, TypeError):
            continue
        rows.append(SnmpInterfaceSample(
            tenant=tenant, device=device, if_index=str(iface.get("if_index", "")),
            in_octets=in_octets, out_octets=out_octets, speed_mbps=speed,
            sampled_at=sampled_at,
        ))
    if rows:
        SnmpInterfaceSample.objects.bulk_create(rows)
    return len(rows)


def _pct(delta_octets: int, dt_seconds: float, speed_mbps: int):
    if speed_mbps <= 0 or dt_seconds <= 0:
        return None
    bps = (delta_octets * 8) / dt_seconds
    return round(100 * bps / (speed_mbps * 1_000_000), 2)


def compute_device_utilization(device, points: int = 30) -> dict:
    """``{if_index: [{at, in_pct, out_pct}, ...]}`` from stored samples."""
    by_index: dict[str, list] = defaultdict(list)
    samples = (
        SnmpInterfaceSample.objects
        .filter(device=device)
        .order_by("if_index", "sampled_at")
    )
    for s in samples:
        by_index[s.if_index].append(s)

    out: dict[str, list] = {}
    for if_index, series in by_index.items():
        pts = []
        for prev, cur in zip(series, series[1:]):
            dt = (cur.sampled_at - prev.sampled_at).total_seconds()
            if dt <= 0:
                continue
            # in_octets/out_octets are Decimal (Counter64-safe); the delta over a
            # poll interval fits an int, so cast to keep _pct's arithmetic float.
            d_in = max(0, int(cur.in_octets) - int(prev.in_octets))
            d_out = max(0, int(cur.out_octets) - int(prev.out_octets))
            pts.append({
                "at": cur.sampled_at,
                "in_pct": _pct(d_in, dt, cur.speed_mbps),
                "out_pct": _pct(d_out, dt, cur.speed_mbps),
            })
        if pts:
            out[if_index] = pts[-points:]
    return out
