"""A sensor's channels and their history, read from PRTG when somebody looks.

The status pass reads one row per sensor and never its channels: channels are
one call per sensor, so they are read on demand - when the sensor panel opens
- and kept on the sensor row for one status interval. Two people opening the
same sensor inside that interval cost PRTG one call, not two.

**Channels** come from ``table.json?content=channels``, whose ``info`` column
is a JSON document per channel with everything else the panel needs: the
channel's status, whether it is a percentage, its limits (when limits are on)
and its lookup table. ``getsensordetails.json`` adds PRTG's own summary of the
sensor - its message and how long it has been up or down.

Each channel becomes one row of a fixed shape::

    {id, name, value, value_raw, unit, kind, state, status, lookup_label,
     limits: {warn_min, warn_max, error_min, error_max},
     lookup_states: [{value, to, label, state}], min, max, primary}

``kind`` is ``number``, ``percent``, ``lookup`` or ``text``. ``value`` is
PRTG's display string; ``value_raw`` is the number in the unit PRTG displays
(``0.03`` for "0.03 Mbit/s", not the bytes per second PRTG keeps underneath),
or for a lookup channel the lookup key. Lookup ``state`` is PRTG's lookup
vocabulary: ``ok``, ``warning``, ``error``, ``none`` or ``unknown``.

**History** comes from ``historicdata.xml`` per range (1 hour, 24 hours, 7
days) with an average per range, capped in points, cached the same way.
"""
from __future__ import annotations

import time
from datetime import timedelta

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from . import status as st
from .client import PrtgClient, PrtgError, clean_text, loads_lenient, parse_value

#: PRTG lookup state numbers, as ``info``'s ``lookups`` rows carry them.
#: Checked against PRTG 26.3: "Yes" on *Root Authority Trusted* is 1 and the
#: sensor's warning names "No" (3); "Unsafe" key length is 2, "Weak" 3.
LOOKUP_STATES = {"0": "none", "1": "ok", "2": "error", "3": "warning", "4": "unknown"}

#: A lookup entry's state as Danbyte's monitoring state.
_LOOKUP_TO_STATE = {"ok": "up", "warning": "degraded", "error": "down"}

#: range -> (seconds, PRTG ``avg`` in seconds). 60, 96 and 168 points.
RANGES = {
    "1h": (3600, 60),
    "24h": (86_400, 900),
    "7d": (7 * 86_400, 3600),
}
#: Points kept per channel and range, whatever PRTG returns.
MAX_POINTS = 400
#: How long a second request waits for the first one's read.
WAIT_SECONDS = 5.0
#: The widest gap between UTC and a PRTG server's clock, used to pad a
#: window when the offset is unknown.
MAX_OFFSET = timedelta(hours=14)


def _num(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _info(row) -> dict:
    text = row.get("info")
    if not isinstance(text, str) or not text.strip():
        return {}
    try:
        data = loads_lenient(text).get("data") or []
    except (ValueError, AttributeError):
        return {}
    return data[0] if data and isinstance(data[0], dict) else {}


def scaled(display, raw) -> float | None:
    """A value in the unit PRTG shows it in.

    PRTG keeps some channels in a base unit (bytes per second) and displays
    them scaled ("0.03 Mbit/s"); others keep the displayed unit and only round
    it for display ("0 msec" for 0.06). The display number wins when it is far
    from the raw one - a different unit - and the raw one when they differ by
    rounding only.
    """
    number, _ = parse_value(display)
    raw = _num(raw)
    if number is None:
        return raw
    if raw is None:
        return number
    if abs(raw - number) > max(1.0, abs(number)) * 0.5:
        return number
    return raw


def _lookup_states(lookups) -> list[dict]:
    out = []
    for entry in lookups or ():
        if not isinstance(entry, (list, tuple)) or len(entry) < 3:
            continue
        value = _num(entry[0])
        if value is None:
            continue
        to = _num(entry[3]) if len(entry) > 4 and str(entry[4]) == "2" else None
        out.append({
            "value": value,
            "to": to,
            "label": clean_text(entry[1]),
            "state": LOOKUP_STATES.get(str(entry[2]), "unknown"),
        })
    return out


def _current_lookup(states, raw):
    if raw is None:
        return None
    for s in states:
        if s["to"] is not None:
            if s["value"] <= raw <= s["to"]:
                return s
        elif s["value"] == raw:
            return s
    return None


def channel_row(row: dict, mapping: dict) -> dict:
    """One PRTG channel as the panel's row."""
    info = _info(row)
    display = clean_text(row.get("lastvalue")) or clean_text(info.get("lastvalue"))
    if display.lower().startswith("no data"):
        display = ""
    status_code = info.get("status")
    number, unit = parse_value(display)
    lookups = _lookup_states(info.get("lookups"))
    out = {
        "id": str(row.get("objid_raw", row.get("objid"))),
        "name": clean_text(row.get("name")),
        "value": display,
        "value_raw": None,
        "unit": "",
        "kind": "text",
        "state": st.map_code(status_code, mapping) if status_code is not None else "unknown",
        "status": st.label(status_code) if status_code is not None else "",
        "lookup_label": "",
        "limits": {"warn_min": None, "warn_max": None, "error_min": None, "error_max": None},
        "lookup_states": [],
        "min": None,
        "max": None,
        "primary": bool(info.get("primary")),
    }
    if str(info.get("limitmode", "")) == "1":
        out["limits"] = {
            "warn_min": _num(info.get("limitminwarning")),
            "warn_max": _num(info.get("limitmaxwarning")),
            "error_min": _num(info.get("limitminerror")),
            "error_max": _num(info.get("limitmaxerror")),
        }
    if lookups:
        raw = _num(info.get("lastvalueraw"))
        if raw is None:
            raw = _num(row.get("lastvalue_raw"))
        current = _current_lookup(lookups, raw)
        out.update({
            "kind": "lookup", "value_raw": raw, "lookup_states": lookups,
            "lookup_label": current["label"] if current else display,
            # PRTG repeats the sensor's status on every channel; the
            # channel's own verdict is the state of its current lookup value.
            "state": _LOOKUP_TO_STATE.get(current["state"], "unknown") if current else "unknown",
        })
        return out
    if number is None and not display:
        # No reading yet: keep the channel's kind from what PRTG says it is.
        out["kind"] = "percent" if info.get("ispercent") else "number"
        out["unit"] = "%" if info.get("ispercent") else ""
    elif number is None:
        out["state"] = "unknown"
        return out  # a text channel ("Disabled", "Only Strong Protocols Available")
    else:
        out["kind"] = "percent" if (info.get("ispercent") or unit.startswith("%")) else "number"
        out["unit"] = unit
        out["value_raw"] = scaled(display, info.get("lastvalueraw", row.get("lastvalue_raw")))
    if out["kind"] == "percent":
        out["unit"] = out["unit"] or "%"
        out["min"], out["max"] = 0.0, 100.0
    else:
        low = parse_value(clean_text(info.get("graphmin")))[0]
        high = parse_value(clean_text(info.get("graphmax")))[0]
        marks = [m for m in (out["value_raw"], *out["limits"].values()) if m is not None]
        low = min([low if low is not None else 0.0, *marks])
        high = max([high if high is not None else 0.0, *marks])
        if high <= low:
            high = low + (abs(low) or 1.0)
        out["min"], out["max"] = low, high
    out["state"] = _limit_state(out["value_raw"], out["limits"])
    return out


def _limit_state(value, limits) -> str:
    """A number's own verdict against its channel limits: ``down`` past an
    error limit, ``degraded`` past a warning one, ``up`` inside them, and
    ``unknown`` when the channel has no limits or no reading (PRTG's
    channel table only repeats the sensor's status)."""
    if value is None or not any(v is not None for v in limits.values()):
        return "unknown"
    if (limits["error_min"] is not None and value < limits["error_min"]) or (
            limits["error_max"] is not None and value > limits["error_max"]):
        return "down"
    if (limits["warn_min"] is not None and value < limits["warn_min"]) or (
            limits["warn_max"] is not None and value > limits["warn_max"]):
        return "degraded"
    return "up"


def map_channels(rows, mapping) -> list[dict]:
    """Every channel, in PRTG's order with the Downtime channel last."""
    out = [channel_row(r, mapping) for r in rows if isinstance(r, dict)]
    return sorted(out, key=lambda c: c["id"] == "-4")


def _summary(details: dict) -> dict:
    return {
        "message": details.get("lastmessage", ""),
        "status": details.get("statustext", ""),
        "last_value": details.get("lastvalue", ""),
        "uptime_for": details.get("uptimetime", ""),
        "downtime_for": details.get("downtimetime", ""),
    }


# ── caching ─────────────────────────────────────────────────────────────────


def _fresh(stamp, conn, now) -> bool:
    at = parse_datetime(stamp) if isinstance(stamp, str) else None
    return at is not None and now - at < timedelta(seconds=conn.cache_seconds)


def _lock_key(sensor, what) -> str:
    return f"danbyte-prtg-{what}:{sensor.id}"


def _acquire(key) -> bool:
    """One reader per sensor at a time. Without a cache it is everyone."""
    try:
        from django.core.cache import cache

        return bool(cache.add(key, "1", timeout=60))
    except Exception:  # noqa: BLE001 - no Redis is not a reason to stop
        return True


def _release(key) -> None:
    try:
        from django.core.cache import cache

        cache.delete(key)
    except Exception:  # noqa: BLE001
        pass


def _cached(sensor, conn, now, pick):
    """Wait briefly for another request's read of the same sensor, then use
    whatever the row holds."""
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(0.25)
        sensor.refresh_from_db(fields=["channels", "history"])
        hit = pick(sensor)
        if hit and _fresh(hit.get("fetched_at"), conn, now):
            return hit
    return pick(sensor)


def read_channels(sensor, *, client: PrtgClient | None = None, now=None) -> dict:
    """The sensor's channels, from the row when read within the connection's
    interval, else from PRTG (two calls: channels and the sensor's details).
    Raises :class:`PrtgError` when PRTG cannot be read and nothing is cached."""
    conn = sensor.connection
    now = now or timezone.now()
    cached = sensor.channels or {}
    if cached.get("rows") is not None and _fresh(cached.get("fetched_at"), conn, now):
        return cached
    key = _lock_key(sensor, "channels")
    if not _acquire(key):
        hit = _cached(sensor, conn, now, lambda s: s.channels or None)
        if hit:
            return hit
        raise PrtgError("PRTG is being read for this sensor; try again in a moment.")
    try:
        client = client or PrtgClient.for_connection(conn)
        mapping = st.clean_map(conn.state_map)
        rows = map_channels(client.channels(int(sensor.objid)), mapping)
        try:
            summary = _summary(client.sensor_details(int(sensor.objid)))
        except PrtgError:
            summary = {}
        payload = {"fetched_at": now.isoformat(), "summary": summary, "rows": rows}
        sensor.channels = payload
        sensor.save(update_fields=["channels"])
        return payload
    except PrtgError:
        if cached.get("rows") is not None:
            return {**cached, "stale": True}
        raise
    finally:
        _release(key)


def server_offset(conn, client) -> int | None:
    """Minutes the PRTG clock is ahead of UTC, learned once from
    ``getstatus.htm`` and kept on the connection. Rounded to the quarter
    hour, which every time zone is a multiple of."""
    if conn.server_utc_offset_minutes is not None:
        return conn.server_utc_offset_minutes
    try:
        clock = client.server_clock()
    except PrtgError:
        return None
    if clock is None:
        return None
    utc = timezone.now().replace(tzinfo=None)
    minutes = round((clock - utc).total_seconds() / 900) * 15
    if abs(minutes) > 14 * 60:
        return None
    conn.server_utc_offset_minutes = minutes
    conn.save(update_fields=["server_utc_offset_minutes"])
    return minutes


def _cap(points: list, limit: int | None = None) -> list:
    limit = MAX_POINTS if limit is None else limit
    if len(points) <= limit:
        return points
    step = len(points) / limit
    return [points[int(i * step)] for i in range(limit)]


def read_history(sensor, rng: str, *, client: PrtgClient | None = None, now=None) -> dict:
    """``{range, avg, fetched_at, series: {channel id: {name, unit, points:
    [{t, v}]}}}`` for one range, cached per range like the channels."""
    if rng not in RANGES:
        raise ValueError(f"range is one of {', '.join(RANGES)}.")
    conn = sensor.connection
    now = now or timezone.now()
    cached = (sensor.history or {}).get(rng) or {}
    if cached.get("series") is not None and _fresh(cached.get("fetched_at"), conn, now):
        return cached
    key = _lock_key(sensor, f"history-{rng}")
    if not _acquire(key):
        hit = _cached(sensor, conn, now, lambda s: (s.history or {}).get(rng))
        if hit:
            return hit
        raise PrtgError("PRTG is being read for this sensor; try again in a moment.")
    try:
        client = client or PrtgClient.for_connection(conn)
        seconds, avg = RANGES[rng]
        if rng == "1h":
            # A sensor read every five minutes has nothing to say per minute.
            avg = max(avg, int(sensor.interval_seconds or 0))
        offset = server_offset(conn, client)
        start, end = now - timedelta(seconds=seconds), now
        pad = timedelta(seconds=avg) if offset is not None else MAX_OFFSET
        shift = timedelta(minutes=offset or 0)

        def local(dt):
            return (dt + shift).replace(tzinfo=None, microsecond=0)

        items = client.historic(int(sensor.objid), local(start - pad), local(end + pad), avg)
        series: dict = {}
        for item in items:
            at = item["end"] - timedelta(seconds=avg)
            if at < start - timedelta(seconds=avg) or at > end:
                continue
            for cid, v in item["values"].items():
                entry = series.setdefault(cid, {"name": v["name"], "unit": "", "points": []})
                value = scaled(v["display"], v["raw"]) if v["display"] else v["raw"]
                if not entry["unit"] and v["display"]:
                    entry["unit"] = parse_value(v["display"])[1]
                entry["points"].append({"t": at.isoformat(), "v": value})
        for entry in series.values():
            entry["points"] = _cap(entry["points"])
        payload = {"range": rng, "avg": avg, "fetched_at": now.isoformat(), "series": series}
        history = dict(sensor.history or {})
        history[rng] = payload
        sensor.history = history
        sensor.save(update_fields=["history"])
        return payload
    except PrtgError:
        if cached.get("series") is not None:
            return {**cached, "stale": True}
        raise
    finally:
        _release(key)
