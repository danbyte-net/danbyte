"""Free space inside prefixes: the gaps between child prefixes, free blocks
of one size, and the subnet planner (docs/features/prefix-crud.md).

Gaps are computed against every prefix in the parent's tenant and VRF,
whatever the reader may view, so a block offered as free is free. Space a
prefix the reader may not view takes is simply not offered; nothing here
names it or counts it. Which parents a reader may look inside, and who may
create in them, is the caller's business (api.viewsets.PrefixViewSet).

All arithmetic is on Python ints, so IPv4 and IPv6 share it. Under an IPv6
parent of /64 or shorter, used space is rounded out to whole /64s: a /64
holding one /127 is not offered, and free blocks start at /64 boundaries.
An explicit request for something longer than a /64 (a /127 link) is the
exception and packs into partly used /64s.
"""

from __future__ import annotations

import ipaddress
import math
from bisect import bisect_left, insort
from dataclasses import dataclass, field

from django.db.models import BooleanField, Q
from django.db.models.expressions import RawSQL

from .models import Prefix

#: Free rows per parent in the list without a size, and with one.
LIST_LIMIT = 8
SIZE_LIMIT = 16
#: The most blocks one request returns.
MAX_LIMIT = 256
#: The most subnets one plan may create.
MAX_PLAN_ITEMS = 1024
#: IPv6 free space is offered in whole /64s under a /64 or shorter.
V6_FLOOR = 64
#: Spans the planner's strip draws at most; closer ones are merged.
STRIP_SPANS = 400

STRATEGIES = ("first", "best")


class SpaceError(Exception):
    """A refusal: ``status`` 400 (the request), 403 or 409 (space changed)."""

    def __init__(self, message: str, status: int = 400, field_name: str = "length"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.field_name = field_name


# ─── parsing ────────────────────────────────────────────────────────────────


def parse_network(raw, field_name: str = "scope"):
    """``raw`` as a network, or SpaceError. Host bits are refused so a typo
    (10.0.0.1/24) is not silently read as its network."""
    text = str(raw or "").strip()
    if "/" not in text:
        raise SpaceError("A prefix with its length, e.g. 10.20.0.0/19.", field_name=field_name)
    try:
        return ipaddress.ip_network(text, strict=True)
    except ValueError as exc:
        raise SpaceError(f"Not a valid prefix: {exc}.", field_name=field_name) from None


def parse_length(raw, version: int | None = None, *, required: bool = True):
    """A prefix length from ``29`` or ``/29``; None when absent and optional."""
    if raw is None or str(raw).strip() == "":
        if required:
            raise SpaceError("A prefix length, e.g. 29.")
        return None
    text = str(raw).strip().lstrip("/")
    if not text.isdigit():
        raise SpaceError("A prefix length, e.g. 29.")
    length = int(text)
    width = 32 if version == 4 else 128
    if length > width:
        raise SpaceError(f"An IPv{version or 6} prefix length is at most {width}.")
    return length


def parse_strategy(raw) -> str:
    value = str(raw or "first").strip().lower()
    if value not in STRATEGIES:
        raise SpaceError("first or best.", field_name="strategy")
    return value


def parse_limit(raw, default: int) -> int:
    if raw is None or str(raw).strip() == "":
        return default
    text = str(raw).strip()
    if not text.isdigit() or int(text) < 1:
        raise SpaceError("A whole number from 1.", field_name="limit")
    return min(int(text), MAX_LIMIT)


def cidr_of(addr: int, length: int, version: int) -> str:
    cls = ipaddress.IPv4Network if version == 4 else ipaddress.IPv6Network
    return str(cls((addr, length)))


def _bounds(net) -> tuple[int, int]:
    return int(net.network_address), int(net.broadcast_address)


# ─── arithmetic ─────────────────────────────────────────────────────────────


def gaps(lo: int, hi: int, occupied, mask: int = 0):
    """The free stretches of ``[lo, hi]`` between ``occupied`` (``(start,
    end)`` pairs sorted by start, overlaps allowed). ``mask`` rounds each
    used stretch out to whole blocks (the IPv6 /64 floor)."""
    cur = lo
    for s, e in occupied:
        if mask:
            s &= ~mask
            e |= mask
        if e < cur:
            continue
        if s > hi:
            break
        if s > cur:
            yield cur, s - 1
        if e + 1 > cur:
            cur = e + 1
        if cur > hi:
            return
    if cur <= hi:
        yield cur, hi


def aligned_blocks(start: int, end: int, width: int):
    """``[start, end]`` as the fewest aligned CIDR blocks, lowest first:
    ``(address, length)`` pairs."""
    out = []
    while start <= end:
        bits = (start & -start).bit_length() - 1 if start else width
        bits = min(bits, (end - start + 1).bit_length() - 1)
        out.append((start, width - bits))
        start += 1 << bits
    return out


def sized_blocks(start: int, end: int, width: int, length: int):
    """Every aligned block of exactly ``length`` inside ``[start, end]``."""
    step = 1 << (width - length)
    a = -(-start // step) * step
    while a + step - 1 <= end:
        yield a
        a += step


def sized_count(start: int, end: int, width: int, length: int) -> int:
    step = 1 << (width - length)
    return max(0, (end + 1) // step - -(-start // step))


# ─── the space inside one parent ───────────────────────────────────────────


@dataclass
class Space:
    """The space of one parent prefix (clipped to a scope), and the prefixes
    already in it."""

    parent: Prefix
    version: int
    lo: int
    hi: int
    root_len: int
    occupied: list = field(default_factory=list)
    #: Space taken while planning, on top of ``occupied``.
    taken: list = field(default_factory=list)

    @property
    def width(self) -> int:
        return 32 if self.version == 4 else 128

    @property
    def root(self) -> str:
        return cidr_of(self.lo, self.root_len, self.version)

    def mask(self, length: int | None = None) -> int:
        if self.version == 6 and self.root_len <= V6_FLOOR and (
            length is None or length <= V6_FLOOR
        ):
            return (1 << (128 - V6_FLOOR)) - 1
        return 0

    def _used(self):
        if not self.taken:
            return self.occupied
        return sorted(self.occupied + self.taken)

    def free(self, length: int | None = None):
        return list(gaps(self.lo, self.hi, self._used(), self.mask(length)))

    def blocks(self):
        """The free space as its largest aligned blocks, lowest first."""
        out = []
        for s, e in self.free():
            out.extend(aligned_blocks(s, e, self.width))
        return out

    def largest(self, length: int | None = None) -> int | None:
        """The length of the largest free aligned block, or None."""
        best = None
        for s, e in self.free(length):
            for _a, ln in aligned_blocks(s, e, self.width):
                if best is None or ln < best:
                    best = ln
        return best

    def count(self, length: int) -> int:
        if length < self.root_len or length > self.width:
            return 0
        return sum(sized_count(s, e, self.width, length) for s, e in self.free(length))

    def candidates(self, length: int, strategy: str = "first"):
        """Addresses of free aligned blocks of ``length``: lowest first, or
        (``best``) from the smallest free block that holds one."""
        if length < self.root_len or length > self.width:
            return
        free = self.free(length)
        if strategy == "first":
            for s, e in free:
                yield from sized_blocks(s, e, self.width, length)
            return
        pieces = [
            (a, ln)
            for s, e in free
            for a, ln in aligned_blocks(s, e, self.width)
            if ln <= length
        ]
        pieces.sort(key=lambda p: (-p[1], p[0]))
        for a, ln in pieces:
            yield from sized_blocks(a, a + (1 << (self.width - ln)) - 1, self.width, length)

    def is_free(self, addr: int, length: int) -> bool:
        end = addr + (1 << (self.width - length)) - 1
        if addr < self.lo or end > self.hi:
            return False
        for s, e in self.free(length):
            if s <= addr and end <= e:
                return True
        return False

    def take(self, addr: int, length: int) -> None:
        insort(self.taken, (addr, addr + (1 << (self.width - length)) - 1))

    def spans(self, ranges) -> list[list[float]]:
        """``(start, end)`` ranges as merged ``[from, to]`` fractions of the
        root, for the planner's strip. Touching ranges are one span; past
        ``STRIP_SPANS`` the nearest neighbours merge first, so a gap wide
        enough to see is never painted as used."""
        merged: list[list[int]] = []
        for s, e in sorted(ranges):
            s, e = max(s, self.lo), min(e, self.hi)
            if s > e:
                continue
            if merged and s <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        total = self.hi - self.lo + 1
        gap = 1
        while len(merged) > STRIP_SPANS:
            gap *= 4
            joined: list[list[int]] = []
            for s, e in merged:
                if joined and s - joined[-1][1] <= gap:
                    joined[-1][1] = max(joined[-1][1], e)
                else:
                    joined.append([s, e])
            merged = joined
        return [
            [round((s - self.lo) / total, 6), round((e + 1 - self.lo) / total, 6)]
            for s, e in merged
        ]


def _vrf_q(vrf_ids) -> Q:
    ids = [v for v in vrf_ids if v is not None]
    q = Q(vrf_id__in=ids) if ids else Q(pk__in=[])
    if None in vrf_ids:
        q |= Q(vrf__isnull=True)
    return q


def prefixes_inside(tenant_id, vrf_ids, cidrs):
    """Every prefix of ``tenant_id`` in ``vrf_ids`` strictly inside one of
    ``cidrs``, whoever may view it. This is what takes space: the free rows,
    Next available, allocate, the planner and the Space map all count it, so
    a block one of them calls free is free in the others too. Which of these
    the reader may name is the caller's business."""
    return (
        Prefix.objects.filter(tenant_id=tenant_id)
        .filter(_vrf_q(set(vrf_ids)))
        .annotate(_fs_in=RawSQL(
            '"api_prefix"."cidr"::inet << ANY(%s::inet[])', (sorted(cidrs),),
            output_field=BooleanField(),
        ))
        .filter(_fs_in=True)
    )


def load_spaces(tenant_id, parents, scope=None) -> dict:
    """``{parent pk: Space}`` for ``parents`` (one tenant), against every
    prefix of that tenant inside them. One query for the whole set. A parent
    the scope does not reach is left out; so is one whose CIDR does not
    parse."""
    nets = {}
    for p in parents:
        net = p.network
        if net is None:
            continue
        if scope is not None:
            if net.version != scope.version or not net.overlaps(scope):
                continue
        nets[p.pk] = (p, net)
    if not nets:
        return {}
    cidrs = sorted({str(n) for _p, n in nets.values()})
    rows = prefixes_inside(
        tenant_id, {p.vrf_id for p, _n in nets.values()}, cidrs,
    ).values_list("vrf_id", "cidr")
    buckets: dict[tuple, list] = {}
    for vrf_id, cidr in rows:
        try:
            n = ipaddress.ip_network(cidr, strict=False)
        except (TypeError, ValueError):
            continue
        buckets.setdefault((vrf_id, n.version), []).append(_bounds(n))
    starts: dict[tuple, list] = {}
    for key, items in buckets.items():
        items.sort()
        starts[key] = [s for s, _e in items]

    out = {}
    for pk, (p, net) in nets.items():
        ps, pe = _bounds(net)
        lo, hi, root_len = ps, pe, net.prefixlen
        if scope is not None:
            ss, se = _bounds(scope)
            lo, hi = max(ps, ss), min(pe, se)
            root_len = max(net.prefixlen, scope.prefixlen)
        key = (p.vrf_id, net.version)
        items = buckets.get(key, [])
        first = bisect_left(starts.get(key, []), ps)
        occupied = []
        for s, e in items[first:]:
            if s > pe:
                break
            if e > pe or (s == ps and e == pe):
                continue  # a supernet of this parent, or the parent itself
            occupied.append((s, e))
        out[pk] = Space(parent=p, version=net.version, lo=lo, hi=hi,
                        root_len=root_len, occupied=occupied)
    return out


def is_container(p: Prefix) -> bool:
    status = getattr(p, "status", None) if p.status_id else None
    return bool(status and status.slug == "container")


# ─── rows ───────────────────────────────────────────────────────────────────


def free_row(space: Space, addr: int, length: int) -> dict:
    p = space.parent
    return {
        "kind": "free",
        "cidr": cidr_of(addr, length, space.version),
        "prefixlen": length,
        "family": space.version,
        "parent": str(p.pk),
        "vrf": str(p.vrf_id) if p.vrf_id else None,
    }


def space_rows(space: Space, length: int | None, strategy: str, limit: int):
    """``(rows, total)``: the free blocks of ``length`` (or the largest
    aligned blocks without one), at most ``limit``, and how many there are."""
    if length is None:
        blocks = space.blocks()
        return [free_row(space, a, ln) for a, ln in blocks[:limit]], len(blocks)
    rows = []
    for addr in space.candidates(length, strategy):
        rows.append(free_row(space, addr, length))
        if len(rows) >= limit:
            break
    total = space.count(length) if rows else 0
    return rows, total


def no_room(space: Space, length: int) -> str:
    largest = space.largest(length)
    where = space.root
    if largest is None:
        return f"No free space left in {where}."
    return f"No free /{length} left in {where}; largest free block is /{largest}."


def check_length(space: Space, length: int) -> None:
    if length < space.root_len:
        raise SpaceError(f"A /{length} is larger than {space.root}.")
    if length > space.width:
        raise SpaceError(f"An IPv{space.version} prefix length is at most {space.width}.")


def check_scope(parent: Prefix, scope) -> None:
    net = parent.network
    if scope is None or net is None:
        return
    if scope.version != net.version or not scope.overlaps(net):
        raise SpaceError(f"The scope must be inside {parent.cidr}.", field_name="scope")


# ─── the planner ────────────────────────────────────────────────────────────


@dataclass
class PlanItem:
    request: int
    n: int
    length: int
    fields: dict
    cidr: str | None = None
    addr: int | None = None
    reason: str | None = None


def _fill(pattern: str, n: int) -> str:
    return (pattern or "").replace("{n}", str(n))


def plan_requests(raw) -> list[dict]:
    """The planner's ``requests``, checked: ``count``, ``length`` and the
    optional ``description`` pattern (``{n}`` numbers it), ``status_id``,
    ``vlan_id``, ``site_id``, ``location_id``, ``tag_ids`` and
    ``keep_together``."""
    if not isinstance(raw, list) or not raw:
        raise SpaceError("At least one row: a count and a size.", field_name="requests")
    out = []
    total = 0
    for i, r in enumerate(raw):
        if not isinstance(r, dict):
            raise SpaceError(f"Row {i + 1}: an object.", field_name="requests")
        count = r.get("count", 1)
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise SpaceError(f"Row {i + 1}: count is a whole number from 1.",
                             field_name="requests")
        try:
            length = parse_length(r.get("length"))
        except SpaceError as exc:
            raise SpaceError(f"Row {i + 1}: {exc.message}", field_name="requests") from None
        total += count
        if total > MAX_PLAN_ITEMS:
            raise SpaceError(f"At most {MAX_PLAN_ITEMS} subnets in one plan.",
                             field_name="requests")
        fields = {
            k: r[k] for k in ("status_id", "vlan_id", "site_id", "location_id", "tag_ids")
            if k in r and r[k] not in (None, "")
        }
        out.append({
            "count": count, "length": length, "fields": fields,
            "description": str(r.get("description") or ""),
            "keep_together": bool(r.get("keep_together")),
        })
    return out


def plan(space: Space, requests: list[dict], strategy: str = "first",
         reserve_growth: bool = False) -> tuple[list[PlanItem], list[tuple[int, int]]]:
    """Place every request in ``space``: largest first, aligned, by
    ``strategy``. Returns the items in request order (an item that does not
    fit carries its reason) and the growth room held back."""
    width = space.width
    units = []  # (length, request index, items) - one unit is placed as one block
    items_by_req: list[list[PlanItem]] = []
    for ri, r in enumerate(requests):
        items = [
            PlanItem(request=ri, n=k + 1, length=r["length"],
                     fields={**r["fields"], "description": _fill(r["description"], k + 1)})
            for k in range(r["count"])
        ]
        items_by_req.append(items)
        if r["keep_together"] and r["count"] > 1:
            group = r["length"] - math.ceil(math.log2(r["count"]))
            units.append((group, ri, items))
        else:
            units.extend((r["length"], ri, [it]) for it in items)
    units.sort(key=lambda u: (u[0], u[1]))

    reserved: list[tuple[int, int]] = []
    for length, _ri, items in units:
        need = items[0].length
        if length < space.root_len or need > width:
            reason = (f"A /{need} is larger than {space.root}." if need < space.root_len
                      else no_room(space, need))
            if need >= space.root_len and len(items) > 1:
                reason = f"No free /{length} left for {len(items)} × /{need} together in {space.root}."
            for it in items:
                it.reason = reason
            continue
        addr = next(iter(space.candidates(length, strategy)), None)
        if addr is None:
            reason = no_room(space, need) if len(items) == 1 else (
                f"No free /{length} left for {len(items)} × /{need} together in {space.root}.")
            for it in items:
                it.reason = reason
            continue
        space.take(addr, length)
        step = 1 << (width - need)
        for k, it in enumerate(items):
            it.addr = addr + k * step
            it.cidr = cidr_of(it.addr, need, space.version)
        if len(items) > 1:
            # The rest of a kept-together block stays free.
            used_end = addr + len(items) * step - 1
            space.taken.remove((addr, addr + (1 << (width - length)) - 1))
            insort(space.taken, (addr, used_end))
        if reserve_growth:
            size = 1 << (width - length)
            nxt = addr + size
            if space.is_free(nxt, length):
                space.take(nxt, length)
                reserved.append((nxt, length))
    flat = [it for items in items_by_req for it in items]
    return flat, reserved


def describe_plan(space: Space, items: list[PlanItem], reserved, *, strategy: str,
                  dry_run: bool, applied: bool = False, created=None) -> dict:
    width = space.width
    placed = [(it.addr, it.addr + (1 << (width - it.length)) - 1) for it in items if it.cidr]
    held = [(a, a + (1 << (width - ln)) - 1) for a, ln in reserved]
    return {
        "parent": {"id": str(space.parent.pk), "cidr": space.parent.cidr},
        "scope": space.root,
        "strategy": strategy,
        "dry_run": dry_run,
        "applied": applied,
        "fits": all(it.cidr for it in items),
        "items": [
            {
                "request": it.request, "n": it.n, "length": it.length,
                "cidr": it.cidr, "description": it.fields.get("description", ""),
                "reason": it.reason,
            }
            for it in items
        ],
        "reserved": [cidr_of(a, ln, space.version) for a, ln in reserved],
        "strip": {
            "root": space.root,
            "used": space.spans(space.occupied),
            "planned": space.spans(placed),
            "reserved": space.spans(held),
        },
        "created": created or [],
    }
