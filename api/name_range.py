"""One ``[a-b]`` range in a component name fans out to that many components.

The expansion used to live only in the frontend dialogs, so a template created
through the raw API with "RF[1-2]" became one literally-named row (#111 test
seeding surfaced it). The server is the right place for a naming contract:
now every create path - dialog, script, import - means the same thing.

Mirrors ``frontend/src/lib/name-range.ts`` exactly: one range per name, bounds
must be ordered, spans over the cap fall back to a plain single name.
"""
from __future__ import annotations

import re

NAME_RANGE_RE = re.compile(r"\[(\d+)-(\d+)\]")

#: Refuse to fan out beyond this in one create - a typo like [1-99999]
#: must not try to make 99k rows.
RANGE_CAP = 128


def expand_name_range(name: str) -> list[str]:
    """"Disk[1-5]" → ["Disk1", …, "Disk5"]; anything else → [name]."""
    m = NAME_RANGE_RE.search(name or "")
    if not m:
        return [name]
    lo, hi = int(m.group(1)), int(m.group(2))
    if hi < lo or hi - lo + 1 > RANGE_CAP:
        return [name]
    return [NAME_RANGE_RE.sub(str(i), name, count=1) for i in range(lo, hi + 1)]
