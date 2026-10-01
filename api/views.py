"""Shared IPAM helpers used across the API.

Formerly the legacy server-rendered prefix/IP HTML views; those dead htmx
endpoints were removed (#61). What remains are the live helpers other modules
import - chiefly ``_get_active_tenant`` (used app-wide) and the space-map /
next-available / autospawn utilities the IPAM viewsets call.
"""
from __future__ import annotations

import ipaddress
import json
from typing import Iterable

from django.core.exceptions import ValidationError
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Count, F, Q
from django.db.models.expressions import RawSQL
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.text import slugify
from django.views.decorators.http import require_http_methods, require_POST

from api.forms import IPAddressForm, PrefixForm
from api.form_helpers import initial_from_get, save_and_add_more_redirect
from api.models import VRF, IPAddress, IPRole, Status, Prefix, Site, VLAN
from core.models import Organization, Tag, Tenant
from auth_api.permissions import require_perm
from auth_api.user_prefs import get_page_size


def _tenant_gateway_role(tenant):
    """The role flagged ``is_gateway`` for this tenant, or None. Prefer the
    plain (non-virtual) Gateway role over the Virtual/VIP one for the autospawn."""
    return (
        IPRole.objects.filter(tenant=tenant, is_gateway=True)
        .order_by("is_virtual", "weight")
        .first()
    )


def _tenant_default_status(tenant):
    """The IP status flagged default_for ipaddress, else first IP-usable by weight."""
    ip_statuses = Status.objects.filter(
        tenant=tenant, available_to__contains=["ipaddress"]
    )
    return (
        ip_statuses.filter(default_for__contains=["ipaddress"]).first()
        or ip_statuses.first()
    )


# Fields a "Save and add more" round-trip carries forward on the prefix form.
# CIDR is excluded (unique by definition); tags_input is excluded for now
# because the form converts it from a comma-separated string and round-tripping
# would need extra normalization.
PREFIX_STICKY_FIELDS = ["status", "site", "vlan", "vrf", "description"]


# ─── Shared helpers ────────────────────────────────────────────────────────


SORT_FIELDS = {
    # `cidr` is special-cased above to render the section/tree view.
    # Everything else falls through to a flat ORDER BY on the queryset.
    "cidr": "cidr", "-cidr": "-cidr",
    "status": "status", "-status": "-status",
    "vlan": "vlan__vlan_id", "-vlan": "-vlan__vlan_id",
    "site": "site__name", "-site": "-site__name",
    "gateway": "gateway", "-gateway": "-gateway",
    "description": "description", "-description": "-description",
    "created": "created_at", "-created": "-created_at",
    "updated": "updated_at", "-updated": "-updated_at",
}


def _get_active_tenant(request=None):
    """The current tenant, scoped to what the signed-in user can access.

    Picks the user's session-stored tenant if they still have access; else
    falls back to the first allowed tenant. Anonymous callers or users
    without any granted tenants get None - views should handle that with
    ``api/no_org.html``.

    Unauthenticated calls (no request, or anonymous user) keep the legacy
    behaviour of returning the first active tenant. Anything signed in is
    filtered through :func:`auth_api.permissions.user_tenants`.
    """
    if request is None or not getattr(request, "user", None) \
            or not request.user.is_authenticated:
        return Tenant.objects.filter(is_active=True).first()

    # Resolved once per request. Every serializer row asks for the active
    # tenant (the per-row permissions field, site scoping), and each ask cost
    # a tenant query - a page of a hundred devices ran a hundred of them, a
    # full list thousands. The answer is keyed on what could change it inside
    # a request (the session's choice, the token's tenant, the user), so a
    # tenant switch in the same request still sees its new choice.
    session = request.session if hasattr(request, "session") else None
    tok_tid = getattr(getattr(request, "auth", None), "tenant_id", None)
    key = (
        request.user.pk,
        tok_tid,
        session.get("current_tenant_id") if session else None,
    )
    holder = getattr(request, "_request", request)
    memo = getattr(holder, "_danbyte_active_tenant", None)
    if memo is not None and memo[0] == key:
        return memo[1]

    from auth_api.permissions import user_tenants
    allowed = user_tenants(request.user)
    tenant = None
    # An API token is scoped to a tenant - honour it (runners have no session).
    if tok_tid:
        tenant = allowed.filter(pk=tok_tid).first()
    if tenant is None:
        # Session choice, else the profile's home tenant (site-role
        # provisioning sets it to where the user's grants live, so a
        # multi-tenant user does not land on an arbitrary first tenant), else
        # the first allowed.
        from auth_api.permissions import active_tenant
        tenant = active_tenant(request.user, session)
    try:
        holder._danbyte_active_tenant = (key, tenant)
    except AttributeError:
        pass
    return tenant


# Back-compat alias so I don't have to touch every call site at once.
_get_active_org = _get_active_tenant


def _parse_int(value, default, min_value=1):
    try:
        return max(int(value), min_value)
    except (TypeError, ValueError):
        return default


# Most used-span segments one cell carries. Past this the cell is cut into
# this many equal bins instead, so a cell holding a thousand /32s stays a few
# bars.
SPACE_MAP_MAX_SPANS = 16

# A gap narrower than this share of a cell is at most a pixel wide on any
# cell the map draws, so the spans either side of it are drawn as one.
SPACE_MAP_GAP_SLACK = 1024


def _space_map_spans(intervals, cell_first, size, limit=SPACE_MAP_MAX_SPANS):
    """``[start, end, share]`` spans of a cell covered by ``intervals``.

    ``intervals`` are sorted, disjoint ``(first, last)`` address ints inside
    the cell. ``start`` / ``end`` are fractions of the cell and ``share`` is how
    much of that stretch is really in use (1 for a solid span), so the map can
    draw a stretch that holds pixel-wide gaps fainter instead of as taken.

    Touching blocks, and blocks at most a pixel apart, merge into one span.
    Past ``limit`` spans the cell is cut into ``limit`` equal bins, and each
    bin that holds anything becomes one solid sliver as wide as what it holds,
    centred on where it sits. Free space is never drawn as used: the used
    addresses always add up to ``sum((end - start) * share)``.
    """
    slack = size // SPACE_MAP_GAP_SLACK
    merged: list[list[int]] = []  # [first, last, used]
    for first, last in intervals:
        if merged and first - merged[-1][1] - 1 <= slack:
            merged[-1][1] = last
            merged[-1][2] += last - first + 1
        else:
            merged.append([first, last, last - first + 1])
    if len(merged) <= limit or size < limit:
        return [
            [
                (first - cell_first) / size,
                (last + 1 - cell_first) / size,
                used / (last - first + 1),
            ]
            for first, last, used in merged
        ]
    width = size // limit
    bins: dict[int, list[int]] = {}  # bin -> [used, sum of used * midpoint x2]
    for first, last in intervals:
        a, b = first - cell_first, last - cell_first
        while a <= b:
            i = a // width
            end = min(b, (i + 1) * width - 1)
            n = end - a + 1
            slot = bins.setdefault(i, [0, 0])
            slot[0] += n
            slot[1] += n * (a + end + 1)
            a = end + 1
    spans = []
    for i in sorted(bins):
        used, weighted = bins[i]
        lo = i * width
        start = min(max(weighted // (2 * used) - used // 2, lo), lo + width - used)
        spans.append([start / size, (start + used) / size, 1.0])
    return spans


def _range_label(first: int, last: int, version: int) -> str:
    """A compact IP range label: ``10.0.0.10–50``, ``10.0.0.250–1.5``."""
    a = ipaddress.ip_address(first)
    if first == last:
        return str(a)
    b = ipaddress.ip_address(last)
    if version == 4:
        sa, sb = str(a).split("."), str(b).split(".")
        k = next(i for i in range(4) if sa[i] != sb[i])
        return f"{a}–{'.'.join(sb[k:])}"
    return f"{a}–{b}"


def _space_map_ips(net, *, tenant, vrf) -> list[int]:
    """Sorted address ints of the IPs in ``tenant`` + ``vrf`` inside ``net``.

    The containment test runs in Postgres, so a zoom into a /28 reads the
    handful of IPs in it, not every IP the tenant holds.
    """
    from django.db.models import BooleanField

    rows = (
        IPAddress.objects
        .filter(tenant=tenant, vrf=vrf)
        .annotate(_inside=RawSQL(
            "ip_address::inet <<= %s::inet", (str(net),),
            output_field=BooleanField(),
        ))
        .filter(_inside=True)
        .values_list("ip_address", flat=True)
    )
    out = []
    for s in rows:
        try:
            out.append(int(ipaddress.ip_address(s)))
        except ValueError:
            continue
    out.sort()
    return out


def _space_map_ranges(net, *, tenant, vrf) -> list[tuple[int, int]]:
    """``(first, last)`` of every IP range in ``tenant`` + ``vrf`` that
    overlaps ``net``, sorted by first address."""
    from django.db.models import BooleanField

    from api.models import IPRange

    rows = (
        IPRange.objects
        .filter(tenant=tenant, vrf=vrf)
        .annotate(_hit=RawSQL(
            "family(start_address::inet) = %s"
            " AND start_address::inet <= %s::inet"
            " AND end_address::inet >= %s::inet",
            (net.version, str(net.broadcast_address), str(net.network_address)),
            output_field=BooleanField(),
        ))
        .filter(_hit=True)
        .values_list("start_address", "end_address")
    )
    out = []
    for s, e in rows:
        try:
            a, b = int(ipaddress.ip_address(s)), int(ipaddress.ip_address(e))
        except ValueError:
            continue
        if a <= b:
            out.append((a, b))
    out.sort()
    return out


def _union(intervals):
    """Sorted, overlapping ``(first, last)`` pairs → sorted disjoint ones."""
    out: list[list[int]] = []
    for a, b in intervals:
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


#: The most subnets a row past the +8 window may have (``deeper``): a /16
#: goes down to /31 (32,768), a /64 to /80.
SPACE_MAP_DEEP_CELLS = 1 << 16


def _space_map_step(net, prefixlen: int) -> int:
    """The next row's prefix length after ``prefixlen``: a bit for IPv4, a
    nibble for IPv6 until it is within a nibble of /128."""
    if net.version == 4 or net.max_prefixlen - prefixlen < 4:
        return prefixlen + 1
    return prefixlen + 4


def _space_map_next_row(net, last: int, *, max_v4=None, max_v6=None):
    """``{prefixlen, count}`` of the row a ``deeper`` request would add after
    the row at ``last``, or None when the depth preference, the family's
    deepest row or ``SPACE_MAP_DEEP_CELLS`` ends the map there."""
    deepest = 31 if net.version == 4 else 128
    cap = max_v4 if net.version == 4 else max_v6
    nxt = _space_map_step(net, last)
    if nxt > deepest or (cap is not None and nxt > cap):
        return None
    count = 1 << (nxt - net.prefixlen)
    return {"prefixlen": nxt, "count": count} if count <= SPACE_MAP_DEEP_CELLS else None


def _space_map_run_row(net, prefixlen, *, tops, kids, ip_ints, ranges):
    """A row past the +8 window as runs of cells, not cells: thousands of
    them would be megabytes. Each run is ``[first, last, state, dirty,
    ranged, prefix]`` - cell indexes, the state every cell in it shares,
    whether its free cells hold stray IPs, whether an IP range reaches it,
    and the outermost child prefix a used run sits in. Worked out from the
    children, IPs and ranges in one sweep, so it costs the same at /31 as at
    /24."""
    from bisect import bisect_right
    from itertools import pairwise

    first = int(net.network_address)
    shift = net.max_prefixlen - prefixlen
    count = 1 << (prefixlen - net.prefixlen)

    def idx(addr):
        return (addr - first) >> shift

    # The outermost child at each top block (kids are sorted biggest first).
    top_kid = {}
    for kid in kids:
        top_kid.setdefault(int(kid.network_address), kid)
    # Used stretches: a child at least a cell wide fills its cells; a smaller
    # one makes its cell partly used. Outermost children are disjoint.
    segments = []  # [first, last, state, prefix], covering 0..count-1
    at = 0
    for a, b in tops:
        kid = top_kid[a]
        i, j = idx(a), idx(b)
        state = "full" if kid.prefixlen <= prefixlen else "partial"
        if state == "partial" and segments and segments[-1][1] == i:
            continue  # another small child in the same cell
        if i > at:
            segments.append([at, i - 1, "free", None])
        segments.append([i, j, state, str(kid)])
        at = j + 1
    if at < count:
        segments.append([at, count - 1, "free", None])

    # Stray IPs (outside every child) by cell, and the cells ranges reach.
    top_firsts = [a for a, _ in tops]
    dirty = set()
    for x in ip_ints:
        t = bisect_right(top_firsts, x) - 1
        if t < 0 or tops[t][1] < x:
            dirty.add(idx(x))
    reach = []
    for lo, hi in sorted((idx(a), idx(b)) for a, b in ranges):
        if reach and lo <= reach[-1][1] + 1:
            reach[-1][1] = max(reach[-1][1], hi)
        else:
            reach.append([lo, hi])

    # Every place a run can change, then one pass over them.
    marks = {0, count}
    for seg in segments:
        marks.update((seg[0], seg[1] + 1))
    for d in dirty:
        marks.update((d, d + 1))
    for lo, hi in reach:
        marks.update((lo, hi + 1))
    marks = sorted(m for m in marks if 0 <= m <= count)

    runs = []
    si = ri = 0
    for lo, nxt in pairwise(marks):
        while segments[si][1] < lo:
            si += 1
        while ri < len(reach) and reach[ri][1] < lo:
            ri += 1
        _, _, state, prefix = segments[si]
        is_ranged = state != "full" and ri < len(reach) and reach[ri][0] <= lo
        is_dirty = state == "free" and lo in dirty
        run = [lo, nxt - 1, state, is_dirty, is_ranged, prefix]
        if runs and runs[-1][1] == lo - 1 and runs[-1][2:] == run[2:]:
            runs[-1][1] = nxt - 1
        else:
            runs.append(run)

    def cells(state=None, flag=None):
        return sum(
            r[1] - r[0] + 1 for r in runs
            if (state is None or r[2] == state) and (flag is None or r[flag])
        )

    return {
        "prefixlen": prefixlen,
        "count": count,
        "free_count": cells("free"),
        "partial_count": cells("partial"),
        "dirty_count": cells("free", 3),
        "ranged_count": cells(flag=4),
        "cells": [],
        "runs": runs,
    }


def _build_space_map(
    net, *, child_nets, tenant, vrf, max_v4=None, max_v6=None, deeper=0
):
    """Build the space-map row list for ``net``.

    Every aligned subnet (a cell) gets a ``state``:

    - ``full`` - the cell sits inside (or is) a child prefix. ``exact`` says
      the cell *is* that prefix; ``overlap_with`` lists the covering prefixes,
      most specific first.
    - ``partial`` - no child covers the cell, but smaller children sit inside
      it. ``overlap_with`` lists those children (outermost only), and
      ``used_fraction`` / ``used_spans`` say how much of the cell they take and
      where, so the map can draw the used part and let the operator zoom in.
    - ``free`` - no child prefix touches the cell. ``dirty`` flags one that
      already holds IPs (stray addresses a new prefix would adopt).

    IP ranges don't change the state - a range is not a prefix, and a new
    child prefix over a pool is how the pool gets its subnet. A free or partly
    used cell a range reaches carries ``range_count``, ``ranges`` (labels) and
    ``range_spans`` instead, so the operator sees the pool before carving over
    it. Ranges that sit wholly inside a child prefix belong to that prefix and
    are left out.

    ``used`` stays true for any cell a child touches (full or partial).

    A child equal to ``net`` itself is the context the map is drawn inside
    (the operator zoomed into an existing prefix), not a child: it is skipped,
    so its own free space shows as free.

    ``max_v4`` / ``max_v6`` are the user's per-family "deepest prefix length to
    show" preference. They can only make the map *shallower* - clamped after the
    +8 / 256-cell safety cap, never beyond it.

    ``deeper`` adds that many rows past the +8 window (still within the
    preference), each as runs of cells (``_space_map_run_row``) rather than
    cells.
    """
    rows = []
    if net is None:
        return rows
    # Per-family "deepest" boundary: v4 bottoms out at the /31 point-to-point
    # (a /32 is a host); v6 goes all the way to /128 host cells.
    v4 = net.version == 4
    deepest = 31 if v4 else 128
    if net.prefixlen >= deepest:
        return rows
    width = net.max_prefixlen

    # The IPs inside ``net`` as a sorted int list, so the per-cell count is
    # O(log n). Python ints are arbitrary-precision, so this is v6-safe (a /64
    # never explodes - only the *registered* IPs are listed, never the space).
    from bisect import bisect_left, bisect_right
    ip_ints = _space_map_ips(net, tenant=tenant, vrf=vrf)

    # Children strictly inside ``net``, sorted by first address and then
    # largest block first, so a parent always precedes its own children.
    # CIDR blocks either nest or are disjoint, which is what makes the two
    # lookups below exact: the children *covering* a cell are its supernets
    # (a dict hit per length), and the children *inside* it are a contiguous
    # run of first addresses (a bisect).
    kids = sorted(
        {
            c for c in child_nets
            if c.version == net.version and c != net and c.subnet_of(net)
        },
        key=lambda c: (int(c.network_address), c.prefixlen),
    )
    by_block = {(int(c.network_address), c.prefixlen): c for c in kids}
    kid_firsts = [int(c.network_address) for c in kids]

    # IP ranges not wholly inside a child prefix. The outermost children are
    # disjoint, so the one that could hold a range is the last starting at or
    # before it.
    tops: list[tuple[int, int]] = []
    for c in kids:
        a, b = int(c.network_address), int(c.broadcast_address)
        if not tops or a > tops[-1][1]:
            tops.append((a, b))
    top_firsts = [a for a, _ in tops]
    ranges = []
    for a, b in _space_map_ranges(net, tenant=tenant, vrf=vrf):
        i = bisect_right(top_firsts, a) - 1
        if i >= 0 and tops[i][1] >= b:
            continue
        ranges.append((a, b))
    range_firsts = [a for a, _ in ranges]
    # Running max of the range ends: ranges may overlap or nest, so the first
    # one that can reach a cell is found by the end, not the start.
    range_reach = []
    for _, b in ranges:
        range_reach.append(max(b, range_reach[-1]) if range_reach else b)

    # Which child prefix-lengths to render as rows. We never go deeper than
    # +8 bits, so every row has ≤256 cells. v4 steps one bit at a time. v6
    # steps a nibble (4 bits) for readability - a /64 shows /68·/72, not eight
    # dense rows - but falls back to bit-steps for prefixes within a nibble of
    # /128 (e.g. a /126 still shows /127·/128).
    hi = min(net.prefixlen + 8, deepest)
    # User "max depth" preference can only narrow the view (never beyond the
    # +8 safety cap or the family's deepest); a cap shallower than the first
    # child row is ignored.
    cap = max_v4 if v4 else max_v6
    if cap is not None:
        hi = min(hi, max(net.prefixlen + 1, cap))
    if v4:
        steps = list(range(net.prefixlen + 1, hi + 1))
    else:
        steps = [p for p in range(net.prefixlen + 1, hi + 1)
                 if (p - net.prefixlen) % 4 == 0]
        if not steps:
            steps = list(range(net.prefixlen + 1, hi + 1))

    for new_prefixlen in steps:
        cells = []
        for s in net.subnets(new_prefix=new_prefixlen):
            cell_first = int(s.network_address)
            cell_last = int(s.broadcast_address)
            size = cell_last - cell_first + 1

            # Covering children: the cell itself or one of its supernets
            # down to (not including) ``net``. Most specific first.
            covering = []
            for plen in range(new_prefixlen, net.prefixlen, -1):
                block_first = cell_first & ~((1 << (width - plen)) - 1)
                hit = by_block.get((block_first, plen))
                if hit is not None:
                    covering.append(hit)

            # Children inside the cell, outermost only (a grandchild inside
            # a child adds nothing to what is used).
            inside = []
            if not covering:
                end = -1
                lo = bisect_left(kid_firsts, cell_first)
                upto = bisect_right(kid_firsts, cell_last)
                for kid in kids[lo:upto]:
                    k_first = int(kid.network_address)
                    if k_first <= end:
                        continue
                    inside.append(kid)
                    end = int(kid.broadcast_address)

            if covering:
                state = "full"
                listed = covering
                used_fraction = 1.0
                spans = [[0.0, 1.0, 1.0]]
            elif inside:
                state = "partial"
                listed = inside
                intervals = [
                    (int(k.network_address), int(k.broadcast_address))
                    for k in inside
                ]
                used_fraction = sum(b - a + 1 for a, b in intervals) / size
                spans = _space_map_spans(intervals, cell_first, size)
            else:
                state = "free"
                listed = []
                used_fraction = 0.0
                spans = []

            # IP ranges reaching the cell (a full cell's belong to its prefix).
            cell_ranges = []
            if state != "full" and ranges:
                lo = bisect_left(range_reach, cell_first)
                upto = bisect_right(range_firsts, cell_last)
                cell_ranges = [r for r in ranges[lo:upto] if r[1] >= cell_first]
            range_spans = (
                _space_map_spans(
                    _union(sorted(
                        (max(a, cell_first), min(b, cell_last))
                        for a, b in cell_ranges
                    )),
                    cell_first, size,
                )
                if cell_ranges else []
            )

            ip_count = (
                bisect_right(ip_ints, cell_last) - bisect_left(ip_ints, cell_first)
            )
            used = state != "free"
            cells.append({
                "cidr": str(s),
                "state": state,
                "used": used,
                # The cell is exactly an existing child prefix.
                "exact": bool(covering) and covering[0].prefixlen == new_prefixlen,
                "overlap_with": [str(c) for c in listed[:3]],
                "overlap_count": len(listed),
                "used_fraction": used_fraction,
                "used_spans": spans,
                # "dirty" = free but the address range already holds IPs.
                # Creating a new prefix here would have to re-parent them.
                "dirty": (not used) and (ip_count > 0),
                "ip_count": ip_count,
                "range_count": len(cell_ranges),
                "ranges": [
                    _range_label(a, b, net.version) for a, b in cell_ranges[:3]
                ],
                "range_spans": range_spans,
            })
        free_count = sum(1 for c in cells if c["state"] == "free")
        partial_count = sum(1 for c in cells if c["state"] == "partial")
        dirty_count = sum(1 for c in cells if c["dirty"])
        ranged_count = sum(1 for c in cells if c["range_count"])
        rows.append({
            "prefixlen": new_prefixlen,
            "count": len(cells),
            "free_count": free_count,
            "partial_count": partial_count,
            "dirty_count": dirty_count,
            "ranged_count": ranged_count,
            "cells": cells,
        })
    last = steps[-1] if steps else net.prefixlen
    for _ in range(max(0, int(deeper or 0))):
        nxt = _space_map_next_row(net, last, max_v4=max_v4, max_v6=max_v6)
        if nxt is None:
            break
        rows.append(_space_map_run_row(
            net, nxt["prefixlen"], tops=tops, kids=kids, ip_ints=ip_ints,
            ranges=ranges,
        ))
        last = nxt["prefixlen"]
    return rows


def _subnet_details(prefix) -> list[dict] | None:
    """Computed display rows for the "Subnet details" card on prefix /
    IP detail. Returns ``None`` for unparseable CIDRs so the card renders
    nothing instead of crashing the page.

    Each row is ``{label, value, mono, copy}`` - ``copy`` is the exact
    string copied to clipboard when the user clicks the row's copy
    button (usually ``value`` minus any " (.0)" annotation).
    """
    net = prefix.network
    if net is None:
        return None

    rows = [
        {"label": "CIDR",       "value": str(net), "mono": True, "copy": str(net)},
        {"label": "Network",    "value": str(net.network_address), "mono": True,
         "copy": str(net.network_address)},
    ]

    if net.version == 4:
        rows.append({
            "label": "Netmask", "value": str(net.netmask), "mono": True,
            "copy": str(net.netmask),
        })
        rows.append({
            "label": "Wildcard", "value": str(net.hostmask), "mono": True,
            "copy": str(net.hostmask),
        })

    rows.append({
        "label": "Prefix length", "value": f"/{net.prefixlen}", "mono": True,
        "copy": f"/{net.prefixlen}",
    })

    # First / last usable. /31 and /32 (IPv4) are point-to-point or host
    # routes - every address is "usable", so show first==network and
    # last==broadcast directly without the "+1/-1" trim.
    if net.version == 4 and net.prefixlen <= 30:
        first_usable = str(net.network_address + 1)
        last_usable = str(net.broadcast_address - 1)
    elif net.version == 6 and net.prefixlen <= 126:
        first_usable = str(net.network_address + 1)
        last_usable = str(net.broadcast_address - 1)
    else:
        first_usable = str(net.network_address)
        last_usable = str(net.broadcast_address)
    rows.append({
        "label": "First usable", "value": first_usable, "mono": True,
        "copy": first_usable,
    })
    rows.append({
        "label": "Last usable", "value": last_usable, "mono": True,
        "copy": last_usable,
    })

    # Broadcast is only meaningful for v4 prefixes /30 or larger.
    if net.version == 4 and net.prefixlen <= 30:
        rows.append({
            "label": "Broadcast", "value": str(net.broadcast_address), "mono": True,
            "copy": str(net.broadcast_address),
        })

    # Total addresses + usable hosts.
    total = net.num_addresses
    if net.version == 4 and net.prefixlen <= 30:
        usable = total - 2
    elif net.version == 6 and net.prefixlen <= 126:
        usable = total - 2
    else:
        usable = total
    rows.append({
        "label": "Total addresses",
        "value": f"{total:,}", "mono": False, "copy": str(total),
    })
    rows.append({
        "label": "Usable hosts",
        "value": f"{usable:,}", "mono": False, "copy": str(usable),
    })

    # Allocating from ranges: the provider's slice is what's managed here,
    # shown next to the theoretical subnet capacity above.
    summary = prefix.allocation_summary()
    if summary is not None:
        spans = ", ".join(
            f"{r['start_address']}–{r['end_address']}" for r in summary["ranges"]
        ) or "no ranges yet"
        rows.append({
            "label": "Allocation", "value": spans, "mono": True,
            "copy": spans,
        })
        rows.append({
            "label": "Managed addresses",
            "value": f"{summary['size']:,}", "mono": False,
            "copy": str(summary["size"]),
        })
        rows.append({
            "label": "Used", "value": f"{summary['used']:,}", "mono": False,
            "copy": str(summary["used"]),
        })
        rows.append({
            "label": "Available", "value": f"{summary['free']:,}", "mono": False,
            "copy": str(summary["free"]),
        })

    return rows


def _next_available_ips(prefix, *, count: int = 5) -> list[str]:
    """First ``count`` host addresses inside ``prefix`` that aren't already
    registered in this tenant+VRF.

    Useful on the prefix-detail header so an operator can spot the next
    free address (and click to register it) without scanning the IPs table.
    Only runs for *enumerable* prefixes (≤ ``ENUMERABLE_HOST_CAP`` addresses) -
    a /64 has no meaningful "next free" and we won't iterate 2⁶⁴ hosts.
    """
    from .models import ENUMERABLE_HOST_CAP, is_enumerable

    net = prefix.network
    if net is None:
        return []
    spans = prefix.allocation_spans()
    if not spans and (prefix.allocate_from_ranges or not is_enumerable(net)):
        return []
    used = set(
        IPAddress.objects
        .filter(tenant=prefix.tenant, vrf=prefix.vrf)
        .values_list("ip_address", flat=True)
    )
    out: list[str] = []
    if spans:
        # Allocating from ranges: walk the ranges, not the network. A range
        # is bounded on its own, so no enumerability gate - just a step cap.
        budget = ENUMERABLE_HOST_CAP
        for start, end in spans:
            for n in range(start, end + 1):
                if budget <= 0:
                    return out
                budget -= 1
                addr = str(ipaddress.ip_address(n))
                if addr not in used:
                    out.append(addr)
                    if len(out) >= count:
                        return out
        return out
    # `.hosts()` skips network + broadcast on /30 or shorter, which is what
    # operators want here - those addresses aren't normally assignable.
    for host in net.hosts():
        addr = str(host)
        if addr not in used:
            out.append(addr)
            if len(out) >= count:
                break
    return out


def reparent_ips_into(prefix) -> int:
    """When a new prefix is created, pull in the IPs it now *most-specifically*
    contains: IPs in the same (tenant, VRF) that fall inside ``prefix`` but are
    currently parented to a **broader ancestor** prefix - WITHOUT stealing IPs
    that belong to an existing more-specific child of ``prefix``.

    Danbyte pins each IP to exactly one prefix (``IPAddress.prefix`` FK), so
    carving a subnet out of a parent must re-home the covered IPs or they'd stay
    stranded on the parent (the bug behind "created a subnet in the map view and
    the IPs didn't move"). Returns the number of IPs moved.
    """
    net = prefix.network
    if net is None:
        return 0
    first = int(net.network_address)
    last = int(net.broadcast_address)
    new_len = net.prefixlen

    # Existing prefixes more specific than this one, same tenant+VRF, inside its
    # range - an IP within one of those belongs there, not on ``prefix``.
    children = []
    for p in (
        Prefix.objects.filter(tenant=prefix.tenant, vrf=prefix.vrf)
        .exclude(pk=prefix.pk)
    ):
        pn = p.network
        if pn is None or pn.prefixlen <= new_len:
            continue
        if int(pn.network_address) >= first and int(pn.broadcast_address) <= last:
            children.append((int(pn.network_address), int(pn.broadcast_address)))

    def covered_by_child(addr_int: int) -> bool:
        return any(lo <= addr_int <= hi for lo, hi in children)

    moved = 0
    with transaction.atomic():
        qs = (
            IPAddress.objects.filter(tenant=prefix.tenant, vrf=prefix.vrf)
            .exclude(prefix=prefix)
            .select_related("prefix")
        )
        for ip in qs.iterator():
            cur = ip.prefix
            cur_net = cur.network if cur else None
            # Only pull from a broader (or unparented) prefix - never steal from
            # a same-or-more-specific one.
            if cur_net is not None and cur_net.prefixlen >= new_len:
                continue
            try:
                addr_int = int(ipaddress.ip_address(ip.ip_address))
            except ValueError:
                continue
            if not (first <= addr_int <= last) or covered_by_child(addr_int):
                continue
            ip.prefix = prefix
            ip.vrf = prefix.vrf  # keep the IP's VRF consistent with its prefix
            ip.save(update_fields=["prefix", "vrf"])
            moved += 1
    return moved


def reparent_ips_out_of(prefix, *, dry_run: bool = False) -> dict:
    """Before a prefix goes: hand every address on it to the longest prefix
    that still contains it. See :func:`reparent_ips_out_of_batch`."""
    return reparent_ips_out_of_batch([prefix], dry_run=dry_run)


def reparent_ips_out_of_batch(prefixes, *, dry_run: bool = False) -> dict:
    """Before these prefixes go: hand every address on them to the longest
    prefix that still contains it **and survives this batch** (same tenant
    and VRF). A prefix about to be deleted is never a landing place - a
    parent and its child selected together used to move the child's
    addresses into the parent and then cascade them away, reporting them as
    moved (#215). Addresses nothing surviving covers are counted as
    ``removed`` - they fall with the prefix, as the confirm dialog says.
    Returns the counts and the prefix most addresses land on.

    One scan of the candidate prefixes per (tenant, VRF) in the batch, and
    one UPDATE per landing prefix - not per selected row and per address."""
    going = {p.pk for p in prefixes}
    if not going:
        return {"moved": 0, "removed": 0, "parent": None}
    ips = list(
        IPAddress.objects.filter(prefix_id__in=going).only(
            "id", "ip_address", "prefix_id"
        )
    )
    if not ips:
        return {"moved": 0, "removed": 0, "parent": None}

    source = {p.pk: p for p in prefixes}
    survivors: dict[tuple, list] = {}
    for key in {(p.tenant_id, p.vrf_id) for p in prefixes}:
        rows = []
        for p in (
            Prefix.objects.filter(tenant_id=key[0], vrf_id=key[1])
            .exclude(pk__in=going)
        ):
            pn = p.network
            if pn is not None:
                rows.append((pn.prefixlen, pn, p))
        rows.sort(key=lambda r: -r[0])  # longest match first
        survivors[key] = rows

    moved = 0
    landing: dict[str, int] = {}
    assign: dict = {}
    for ip in ips:
        src = source.get(ip.prefix_id)
        if src is None:
            continue
        try:
            addr = ipaddress.ip_address(ip.ip_address)
        except ValueError:
            continue
        for _, pn, target in survivors.get((src.tenant_id, src.vrf_id), ()):
            if addr.version == pn.version and addr in pn:
                assign.setdefault(target.pk, []).append(ip.pk)
                landing[str(target.cidr)] = landing.get(str(target.cidr), 0) + 1
                moved += 1
                break
    if not dry_run and assign:
        with transaction.atomic():
            for target_pk, ip_pks in assign.items():
                IPAddress.objects.filter(pk__in=ip_pks).update(prefix_id=target_pk)
    parent = max(landing.items(), key=lambda kv: kv[1])[0] if landing else None
    return {"moved": moved, "removed": len(ips) - moved, "parent": parent}


def _apply_filters(qs, params):
    """Apply the same filter set used by both the list view and the export."""
    statuses = params.getlist("status")
    if statuses:
        qs = qs.filter(status__in=statuses)

    site_names = params.getlist("site")
    if site_names:
        qs = qs.filter(site__name__in=site_names)

    family = params.get("family")
    if family == "4":
        qs = qs.filter(cidr__contains=".")
    elif family == "6":
        qs = qs.filter(cidr__contains=":")

    q = (params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(cidr__icontains=q) | Q(description__icontains=q))

    return qs


# ─── List view ─────────────────────────────────────────────────────────────


def _condensed_page_range(page) -> list:
    """Compact pager: 1 … current-1 current current+1 … last."""
    n = page.paginator.num_pages
    cur = page.number
    if n <= 7:
        return list(range(1, n + 1))
    pages = {1, n, cur - 1, cur, cur + 1}
    pages = sorted(p for p in pages if 1 <= p <= n)
    out = []
    prev = 0
    for p in pages:
        if p - prev > 1:
            out.append("…")
        out.append(p)
        prev = p
    return out


# ─── Gateway / address helpers ───────────────────────────────────────────


def _gateway_address_for(network, policy):
    """Return the canonical IP string for a site's gateway policy, or None."""
    if network is None or policy in (None, "none", ""):
        return None
    if policy == "first":
        try:
            return str(next(network.hosts()))
        except StopIteration:
            return None
    if policy == "last":
        if network.version == 4 and network.num_addresses > 2:
            return str(network.broadcast_address - 1)
        if network.version == 6 and network.num_addresses > 1:
            return str(network.broadcast_address)
        if network.num_addresses == 2:  # /31 etc
            return str(network.broadcast_address)
        return str(network.network_address)
    return None


def _set_tags_from_string(obj, raw, *, create_missing=True):
    """Parse a comma-separated tag string and apply to ``obj``."""
    names = [n.strip() for n in (raw or "").split(",") if n.strip()]
    if not names:
        obj.tags.clear()
        return
    tags = []
    for name in names:
        t, _ = Tag.objects.get_or_create(
            name=name, defaults={"slug": slugify(name)}
        ) if create_missing else (Tag.objects.filter(name=name).first(), False)
        if t is not None:
            tags.append(t)
    obj.tags.set(tags)


def _autospawn_gateway(prefix, *, request=None):
    """If the prefix's site has a gateway_policy, create an IPAddress with
    role='gateway' at that address and copy it onto ``prefix.gateway``.

    No-op for IPv6 (we don't want to register specific /64 gateways from
    policy alone) or when policy is 'none'.
    """
    if prefix.site is None:
        return None
    policy = prefix.site.gateway_policy
    if policy in (None, "", "none"):
        return None
    net = prefix.network
    if net is None or net.version == 6:
        return None
    gw_addr = _gateway_address_for(net, policy)
    if gw_addr is None:
        return None
    # The first/last usable of a subnet that isn't yours is the provider's
    # gateway, not an address you allocate - leave it to the operator.
    if prefix.allocate_from_ranges and not prefix.in_allocation(gw_addr):
        return None

    gateway_role = _tenant_gateway_role(prefix.tenant)
    default_status = _tenant_default_status(prefix.tenant)
    ip, _ = IPAddress.objects.get_or_create(
        tenant=prefix.tenant,
        ip_address=gw_addr,
        defaults={
            "prefix": prefix,
            "status": default_status,
            "role": gateway_role,
            "description": "Auto-created by site gateway policy.",
        },
    )
    # If it pre-existed (e.g. someone imported it earlier), make sure it's a
    # gateway now and attached to this prefix.
    changed = False
    if gateway_role and ip.role_id != gateway_role.id:
        ip.role = gateway_role
        changed = True
    if ip.prefix_id != prefix.id:
        ip.prefix = prefix
        changed = True
    if changed:
        ip.save()
    prefix.gateway = gw_addr
    prefix.save(update_fields=["gateway", "updated_at"])
    return ip


# ─── Prefix detail ────────────────────────────────────────────────────────


# ─── Prefix create / edit / delete ───────────────────────────────────────


# ─── Map-picker modal (used inside the prefix-create form) ───────────────


# ─── IP create + role action ─────────────────────────────────────────────


def _next_free_address(prefix):
    """Find the lowest unregistered host address in the prefix.

    Returns a string or None. Skips already-registered IPs.
    """
    net = prefix.network
    if net is None:
        return None
    registered = set(prefix.ip_addresses.values_list("ip_address", flat=True))
    if net.version == 4 and net.num_addresses > 2:
        for host in net.hosts():
            if str(host) not in registered:
                return str(host)
    elif net.version == 4:
        for host in net:
            if str(host) not in registered:
                return str(host)
    else:
        # IPv6 - sample the first usable
        try:
            return str(next(net.hosts()))
        except StopIteration:
            return None
    return None


def _make_gateway(prefix, ip):
    """Set ``ip`` as the gateway for ``prefix``: clear any prior gateway role
    on siblings, sync ``prefix.gateway`` to this address.
    """
    gateway_role = _tenant_gateway_role(prefix.tenant)
    if gateway_role is None:
        return
    # Clear gateway role from other IPs in the same prefix.
    IPAddress.objects.filter(
        prefix=prefix, role=gateway_role
    ).exclude(pk=ip.pk).update(role=None)
    if ip.role_id != gateway_role.id:
        ip.role = gateway_role
        ip.save(update_fields=["role", "updated_at"])
    if prefix.gateway != ip.ip_address:
        prefix.gateway = ip.ip_address
        prefix.save(update_fields=["gateway", "updated_at"])


# ─── Export ────────────────────────────────────────────────────────────────


# ─── Per-prefix IP export ──────────────────────────────────────────────────


# ─── Per-prefix IP import ──────────────────────────────────────────────────


# ─── Import ────────────────────────────────────────────────────────────────

