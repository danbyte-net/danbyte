"""Dashboard aggregation - one batched, tenant-scoped payload for the home page.

Every dashboard widget reads from this single endpoint so the page is one fetch.
Aggregations are deliberately cheap (``.count()`` + ``values().annotate()``); the
only per-instance work is utilisation for the top-8 prefixes. The monitoring
charts read the rollups, never the raw results, and ``?include=`` limits the
work to the widgets on show. The query count does not grow with the estate
(api.tests_dashboard_cost).
"""
from __future__ import annotations

import ipaddress
import uuid

from django.db.models import Count, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import (
    Cable,
    Device,
    Interface,
    IPAddress,
    Prefix,
    Site,
    VLAN,
    VRF,
)
from .views import _get_active_tenant
from auth_api import rbac
from routing.models import BGPSession, StaticRoute

# A neutral palette for distributions whose categories have no catalog colour
# (device status, protocols, …). Sky-family to match the brand chart tokens.
_PALETTE = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--color-zinc-400)",
]


def _titilise(v: str) -> str:
    return v.replace("_", " ").title() if v else "-"


# Carrier-grade NAT shared space (RFC 6598) - routable-looking but not public.
# Checked before is_private so it lands in its own bucket regardless of how the
# stdlib classifies it across Python versions.
_CGNAT4 = ipaddress.ip_network("100.64.0.0/10")


def _classify_ip_scope(value: str) -> str | None:
    """Bucket an address by reachability, from the address alone - no config,
    no seed data. Returns ``Public`` / ``Private`` / ``CGNAT`` / ``Special``,
    or ``None`` when unparseable.

    - **Private**  RFC 1918 (v4) / ULA fc00::/7 (v6)
    - **CGNAT**    RFC 6598 100.64.0.0/10
    - **Special**  loopback, link-local, unspecified, multicast, reserved
    - **Public**   everything globally routable
    """
    try:
        addr = ipaddress.ip_address((value or "").split("/")[0].strip())
    except ValueError:
        return None
    if (
        addr.is_loopback
        or addr.is_link_local
        or addr.is_unspecified
        or addr.is_multicast
        or addr.is_reserved
    ):
        return "Special"
    if addr.version == 4 and addr in _CGNAT4:
        return "CGNAT"
    if addr.is_private:
        return "Private"
    return "Public"


# Fixed presentation order + colour per scope bucket, so the donut reads the
# same every render. Public gets the prominent brand chart colour (it's the
# scarce, billable space operators watch); CGNAT is amber to flag "not public".
_SCOPE_ORDER = ("Public", "Private", "CGNAT", "Special")
_SCOPE_COLORS = {
    "Public": "var(--chart-1)",
    "Private": "var(--chart-2)",
    "CGNAT": "var(--color-amber-500)",
    "Special": "var(--color-zinc-400)",
}


# The same buckets as ``_classify_ip_scope``, as one SQL CASE over the inet
# column, so the distribution is a grouped count in the database rather than
# every address parsed in Python (#201). Special = the stdlib's loopback,
# link-local, unspecified, multicast and reserved; Private = its private
# networks that are none of those; CGNAT sits between the two.
_SPECIAL_NETS = (
    "127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4",
    "::1/128", "::/128", "fe80::/10", "ff00::/8",
)
_PRIVATE_NETS = (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "192.0.0.0/24",
    "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "::ffff:0:0/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32",
    "fc00::/7",
)


def _nets_sql(nets) -> str:
    return "ARRAY[" + ",".join(f"'{n}'::inet" for n in nets) + "]"


SCOPE_CASE_SQL = (
    "CASE"
    f" WHEN ip_address::inet <<= ANY({_nets_sql(_SPECIAL_NETS)}) THEN 'Special'"
    " WHEN ip_address::inet <<= '100.64.0.0/10'::inet THEN 'CGNAT'"
    f" WHEN ip_address::inet <<= ANY({_nets_sql(_PRIVATE_NETS)}) THEN 'Private'"
    " ELSE 'Public' END"
)


def _ip_by_scope(ips) -> list:
    """Public/private/CGNAT/special distribution of a tenant's IP addresses."""
    from django.db.models.expressions import RawSQL

    counts = {k: 0 for k in _SCOPE_ORDER}
    grouped = (
        ips.annotate(scope=RawSQL(SCOPE_CASE_SQL, ()))
        .order_by()
        .values("scope")
        .annotate(n=Count("id"))
    )
    for row in grouped:
        if row["scope"] in counts:
            counts[row["scope"]] += row["n"]
    return [
        {
            "key": name.lower(),
            "name": name,
            "count": counts[name],
            "color": _SCOPE_COLORS[name],
        }
        for name in _SCOPE_ORDER
        if counts[name]
    ]


def _by(qs, field, label_field=None, color_field=None, limit=None):
    """Group ``qs`` by ``field`` → [{key, name, count, color?}], biggest first.

    ``key`` is the raw grouping value (an id when ``field`` is a ``*_id``), so a
    dashboard chart segment can deep-link to the matching filtered list -
    ``name`` alone can't drive a facet, which buckets by id."""
    cols = [field]
    if label_field:
        cols.append(label_field)
    if color_field:
        cols.append(color_field)
    rows = qs.values(*cols).annotate(n=Count("id")).order_by("-n")
    out = []
    for i, r in enumerate(rows):
        raw = r.get(field)
        name = r.get(label_field) if label_field else raw
        out.append(
            {
                "key": None if raw is None else str(raw),
                "name": name or "-",
                "count": r["n"],
                "color": (color_field and r.get(color_field))
                or _PALETTE[i % len(_PALETTE)],
            }
        )
    return out[:limit] if limit else out


#: What a dashboard's scope may name, as query params: comma-separated ids
#: (tag: slugs). Every widget reading this payload inherits it.
SCOPE_KEYS = ("site", "region", "role", "device_type", "tag", "sla")
#: Monitoring chart windows, in hours.
FRAMES = {"24h": 24, "7d": 168, "30d": 720, "90d": 2160}


def _scope_params(params) -> dict:
    """The scope from the query string. Every dimension but tag names ids:
    one that is not an id is a 400, not a database error."""
    out = {}
    for key in SCOPE_KEYS:
        vals = [v.strip() for v in (params.get(key) or "").split(",") if v.strip()]
        if key != "tag":
            for v in vals:
                try:
                    uuid.UUID(v)
                except ValueError:
                    raise serializers.ValidationError({key: f"«{v}» is not an id."}) from None
        if vals:
            out[key] = vals
    return out


def _apply_scope(scope, devices, ips, prefixes, tenant):
    """Narrow the three base querysets to a dashboard's scope. A device
    matches by its own site, role, type and tags; an address by its own
    site, its prefix's or its device's, and its device's role and type; a
    prefix by its site and tags. An SLA scope is its members' addresses."""
    sites = list(scope.get("site", []))
    if scope.get("region"):
        from .viewsets import _region_and_descendant_ids

        region_ids = []
        for r in scope["region"]:
            region_ids.extend(_region_and_descendant_ids(r))
        sites += [str(pk) for pk in Site.objects.filter(
            tenant=tenant, region_id__in=region_ids).values_list("pk", flat=True)]
        if not sites:
            sites = ["00000000-0000-0000-0000-000000000000"]
    if sites:
        devices = devices.filter(site_id__in=sites)
        ips = ips.filter(
            Q(site_id__in=sites) | Q(prefix__site_id__in=sites)
            | Q(assigned_device__site_id__in=sites)
        )
        prefixes = prefixes.filter(site_id__in=sites)
    if scope.get("role"):
        devices = devices.filter(role_id__in=scope["role"])
        ips = ips.filter(assigned_device__role_id__in=scope["role"])
    if scope.get("device_type"):
        devices = devices.filter(device_type_id__in=scope["device_type"])
        ips = ips.filter(assigned_device__device_type_id__in=scope["device_type"])
    for slug in scope.get("tag", []):
        devices = devices.filter(tags__slug=slug)
        ips = ips.filter(Q(tags__slug=slug) | Q(assigned_device__tags__slug=slug))
        prefixes = prefixes.filter(tags__slug=slug)
    if scope.get("tag"):
        devices, ips, prefixes = devices.distinct(), ips.distinct(), prefixes.distinct()
    if scope.get("sla"):
        try:
            from monitoring.sla import member_ip_ids
        except Exception:  # noqa: BLE001
            member_ip_ids = None
        member_ips = member_ip_ids(scope["sla"], tenant=tenant) if member_ip_ids else set()
        ips = ips.filter(pk__in=member_ips)
        devices = devices.filter(ip_addresses__in=member_ips).distinct()
    return devices, ips, prefixes


#: The payload keys a caller can ask for by name (``?include=a,b``): each
#: is one widget's data, computed only when asked for. Without ``include``
#: every one comes. The counts, the check and alert roll-ups and the
#: reachable share (the stat band) and the tenant's default layout always
#: come.
OPTIONAL_KEYS = (
    "recent_activity", "recent_prefixes", "recent_devices", "recent_ips",
    "ip_by_status", "ip_by_role", "ip_by_scope", "prefix_by_family",
    "prefix_by_status", "top_prefixes", "device_by_status", "device_by_type",
    "device_by_site", "device_by_manufacturer", "flapping", "availability_7d",
    "alerts_per_day", "latency_series", "latency_by_kind",
)
#: Read together from one rollup query.
ROLLUP_KEYS = ("availability_7d", "latency_series", "latency_by_kind")


def _include(params) -> set:
    """The optional keys to compute: all of them, or the ``include`` list.
    A name that is not one of them is a 400."""
    raw = params.get("include")
    if raw is None:
        return set(OPTIONAL_KEYS)
    want = {k.strip() for k in raw.split(",") if k.strip()}
    unknown = sorted(want - set(OPTIONAL_KEYS))
    if unknown:
        raise serializers.ValidationError(
            {"include": f"Not a dashboard key: {', '.join(unknown)}."})
    return want


def _empty_dashboard() -> dict:
    """Full-shape payload with everything zeroed/empty. Returned when the user
    has no active tenant (e.g. a freshly created account before a tenant is
    assigned) so the frontend never reads an undefined array/field."""
    return {
        "counts": {}, "reachable_pct": None, "check_by_status": [],
        "alerts_by_severity": [], "default_widgets": [],
        **{k: None if k == "availability_7d" else [] for k in OPTIONAL_KEYS},
    }


@extend_schema(
    summary="Batched, tenant-scoped dashboard aggregation payload",
    tags=["dashboard"],
    request=None,
    parameters=[
        OpenApiParameter(
            "include", OpenApiTypes.STR, OpenApiParameter.QUERY,
            description=(
                "Comma-separated payload keys to compute (the widgets on show); "
                "the others come back empty. Omitted: every key."
            ),
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Single dashboard payload: object counts, IPAM/DCIM distributions, "
            "recent activity feeds, top prefixes by utilisation, and monitoring "
            "roll-ups - all scoped to the active tenant and the caller's RBAC "
            "view grants. Empty-shaped payload when the user has no active tenant."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def dashboard_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response(_empty_dashboard())

    # Scope every base queryset by the user's per-type view grant + row/site
    # constraints, so a reader walled off from a type sees 0 (not tenant-wide
    # counts) and the derived charts stay empty too (issue #59).
    u = request.user

    def _scoped(model, slug, **filt):
        return rbac.restrict_queryset(model.objects.filter(**filt), u, tenant, slug, "view")

    prefixes = _scoped(Prefix, "prefix", tenant=tenant)
    ips = _scoped(IPAddress, "ipaddress", tenant=tenant)
    devices = _scoped(Device, "device", tenant=tenant)
    scope = _scope_params(request.query_params)
    want = _include(request.query_params)
    if scope:
        devices, ips, prefixes = _apply_scope(scope, devices, ips, prefixes, tenant)
    hours = FRAMES.get(request.query_params.get("frame") or "", 168)
    # The addresses monitoring widgets read: the caller's viewable ones, and
    # within a scope only the scope's. None = every address in the tenant,
    # only for an all-rows grant; without ipaddress view ``ips`` is empty.
    ip_q = rbac.row_filter(u, tenant, "ipaddress", "view")
    ip_filter = None if (ip_q is True and not scope) else ips

    counts = {
        "prefixes": prefixes.count(),
        "ips": ips.count(),
        "devices": devices.count(),
        "sites": _scoped(Site, "site", tenant=tenant).count(),
        "vlans": _scoped(VLAN, "vlan", tenant=tenant).count(),
        "vrfs": _scoped(VRF, "vrf", tenant=tenant).count(),
        "cables": _scoped(Cable, "cable", tenant=tenant).count(),
        "interfaces": _scoped(Interface, "interface", device__tenant=tenant).count(),
        "bgp_sessions": _scoped(BGPSession, "bgpsession", tenant=tenant).count(),
        "static_routes": _scoped(StaticRoute, "staticroute", tenant=tenant).count(),
    }

    # ── Monitoring ──────────────────────────────────────────────────────
    # The check/alert roll-ups and the status-change feed describe the
    # monitored OBJECTS (devices/prefixes/IPs - recent activity even carries
    # IP addresses), so they follow the same view grants: a member walled off
    # from all three sees empty monitoring widgets, not a tenant-wide rollup.
    can_see_monitoring = any(
        rbac.has_action(u, tenant, slug, "view")
        for slug in ("device", "prefix", "ipaddress")
    )
    monitoring = (
        _monitoring_block(tenant, ip_filter) if can_see_monitoring
        else {"check_by_status": [], "alerts_by_severity": [],
              "reachable_pct": None}
    )
    monitoring.update(
        _monitoring_charts(request, u, tenant, ip_filter, hours, want) if can_see_monitoring
        else {"availability_7d": None, "alerts_per_day": [], "latency_series": [],
              "latency_by_kind": []}
    )

    # Each widget's data, computed only when the caller's layout shows it.
    widgets = {
        # ── IPAM
        "ip_by_status": lambda: _by(ips, "status_id", "status__name", "status__color"),
        "ip_by_role": lambda: _by(ips, "role_id", "role__name", "role__color"),
        "ip_by_scope": lambda: _ip_by_scope(ips),
        "prefix_by_family": lambda: _prefix_by_family(prefixes),
        "prefix_by_status": lambda: _by(
            prefixes, "status_id", "status__name", "status__color"),
        "top_prefixes": lambda: _top_prefixes(prefixes),
        # ── DCIM
        "device_by_status": lambda: _by(
            devices, "status_id", "status__name", "status__color"),
        "device_by_type": lambda: _by(devices, "device_type_id", "device_type__name", limit=6),
        "device_by_site": lambda: _by(
            devices.exclude(site__isnull=True), "site_id", "site__name", limit=6),
        "device_by_manufacturer": lambda: _by(
            devices.exclude(device_type__manufacturer__isnull=True),
            "device_type__manufacturer__name", limit=6),
        # ── Feeds
        "recent_prefixes": lambda: _recent_prefixes(prefixes),
        "recent_devices": lambda: _recent_devices(devices),
        "recent_ips": lambda: _recent_ips(ips),
        "recent_activity": lambda: (
            _recent_activity(tenant, ip_filter) if can_see_monitoring else []),
        "flapping": lambda: _flapping(u, tenant, ip_filter) if can_see_monitoring else [],
    }

    return Response(
        {
            "counts": counts,
            **{key: fn() if key in want else [] for key, fn in widgets.items()},
            # Admin-set default widget layout for new users (empty = built-in).
            "default_widgets": _default_widgets(tenant),
            "scope": scope,
            "frame_hours": hours,
            **monitoring,
        }
    )


def _prefix_by_family(prefixes) -> list:
    fam = prefixes.aggregate(
        v6=Count("id", filter=Q(cidr__contains=":")),
        v4=Count("id", filter=~Q(cidr__contains=":")),
    )
    return [
        {"key": "4", "name": "IPv4", "count": fam["v4"] or 0, "color": "var(--chart-1)"},
        {"key": "6", "name": "IPv6", "count": fam["v6"] or 0, "color": "var(--chart-3)"},
    ]


def _top_prefixes(prefixes) -> list:
    """The busiest 8 by utilisation, their address counts and statuses read
    with them (#299), the CIDR breaking ties so the widget keeps its order."""
    busiest = list(
        prefixes.select_related("status")
        .annotate(ipc=Count("ip_addresses"))
        .order_by("-ipc", "cidr")[:8]
    )
    return [
        {
            "id": str(p.id),
            "cidr": p.cidr,
            "ip_count": p.ipc,
            "utilisation_pct": p.utilisation_with(p.ipc),
        }
        for p in busiest
        if p.ipc
    ]


def _default_widgets(tenant):
    from core.models import TenantSettings

    row = TenantSettings.objects.filter(tenant=tenant).first()
    # The layout as saved: a v2 {"v": 2, "items": [...]} (what the dashboard
    # writes) or a legacy id list. list() of the dict gave ["v", "items"], so
    # the new-user default never applied.
    return (row.default_dashboard_widgets or []) if row else []


def _recent_prefixes(prefixes, limit: int = 8) -> list:
    # The newest few first, then their address counts: annotating the count
    # on the queryset grouped every prefix in the tenant before the LIMIT.
    rows = list(prefixes.select_related("site", "status").order_by("-created_at")[:limit])
    counts = dict(
        IPAddress.objects.filter(prefix_id__in=[p.id for p in rows])
        .values("prefix_id").annotate(n=Count("id")).order_by()
        .values_list("prefix_id", "n")
    ) if rows else {}
    for p in rows:
        p.ipc = counts.get(p.id, 0)
    return [
        {
            "id": str(p.id),
            "cidr": p.cidr,
            "status": p.status.name if p.status_id else "",
            "site": p.site.name if p.site_id else None,
            "ip_count": p.ipc,
        }
        for p in rows
    ]


def _recent_devices(devices, limit: int = 8) -> list:
    rows = (
        devices.select_related("device_type", "site", "status").order_by("-created_at")[:limit]
    )
    return [
        {
            "id": str(x.id),
            "name": x.name,
            "status": x.status.name if x.status_id else "",
            "type": x.device_type.name if x.device_type_id else None,
            "site": x.site.name if x.site_id else None,
        }
        for x in rows
    ]


def _recent_ips(ips, limit: int = 8) -> list:
    rows = ips.select_related("status").order_by("-created_at")[:limit]
    return [
        {
            "id": str(x.id),
            "ip": x.ip_address,
            "status": x.status.name if x.status_id else None,
            "status_color": x.status.color if x.status_id else None,
            "dns": x.dns_name or None,
        }
        for x in rows
    ]


def _recent_activity(tenant, ip_filter=None, limit: int = 10) -> list:
    """Latest monitoring status changes - a changelog-style feed."""
    try:
        from monitoring.models import StateTransition
    except Exception:  # noqa: BLE001
        return []
    qs = StateTransition.objects.filter(tenant=tenant)
    if ip_filter is not None:
        qs = qs.filter(target_ip__in=ip_filter)
    rows = (
        qs
        .select_related("target_ip", "template")
        .order_by("-at")[:limit]
    )
    return [
        {
            "ip_id": str(t.target_ip_id) if t.target_ip_id else None,
            "ip": t.target_ip.ip_address if t.target_ip_id else "-",
            "kind": t.kind,
            "from_status": t.from_status,
            "to_status": t.to_status,
            "at": t.at,
        }
        for t in rows
    ]


def _flapping(user, tenant, ip_filter=None, limit: int = 8) -> list:
    """The checks currently flagged as flapping, noisiest first - the
    dashboard's "go and look" list. Site-aware like the IP lists: a viewer
    walled off from a site does not learn which of its hosts bounce."""
    try:
        from monitoring.flapping import flapping_ips
    except Exception:  # noqa: BLE001
        return []
    from .models import IPAddress

    q = rbac.row_filter(user, tenant, "ipaddress", "view")
    if q is None:
        return []
    viewable = None if q is True else IPAddress.objects.filter(tenant=tenant).filter(q)
    if ip_filter is not None:
        viewable = ip_filter
    return flapping_ips(tenant, limit=limit, viewable_ips=viewable)


def _monitoring_charts(request, user, tenant, scoped_ips=None, hours: int = 168,
                       want=OPTIONAL_KEYS) -> dict:
    """The frame for the dashboard's monitoring widgets: availability (time
    up over time measured), alerts opened against resolved per day, and the
    p50/p95 latency per check kind - an hour a point up to a week, a day a
    point beyond. Site-aware like the flapping list.

    Read from the rollups through :mod:`monitoring.figures`, like Explore
    and the Latency page the widgets link to, so the figures agree: one
    grouped query per rollup slice. The raw results it used to read are
    ~600k rows a day on a busy install, and three passes over a week of
    them - two with a percentile sort - took the page ten seconds and more.
    Only the keys in ``want`` are computed; the rest come back empty.
    """
    empty = {
        "availability_7d": None, "alerts_per_day": [], "latency_series": [],
        "latency_by_kind": [],
    }
    try:
        from monitoring.charts import alerts_per_day, viewer_tz
        from monitoring.figures import CHART_KEYS, add, chart_window, figures, sums
        from monitoring.rollups import DAY, _floor
    except Exception:  # noqa: BLE001
        return empty
    from datetime import timedelta

    from django.utils import timezone

    from .models import IPAddress

    q = rbac.row_filter(user, tenant, "ipaddress", "view")
    if q is None:
        return empty
    ip_filter = None if q is True else IPAddress.objects.filter(tenant=tenant).filter(q)
    if scoped_ips is not None:
        ip_filter = scoped_ips

    def narrow(qs):
        qs = qs.filter(tenant=tenant)
        return qs if ip_filter is None else qs.filter(target_ip__in=ip_filter)

    now = timezone.now()
    win = chart_window(hours, now)
    # Each address counted from its availability reset (rollup_slices).
    total: dict = {}
    by_kind: dict = {}
    estate: dict = {}
    grouped = (
        sums(win, narrow, ("kind", "bucket"), only=CHART_KEYS)
        if set(want) & set(ROLLUP_KEYS) else {}
    )
    for (kind, bucket), row in grouped.items():
        b = _floor(bucket, DAY) if win.daily else bucket
        add(total, row)
        add(estate.setdefault(b, {}), row)
        add(by_kind.setdefault(kind, {}).setdefault(b, {}), row)

    def points(buckets: dict) -> list:
        out = []
        for b in sorted(buckets):
            if not buckets[b].get("lat_n"):
                continue
            f = figures(buckets[b])
            out.append({"t": b.isoformat(), "p50": f["p50"], "p95": f["p95"]})
        return out

    kinds = [
        {"kind": k, "samples": int(sum(r.get("lat_n") or 0 for r in buckets.values())),
         "series": points(buckets)}
        for k, buckets in by_kind.items()
    ]
    kinds = sorted((k for k in kinds if k["samples"]), key=lambda k: (-k["samples"], k["kind"]))
    availability = figures(total)["availability"] if total else None
    return {
        "availability_7d": (
            round(availability, 2)
            if availability is not None and "availability_7d" in want else None
        ),
        "alerts_per_day": alerts_per_day(
            tenant, now - timedelta(hours=hours), now, viewer_tz(request, tenant), ip_filter,
        ) if "alerts_per_day" in want else [],
        "latency_series": points(estate) if "latency_series" in want else [],
        "latency_by_kind": kinds if "latency_by_kind" in want else [],
    }


def _monitoring_block(tenant, ip_filter=None) -> dict:
    """Check + alert rollups; isolated so a monitoring import issue can't break
    the IPAM/DCIM half of the dashboard."""
    try:
        from monitoring.models import Alert, CheckState
    except Exception:  # noqa: BLE001
        return {"check_by_status": [], "alerts_by_severity": [], "reachable_pct": None}

    status_colors = {
        "up": "var(--color-emerald-500)",
        "degraded": "var(--color-amber-500)",
        "down": "var(--color-red-500)",
        "stale": "var(--color-red-800)",
        "skipped": "var(--color-zinc-300)",
        "unknown": "var(--color-zinc-400)",
    }
    from monitoring.exclusion import monitored

    # Excluded addresses are not monitored: not in the counts, not in
    # the reachable share.
    states = monitored(CheckState.objects.filter(tenant=tenant), tenant.id)
    if ip_filter is not None:
        states = states.filter(target_ip__in=ip_filter)
    by_status = {
        r["status"]: r["n"]
        for r in states.values("status").annotate(n=Count("id"))
    }
    check_by_status = [
        {"key": s, "name": _titilise(s), "count": n,
         "color": status_colors.get(s, "var(--chart-1)")}
        for s, n in sorted(by_status.items(), key=lambda kv: -kv[1])
    ]
    total = sum(by_status.values())
    reachable_pct = (
        round(100 * (by_status.get("up", 0) / total)) if total else None
    )

    sev_colors = {
        "critical": "var(--color-red-500)",
        "warning": "var(--color-amber-500)",
        "info": "var(--color-sky-500)",
    }
    alerts = Alert.objects.filter(tenant=tenant, status="firing")
    if ip_filter is not None:
        alerts = alerts.filter(target_ip__in=ip_filter)
    alerts_by_severity = [
        {"key": r["severity"], "name": _titilise(r["severity"]), "count": r["n"],
         "color": sev_colors.get(r["severity"], "var(--chart-1)")}
        for r in alerts.values("severity").annotate(n=Count("id")).order_by("-n")
    ]
    return {
        "check_by_status": check_by_status,
        "alerts_by_severity": alerts_by_severity,
        "reachable_pct": reachable_pct,
    }
