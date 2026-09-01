"""Interface speed as a number.

``Interface.speed`` is free text and legitimately arrives in several shapes -
the form suggests "1G"/"25G", SNMP sync writes "1 Gbps", operators type
"100 Mbps". Anything that compares or sums speeds goes through here so "1G"
and "1 Gbps" agree.
"""
from __future__ import annotations

import re

_SPEED_RE = re.compile(
    r"\s*(\d+(?:\.\d+)?)\s*(g|gbps|gbit/?s?|m|mbps|mbit/?s?)\s*", re.IGNORECASE
)


def speed_mbps(value) -> int | None:
    """Parse a human speed string to Mbps, or None when it isn't one."""
    m = _SPEED_RE.fullmatch(str(value or ""))
    if not m:
        return None
    n = float(m.group(1))
    if m.group(2).lower().startswith("g"):
        n *= 1000
    return int(n)


def fmt_speed(mbps) -> str:
    """Mbps → a human string ("10 Gbps" / "100 Mbps"). Blank when unknown."""
    try:
        n = int(mbps)
    except (ValueError, TypeError):
        return ""
    if n <= 0:
        return ""
    if n >= 1000 and n % 1000 == 0:
        return f"{n // 1000} Gbps"
    return f"{n} Mbps"
