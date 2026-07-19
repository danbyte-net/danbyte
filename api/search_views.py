"""Global search endpoint — one query, results grouped by entity.

Tenant-scoped: each row is filtered by the user's active tenant (tags are
global since the Tag model itself is global). Returns up to `limit` rows
per entity so the topbar suggester stays snappy and the /search results
page can render a grouped table.

Matching is currently substring (``__icontains``) across every plausible
field per entity. Postgres trigram (``pg_trgm``) is the obvious upgrade
once the schema migrations are unblocked — drop in
``TrigramSimilarity`` + a similarity threshold and reorder by score.
"""
from __future__ import annotations

from django.db.models import Q
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core.models import Tag, Tenant
from auth_api import rbac
from .models import Device, IPAddress, Prefix, RouteTarget, Site, VLAN, VRF
from .serializers import TagSerializer
from .views import _get_active_tenant


DEFAULT_LIMIT = 25
MAX_LIMIT = 100


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def search(request):
    """GET /api/search/?q=<query>&limit=<n>

    Returns ``{ q, total, groups: { prefixes, ips, vlans, vrfs,
    route_targets, sites, tenants, devices, tags } }``. Each group is
    pre-shaped for the React results table — id, label, sublabel, url —
    so the page can render every section the same way without per-entity
    branches.
    """
    q = (request.query_params.get("q") or "").strip()
    try:
        limit = min(int(request.query_params.get("limit") or DEFAULT_LIMIT), MAX_LIMIT)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT

    if not q:
        return Response({"q": q, "total": 0, "groups": _empty_groups()})

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")

    u = request.user
    groups = {
        "prefixes":      _search_prefixes(q, u, tenant, limit),
        "ips":           _search_ips(q, u, tenant, limit),
        "vlans":         _search_vlans(q, u, tenant, limit),
        "vrfs":          _search_vrfs(q, u, tenant, limit),
        "route_targets": _search_rts(q, u, tenant, limit),
        "sites":         _search_sites(q, u, tenant, limit),
        "tenants":       _search_tenants(q, u, limit),
        "devices":       _search_devices(q, u, tenant, limit),
        "tags":          _search_tags(q, limit),
    }
    total = sum(len(g) for g in groups.values())
    return Response({"q": q, "total": total, "groups": groups})


# ─── Per-entity searches ───────────────────────────────────────────────

def _search_prefixes(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view")
        .filter(Q(cidr__icontains=q) | Q(description__icontains=q))
        .select_related("vrf", "site")
        .order_by("cidr")[:limit]
    )
    return [
        {
            "id": str(p.id),
            "label": str(p.cidr),
            "sublabel": p.description or "",
            "extras": {
                "status": p.status.slug if p.status_id else None,
                "vrf": p.vrf.name if p.vrf else None,
                "site": p.site.name if p.site else None,
            },
            "url": f"/prefixes/{p.id}",
        }
        for p in qs
    ]


def _search_ips(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress", "view")
        .filter(
            Q(ip_address__icontains=q)
            | Q(description__icontains=q)
            | Q(reservation_note__icontains=q)
        )
        .select_related("status", "role", "assigned_device", "prefix")
        .order_by("ip_address")[:limit]
    )
    return [
        {
            "id": str(ip.id),
            "label": str(ip.ip_address),
            "sublabel": ip.description or ip.reservation_note or "",
            "extras": {
                "status": ip.status.name if ip.status else None,
                "role": ip.role.name if ip.role else None,
                "device": ip.assigned_device.name if ip.assigned_device else None,
                "prefix": str(ip.prefix.cidr) if ip.prefix else None,
            },
            "url": f"/ips/{ip.id}",
        }
        for ip in qs
    ]


def _search_vlans(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    cond = Q(name__icontains=q) | Q(description__icontains=q)
    if q.isdigit():
        # Exact match on VLAN ID — IntegerField doesn't support icontains
        # cleanly across all backends.
        cond |= Q(vlan_id=int(q))
    qs = (
        rbac.restrict_queryset(VLAN.objects.filter(tenant=tenant), user, tenant, "vlan", "view")
        .filter(cond)
        .select_related("site")
        .order_by("vlan_id")[:limit]
    )
    return [
        {
            "id": str(v.id),
            "label": f"{v.vlan_id} · {v.name}",
            "sublabel": v.description or "",
            "extras": {"site": v.site.name if v.site else None},
            "url": f"/vlans/{v.id}",
        }
        for v in qs
    ]


def _search_vrfs(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(VRF.objects.filter(tenant=tenant), user, tenant, "vrf", "view")
        .filter(Q(name__icontains=q) | Q(rd__icontains=q) | Q(description__icontains=q))
        .order_by("name")[:limit]
    )
    return [
        {
            "id": str(v.id),
            "label": v.name,
            "sublabel": v.description or "",
            "extras": {"rd": v.rd or None},
            "url": f"/vrfs/{v.id}",
        }
        for v in qs
    ]


def _search_rts(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(RouteTarget.objects.filter(tenant=tenant), user, tenant, "routetarget", "view")
        .filter(Q(name__icontains=q) | Q(description__icontains=q))
        .order_by("name")[:limit]
    )
    return [
        {
            "id": str(rt.id),
            "label": rt.name,
            "sublabel": rt.description or "",
            "extras": {},
            "url": f"/route-targets/{rt.id}",
        }
        for rt in qs
    ]


def _search_sites(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(Site.objects.filter(tenant=tenant), user, tenant, "site", "view")
        .filter(
            Q(name__icontains=q)
            | Q(location__icontains=q)
            | Q(description__icontains=q)
        )
        .order_by("name")[:limit]
    )
    return [
        {
            "id": str(s.id),
            "label": s.name,
            "sublabel": s.location or s.description or "",
            "extras": {},
            "url": f"/sites/{s.id}",
        }
        for s in qs
    ]


def _search_tenants(q: str, user, limit: int) -> list[dict]:
    # Tenants aren't tenant-scoped (they ARE the scope). Limit to ones
    # the user has membership on — but for the moment the user model
    # doesn't surface that cleanly, so superusers see all and others see
    # only their currently active tenant. Refine if/when membership is
    # exposed via the API.
    if not getattr(user, "is_authenticated", False):
        return []
    base = Tenant.objects.filter(
        Q(name__icontains=q) | Q(slug__icontains=q) | Q(description__icontains=q)
    )
    if getattr(user, "is_superuser", False):
        qs = base
    else:
        active_id = getattr(user, "active_tenant_id", None)
        qs = base.filter(pk=active_id) if active_id else Tenant.objects.none()
    return [
        {
            "id": str(t.id),
            "label": t.name,
            "sublabel": t.slug,
            "extras": {"is_active": t.is_active},
            "url": f"/tenants/{t.id}",
        }
        for t in qs.order_by("name")[:limit]
    ]


def _search_devices(q: str, user, tenant: Tenant, limit: int) -> list[dict]:
    qs = (
        rbac.restrict_queryset(Device.objects.filter(tenant=tenant), user, tenant, "device", "view")
        .filter(Q(name__icontains=q))
        .order_by("name")[:limit]
    )
    return [
        {
            "id": str(d.id),
            "label": d.name,
            "sublabel": "",
            "extras": {},
            "url": f"/devices/{d.id}",
        }
        for d in qs
    ]


def _search_tags(q: str, limit: int) -> list[dict]:
    qs = Tag.objects.filter(Q(name__icontains=q) | Q(slug__icontains=q)).order_by("name")[:limit]
    serialized = TagSerializer(qs, many=True).data
    return [
        {
            "id": t["id"],
            "label": t["name"],
            "sublabel": t["slug"],
            "extras": {"color": t["color"], "text_color": t["text_color"]},
            # Tag has no detail page yet; deep-link the tenant prefix list
            # filtered by the tag slug instead.
            "url": f"/prefixes?tag={t['slug']}",
        }
        for t in serialized
    ]


def _empty_groups() -> dict[str, list]:
    return {
        "prefixes": [], "ips": [], "vlans": [], "vrfs": [],
        "route_targets": [], "sites": [], "tenants": [],
        "devices": [], "tags": [],
    }
