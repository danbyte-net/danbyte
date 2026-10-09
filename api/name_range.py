"""One ``[a-b]`` range in a component name fans out to that many components.

The expansion used to live only in the frontend dialogs, so a template created
through the raw API with "RF[1-2]" became one literally-named row (#111 test
seeding surfaced it). The server is the right place for a naming contract:
now every create path - dialog, script, import - means the same thing.

Mirrors ``frontend/src/lib/name-range.ts`` exactly: one range per name, bounds
must be ordered, a zero-padded start bound pads every name to its width
("Eth[01-04]" → Eth01 … Eth04), and "[5-5]" is a range of one (#335). A range
that can't be honoured is refused by :func:`range_error`, never stored with
its brackets.
"""
from __future__ import annotations

import re

NAME_RANGE_RE = re.compile(r"\[(\d+)-(\d+)\]")

#: Refuse to fan out beyond this in one create - a typo like [1-99999]
#: must not try to make 99k rows.
RANGE_CAP = 128


def _usable(m: re.Match) -> bool:
    lo, hi = int(m.group(1)), int(m.group(2))
    return lo <= hi and hi - lo + 1 <= RANGE_CAP


def expand_name_range(name: str) -> list[str]:
    """"Disk[1-5]" → ["Disk1", …, "Disk5"]; "Disk[5-5]" → ["Disk5"];
    anything else → [name]. Callers refuse a leftover range via
    :func:`range_error` before creating anything."""
    m = NAME_RANGE_RE.search(name or "")
    if not m or not _usable(m):
        return [name]
    start = m.group(1)
    # A leading zero on the start bound fixes the width: [01-12] → 01 … 12.
    width = len(start) if len(start) > 1 and start.startswith("0") else 0
    lo, hi = int(start), int(m.group(2))
    return [
        name[: m.start()] + str(i).zfill(width) + name[m.end():]
        for i in range(lo, hi + 1)
    ]


def range_error(name: str) -> str | None:
    """Why a name's range shorthand can't be honoured, or ``None`` when the
    name is a plain name or a usable ``[a-b]`` range. Create paths surface
    this so a typo is refused instead of stored literally."""
    name = name or ""
    if re.search(r"\{\d+-\d+\}", name):
        return "Ranges use square brackets: [1-24]."
    found = list(NAME_RANGE_RE.finditer(name))
    if len(found) > 1:
        return "Only one [a-b] range per name."
    if found and not _usable(found[0]):
        return f"A range must count up and cover at most {RANGE_CAP} names."
    return None
