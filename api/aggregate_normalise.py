"""Bring stored aggregate prefixes to their canonical form (#381).

Aggregates used to be stored as typed: ``2001:DB8::/32`` next to
``2001:db8::/32``, ``10.1.2.3/8`` next to ``10.0.0.0/8``. New writes are
normalised (``Aggregate.normalise_prefix``); this plans the same for rows
already stored, without ever deleting one. A row is rewritten only when its
canonical form is free in its tenant. Rows that would collide - two spellings
of one block - are left exactly as they are and reported, for an operator to
merge by hand (``manage.py check_aggregates``).

Pure functions over plain tuples, so the data migration can use them with
historical models.
"""
from __future__ import annotations

import ipaddress
from collections import defaultdict


def canonical(prefix) -> str | None:
    try:
        return str(ipaddress.ip_network(str(prefix or "").strip(), strict=False))
    except ValueError:
        return None


def plan(rows) -> tuple[dict, list]:
    """``rows`` is ``[(pk, tenant_id, prefix)]``. Returns ``(updates,
    collisions)``: ``{pk: canonical}`` for the rows that can be rewritten,
    and ``[(tenant_id, canonical, [(pk, prefix), ...])]`` for every block
    stored more than once in a tenant."""
    groups: dict[tuple, list] = defaultdict(list)
    for pk, tenant_id, prefix in rows:
        c = canonical(prefix)
        if c is None:
            continue
        groups[(tenant_id, c)].append((pk, prefix))
    updates: dict = {}
    collisions: list = []
    for (tenant_id, c), members in sorted(groups.items(), key=lambda kv: str(kv[0])):
        if len(members) > 1:
            collisions.append((tenant_id, c, sorted(members, key=lambda m: str(m[1]))))
            continue
        pk, prefix = members[0]
        if prefix != c:
            updates[pk] = c
    return updates, collisions
