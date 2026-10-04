"""A site's rack capacity, floor plan by floor plan (#247).

``GET /api/sites/{id}/capacity/`` answers the site page's Capacity tab: one
entry per floor plan of the site with the totals of the site's racks standing
on it and a thumbnail - the rack tiles only, never every tile - plus the
site's racks that stand on no floor plan, and the whole site's totals. Every
figure is ``api.capacity``'s, so a rack reads here as on its own page.

Floor plans are the ones the caller may view, racks likewise. A rack's totals
count every device in it, as its units and power do. About twenty queries,
whatever the site holds.
"""
from __future__ import annotations

from django.db.models import Exists, OuterRef

from . import capacity
from .natural import natural


def _mini(obj, *fields) -> dict | None:
    if obj is None:
        return None
    return {f: (str(getattr(obj, f)) if f == "id" else getattr(obj, f)) for f in fields}


def site_capacity(request, site) -> dict:
    """The payload for ``site``, which the caller may view - see the module
    docstring and ``docs/models/site.md``."""
    from auth_api import rbac
    from core.effective_settings import port_count_virtual

    from .models import FloorPlan, FloorPlanTile, Rack
    from .views import _get_active_tenant

    tenant = _get_active_tenant(request)
    user = request.user
    count_virtual = port_count_virtual(tenant)

    plans = list(
        rbac.restrict_queryset(
            FloorPlan.objects.filter(tenant=tenant, location__site=site),
            user, tenant, "floorplan", "view",
        )
        .select_related("location")
        .order_by(natural("name"))
    )
    racks = list(
        rbac.restrict_queryset(
            Rack.objects.filter(tenant=tenant, site=site), user, tenant, "rack", "view"
        )
        .select_related("role", "status")
        .prefetch_related(capacity.racked_devices_prefetch(), "power_feeds")
        # On any floor plan at all - a rack on a plan the caller cannot see
        # is not "on no floor plan".
        .annotate(placed=Exists(FloorPlanTile.objects.filter(rack=OuterRef("pk"))))
        .order_by(natural("name"))
    )
    by_id = {r.id: r for r in racks}
    tiles = (
        FloorPlanTile.objects.filter(floor_plan__in=[p.id for p in plans], rack__in=list(by_id))
        .order_by("y", "x")
        .values("floor_plan_id", "rack_id", "x", "y", "width", "height", "orientation")
        if plans and racks else []
    )
    split = capacity.rack_port_split(racks, count_virtual=count_virtual)
    figures = {r.id: capacity.rack_figures(r, split[r.id]) for r in racks}

    def rack_entry(rack) -> dict:
        return {
            "id": str(rack.id),
            "name": rack.name,
            "role": _mini(rack.role, "id", "name", "color"),
            "status": _mini(rack.status, "id", "name", "slug", "color", "text_color"),
            **figures[rack.id],
        }

    tiles_by_plan: dict = {}
    for t in tiles:
        tiles_by_plan.setdefault(t["floor_plan_id"], []).append(t)

    floor_plans = []
    for plan in plans:
        plan_tiles = tiles_by_plan.get(plan.id, [])
        on_plan = {t["rack_id"] for t in plan_tiles}
        plan_racks = [r for r in racks if r.id in on_plan]
        floor_plans.append({
            "id": str(plan.id),
            "name": plan.name,
            "location": {"id": str(plan.location_id), "name": plan.location.name},
            "grid_width": plan.grid_width,
            "grid_height": plan.grid_height,
            "totals": capacity.sum_figures(figures[r.id] for r in plan_racks),
            "racks": [rack_entry(r) for r in plan_racks],
            "tiles": [
                {
                    "rack_id": str(t["rack_id"]),
                    "x": t["x"],
                    "y": t["y"],
                    "w": t["width"],
                    "h": t["height"],
                    "orientation": t["orientation"],
                }
                for t in plan_tiles
            ],
        })

    unplaced = [r for r in racks if not r.placed]
    return {
        "site": {"id": str(site.id), "name": site.name},
        "count_virtual": count_virtual,
        "totals": capacity.sum_figures(figures.values()),
        "floor_plans": floor_plans,
        "unplaced": {
            "totals": capacity.sum_figures(figures[r.id] for r in unplaced),
            "racks": [rack_entry(r) for r in unplaced],
        },
    }
