"""Explore an OID subtree against a live device, so sensors can be built by
looking rather than by reading a MIB.

A flat walk is the wrong shape for a human. `snmpwalk` on a table base prints
one line per (column, row) pair, and the reader has to mentally transpose
hundreds of lines to answer the only question that matters: *which column holds
the health value, and what does it say?*

So the walk is reshaped back into the table it came from — rows are components,
columns are attributes — which makes the answer visible: the column reading
"Normal"/"Normal" next to the column reading "Power Supply 1"/"Power Supply 2"
is the health column, and its distinct values are the `value_map` to write.
"""
from __future__ import annotations

from danbyte_checks.snmp_facts import SnmpFactsError, fetch_oid_sync

from .snmp_poll import _device_target
from .snmp_resolve import resolve_device_profile

# An interactive walk is bounded: a mistyped base (say the whole enterprise
# subtree) should come back trimmed with a warning, not stall the request or
# ship megabytes to the browser.
WALK_LIMIT = 1500

# Per column, how many distinct values to report. Enough to seed a value_map
# from an enum column, few enough that a column of serial numbers doesn't
# dominate the payload.
MAX_DISTINCT = 12


def _split_tail(tail: str) -> tuple[str, str]:
    """``"6.1"`` → column ``"6"``, row ``"1"``.

    The first sub-identifier after the base is the column; everything left is
    the row index, which may itself be multi-part for a compound-index table
    (``ifXTable`` style) and is kept whole so it still identifies one row.
    """
    column, _, row = tail.partition(".")
    return column, row or "0"


def walk_device_oid(device, tenant, oid: str, walk: bool = True, profile=None) -> dict:
    """Walk ``oid`` on ``device`` and return it shaped as a table.

    ``{base, columns: [{column, oid, distinct, values_seen, filled}],
       rows: [{index, values: {column: value}}], count, truncated, error}``

    Never raises for SNMP conditions — a timeout or a refused community comes
    back as ``error`` so the UI can show it inline next to the field.
    """
    oid = (oid or "").strip().strip(".")
    if not oid:
        return _empty(oid, "enter an OID to walk")
    if not all(part.isdigit() for part in oid.split(".")):
        return _empty(
            oid,
            "numeric OIDs only — a MIB name can't be resolved without its MIB "
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

    try:
        raw = fetch_oid_sync(
            target, profile.version, profile.params, profile.secret_params,
            oid, walk, profile.timeout_ms, WALK_LIMIT if walk else None,
        )
    except SnmpFactsError as exc:
        return _empty(oid, str(exc))

    if not walk:
        # A scalar GET has no table to rebuild — one value, shown as one cell.
        value = raw.get("0", "")
        return {
            "base": oid, "walk": False,
            "columns": [{
                "column": "", "oid": oid, "distinct": [value] if value else [],
                "values_seen": 1 if value else 0, "filled": 1 if value else 0,
            }],
            "rows": [{"index": "0", "values": {"": value}}] if value else [],
            "count": 1 if value else 0, "truncated": False, "error": "",
        }

    by_row: dict[str, dict[str, str]] = {}
    distinct: dict[str, list[str]] = {}
    for tail, value in raw.items():
        column, row = _split_tail(tail)
        by_row.setdefault(row, {})[column] = value
        seen = distinct.setdefault(column, [])
        if value not in seen and len(seen) < MAX_DISTINCT:
            seen.append(value)

    # Numeric-aware ordering, so column 10 follows column 9 and rows read 1..n
    # rather than 1, 10, 11, 2 — the same reason tables here sort naturally.
    def key(s: str) -> tuple:
        return tuple(int(p) if p.isdigit() else p for p in s.split("."))

    columns = sorted(distinct, key=key)
    rows = sorted(by_row, key=key)
    return {
        "base": oid,
        "walk": True,
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


def _empty(oid: str, error: str) -> dict:
    return {
        "base": oid, "walk": True, "columns": [], "rows": [],
        "count": 0, "truncated": False, "error": error,
    }
