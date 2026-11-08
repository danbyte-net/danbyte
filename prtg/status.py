"""PRTG's object status codes and the Danbyte state each one means.

The codes are the fixed list PRTG returns as ``status_raw`` in ``table.json``.
The default state is what a code means before an operator edits anything;
each connection's ``state_map`` edits the six codes that carry a verdict, on
the shared :class:`~monitoring.external.state_map.StateMap`.
"""
from __future__ import annotations

from monitoring.external.state_map import StateMap

NONE = 0
UNKNOWN = 1
SCANNING = 2
UP = 3
WARNING = 4
DOWN = 5
NO_PROBE = 6
PAUSED_USER = 7
PAUSED_DEPENDENCY = 8
PAUSED_SCHEDULE = 9
UNUSUAL = 10
NOT_LICENSED = 11
PAUSED_UNTIL = 12
DOWN_ACKNOWLEDGED = 13
DOWN_PARTIAL = 14

#: status_raw -> PRTG's own word for it.
LABELS: dict[int, str] = {
    NONE: "None",
    UNKNOWN: "Unknown",
    SCANNING: "Scanning",
    UP: "Up",
    WARNING: "Warning",
    DOWN: "Down",
    NO_PROBE: "No Probe",
    PAUSED_USER: "Paused by User",
    PAUSED_DEPENDENCY: "Paused by Dependency",
    PAUSED_SCHEDULE: "Paused by Schedule",
    UNUSUAL: "Unusual",
    NOT_LICENSED: "Not Licensed",
    PAUSED_UNTIL: "Paused Until",
    DOWN_ACKNOWLEDGED: "Down (Acknowledged)",
    DOWN_PARTIAL: "Down (Partial)",
}

PAUSED = frozenset({PAUSED_USER, PAUSED_DEPENDENCY, PAUSED_SCHEDULE, PAUSED_UNTIL})

#: Codes an operator may map onto another state later. The rest are fixed:
#: PRTG not knowing, or not measuring, is never "down".
MAPPABLE = frozenset({UP, WARNING, DOWN, UNUSUAL, DOWN_ACKNOWLEDGED, DOWN_PARTIAL})

#: status_raw -> Danbyte check state, before any edit.
DEFAULT_STATE: dict[int, str] = {
    UP: "up",
    WARNING: "degraded",
    UNUSUAL: "degraded",
    DOWN: "down",
    DOWN_PARTIAL: "degraded",
    DOWN_ACKNOWLEDGED: "down",
}

#: Why a fixed code reads as unknown, for the message beside it.
UNKNOWN_REASON: dict[int, str] = {
    NOT_LICENSED: "PRTG licence limit",
    NO_PROBE: "PRTG probe disconnected",
    SCANNING: "PRTG has not measured it yet",
}


def label(code) -> str:
    try:
        return LABELS.get(int(code), f"Status {code}")
    except (TypeError, ValueError):
        return "Unknown"


# ── the per-connection map ──────────────────────────────────────────────────

#: Every code: the editable ones first, in the order the map editor lists
#: them, then the fixed ones.
SOURCE_VALUES = tuple(
    (code, LABELS[code])
    for code in (UP, WARNING, UNUSUAL, DOWN, DOWN_PARTIAL, DOWN_ACKNOWLEDGED,
                 PAUSED_USER, PAUSED_DEPENDENCY, PAUSED_SCHEDULE, PAUSED_UNTIL,
                 NOT_LICENSED, NO_PROBE, NONE, UNKNOWN, SCANNING)
)

#: PRTG's vocabulary on the shared map. The six codes in ``MAPPABLE`` are the
#: operator's to place; paused, unmeasured, unlicensed and probe-less sensors
#: are fixed to unknown, because PRTG not measuring something is never a
#: verdict about it.
STATE_MAP = StateMap(
    source_values=SOURCE_VALUES,
    defaults={str(code): state for code, state in DEFAULT_STATE.items()},
    mappable=("up", "degraded", "down"),
    fixed={str(code): "unknown" for code in LABELS if code not in MAPPABLE},
    fallback="unknown",
)


def clean_map(raw) -> dict:
    """A stored map, completed from the defaults; fixed codes stay unknown."""
    return STATE_MAP.clean(raw)


def _code(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def map_code(code, mapping) -> str:
    """The Danbyte state one status code means under ``mapping``."""
    key = _code(code)
    return "unknown" if key is None else mapping.get(str(key), "unknown")


def rollup(codes, mapping) -> str:
    """A device's state from its sensors' codes: worst wins.

    Paused sensors are left out - pausing is somebody's decision, not a
    result - and a device whose sensors are all paused, or that has none, is
    unknown. ``unknown`` ranks below ``up``, so a sensor beyond the licence
    limit beside a healthy one leaves the device up, and a device with only
    unlicensed sensors is unknown, never down.
    """
    states = [map_code(c, mapping) for c in codes if _code(c) not in PAUSED]
    if not states:
        return "unknown"
    return max(states, key=lambda s: STATE_MAP.order.get(s, -1))


def default_state(code) -> str:
    """The Danbyte state a status code means by default; unknown for anything
    paused, unmeasured, unlicensed or unrecognised."""
    try:
        return DEFAULT_STATE.get(int(code), "unknown")
    except (TypeError, ValueError):
        return "unknown"
