"""Lifecycle → Versions (#451): how many devices and VMs run each software
version, per platform.

``GET /api/lifecycle/versions/`` answers one row per (platform, version) -
the object's own platform, blank version as its own row - with the device
and VM counts, whether the version is the platform's target, and how many
of each source. ``?site=``, ``?platform=`` and ``?role=`` take one id or a
comma-separated list; ``none`` stands for objects without one. Devices and VMs come through ``rbac.restrict_queryset``
(site roles count only their sites); an object type the caller cannot view
is left out. ``facets`` lists the sites, platforms and roles of the visible
objects with their counts, for the page's filters. A fixed number of
grouped queries, however large the fleet.
"""
from __future__ import annotations

import uuid

from django.db.models import Count, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .models import Device, DeviceRole, Platform, Site, VirtualMachine
from .software_versions import version_sort_key
from .views import _get_active_tenant

FILTERS = (("site", "site_id"), ("platform", "platform_id"), ("role", "role_id"))
_KINDS = (("device", Device, "devices"), ("virtualmachine", VirtualMachine, "virtual_machines"))


def _filter_q(raw: str | None, name: str, field: str) -> Q | None:
    """``?<name>=<id>,<id>,none`` as a filter on ``field``; None without one."""
    ids, none = [], False
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part == "none":
            none = True
            continue
        try:
            ids.append(uuid.UUID(part))
        except ValueError:
            raise ValidationError({name: "Valid UUIDs or none, comma-separated."}) from None
    if not ids and not none:
        return None
    q = Q(**{f"{field}__in": ids})
    if none:
        q |= Q(**{f"{field}__isnull": True})
    return q


def _visible(request, tenant):
    """``[(kind, count key, queryset)]`` for the object types the caller may
    view, before the filters."""
    out = []
    for slug, model, key in _KINDS:
        if rbac.has_action(request.user, tenant, slug, "view"):
            qs = rbac.restrict_queryset(
                model.objects.filter(tenant=tenant), request.user, tenant, slug, "view"
            )
            out.append((key, qs))
    return out


def _facets(tenant, visible) -> dict:
    """Sites, platforms and roles of the visible objects, with counts."""
    counts: dict[str, dict] = {"site": {}, "platform": {}, "role": {}}
    for _key, qs in visible:
        for name, field in FILTERS:
            for r in qs.order_by().values(field).annotate(n=Count("pk")):
                ref = r[field]
                ref = str(ref) if ref else None
                counts[name][ref] = counts[name].get(ref, 0) + r["n"]
    names = {
        "site": {str(s["id"]): {"name": s["name"]} for s in Site.objects.filter(
            tenant=tenant, pk__in=[k for k in counts["site"] if k]).values("id", "name")},
        "platform": {str(p["id"]): {"name": p["name"]} for p in Platform.objects.filter(
            tenant=tenant, pk__in=[k for k in counts["platform"] if k]).values("id", "name")},
        "role": {str(r["id"]): {"name": r["name"], "color": r["color"]}
                 for r in DeviceRole.objects.filter(
                     tenant=tenant, pk__in=[k for k in counts["role"] if k]
                 ).values("id", "name", "color")},
    }
    out = {}
    for name, by_id in counts.items():
        rows = [
            {"id": ref, **names[name].get(ref, {"name": ""}), "count": n}
            for ref, n in by_id.items()
            if ref is None or ref in names[name]
        ]
        rows.sort(key=lambda r: (r["id"] is None, r["name"].lower()))
        out[name] = rows
    return out


@extend_schema(
    summary="Devices and virtual machines by running software version",
    tags=["devices"],
    parameters=[
        OpenApiParameter(name, OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description=f"One {name} id, or several comma-separated; "
                                     f"`none` for objects without one.")
        for name, _ in FILTERS
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{results: [{platform: {id, name, target_version} | null, version, "
                    "devices, virtual_machines, on_target: bool | null, sources: "
                    "{manual, snmp, virtualization, oxidized, import, none}}], "
                    "facets: {site, platform, role: [{id, name, count}]}}",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def software_versions_summary(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    wanted = [
        q for name, field in FILTERS
        if (q := _filter_q(request.query_params.get(name), name, field)) is not None
    ]

    visible = _visible(request, tenant)
    facets = _facets(tenant, visible)

    rows: dict[tuple, dict] = {}
    for key, qs in visible:
        for q in wanted:
            qs = qs.filter(q)
        grouped = (
            qs.order_by()
            .values("platform_id", "software_version", "software_version_source")
            .annotate(n=Count("pk"))
        )
        for r in grouped:
            pid = str(r["platform_id"]) if r["platform_id"] else None
            row = rows.setdefault((pid, r["software_version"]), {
                "platform_ref": pid, "version": r["software_version"],
                "devices": 0, "virtual_machines": 0, "sources": {},
            })
            row[key] += r["n"]
            source = r["software_version_source"] or "none"
            row["sources"][source] = row["sources"].get(source, 0) + r["n"]

    platforms = {
        str(p["id"]): p for p in Platform.objects.filter(
            tenant=tenant, pk__in=[pid for pid, _v in rows if pid]
        ).values("id", "name", "target_version")
    }
    results = []
    for row in rows.values():
        p = platforms.get(row.pop("platform_ref") or "")
        target = (p["target_version"] if p else "") or ""
        results.append({
            "platform": (
                {"id": str(p["id"]), "name": p["name"], "target_version": target}
                if p else None
            ),
            **row,
            "on_target": (row["version"] == target) if row["version"] and target else None,
        })
    results.sort(key=lambda r: (
        r["platform"] is None,
        (r["platform"] or {}).get("name", "").lower(),
        version_sort_key(r["version"]),
    ))
    return Response({"results": results, "facets": facets})
