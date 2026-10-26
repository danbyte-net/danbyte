"""Which remote object is this Danbyte device? The cascade, for any system.

Each system supplies its levels - the ways a device can be recognised in it,
most reliable first - and an index of its objects per level, built once per
pass. The cascade tries a stored link, then each level in turn, **stopping at
the first unambiguous hit**.

Where a level finds **two** candidates, the answer is **no match** - recorded
as needing a person. A wrong pairing means an operator reads one object's
problems believing they are reading another's, and nothing downstream would
ever flag it. A missing pairing is visible and fixable; a wrong one is neither.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass


@dataclass
class Match:
    """The outcome of matching one device."""

    device: object
    #: The remote object (as the system's API returned it), or None.
    host: dict | None = None
    #: link | <level name> | none | ambiguous
    how: str = "none"
    #: Human sentence for the "needs a decision" queue.
    reason: str = ""

    @property
    def matched(self) -> bool:
        return self.host is not None

    @property
    def remote(self) -> dict | None:
        """The matched object under a system-neutral name."""
        return self.host


@dataclass(frozen=True)
class Level:
    """One way of recognising a device: a name for the level (also the index
    key and what ``Match.how`` reports) and the device's keys at it."""

    name: str
    keys: Callable[[object], Iterable[str]]


@dataclass(frozen=True)
class Cascade:
    """A system's matching rules.

    ``id_key`` and ``label_key`` read a remote object's identity and display
    name; ``plural`` and ``singular`` name it in the sentences an operator
    reads ("Zabbix hosts", "Zabbix host").
    """

    levels: tuple
    id_key: str
    label_key: str = "name"
    plural: str = "remote objects"
    singular: str = "remote object"

    def only(self, candidates):
        """One object, or nothing. Deduplicated by id first, because an
        object reachable twice under the same key is one object, not an
        ambiguity."""
        if not candidates:
            return None, 0
        unique = {c[self.id_key]: c for c in candidates}
        if len(unique) == 1:
            return next(iter(unique.values())), 1
        return None, len(unique)

    def match(self, device, index, link_id=None) -> Match:
        """Which remote object this device is, and how we decided.

        ``index`` maps each level's name to ``{key: [objects]}`` and may carry
        ``by_id`` for the stored link; ``link_id`` is the stored link's remote
        id, if there is one.
        """
        if link_id is not None:
            found = index.get("by_id", {}).get(link_id)
            if found is not None:
                return Match(device, found, "link")
            # The link points at an object that is gone. Fall through and try
            # to find it again rather than reporting the device unmatched - an
            # object deleted and recreated is still the same box.

        for level in self.levels:
            found = None
            by_key = index.get(level.name) or {}
            for key in level.keys(device):
                if not key:
                    continue
                hit, n = self.only(by_key.get(key) or [])
                if n > 1:
                    names = ", ".join(
                        sorted(c[self.label_key] for c in by_key[key])[:4]
                    )
                    return Match(
                        device, None, "ambiguous",
                        f"{n} {self.plural} share this device's {level.name} "
                        f"'{key}' ({names}).",
                    )
                if hit is not None:
                    if found is not None and found[self.id_key] != hit[self.id_key]:
                        return Match(
                            device, None, "ambiguous",
                            f"This device's addresses point at different "
                            f"{self.plural} ({found[self.label_key]}, "
                            f"{hit[self.label_key]}).",
                        )
                    found = hit
            if found is not None:
                return Match(device, found, level.name)

        return Match(
            device, None, "none",
            f"No {self.singular} matches this device.",
        )
