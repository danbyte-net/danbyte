"""MAC tracking endpoints (#284), mounted under ``/api/monitoring/``.

Read:

* ``GET devices/<id>/macs/`` - learned MACs per port, with each port's uplink
  state and reasons and the tenant's "MACs shown per port". Device view, row
  scoped.
* ``GET interfaces/<id>/macs/`` - one port's MACs, present or all, paged.
  Interface view, row scoped.
* ``GET mac-sightings/`` - the network-wide Learned list: one row per MAC at
  its location, server-paged. ``macaddress.view`` plus device row scope.

Write:

* ``POST devices/<id>/mac-refresh/`` - read the device's whole MAC table now,
  in the background. ``device.change`` on the device, re-checked by the job.
* ``GET mac-refresh/<run_id>/`` - that run's status, for the user who started
  it or anyone who may view the device.

Every endpoint resolves the tenant first, then the caller's row scope, and
only then reads ids or MACs off the request.
"""
from __future__ import annotations

import math
import re
import uuid
from collections import defaultdict

from django.db.models import CharField, Count, F, Q, Value
from django.db.models.functions import Cast, Concat, Replace
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import Interface
from api.natural import natural_key
from api.oui import vendors_for
from api.views import _get_active_tenant
from auth_api import rbac

from .mac_location import (
    UplinkContext,
    enrich,
    locate,
    locate_for_device,
    location_ref,
    restrict,
    seen_rows,
    viewable_devices,
    vlan_objects,
)
from .mac_tables import canon_mac, hexkey, is_stale, mac_settings, stack_of
from .models import DeviceSnmp, MacSighting

_MAX_PAGE = 500


def _int_param(request, name, default, low, high):
    raw = request.query_params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if low <= value <= high else None


def _vendor(vendors, mac):
    return vendors.get(hexkey(mac))


def _ips(entry) -> list[dict]:
    return [{"ip": e["ip"], "id": e["ip_id"]} for e in (entry or {}).get("ips", [])]


def _port_label_map(members) -> dict:
    """``{lowercased name or SNMP name: (interface id, name, device id)}`` over
    the members' interfaces - for ports a poll summarised but no MAC placed."""
    out: dict = {}
    for pk, name, snmp_name, device_id in Interface.objects.filter(
        device_id__in=[m.id for m in members]
    ).values_list("id", "name", "snmp_name", "device_id"):
        for n in (snmp_name, name):
            if n:
                out.setdefault(n.strip().lower(), (pk, name, device_id))
    return out


def _visible_members(tenant, members, user) -> set:
    """The ids of the stack ``members`` this user may view."""
    from api.models import Device

    ids = [m.id for m in members]
    scope = viewable_devices(tenant, user)
    if scope is None:
        return set(ids)
    return set(
        Device.objects.filter(pk__in=ids).filter(pk__in=scope).values_list("pk", flat=True)
    )


# ─── device ─────────────────────────────────────────────────────────────────


def device_macs_payload(tenant, device, user, *, view="member", limit=None) -> dict:
    """The per-port learned-MAC table for one device (or, ``view=observed``,
    its stack owner's whole observation). Constant query count: one location
    semi-join and one enrichment batch, however many ports."""
    owner, members = stack_of(device)
    state = DeviceSnmp.objects.filter(tenant=tenant, device=owner).first()
    settings = mac_settings(tenant)
    if limit is None:
        limit = int(settings["mac_port_display_limit"])
    member_id = device.id if view == "member" else None
    ctx = UplinkContext(tenant, settings=settings)
    locs = locate_for_device(tenant, owner.id, user, member_id=member_id, ctx=ctx)
    rows_qs = MacSighting.objects.filter(
        tenant=tenant, polled_device=owner, gone_at__isnull=True
    )
    if member_id is not None:
        rows_qs = rows_qs.filter(device_id=member_id)
        visible = {member_id}
    else:
        # The whole observation spans the stack: only the members this user
        # may view, and ports no member claims only while the owner is one
        # of them (#290).
        visible = _visible_members(tenant, members, user)
        mine = Q(device_id__in=visible)
        if owner.id in visible:
            mine |= Q(device_id__isnull=True)
        rows_qs = rows_qs.filter(mine)
    rows = seen_rows(rows_qs)
    ctx.load({owner.id}, {r.interface_id for r in rows})

    ports: dict = {}
    for r in rows:
        p = ports.setdefault(r.port_key, {
            "rows": [], "interface_id": None, "interface_name": None,
            "port_name": r.port_name, "if_index": r.if_index, "device_id": r.device_id,
        })
        p["rows"].append(r)
        if r.interface_id:
            p["interface_id"], p["interface_name"] = r.interface_id, r.interface_name
    # Ports the poll summarised without placing a MAC on them - an idle trunk
    # with an LLDP switch neighbour is still an uplink. Only where the ports
    # are known to be this device's: the whole observation, or a standalone
    # device.
    if view == "observed" or len(members) == 1:
        extra = {
            k: v for k, v in (ctx.ports.get(owner.id) or {}).items()
            if k not in ports and (v.get("lldp") or v.get("lag"))
        }
        if extra:
            labels = _port_label_map(members if view == "observed" else [device])
            for key, entry in extra.items():
                pk, name, on = labels.get(key, (None, None, owner.id))
                if on not in visible:
                    continue
                ports[key] = {
                    "rows": [], "interface_id": pk, "interface_name": name,
                    "port_name": entry.get("name") or key,
                    "if_index": entry.get("if_index") or "", "device_id": None,
                }
            ctx.load(interface_ids={p["interface_id"] for p in ports.values()})

    shown: set = set()
    built = []
    for key, p in ports.items():
        uplink = ctx.classify(owner.id, key, p["interface_id"])
        by_mac: dict = defaultdict(list)
        for r in p["rows"]:
            by_mac[r.mac].append(r)

        def here(mac, _key=key):
            loc = locs.get(mac)
            return bool(loc) and loc.at.polled_device_id == owner.id and loc.at.port_key == _key

        macs = []
        if not uplink.is_uplink:
            ordered = sorted(by_mac, key=lambda m: (not here(m), m))
            macs = ordered if not limit else ordered[:limit]
            shown.update(macs)
        built.append((key, p, uplink, by_mac, macs, sum(1 for m in by_mac if here(m))))

    vendors = vendors_for(shown, tenant)
    info = enrich(tenant, shown, user)
    out_ports = []
    for key, p, uplink, by_mac, macs, located in sorted(
        built, key=lambda b: natural_key(b[1]["port_name"] or b[0])
    ):
        mac_rows = []
        for mac in macs:
            loc = locs.get(mac)
            is_here = bool(loc) and loc.at.polled_device_id == owner.id and loc.at.port_key == key
            seen = by_mac[mac]
            entry = info.get(mac) or {}
            mac_rows.append({
                "mac": mac,
                "vendor": _vendor(vendors, mac),
                "vlans": sorted({s.vlan for s in seen if s.vlan is not None}),
                "ips": _ips(entry),
                "name": entry.get("name"),
                "name_source": entry.get("name_source"),
                "first_seen": min(s.first_seen for s in seen),
                "last_seen": max(s.last_seen for s in seen),
                "here": is_here,
                "location": None if is_here or loc is None else location_ref(loc),
            })
        out_ports.append({
            "interface_id": str(p["interface_id"]) if p["interface_id"] else None,
            "interface_name": p["interface_name"],
            "device_id": str(p["device_id"]) if p["device_id"] else None,
            "port_name": p["port_name"],
            "port_key": key,
            "if_index": p["if_index"],
            "uplink": uplink.payload(),
            "count": len(by_mac),
            "located": located,
            "macs": mac_rows,
        })
    read_at = state.fdb_polled_at if state else None
    return {
        "device": {"id": str(device.id), "name": device.name},
        "polled_via": (
            {"id": str(owner.id), "name": owner.name} if owner.id != device.id else None
        ),
        "view": view,
        "read_at": read_at,
        "polled_at": state.polled_at if state else None,
        "stale": read_at is not None and is_stale(read_at),
        "meta": (state.fdb_meta or {}) if state else {},
        "limit": limit,
        "macs": len({r.mac for r in rows}),
        "ports": out_ports,
    }


@extend_schema(
    summary="Learned MACs per port of a device, with each port's uplink state",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter("view", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="member (this device's ports, default) or "
                         "observed (the stack owner's whole observation)."),
        OpenApiParameter("limit", OpenApiTypes.INT, OpenApiParameter.QUERY,
                         description="MACs listed per port; defaults to the "
                         "tenant's 'MACs shown per port', 0 = all."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{device, polled_via, view, read_at, polled_at, stale, meta, "
        "limit, macs, ports:[{interface_id, interface_name, device_id, port_name, "
        "port_key, if_index, uplink:{is, mode, reasons}, count, located, "
        "macs:[{mac, vendor, vlans, ips, name, name_source, first_seen, "
        "last_seen, here, location}]}]}",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_macs_view(request, device_id):
    from .views import _resolve_device

    resolved, err = _resolve_device(request, device_id)
    if err is not None:
        return err
    device, tenant = resolved
    view = request.query_params.get("view") or "member"
    if view not in ("member", "observed"):
        return Response({"view": "member or observed."}, status=400)
    limit = _int_param(request, "limit", None, 0, 4096)
    if limit is None and request.query_params.get("limit") not in (None, ""):
        return Response({"limit": "0 to 4096."}, status=400)
    return Response(
        device_macs_payload(tenant, device, request.user, view=view, limit=limit)
    )


# ─── interface ──────────────────────────────────────────────────────────────


@extend_schema(
    summary="Learned MACs on one interface - present, or with their history",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter("state", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="present (default) or all - gone rows stay "
                         "for the tenant's retention window."),
        OpenApiParameter("cursor", OpenApiTypes.INT, OpenApiParameter.QUERY,
                         description="Offset from a previous next_cursor."),
        OpenApiParameter("limit", OpenApiTypes.INT, OpenApiParameter.QUERY,
                         description=f"Page size (default 100, max {_MAX_PAGE})."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{interface, uplink:{is, mode, reasons}, counts:{present, all}, "
        "read_at, stale, results:[{id, mac, vendor, vlan, vlan_object, ips, name, "
        "name_source, first_seen, last_seen, gone_at, state, stale, here, "
        "location}], next_cursor}",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def interface_macs_view(request, interface_id):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    iface = (
        restrict(
            Interface.objects.filter(device__tenant=tenant).select_related("device"),
            request.user, tenant, "interface",
        )
        .filter(pk=interface_id)
        .first()
    )
    if iface is None:
        return Response({"detail": "Interface not found."}, status=404)
    which = request.query_params.get("state") or "present"
    if which not in ("present", "all"):
        return Response({"state": "present or all."}, status=400)
    cursor = _int_param(request, "cursor", 0, 0, 10**9)
    limit = _int_param(request, "limit", 100, 1, _MAX_PAGE)
    if cursor is None or limit is None:
        return Response({"detail": "Bad cursor or limit."}, status=400)

    base = MacSighting.objects.filter(tenant=tenant, interface=iface)
    counts = base.aggregate(
        all=Count("pk"), present=Count("pk", filter=Q(gone_at__isnull=True))
    )
    qs = base if which == "all" else base.filter(gone_at__isnull=True)
    page = seen_rows(
        qs.order_by(F("gone_at").asc(nulls_first=True), "-last_seen", "mac")[
            cursor:cursor + limit + 1
        ]
    )
    more = len(page) > limit
    page = page[:limit]

    owner, _members = stack_of(iface.device)
    state = DeviceSnmp.objects.filter(tenant=tenant, device=owner).first()
    ctx = UplinkContext(tenant)
    locs = locate(tenant, {r.mac for r in page if r.gone_at is None}, request.user, ctx=ctx)
    ctx.load({owner.id}, {iface.id})
    port_key = next((r.port_key for r in page if r.polled_device_id == owner.id), None)
    if port_key is None:
        names = {n.strip().lower() for n in (iface.name, iface.snmp_name) if n}
        port_key = next(
            (k for k, v in (ctx.ports.get(owner.id) or {}).items()
             if k in names or str(v.get("name") or "").strip().lower() in names),
            "",
        )
    uplink = ctx.classify(owner.id, port_key, iface.id)
    for r in page:
        r.uplink = uplink

    vendors = vendors_for({r.mac for r in page}, tenant)
    info = enrich(tenant, {r.mac for r in page}, request.user)
    vlans = vlan_objects(
        tenant, request.user,
        {(iface.device.site_id, r.vlan) for r in page if r.vlan is not None},
    )
    now = timezone.now()
    results = []
    for r in page:
        loc = locs.get(r.mac) if r.gone_at is None else None
        is_here = bool(loc) and loc.at.interface_id == iface.id
        entry = info.get(r.mac) or {}
        results.append({
            "id": str(r.id),
            "mac": r.mac,
            "vendor": _vendor(vendors, r.mac),
            "vlan": r.vlan,
            "vlan_object": vlans.get((iface.device.site_id, r.vlan)),
            "ips": _ips(entry),
            "name": entry.get("name"),
            "name_source": entry.get("name_source"),
            "first_seen": r.first_seen,
            "last_seen": r.last_seen,
            "gone_at": r.gone_at,
            "state": "present" if r.gone_at is None else "gone",
            "stale": r.gone_at is None and is_stale(r.last_seen, now),
            "here": is_here,
            "location": None if is_here or loc is None else location_ref(loc),
        })
    read_at = state.fdb_polled_at if state else None
    return Response({
        "interface": {
            "id": str(iface.id), "name": iface.name,
            "device": {"id": str(iface.device_id), "name": iface.device.name},
        },
        "uplink": uplink.payload(),
        "counts": counts,
        "read_at": read_at,
        "stale": read_at is not None and is_stale(read_at, now),
        "state": which,
        "results": results,
        "next_cursor": cursor + limit if more else None,
    })


# ─── the network-wide Learned list ──────────────────────────────────────────

_MAC_TEXT = re.compile(r"^[0-9a-fA-F:.\-\s]+$")


def _uuid_param(request, name):
    raw = request.query_params.get(name)
    if not raw:
        return None, False
    try:
        return uuid.UUID(str(raw)), False
    except ValueError:
        return None, True


@extend_schema(
    summary="The network-wide learned MAC table: one row per MAC at its location",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter("q", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="A MAC (any notation) or part of one; other "
                         "text matches the device or port name."),
        OpenApiParameter("site", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter("device", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter("vlan", OpenApiTypes.INT, OpenApiParameter.QUERY),
        OpenApiParameter("state", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="present (default), gone or all."),
        OpenApiParameter("kind", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="access or behind_uplink (present MACs)."),
        OpenApiParameter("page", OpenApiTypes.INT, OpenApiParameter.QUERY),
        OpenApiParameter("page_size", OpenApiTypes.INT, OpenApiParameter.QUERY,
                         description=f"Default 50, max {_MAX_PAGE}."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{count, page, page_size, num_pages, results:[{mac, vendor, "
        "state, kind, device, interface, port_name, vlan, vlan_object, ips, name, "
        "name_source, first_seen, last_seen, gone_at, stale}]}",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_sightings_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)
    which = request.query_params.get("state") or "present"
    kind = request.query_params.get("kind") or ""
    if which not in ("present", "gone", "all") or kind not in ("", "access", "behind_uplink"):
        return Response({"detail": "state: present|gone|all; kind: access|behind_uplink."},
                        status=400)
    site_id, bad_site = _uuid_param(request, "site")
    device_id, bad_device = _uuid_param(request, "device")
    vlan = _int_param(request, "vlan", None, 1, 4094)
    page = _int_param(request, "page", 1, 1, 10**6)
    size = _int_param(request, "page_size", 50, 1, _MAX_PAGE)
    if bad_site or bad_device or page is None or size is None or (
        vlan is None and request.query_params.get("vlan") not in (None, "")
    ):
        return Response({"detail": "Bad filter value."}, status=400)

    base = MacSighting.objects.filter(tenant=tenant)
    scope = viewable_devices(tenant, user)
    if scope is not None:
        base = base.filter(device_id__in=scope)
    filters = Q()
    if site_id:
        filters &= Q(device__site_id=site_id)
    if device_id:
        filters &= Q(device_id=device_id)
    if vlan:
        filters &= Q(vlan_vid=vlan)
    q = (request.query_params.get("q") or "").strip()
    if q:
        key = hexkey(q)
        if _MAC_TEXT.match(q) and key:
            if len(key) == 12:
                filters &= Q(mac=canon_mac(key))
            else:
                base = base.annotate(_hex=Replace("mac", Value(":"), Value("")))
                filters &= Q(_hex__contains=key)
        else:
            filters &= Q(device__name__icontains=q) | Q(port_name__icontains=q)

    present = base.filter(gone_at__isnull=True)
    ctx = UplinkContext(tenant).load_all_flags()
    ports = list(
        present.values_list("polled_device_id", "port_key", "interface_id").distinct()
    )
    ctx.load({p[0] for p in ports})
    uplink_ports = sorted({
        f"{pd}|{key}" for pd, key, iface in ports if ctx.classify(pd, key, iface).is_uplink
    })
    present = present.annotate(_port=Concat(
        Cast("polled_device_id", CharField()), Value("|"), "port_key",
        output_field=CharField(),
    ))
    if uplink_ports:
        on_uplink = Q(_port__in=uplink_ports)
        access_macs = present.exclude(on_uplink).values("mac")
        access = ~on_uplink
        behind = on_uplink & ~Q(mac__in=access_macs)
    else:
        access, behind = Q(), None
    if kind == "access":
        cand = access
    elif kind == "behind_uplink":
        cand = behind
    else:
        cand = access if behind is None else (access | behind)

    parts = []
    if which in ("present", "all") and cand is not None:
        parts.append(present.filter(cand).filter(filters).values("mac"))
    if which in ("gone", "all") and not kind:
        parts.append(
            base.filter(gone_at__isnull=False)
            .exclude(mac__in=base.filter(gone_at__isnull=True).values("mac"))
            .filter(filters).values("mac")
        )
    if not parts:
        macs_qs = MacSighting.objects.none().values("mac")
    elif len(parts) == 1:
        macs_qs = parts[0].distinct()
    else:
        macs_qs = parts[0].union(parts[1])
    total = macs_qs.count()
    page_macs = [
        r["mac"] for r in macs_qs.order_by("mac")[(page - 1) * size:page * size]
    ]

    present_macs = set(
        base.filter(gone_at__isnull=True, mac__in=page_macs).values_list("mac", flat=True)
    )
    locs = locate(tenant, present_macs, user, ctx=ctx)
    # A gone MAC shows the access port it was last seen on, as a present one
    # shows its Location - the uplink that saw it too keeps it a little
    # longer - and only a row the filters match, so a device filter never
    # lists another device's row.
    gone_rows = seen_rows(
        base.filter(gone_at__isnull=False, mac__in=set(page_macs) - present_macs)
        .filter(filters)
        .order_by("mac", "-last_seen", "-gone_at")
    )
    ctx.load({r.polled_device_id for r in gone_rows})
    last_gone: dict = {}
    on_uplink: dict = {}
    for r in gone_rows:
        up = ctx.classify(r.polled_device_id, r.port_key, r.interface_id).is_uplink
        if r.mac not in last_gone or (on_uplink[r.mac] and not up):
            last_gone[r.mac], on_uplink[r.mac] = r, up
    vendors = vendors_for(page_macs, tenant)
    info = enrich(tenant, page_macs, user)
    picked = {
        mac: (locs[mac].at if mac in locs and locs[mac] else last_gone.get(mac))
        for mac in page_macs
    }
    vlans = vlan_objects(
        tenant, user,
        {(s.site_id, s.vlan) for s in picked.values() if s is not None and s.vlan},
    )
    now = timezone.now()
    results = []
    for mac in page_macs:
        at = picked.get(mac)
        if at is None:  # gone from view between the two reads
            continue
        loc = locs.get(mac)
        entry = info.get(mac) or {}
        results.append({
            "mac": mac,
            "vendor": _vendor(vendors, mac),
            "state": "present" if loc else "gone",
            "kind": loc.kind if loc else None,
            "device": {"id": str(at.device_id), "name": at.device_name},
            "interface": (
                {"id": str(at.interface_id), "name": at.interface_name}
                if at.interface_id else None
            ),
            "port_name": at.port_name,
            "vlan": at.vlan,
            "vlan_object": vlans.get((at.site_id, at.vlan)),
            "ips": _ips(entry),
            "name": entry.get("name"),
            "name_source": entry.get("name_source"),
            "first_seen": at.first_seen,
            "last_seen": at.last_seen,
            "gone_at": at.gone_at,
            "stale": bool(loc) and is_stale(at.last_seen, now),
        })
    return Response({
        "count": total,
        "page": page,
        "page_size": size,
        "num_pages": max(1, math.ceil(total / size)) if total else 1,
        "results": results,
    })


# ─── Refresh MACs ───────────────────────────────────────────────────────────


@extend_schema(
    summary="Read a device's whole MAC table now, in the background",
    tags=["monitoring"],
    request=None,
    responses={
        202: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="{queued, run_id, running, device} - or, for a device an "
            "Outpost polls, {queued, queued_on_outpost, engine, engine_stale, detail}.",
        ),
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="Redis unavailable: the refresh ran inline in quick mode - "
            "{queued: false, inline: true, status, macs, ports, complete, error}.",
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def device_mac_refresh_view(request, device_id):
    from .mac_jobs import RefreshUnavailable, run_refresh, start_refresh, summary
    from .snmp_poll import _device_target
    from .snmp_resolve import resolve_device_profile
    from .views import _queue_on_outpost, _resolve_device

    resolved, err = _resolve_device(request, device_id)
    if err is not None:
        return err
    device, tenant = resolved
    if not rbac.can_act_on(request.user, tenant, "device", "change", device):
        return Response(
            {"detail": "You do not have permission to change this device."}, status=403
        )
    # A stack is one agent: a member refreshes its owner.
    owner, _members = stack_of(device)
    queued = _queue_on_outpost(owner, tenant)
    if queued is not None:
        return queued
    profile, _src = resolve_device_profile(owner, tenant)
    if profile is None:
        return Response(
            {"detail": "No SNMP profile resolves for this device - assign one on "
             "the device, its role, its type, or set a tenant default."},
            status=400,
        )
    if not _device_target(owner):
        return Response({"detail": "Device has no primary IP or name to poll."}, status=400)
    ref = {"id": str(owner.id), "name": owner.name}
    try:
        run = start_refresh(owner, tenant, request.user)
    except RefreshUnavailable:
        state, reason = run_refresh(owner, tenant, mac_mode="quick")
        if reason is not None:
            return Response({"detail": "The device could not be polled."}, status=400)
        return Response({
            "queued": False, "inline": True, "run_id": None, "device": ref,
            "status": "done" if state.reachable else "unreachable",
            **summary(state),
        })
    return Response(
        {"queued": True, "run_id": run["run_id"], "running": run["running"], "device": ref},
        status=202,
    )


_RUN_ID = re.compile(r"^[0-9a-f]{32}$")


@extend_schema(
    summary="Status of a Refresh MACs run",
    tags=["monitoring"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{run_id, found, done, status, device, queued_at, started_at, "
        "finished_at, macs, ports, complete, error}. status: queued, running, done, "
        "unreachable, denied, skipped or error; an unknown or expired run reads "
        "{found: false, done: true}.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_refresh_run_view(request, run_id):
    from api.models import Device

    from .mac_jobs import read_run

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    unknown = {"run_id": run_id, "found": False, "done": True, "status": "unknown"}
    run = read_run(run_id) if _RUN_ID.match(run_id or "") else None
    if run is None or run.get("tenant") != str(tenant.id):
        return Response(unknown)
    user = request.user
    if not (user.is_superuser or run.get("owner") == str(user.pk)):
        try:
            device_pk = uuid.UUID(run.get("device") or "")
        except ValueError:
            return Response(unknown)
        if not restrict(
            Device.objects.filter(tenant=tenant, pk=device_pk), user, tenant, "device"
        ).exists():
            return Response(unknown)
    status = run.get("status") or "queued"
    complete = run.get("complete")
    return Response({
        "run_id": run_id,
        "found": True,
        "done": status not in ("queued", "running"),
        "status": status,
        "device": {"id": run.get("device"), "name": run.get("device_name")},
        "queued_at": run.get("queued_at") or None,
        "started_at": run.get("started_at") or None,
        "finished_at": run.get("finished_at") or None,
        "macs": int(run.get("macs") or 0),
        "ports": int(run.get("ports") or 0),
        "complete": None if complete in (None, "") else complete == "1",
        "error": run.get("error") or "",
    })
