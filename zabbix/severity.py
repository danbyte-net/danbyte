"""Zabbix severity → Danbyte status.

Danbyte's six statuses are keyed off by the rollup, the dashboard, the site
map, topology and every faceplate, so Zabbix's severities are **mapped** onto
them rather than added to them. The map is per connection and editable,
because where an estate draws the line between "worth a colour" and "worth a
page" is an operational decision, not ours.

The defaults treat Information and below as noise - Zabbix installs generate a
lot of it - Warning and Average as degraded, and High and Disaster as down.
"""
from __future__ import annotations

#: Zabbix trigger severity, by its API value.
SEVERITIES = [
    (0, "Not classified"),
    (1, "Information"),
    (2, "Warning"),
    (3, "Average"),
    (4, "High"),
    (5, "Disaster"),
]

DEFAULT_MAP = {
    "0": "up",
    "1": "up",
    "2": "degraded",
    "3": "degraded",
    "4": "down",
    "5": "down",
}

_ALLOWED = {"up", "degraded", "down"}


def clean_map(raw) -> dict:
    """A stored map, filled in from the defaults and stripped of anything odd.

    Tolerant on purpose: a map written by an older version, or edited by hand,
    should degrade to the default for the severities it does not cover rather
    than leaving a hole that reads as ``up``.
    """
    out = dict(DEFAULT_MAP)
    if isinstance(raw, dict):
        for value, _ in SEVERITIES:
            status = raw.get(str(value))
            if status in _ALLOWED:
                out[str(value)] = status
    return out


def worst(severities, mapping) -> str:
    """The status a set of live problem severities adds up to.

    Worst wins: one Disaster among a dozen Warnings is a down host, and the
    reverse would hide it.
    """
    order = {"up": 0, "degraded": 1, "down": 2}
    status = "up"
    for sev in severities:
        mapped = mapping.get(str(sev), "up")
        if order[mapped] > order[status]:
            status = mapped
    return status
