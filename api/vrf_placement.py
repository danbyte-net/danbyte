"""Choose which VRF's address space a discovered address belongs in.

Sync engines never invent address space: an address is recorded only when a
containing Prefix already exists. This module answers the question that comes
first — *whose* prefixes do we look at.

Historically every sync searched the Global VRF alone, so moving a prefix into a
VRF didn't put its addresses in the wrong place, it made them **disappear**:
nothing contained them any more and they were dropped without a word. Placement
is now a stated policy per connection, refinable per virtual switch, network and
interface.

Two rules the callers depend on:

* **Nothing here writes a VRF onto anything.** An address's VRF is denormalised
  from its prefix (``IPAddress.save()``), so choosing the prefix *is* choosing
  the VRF. Callers read the policy chain live, which means a policy change takes
  effect on the next pass with nothing to backfill.
* **A stated VRF is a hard scope, not a preference.** If a policy names a VRF
  and no prefix there contains the address, the address is skipped and reported
  — never quietly re-homed into Global. A pin that silently falls back is worse
  than no pin at all.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass

# "No opinion — search every VRF." Distinct from ``None``, which is the Global
# VRF: a real, nameable routing context, not the absence of one.
ANY_VRF = object()

PINNED = "pinned"
SEARCH = "search"

VRF_MODE_CHOICES = [
    (PINNED, "Only the chosen VRF"),
    (SEARCH, "Chosen VRF first, then any other"),
]


def vrf_label(vrf) -> str:
    """How a VRF reads in a warning. NULL is 'Global', not blank."""
    return getattr(vrf, "name", None) or "Global"


@dataclass(frozen=True)
class Placement:
    """Where one address is allowed to live.

    ``preferred`` is a VRF instance or ``None`` (``None`` = Global VRF — a real
    value, not "unset"). ``allow_other_vrfs`` widens the search to every other
    VRF *after* the preferred one misses, which is what ``search`` mode means.
    """

    preferred: object = None
    allow_other_vrfs: bool = False

    @property
    def preferred_id(self):
        return getattr(self.preferred, "id", None)

    @classmethod
    def from_policy(cls, obj) -> Placement:
        """Read ``vrf_mode``/``vrf`` off a connection or source.

        Anything without the fields — or with a mode we don't recognise — gets
        the pinned/Global default, which is exactly the behaviour that shipped
        before placement existed. Fail closed: an unreadable policy must never
        silently widen the search.
        """
        if obj is None:
            return cls()
        return cls(
            preferred=getattr(obj, "vrf", None),
            allow_other_vrfs=getattr(obj, "vrf_mode", PINNED) == SEARCH,
        )


@dataclass(frozen=True)
class Placed:
    """The outcome of placing one address.

    ``reason`` is ``""`` on success, else ``"no_prefix"`` (nothing contains it
    in the VRFs we were allowed to search) or ``"ambiguous_vrf"`` (several VRFs
    contain it equally well and picking one would be a guess). ``detail`` is the
    operator-facing sentence, and always names the remedy.
    """

    prefix: object = None
    reason: str = ""
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.prefix is not None


def _parse(ip):
    try:
        return ipaddress.ip_address(str(ip))
    except ValueError:
        return None


def load_prefixes(tenant, *, vrf=ANY_VRF):
    """Materialise ``[(network, prefix)]`` once for many placements.

    ``_attach_ips`` used to rebuild this per guest — a full Prefix scan per VM.
    Callers placing more than one address should hoist it and pass it in.
    """
    from api.models import Prefix

    qs = Prefix.objects.filter(tenant=tenant)
    if vrf is not ANY_VRF:
        qs = qs.filter(vrf=vrf)
    out = []
    for p in qs:
        try:
            out.append((ipaddress.ip_network(p.cidr, strict=False), p))
        except ValueError:
            continue
    return out


def _longest(addr, candidates, vrf_id):
    """Longest-match prefix among ``candidates`` restricted to one VRF."""
    best = None
    best_len = -1
    for net, p in candidates:
        if p.vrf_id != vrf_id:
            continue
        if addr.version == net.version and addr in net and net.prefixlen > best_len:
            best, best_len = p, net.prefixlen
    return best


def containing_prefix(tenant, ip, vrf=ANY_VRF):
    """Smallest tenant prefix containing ``ip``, or ``None``.

    ``vrf`` scopes the search so an address lands in the prefix of the right
    routing context and overlapping space across VRFs doesn't collide. With
    ``ANY_VRF`` the tie-break between equally-specific prefixes in different
    VRFs is arbitrary — use :func:`place` where that matters.
    """
    addr = _parse(ip)
    if addr is None:
        return None
    candidates = load_prefixes(tenant, vrf=vrf)
    if vrf is not ANY_VRF:
        return _longest(addr, candidates, getattr(vrf, "id", None))
    best = None
    best_len = -1
    for net, p in candidates:
        if addr.version == net.version and addr in net and net.prefixlen > best_len:
            best, best_len = p, net.prefixlen
    return best


def place(tenant, ip, placement: Placement, *, prefixes=None) -> Placed:
    """Pick the prefix a discovered address belongs in, under ``placement``.

    The preferred VRF is tried **first and on its own**. Only if it holds
    nothing — and only in ``search`` mode — do other VRFs get a look. That
    ordering is what makes ``search`` safe to turn on: it can place addresses
    that are dropped today, but it can never move one that already places.
    A plain longest-match across all VRFs would relocate an address sitting in a
    Global ``/8`` the moment a more specific prefix appeared in another VRF.
    """
    addr = _parse(ip)
    if addr is None:
        return Placed(None, "no_prefix", f"{ip} is not an IP address")
    candidates = prefixes if prefixes is not None else load_prefixes(tenant)

    hit = _longest(addr, candidates, placement.preferred_id)
    if hit is not None:
        return Placed(hit)

    where = vrf_label(placement.preferred)
    if not placement.allow_other_vrfs:
        # Terse on purpose: this repeats once per address, and the remedy is
        # stated once in the run's summary rather than 200 times beside it.
        return Placed(None, "no_prefix", f"{ip} — no prefix in {where}")

    # Widened search: the best match within each other VRF, then compare.
    best_per_vrf = {}
    for net, p in candidates:
        if p.vrf_id == placement.preferred_id:
            continue
        if addr.version != net.version or addr not in net:
            continue
        current = best_per_vrf.get(p.vrf_id)
        if current is None or net.prefixlen > current[0]:
            best_per_vrf[p.vrf_id] = (net.prefixlen, p)

    if not best_per_vrf:
        return Placed(None, "no_prefix", f"{ip} — no prefix in any VRF")
    longest = max(length for length, _ in best_per_vrf.values())
    winners = [p for length, p in best_per_vrf.values() if length == longest]
    if len(winners) == 1:
        return Placed(winners[0])
    names = ", ".join(sorted(vrf_label(p.vrf) for p in winners))
    return Placed(
        None, "ambiguous_vrf",
        f"{ip} — matched equally well in {names}, so the VRF is ambiguous",
    )


def existing_row(tenant, ip, placement: Placement):
    """The address's IPAM row under ``placement``, plus a warning if odd.

    Returns ``(row_or_None, warning)``. The same literal address legitimately
    exists once per VRF, so "found it" has to mean "found it *here*" — adopting
    a row from another routing context would be editing someone else's record.
    """
    from api.models import IPAddress

    rows = list(
        IPAddress.objects.filter(tenant=tenant, ip_address=str(ip))
        .select_related("vrf")[:8]
    )
    if not rows:
        return None, ""

    here = [r for r in rows if r.vrf_id == placement.preferred_id]
    others = [r for r in rows if r.vrf_id != placement.preferred_id]
    if here:
        warning = ""
        if others:
            names = ", ".join(sorted(vrf_label(r.vrf) for r in others))
            warning = (
                f"{ip} also exists in {names}; this sync manages the one in "
                f"{vrf_label(placement.preferred)}"
            )
        return here[0], warning

    # Only elsewhere. In search mode a single unambiguous row is the one meant.
    if placement.allow_other_vrfs and len(others) == 1:
        return others[0], ""
    names = ", ".join(sorted(vrf_label(r.vrf) for r in others))
    return None, (
        f"{ip} exists in {names} but not in {vrf_label(placement.preferred)}"
    )
