"""Zabbix severity → Danbyte status.

Danbyte's six statuses are keyed off by the rollup, the dashboard, the site
map, topology and every faceplate, so Zabbix's severities are **mapped** onto
them rather than added to them. The map is per connection and editable,
because where an estate draws the line between "worth a colour" and "worth a
page" is an operational decision, not ours.

The defaults treat Information and below as noise - Zabbix installs generate a
lot of it - Warning and Average as degraded, and High and Disaster as down.

The mechanics are shared with every external monitor
(:mod:`monitoring.external.state_map`); this module is Zabbix's vocabulary.
"""
from __future__ import annotations

from monitoring.external.state_map import StateMap

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

#: The statuses a severity may map onto, best first. Danbyte's other two
#: states are its own bookkeeping - ``stale`` means nobody answered and
#: ``skipped`` means we chose not to ask, neither of which Zabbix knows.
MAPPABLE = ["up", "degraded", "down"]

#: Zabbix's vocabulary on the shared map. Nothing is fixed: every severity is
#: the operator's to place.
STATE_MAP = StateMap(
    source_values=tuple(SEVERITIES),
    defaults=DEFAULT_MAP,
    mappable=tuple(MAPPABLE),
)


def clean_map(raw) -> dict:
    """A stored map, filled in from the defaults and stripped of anything odd.

    Tolerant on purpose: a map written by an older version, or edited by hand,
    should degrade to the default for the severities it does not cover rather
    than leaving a hole that reads as ``up``.
    """
    return STATE_MAP.clean(raw)


def worst(severities, mapping) -> str:
    """The status a set of live problem severities adds up to.

    Worst wins: one Disaster among a dozen Warnings is a down host, and the
    reverse would hide it.
    """
    return STATE_MAP.worst(severities, mapping)
