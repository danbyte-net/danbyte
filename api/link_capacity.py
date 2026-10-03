"""How fast a site-to-site link is, for the site map (#246).

The first answer Danbyte has wins, and the answer names where it came from:

* a circuit: its commit rate, then its terminations' port and upstream speeds
  (one per direction), then the speed of an interface cabled to it;
* a tunnel: its capacity override - nothing derives one in 0.17;
* a cable: the lower of its two ends' interface speeds. A cable into a patch
  panel ends where its strands come out through the panels, so a trunk
  carries one link per patched strand, and those add up.

Several links between two sites add up (``2×10G``). Unknown is ``None``, never
a guess. Pure functions over plain values: the callers load the rows
(``api.site_map_links`` for the site map).
"""
from __future__ import annotations

from dataclasses import dataclass

from .speed import speed_mbps


@dataclass(frozen=True)
class Capacity:
    """A link's speed in kbps; ``up_kbps`` only when the other direction
    differs."""

    kbps: int
    up_kbps: int | None
    source: str  # commit | port | interface | override | cable

    def as_dict(self) -> dict:
        return {"kbps": self.kbps, "up_kbps": self.up_kbps, "source": self.source,
                "label": short(self.kbps, self.up_kbps)}


def _positive(values) -> list[int]:
    return [int(v) for v in values if v]


def interface_kbps(speed) -> int | None:
    """An interface's free-text speed (``"10G"``, ``"1 Gbps"``, a bare kbps
    number - see ``api.speed``) in kbps; None when it is not a speed."""
    mbps = speed_mbps(speed)
    return mbps * 1000 if mbps else None


def circuit_capacity(commit_kbps, terminations=(), interface_kbps=None) -> Capacity | None:
    """``terminations`` are ``(port_speed_kbps, upstream_speed_kbps)`` pairs;
    the slower end limits each direction."""
    if commit_kbps:
        return Capacity(int(commit_kbps), None, "commit")
    down = _positive(t[0] for t in terminations)
    if down:
        up = _positive(t[1] for t in terminations)
        slow_down, slow_up = min(down), (min(up) if up else None)
        return Capacity(slow_down, slow_up if slow_up != slow_down else None, "port")
    if interface_kbps:
        return Capacity(int(interface_kbps), None, "interface")
    return None


def tunnel_capacity(capacity_kbps) -> Capacity | None:
    return Capacity(int(capacity_kbps), None, "override") if capacity_kbps else None


def cable_capacity(*end_kbps) -> Capacity | None:
    """The slower of the known ends."""
    known = _positive(end_kbps)
    return Capacity(min(known), None, "cable") if known else None


def bundle(capacities) -> dict:
    """Links between one site pair, added up: ``{kbps, count, unknown,
    label}`` - ``2×10G`` when they match, else the sum."""
    known = [c for c in capacities if c is not None]
    unknown = len(capacities) - len(known)
    total = sum(c.kbps for c in known)
    if not known:
        label = ""
    elif len(known) > 1 and len({(c.kbps, c.up_kbps) for c in known}) == 1:
        label = f"{len(known)}×{short(known[0].kbps, known[0].up_kbps)}"
    else:
        label = short(total)
    return {"kbps": total or None, "count": len(known), "unknown": unknown, "label": label}


def combined(capacities) -> dict | None:
    """The figure for one line on the map that carries ``capacities`` - one
    per link, None where a link's speed is unknown: a single link's own
    figure, several added up as ``bundle`` adds them. ``count`` is the links
    whose speed is known and ``unknown`` the rest. None when no link's speed
    is known."""
    capacities = list(capacities)
    known = [c for c in capacities if c is not None]
    if not known:
        return None
    if len(capacities) == 1:
        return {**known[0].as_dict(), "count": 1, "unknown": 0}
    summed = bundle(capacities)
    sources = {c.source for c in known}
    return {
        "kbps": summed["kbps"],
        "up_kbps": None,
        "source": sources.pop() if len(sources) == 1 else "mixed",
        "label": summed["label"],
        "count": summed["count"],
        "unknown": summed["unknown"],
    }


def short(kbps, up_kbps=None) -> str:
    """``10G``, ``500M``, ``2.5G``; an asymmetric link as ``100/20M``."""
    def one(v: int) -> tuple[str, str]:
        if v >= 1_000_000:
            return f"{v / 1_000_000:g}", "G"
        if v >= 1_000:
            return f"{v / 1_000:g}", "M"
        return f"{v:g}", "k"

    if not kbps:
        return ""
    down, unit = one(int(kbps))
    if up_kbps and up_kbps != kbps:
        up, up_unit = one(int(up_kbps))
        return f"{down}/{up}{unit}" if up_unit == unit else f"{down}{unit}/{up}{up_unit}"
    return f"{down}{unit}"
