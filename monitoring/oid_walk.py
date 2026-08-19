"""Browse a device's OID tree and read a table off it, so sensors can be built
by looking rather than by reading a MIB.

Two things are needed, and they are not the same operation:

**Browsing.** A walk returns OIDs in lexicographic order, so walking a high base
like ``1.3.6.1.4.1`` spends its whole budget inside the first vendor it meets and
never reveals the others exist. Listing one level at a time - a GETNEXT per
child, skipping each child's subtree - is what makes the tree navigable.

**Reading a table.** Once the base *is* a table entry, the flat result is the
wrong shape for a human: `snmpwalk` prints one line per (column, row) pair, and
the reader has to mentally transpose it to answer the only question that
matters - which column reports health, and what does it say? Reshaped back into
rows-are-components / columns-are-attributes, the answer is visible: the column
reading "Normal" beside the column reading "Power Supply 1" is the health
column, and its distinct values are the value_map to write.

Which of the two applies is detected, not asked: in a table entry every child
holds its values exactly one level down (``base.column.row``). A branch's
children sit deeper, so it is browsed instead.
"""
from __future__ import annotations

from danbyte_checks.snmp_facts import (
    SnmpFactsError,
    fetch_oid_sync,
    list_oid_children_sync,
)

from .snmp_poll import _device_target
from .snmp_resolve import resolve_device_profile

# An interactive walk is bounded: a mistyped base should come back trimmed with
# a warning, not stall the request or ship megabytes to the browser.
WALK_LIMIT = 1500

# Children listed per level. One round trip each, so this is also a latency cap.
CHILD_LIMIT = 64

# Per column, how many distinct values to report. Enough to seed a value_map
# from an enum column, few enough that a column of serials doesn't dominate.
MAX_DISTINCT = 12


def _split_tail(tail: str) -> tuple[str, str]:
    """``"6.1"`` → column ``"6"``, row ``"1"``.

    Only meaningful under a table entry. The first sub-identifier is the column;
    the rest is the row index, kept whole because a compound-index table
    (``ifXTable`` style) still identifies one row with several parts.
    """
    column, _, row = tail.partition(".")
    return column, row or "0"


def _depth_below(base: str, first_oid: str) -> int:
    """How many levels below ``base.child`` that child's first value sits."""
    return first_oid[len(base) + 1:].count(".")


def walk_device_oid(device, tenant, oid: str, walk: bool = True, profile=None) -> dict:
    """Explore ``oid`` on ``device``.

    Returns ``{base, is_table, children, columns, rows, count, truncated,
    error}``. ``children`` is always populated for a subtree read so the caller
    can navigate; ``columns``/``rows`` only when the base is a table entry.

    ``walk=False`` reads the single OID instead (a scalar GET).

    Never raises for SNMP conditions - a timeout or a refused community comes
    back as ``error`` so the UI can show it inline next to the field.
    """
    oid = (oid or "").strip().strip(".")
    if not oid:
        return _empty(oid, "enter an OID to explore")
    if not all(part.isdigit() for part in oid.split(".")):
        return _empty(
            oid,
            "numeric OIDs only - a MIB name can't be resolved without its MIB "
            "file (e.g. 1.3.6.1.4.1.2.3.51.3.1.11.2.1)",
        )

    if profile is None:
        profile, _ = resolve_device_profile(device, tenant)
    if profile is None:
        return _empty(oid, "no SNMP profile applies to this device")
    target = _device_target(device)
    if not target:
        return _empty(
            oid, "device has no reachable address (no OOB/primary IP, and its "
                 "name does not resolve)"
        )

    args = (target, profile.version, profile.params, profile.secret_params)

    if not walk:
        return _scalar(args, oid, profile.timeout_ms)

    try:
        children = list_oid_children_sync(
            *args, oid, profile.timeout_ms, CHILD_LIMIT
        )
    except SnmpFactsError as exc:
        return _empty(oid, str(exc))

    if not children:
        return _empty(oid, "")

    # A table entry: every child holds its values one level down. Anything else
    # is a branch, and gets browsed rather than transposed.
    is_table = len(children) >= 2 and all(
        _depth_below(oid, c["first_oid"]) == 1 for c in children
    )
    listing = [
        {
            "sub": c["sub"],
            "oid": c["oid"],
            "sample": c["sample"],
            "depth_below": _depth_below(oid, c["first_oid"]),
        }
        for c in children
    ]
    if not is_table:
        return {
            "base": oid, "walk": True, "is_table": False, "children": listing,
            "columns": [], "rows": [], "count": 0, "truncated": False,
            "error": "",
        }

    try:
        raw = fetch_oid_sync(*args, oid, True, profile.timeout_ms, WALK_LIMIT)
    except SnmpFactsError as exc:
        return _empty(oid, str(exc))

    by_row: dict[str, dict[str, str]] = {}
    distinct: dict[str, list[str]] = {}
    for tail, value in raw.items():
        column, row = _split_tail(tail)
        by_row.setdefault(row, {})[column] = value
        seen = distinct.setdefault(column, [])
        if value not in seen and len(seen) < MAX_DISTINCT:
            seen.append(value)

    columns = sorted(distinct, key=_oid_key)
    rows = sorted(by_row, key=_oid_key)
    return {
        "base": oid,
        "walk": True,
        "is_table": True,
        "children": listing,
        "columns": [
            {
                "column": c,
                "oid": f"{oid}.{c}",
                "distinct": distinct[c],
                # More distinct values than we kept → too varied to enumerate,
                # so the UI knows not to offer it as an enum to map.
                "values_seen": len(distinct[c]),
                "filled": sum(1 for r in rows if c in by_row[r]),
            }
            for c in columns
        ],
        "rows": [{"index": r, "values": by_row[r]} for r in rows],
        "count": len(raw),
        "truncated": len(raw) >= WALK_LIMIT,
        "error": "",
    }


def _oid_key(s: str) -> tuple:
    """Numeric-aware ordering, so column 10 follows column 9 and rows read
    1..n rather than 1, 10, 11, 2 - as tables sort everywhere else here."""
    return tuple(int(p) if p.isdigit() else p for p in s.split("."))


def _scalar(args, oid: str, timeout_ms: int) -> dict:
    """One OID, one value - no table to rebuild, so it's shown as one cell."""
    try:
        raw = fetch_oid_sync(*args, oid, False, timeout_ms)
    except SnmpFactsError as exc:
        return _empty(oid, str(exc))
    value = raw.get("0", "")
    return {
        "base": oid, "walk": False, "is_table": True, "children": [],
        "columns": [{
            "column": "", "oid": oid, "distinct": [value] if value else [],
            "values_seen": 1 if value else 0, "filled": 1 if value else 0,
        }],
        "rows": [{"index": "0", "values": {"": value}}] if value else [],
        "count": 1 if value else 0, "truncated": False, "error": "",
    }


def _empty(oid: str, error: str) -> dict:
    return {
        "base": oid, "walk": True, "is_table": False, "children": [],
        "columns": [], "rows": [], "count": 0, "truncated": False,
        "error": error,
    }
