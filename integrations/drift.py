"""Config-drift computation — diff a device's intended vs actual config.

Pure helpers, no I/O. Used by the drift-ingest endpoint to turn a posted
"actual" config into a stored diff + status.
"""
from __future__ import annotations

import difflib


def _norm(text: str) -> list[str]:
    """Normalise to comparable lines: unify newlines, strip trailing space, and
    drop a trailing blank line so a stray final newline isn't reported as drift."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out = [ln.rstrip() for ln in lines]
    while out and out[-1] == "":
        out.pop()
    return out


def compute_drift(intended: str, actual: str) -> tuple[str, str]:
    """Return (status, unified_diff). status ∈ in_sync|drift|unknown.

    `unknown` when either side is empty — there's nothing meaningful to compare.
    """
    if not (intended or "").strip() or not (actual or "").strip():
        return ("unknown", "")
    a, b = _norm(intended), _norm(actual)
    diff = list(
        difflib.unified_diff(a, b, fromfile="intended", tofile="actual", lineterm="")
    )
    if not diff:
        return ("in_sync", "")
    return ("drift", "\n".join(diff))
