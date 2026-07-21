"""Dashboard aggregation — one batched, tenant-scoped payload for the home page.

Every dashboard widget reads from this single endpoint so the page is one fetch.
Aggregations are deliberately cheap (``.count()`` + ``values().annotate()``); the
only per-instance work is utilisation for the top-8 prefixes.
"""
from __future__ import annotations

import ipaddress

from django.db.models import Count
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
    return v.replace("_", " ").title() if v else "—"


# Carrier-grade NAT shared space (RFC 6598) — routable-looking but not public.
# Checked before is_private so it lands in its own bucket regardless of how the
# stdlib classifies it across Python versions.
_CGNAT4 = ipaddress.ip_network("100.64.0.0/10")


def _classify_ip_scope(value: str) -> str | None:
    """Bucket an address by reachability, from the address alone — no config,
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


def _ip_by_scope(ips) -> list:
    """Public/private/CGNAT/special distribution of a tenant's IP addresses."""
    counts = {k: 0 for k in _SCOPE_ORDER}
    for value in ips.values_list("ip_address", flat=True):
        bucket = _classify_ip_scope(value)
        if bucket is not None:
            counts[bucket] += 1
    return [
        {"name": name, "count": counts[name], "color": _SCOPE_COLORS[name]}
        for name in _SCOPE_ORDER
        if counts[name]
    ]


def _by(qs, field, label_field=None, color_field=None, limit=None):
    """Group ``qs`` by ``field`` → [{name, count, color?}], biggest first."""
    cols = [field]
    if label_field:
        cols.append(label_field)
    if color_field:
        cols.append(color_field)
    rows = qs.values(*cols).annotate(n=Count("id")).order_by("-n")
    out = []
    for i, r in enumerate(rows):
        name = r.get(label_field) if label_field else r.get(field)
        out.append(
            {
                "name": name or "—",
                "count": r["n"],
                "color": (color_field and r.get(color_field))
                or _PALETTE[i % len(_PALETTE)],
            }
        )
    return out[:limit] if limit else out


def _empty_dashboard() -> dict:
    """Full-shape payload with everything zeroed/empty. Returned when the user
    has no active tenant (e.g. a freshly created account before a tenant is
    assigned) so the frontend never reads an undefined array/field."""
    keys = (
        "recent_activity", "recent_prefixes", "recent_devices", "recent_ips",
        "ip_by_status", "ip_by_role", "ip_by_scope",
        "prefix_by_family", "prefix_by_status",
        "top_prefixes", "device_by_status", "device_by_type", "device_by_site",
        "device_by_manufacturer", "check_by_status", "alerts_by_severity",
    )
    return {"counts": {}, "reachable_pct": None, **{k: [] for k in keys}}


@extend_schema(
    summary="Batched, tenant-scoped dashboard aggregation payload",
    tags=["dashboard"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Single dashboard payload: object counts, IPAM/DCIM distributions, "
            "recent activity feeds, top prefixes by utilisation, and monitoring "
            "roll-ups — all scoped to the active tenant and the caller's RBAC "
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

    counts = {
        "prefixes": prefixes.count(),
        "ips": ips.count(),
        "devices": devices.count(),
        "sites": _scoped(Site, "site", tenant=tenant).count(),
        "vlans": _scoped(VLAN, "vlan", tenant=tenant).count(),
        "vrfs": _scoped(VRF, "vrf", tenant=tenant).count(),
        "cables": _scoped(Cable, "cable", tenant=tenant).count(),
        "interfaces": _scoped(Interface, "interface", device__tenant=tenant).count(),
    }

    # ── IPAM ────────────────────────────────────────────────────────────
    ip_by_status = _by(ips, "status_id", "status__name", "status__color")
    ip_by_role = _by(ips, "role_id", "role__name", "role__color")
    ip_by_scope = _ip_by_scope(ips)

    fam = {"4": 0, "6": 0}
    for cidr in prefixes.values_list("cidr", flat=True):
        fam["6" if ":" in (cidr or "") else "4"] += 1
    prefix_by_family = [
        {"name": "IPv4", "count": fam["4"], "color": "var(--chart-1)"},
        {"name": "IPv6", "count": fam["6"], "color": "var(--chart-3)"},
    ]

    prefix_by_status = _by(prefixes, "status_id", "status__name", "status__color")

    # Top prefixes by utilisation (per-instance, but only the busiest 8).
    busiest = list(
        prefixes.annotate(ipc=Count("ip_addresses")).order_by("-ipc")[:8]
    )
    top_prefixes = [
        {
            "id": str(p.id),
            "cidr": p.cidr,
            "ip_count": p.ipc,
            "utilisation_pct": p.utilisation_pct,
        }
        for p in busiest
        if p.ipc
    ]

    # ── DCIM ────────────────────────────────────────────────────────────
    device_by_status = _by(devices, "status_id", "status__name", "status__color")
    device_by_type = _by(devices, "device_type__name", limit=6)
    device_by_site = _by(
        devices.exclude(site__isnull=True), "site__name", limit=6
    )
    device_by_manufacturer = _by(
        devices.exclude(device_type__manufacturer__isnull=True),
        "device_type__manufacturer__name",
        limit=6,
    )

    # ── Monitoring ──────────────────────────────────────────────────────
    # The check/alert roll-ups and the status-change feed describe the
    # monitored OBJECTS (devices/prefixes/IPs — recent activity even carries
    # IP addresses), so they follow the same view grants: a member walled off
    # from all three sees empty monitoring widgets, not a tenant-wide rollup.
    can_see_monitoring = any(
        rbac.has_action(u, tenant, slug, "view")
        for slug in ("device", "prefix", "ipaddress")
    )
    monitoring = (
        _monitoring_block(tenant) if can_see_monitoring
        else {"check_by_status": [], "alerts_by_severity": [],
              "reachable_pct": None}
    )

    return Response(
        {
            "counts": counts,
            "recent_activity": (
                _recent_activity(tenant) if can_see_monitoring else []
            ),
            "recent_prefixes": _recent_prefixes(prefixes),
            "recent_devices": _recent_devices(devices),
            "recent_ips": _recent_ips(ips),
            "ip_by_status": ip_by_status,
            "ip_by_role": ip_by_role,
            "ip_by_scope": ip_by_scope,
            "prefix_by_family": prefix_by_family,
            "prefix_by_status": prefix_by_status,
            "top_prefixes": top_prefixes,
            "device_by_status": device_by_status,
            "device_by_type": device_by_type,
            "device_by_site": device_by_site,
            "device_by_manufacturer": device_by_manufacturer,
            **monitoring,
        }
    )


def _recent_prefixes(prefixes, limit: int = 8) -> list:
    rows = (
        prefixes.select_related("site")
        .annotate(ipc=Count("ip_addresses"))
        .order_by("-created_at")[:limit]
    )
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
        devices.select_related("device_type", "site").order_by("-created_at")[:limit]
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


def _recent_activity(tenant, limit: int = 10) -> list:
    """Latest monitoring status changes — a changelog-style feed."""
    try:
        from monitoring.models import StateTransition
    except Exception:  # noqa: BLE001
        return []
    rows = (
        StateTransition.objects.filter(tenant=tenant)
        .select_related("target_ip", "template")
        .order_by("-at")[:limit]
    )
    return [
        {
            "ip_id": str(t.target_ip_id) if t.target_ip_id else None,
            "ip": t.target_ip.ip_address if t.target_ip_id else "—",
            "kind": t.kind,
            "from_status": t.from_status,
            "to_status": t.to_status,
            "at": t.at,
        }
        for t in rows
    ]


def _monitoring_block(tenant) -> dict:
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
    states = CheckState.objects.filter(tenant=tenant)
    by_status = {
        r["status"]: r["n"]
        for r in states.values("status").annotate(n=Count("id"))
    }
    check_by_status = [
        {"name": _titilise(s), "count": n, "color": status_colors.get(s, "var(--chart-1)")}
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
    alerts_by_severity = [
        {"name": _titilise(r["severity"]), "count": r["n"], "color": sev_colors.get(r["severity"], "var(--chart-1)")}
        for r in alerts.values("severity").annotate(n=Count("id")).order_by("-n")
    ]
    return {
        "check_by_status": check_by_status,
        "alerts_by_severity": alerts_by_severity,
        "reachable_pct": reachable_pct,
    }
