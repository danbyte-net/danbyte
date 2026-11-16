"""The prefix tree beside the prefix and IP lists: ``GET /api/prefixes/tree/``.

One VRF's prefixes as a hierarchy, a level at a time, for a pane that never
loads the whole tree:

* ``?vrf=<id>|global`` (default ``global``) and optionally ``?parent=<id>``:
  the direct children of that prefix - or the roots of the VRF - with each
  child's own direct-child count, paged by ``offset`` / ``limit``;
* ``?q=<text>``: the search. Prefixes whose CIDR starts with the text, or,
  when it is an address or network, the ones inside it (else the smallest one
  holding it); only the outermost matches, each with the prefixes above it.
  With ``?parent=<id>`` only the prefixes inside that one take part, and the
  paths stop below it (a prefix detail page's tree);
* ``?reveal=<id>``: the path from the root to that prefix, with each step's
  position among its siblings, so a pane opened on a selection can show it.

Only prefixes the reader may view take part. The tree is built over that set
alone: a prefix whose parent is hidden hangs from the nearest visible prefix
above it, or from the VRF root, and the hidden prefix is never named or
counted. Every answer is one read of the visible prefixes' ids and CIDRs
(inside the parent, through the containment index, when one is given) and a
sorted pass in Python - no query per node or per level.
"""

from __future__ import annotations

import bisect
import ipaddress
from dataclasses import dataclass

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import BooleanField, Q
from django.db.models.expressions import RawSQL
from rest_framework.exceptions import NotFound, ValidationError

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000
#: Outermost search matches answered; ``truncated`` says when there were more.
MAX_MATCHES = 200


@dataclass
class Node:
    id: object
    cidr: str
    net: ipaddress.IPv4Network | ipaddress.IPv6Network
    parent: object = None  # nearest visible prefix above, or None at the root
    child_count: int = 0

    def key(self):
        return (self.net.version, int(self.net.network_address), self.net.prefixlen, str(self.id))

    def as_dict(self, **extra) -> dict:
        return {
            "id": str(self.id),
            "cidr": self.cidr,
            "parent": str(self.parent) if self.parent is not None else None,
            "child_count": self.child_count,
            **extra,
        }


def vrf_filter(raw) -> Q:
    """``?vrf=`` → the VRF's rows: ``global`` (or nothing) is the global table."""
    if raw in (None, "", "global", "null"):
        return Q(vrf__isnull=True)
    return Q(vrf_id=raw)


def build(rows) -> list[Node]:
    """``(id, cidr)`` rows → nodes in address order, each with its nearest
    containing node as ``parent`` and its number of direct children. Rows
    whose CIDR does not parse are left out."""
    nodes = []
    for pk, cidr in rows:
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except (ValueError, TypeError):
            continue
        nodes.append(Node(pk, cidr, net))
    nodes.sort(key=Node.key)
    stack: list[Node] = []
    for n in nodes:
        while stack and not (
            stack[-1].net.version == n.net.version and n.net.subnet_of(stack[-1].net)
        ):
            stack.pop()
        if stack:
            n.parent = stack[-1].id
            stack[-1].child_count += 1
        stack.append(n)
    return nodes


def visible_rows(qs, vrf_q: Q, inside: str | None = None):
    """The ``(id, cidr)`` of ``qs`` (already the reader's visible prefixes)
    in one VRF, optionally only those strictly inside ``inside``."""
    qs = qs.filter(vrf_q)
    if inside:
        qs = qs.annotate(
            _below=RawSQL("cidr::inet << %s::inet", (inside,), output_field=BooleanField())
        ).filter(_below=True)
    return qs.order_by().values_list("id", "cidr")


def _page_params(params):
    def num(name, default, hi):
        raw = params.get(name)
        if raw in (None, ""):
            return default
        try:
            v = int(raw)
        except (TypeError, ValueError):
            raise ValidationError({name: "A whole number."}) from None
        if v < 0:
            raise ValidationError({name: "Zero or more."})
        return min(v, hi)

    return num("offset", 0, 10**9), max(1, num("limit", DEFAULT_LIMIT, MAX_LIMIT))


def _visible_one(qs, pk):
    try:
        row = qs.filter(pk=pk).values_list("id", "cidr", "vrf_id").first()
    except (ValueError, DjangoValidationError):
        row = None
    if row is None:
        raise NotFound()
    return row


def children(qs, params) -> dict:
    offset, limit = _page_params(params)
    parent_id = params.get("parent") or None
    if parent_id:
        nodes = _nodes_inside(qs, parent_id)
    else:
        try:
            nodes = build(visible_rows(qs, vrf_filter(params.get("vrf"))))
        except (ValueError, DjangoValidationError):
            nodes = []
    # Inside the parent, the top level is what hangs from nothing else there.
    top = [n for n in nodes if n.parent is None]
    return {
        "parent": str(parent_id) if parent_id else None,
        "count": len(top),
        "offset": offset,
        "limit": limit,
        "results": [n.as_dict(parent=str(parent_id) if parent_id else None)
                    for n in top[offset:offset + limit]],
    }


def _query_net(text: str):
    """An address or network typed in full, else None."""
    try:
        if "/" in text:
            return ipaddress.ip_network(text, strict=False)
        return ipaddress.ip_network(ipaddress.ip_address(text))
    except ValueError:
        return None


def _all_nodes(qs, params):
    try:
        return build(visible_rows(qs, vrf_filter(params.get("vrf"))))
    except (ValueError, DjangoValidationError):
        return []


def _nodes_inside(qs, parent_id):
    """The visible prefixes strictly inside one visible prefix, as a tree of
    their own: a prefix hanging from nothing inside it is a top node."""
    _pid, cidr, vrf_id = _visible_one(qs, parent_id)
    try:
        inside = str(ipaddress.ip_network(cidr, strict=False))
    except (ValueError, TypeError):
        return []
    vq = Q(vrf__isnull=True) if vrf_id is None else Q(vrf_id=vrf_id)
    return build(visible_rows(qs, vq, inside))


def search(qs, params) -> dict:
    text = (params.get("q") or "").strip().lower()
    parent_id = params.get("parent") or None
    nodes = _nodes_inside(qs, parent_id) if parent_id else _all_nodes(qs, params)
    by_id = {n.id: n for n in nodes}
    net = _query_net(text)
    if net is not None:
        hits = {n.id for n in nodes
                if n.net.version == net.version and n.net.subnet_of(net)}
        if not hits:
            holders = [n for n in nodes
                       if n.net.version == net.version and net.subnet_of(n.net)]
            if holders:
                hits = {max(holders, key=lambda n: n.net.prefixlen).id}
    else:
        hits = {n.id for n in nodes if n.cidr.lower().startswith(text)} if text else set()

    def under_hit(n):
        p = n.parent
        while p is not None:
            if p in hits:
                return True
            p = by_id[p].parent
        return False

    outer = [n for n in nodes if n.id in hits and not under_hit(n)]
    truncated = len(outer) > MAX_MATCHES
    outer = outer[:MAX_MATCHES]
    keep = {}
    for n in outer:
        keep[n.id] = True
        p = n.parent
        while p is not None and p not in keep:
            keep[p] = False
            p = by_id[p].parent
    # Inside a parent, the top of each path hangs from it, as in children().
    def up(n):
        if n.parent is None and parent_id:
            return {"parent": str(parent_id)}
        return {}

    return {
        "q": text,
        "count": len(outer),
        "truncated": truncated,
        "results": [n.as_dict(match=keep[n.id], **up(n)) for n in nodes if n.id in keep],
    }


def reveal(qs, params) -> dict:
    pid, _cidr, vrf_id = _visible_one(qs, params.get("reveal"))
    vq = Q(vrf__isnull=True) if vrf_id is None else Q(vrf_id=vrf_id)
    nodes = build(visible_rows(qs, vq))
    by_id = {n.id: n for n in nodes}
    siblings: dict = {}
    for n in nodes:
        siblings.setdefault(n.parent, []).append(n.key())
    path = []
    cur = by_id.get(pid)
    while cur is not None:
        index = bisect.bisect_left(siblings[cur.parent], cur.key())
        path.append(cur.as_dict(index=index))
        cur = by_id.get(cur.parent)
    path.reverse()
    return {"vrf": str(vrf_id) if vrf_id else None, "path": path}
