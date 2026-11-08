"""A monitoring system's own states, mapped onto Danbyte's.

Danbyte's statuses are keyed off by the rollup, the dashboard, the site map,
topology and every faceplate, so an external system's states or severities are
**mapped** onto them rather than added to them. The map is per connection and
editable, because where an estate draws the line between "worth a colour" and
"worth a page" is an operational decision, not ours.

One :class:`StateMap` per system describes its vocabulary: the source values
in display order, the default status for each, which statuses an operator may
pick, and the values whose status is fixed and never editable.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: Worst-wins order for the statuses a map can produce. ``unknown`` ranks
#: below ``up`` so that something answering always outweighs nothing known.
DEFAULT_ORDER = {"unknown": -1, "up": 0, "degraded": 1, "down": 2}


@dataclass(frozen=True)
class StateMap:
    #: ``(value, label)`` for every state or severity the system reports, in
    #: the order an editor lists them. Values are compared as strings.
    source_values: tuple
    #: value (as a string) -> default Danbyte status, for the editable values.
    defaults: dict
    #: The statuses an editable value may map onto, best first.
    mappable: tuple = ("up", "degraded", "down")
    #: value (as a string) -> status that is not the operator's to change.
    fixed: dict = field(default_factory=dict)
    #: Worst-wins rank per status.
    order: dict = field(default_factory=lambda: dict(DEFAULT_ORDER))
    #: What an unmapped value counts as, and where :meth:`worst` starts.
    fallback: str = "up"

    def default_map(self) -> dict:
        return {**self.defaults, **self.fixed}

    def clean(self, raw) -> dict:
        """A stored map, filled in from the defaults and stripped of anything
        odd.

        Tolerant on purpose: a map written by an older version, or edited by
        hand, should degrade to the default for the values it does not cover
        rather than leaving a hole that reads as ``up``. Fixed values always
        come back as their fixed status.
        """
        out = dict(self.defaults)
        if isinstance(raw, dict):
            allowed = set(self.mappable)
            for value, _ in self.source_values:
                key = str(value)
                if key in self.fixed:
                    continue
                status = raw.get(key)
                if status in allowed:
                    out[key] = status
        out.update(self.fixed)
        return out

    def map(self, value, mapping) -> str:
        return mapping.get(str(value), self.fallback)

    def worst(self, values, mapping) -> str:
        """The status a set of live values adds up to.

        Worst wins: one critical problem among a dozen warnings is a down
        host, and the reverse would hide it.
        """
        status = self.fallback
        for value in values:
            mapped = self.map(value, mapping)
            if self.order[mapped] > self.order[status]:
                status = mapped
        return status
