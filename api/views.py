"""Shared IPAM helpers used across the API.

Formerly the legacy server-rendered prefix/IP HTML views; those dead htmx
endpoints were removed (#61). What remains are the live helpers other modules
import — chiefly ``_get_active_tenant`` (used app-wide) and the space-map /
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
    without any granted tenants get None — views should handle that with
    ``api/no_org.html``.

    Unauthenticated calls (no request, or anonymous user) keep the legacy
    behaviour of returning the first active tenant. Anything signed in is
    filtered through :func:`auth_api.permissions.user_tenants`.
    """
    if request is None or not getattr(request, "user", None) \
            or not request.user.is_authenticated:
        return Tenant.objects.filter(is_active=True).first()

    from auth_api.permissions import user_tenants
    allowed = user_tenants(request.user)
    # An API token is scoped to a tenant — honour it (runners have no session).
    tok_tid = getattr(getattr(request, "auth", None), "tenant_id", None)
    if tok_tid:
        t = allowed.filter(pk=tok_tid).first()
        if t is not None:
            return t
    tid = request.session.get("current_tenant_id") if hasattr(request, "session") else None
    if tid:
        t = allowed.filter(pk=tid).first()
        if t is not None:
            return t
    # No session choice yet (fresh login): prefer the profile's home tenant —
    # site-role provisioning sets it to the tenant the user's grants live in,
    # so a multi-tenant user doesn't land on an arbitrary first tenant where
    # they can see nothing.
    home_id = getattr(getattr(request.user, "profile", None), "current_tenant_id", None)
    if home_id:
        t = allowed.filter(pk=home_id).first()
        if t is not None:
            return t
    return allowed.first()


# Back-compat alias so I don't have to touch every call site at once.
_get_active_org = _get_active_tenant


def _parse_int(value, default, min_value=1):
    try:
        return max(int(value), min_value)
    except (TypeError, ValueError):
        return default


def _build_space_map(net, *, child_nets, tenant, vrf, max_v4=None, max_v6=None):
    """Build the space-map row list for ``net``, marking cells as ``used``
    (overlap with a child prefix), ``dirty`` (free but contains IPs that
    would have to be re-parented on selection), or plain free.

    ``dirty`` cells are the new bit: anywhere an IPAddress row in the same
    tenant + VRF falls inside the cell's network range but no child prefix
    covers that range, we flag it amber so the operator sees stray IPs
    before creating a new prefix on top of them.

    ``max_v4`` / ``max_v6`` are the user's per-family "deepest prefix length to
    show" preference. They can only make the map *shallower* — clamped after the
    +8 / 256-cell safety cap, never beyond it.

    Returns the list shape ``_space_map.html`` consumes.
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

    # Pre-fetch every IP in this tenant + VRF whose address sits inside
    # ``net``. We do the range check in Python with a sorted int list so
    # the per-cell test is O(log n) — beats N * IP_count. Python ints are
    # arbitrary-precision, so this is v6-safe (a /64 never explodes — we only
    # range-check the *registered* IPs, never the address space).
    from bisect import bisect_left, bisect_right
    net_first = int(net.network_address)
    net_last = int(net.broadcast_address)
    ip_strings = (
        IPAddress.objects
        .filter(tenant=tenant, vrf=vrf)
        .values_list("ip_address", flat=True)
    )
    ip_ints = []
    for s in ip_strings:
        try:
            n = int(ipaddress.ip_address(s))
        except ValueError:
            continue
        if net_first <= n <= net_last:
            ip_ints.append(n)
    ip_ints.sort()

    # Which child prefix-lengths to render as rows. We never go deeper than
    # +8 bits, so every row has ≤256 cells. v4 steps one bit at a time. v6
    # steps a nibble (4 bits) for readability — a /64 shows /68·/72, not eight
    # dense rows — but falls back to bit-steps for prefixes within a nibble of
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
            overlap_with = [c for c in child_nets if s.overlaps(c)]
            cell_first = int(s.network_address)
            cell_last = int(s.broadcast_address)
            lo = bisect_left(ip_ints, cell_first)
            hi = bisect_right(ip_ints, cell_last)
            ip_count = hi - lo
            used = bool(overlap_with)
            cells.append({
                "cidr": str(s),
                "used": used,
                "overlap_with": [str(c) for c in overlap_with[:3]],
                # "dirty" = free but the address range already holds IPs.
                # Creating a new prefix here would have to re-parent them.
                "dirty": (not used) and (ip_count > 0),
                "ip_count": ip_count,
            })
        free_count = sum(1 for c in cells if not c["used"])
        dirty_count = sum(1 for c in cells if c["dirty"])
        rows.append({
            "prefixlen": new_prefixlen,
            "count": len(cells),
            "free_count": free_count,
            "dirty_count": dirty_count,
            "cells": cells,
        })
    return rows


def _subnet_details(prefix) -> list[dict] | None:
    """Computed display rows for the "Subnet details" card on prefix /
    IP detail. Returns ``None`` for unparseable CIDRs so the card renders
    nothing instead of crashing the page.

    Each row is ``{label, value, mono, copy}`` — ``copy`` is the exact
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
    # routes — every address is "usable", so show first==network and
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

    return rows


def _next_available_ips(prefix, *, count: int = 5) -> list[str]:
    """First ``count`` host addresses inside ``prefix`` that aren't already
    registered in this tenant+VRF.

    Useful on the prefix-detail header so an operator can spot the next
    free address (and click to register it) without scanning the IPs table.
    Only runs for *enumerable* prefixes (≤ ``ENUMERABLE_HOST_CAP`` addresses) —
    a /64 has no meaningful "next free" and we won't iterate 2⁶⁴ hosts.
    """
    from .models import is_enumerable

    net = prefix.network
    if net is None or not is_enumerable(net):
        return []
    used = set(
        IPAddress.objects
        .filter(tenant=prefix.tenant, vrf=prefix.vrf)
        .values_list("ip_address", flat=True)
    )
    out: list[str] = []
    # `.hosts()` skips network + broadcast on /30 or shorter, which is what
    # operators want here — those addresses aren't normally assignable.
    for host in net.hosts():
        addr = str(host)
        if addr not in used:
            out.append(addr)
            if len(out) >= count:
                break
    return out


def _reparent_ips_into(prefix) -> int:
    """Re-parent every IP in the same (tenant, vrf) whose address falls
    inside ``prefix.network`` onto ``prefix``.

    Triggered by ``?adopt=1`` on the create form, set by the space map
    when the user picks a "dirty" cell (free of prefixes but containing
    stray IPs). Returns the count moved.
    """
    net = prefix.network
    if net is None:
        return 0
    first = int(net.network_address)
    last = int(net.broadcast_address)
    moved = 0
    qs = IPAddress.objects.filter(tenant=prefix.tenant, vrf=prefix.vrf).exclude(prefix=prefix)
    for ip in qs.iterator():
        try:
            addr_int = int(ipaddress.ip_address(ip.ip_address))
        except ValueError:
            continue
        if first <= addr_int <= last:
            ip.prefix = prefix
            ip.save(update_fields=["prefix"])
            moved += 1
    return moved


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
        # IPv6 — sample the first usable
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

