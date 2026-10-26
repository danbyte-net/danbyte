"""PRTG's object status codes and the Danbyte state each one means.

The codes are the fixed list PRTG returns as ``status_raw`` in ``table.json``.
The default state is what a code means before an operator edits anything;
the per-connection map that edits it comes with status reading.
"""
from __future__ import annotations

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


def default_state(code) -> str:
    """The Danbyte state a status code means by default; unknown for anything
    paused, unmeasured, unlicensed or unrecognised."""
    try:
        return DEFAULT_STATE.get(int(code), "unknown")
    except (TypeError, ValueError):
        return "unknown"
