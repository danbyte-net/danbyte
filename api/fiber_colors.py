"""Fibre-strand colour reference (TIA-598-C) + derivation helpers.

The 12-colour sequence is an industry standard (same category as
``CABLE_TYPE_CHOICES`` / ``LENGTH_UNITS`` — a spec, not tenant data), so it ships
as the default palette. A tenant may reorder / recolour it on the Fibre settings
page; that per-tenant palette lives in :class:`api.models.FiberSettings`.

Beyond 12 fibres the sequence repeats; the *group* it repeats in
(``(position-1)//12``) is shown as a black tracer — a stripe on the 2nd dozen and
an added ring on each further dozen. See ``docs/architecture/fiber-strands.md``.
"""
from __future__ import annotations

# TIA-598-C, positions 1..12. Kept in sync with frontend/src/lib/fiber.ts.
TIA_598C: list[dict] = [
    {"name": "Blue", "hex": "#0071CE"},
    {"name": "Orange", "hex": "#FF7A00"},
    {"name": "Green", "hex": "#00A651"},
    {"name": "Brown", "hex": "#7B4A12"},
    {"name": "Slate", "hex": "#8A8D8F"},
    {"name": "White", "hex": "#F4F4F4"},
    {"name": "Red", "hex": "#E4002B"},
    {"name": "Black", "hex": "#101010"},
    {"name": "Yellow", "hex": "#FFD100"},
    {"name": "Violet", "hex": "#8246AF"},
    {"name": "Rose", "hex": "#F4A6C0"},
    {"name": "Aqua", "hex": "#00B5C7"},
]

# Cable `type` prefixes that are optical fibre (so we know to offer strands).
_FIBER_PREFIXES = ("smf", "mmf")


def is_fiber_type(cable_type: str | None) -> bool:
    return bool(cable_type) and cable_type.startswith(_FIBER_PREFIXES)


def fiber_color(position: int, palette: list[dict] | None = None) -> dict:
    """Colour + tracer marks for a 1-based strand ``position``.

    ``group`` = which dozen (0 = 1..12, 1 = 13..24, …); ``stripe`` once past 12;
    ``rings`` = one per *further* wrap. ``palette`` defaults to TIA-598-C.
    """
    pal = palette or TIA_598C
    n = len(pal) or 12
    idx = (position - 1) % n
    group = (position - 1) // n
    base = pal[idx]
    return {
        "position": position,
        "name": base["name"],
        "hex": base["hex"],
        "group": group,
        "stripe": group >= 1,
        "rings": max(0, group - 1),
    }
