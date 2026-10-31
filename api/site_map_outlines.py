"""Building outlines on the Site map.

A ``SiteMapOutline`` is a polygon of ``[lat, lng]`` points drawn on the
geographic Site map, usually linked to the Location it outlines (a building,
any location type). The map lists them from ``GET /api/site-map-outlines/``
(one query, the location and its type joined) and, when one is clicked, asks
``GET /api/site-map-outlines/<id>/drilldown/`` for what is inside the
location: its rooms, racks and devices, and its floor plans.

Scope: outlines are site-scoped (``SITE_PATHS["sitemapoutline"] = "site"``).
An outline linked to a location the reader may not view is not served at all
- not its shape, not its label - so a building the reader cannot see leaves
no trace on their map.
"""
from __future__ import annotations

import math

from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from auth_api import rbac

from .models import (
    Device,
    FloorPlan,
    FloorPlanStack,
    Location,
    Rack,
    Room,
    Site,
    SiteMapOutline,
)
from .serializers import (
    TenantScopedPrimaryKeyRelatedField,
    _OpensMixin,
    hex_color_or_blank,
    location_type_ref,
    polygon_is_simple,
)
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet

MIN_POINTS = 3
MAX_POINTS = 500


def clean_points(raw) -> list[list[float]]:
    """``raw`` as a ring of 3 to 500 ``[lat, lng]`` points rounded to 6 dp,
    a repeated closing point dropped; raises ``ValidationError`` when it is
    not a simple polygon with an area."""
    if not isinstance(raw, list):
        raise serializers.ValidationError("A list of [lat, lng] points.")
    pts = []
    for p in raw:
        if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(
            isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n)
            for n in p
        )):
            raise serializers.ValidationError("Each point is a [lat, lng] pair of numbers.")
        lat, lng = float(p[0]), float(p[1])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise serializers.ValidationError("A point lies off the map.")
        pts.append([round(lat, 6), round(lng, 6)])
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if not MIN_POINTS <= len(pts) <= MAX_POINTS:
        raise serializers.ValidationError(
            f"An outline has {MIN_POINTS} to {MAX_POINTS} points."
        )
    if any(pts[i] == pts[(i + 1) % len(pts)] for i in range(len(pts))):
        raise serializers.ValidationError("Two points in a row are the same.")
    if not polygon_is_simple(pts):
        raise serializers.ValidationError("The outline crosses itself.")
    area = sum(
        pts[i][1] * pts[(i + 1) % len(pts)][0] - pts[(i + 1) % len(pts)][1] * pts[i][0]
        for i in range(len(pts))
    )
    if abs(area) < 1e-12:
        raise serializers.ValidationError("The outline has no area.")
    return pts


def _location_ref(loc) -> dict | None:
    if loc is None:
        return None
    return {
        "id": str(loc.id),
        "name": loc.name,
        "code": loc.code,
        "color": loc.display_color,
        "icon": loc.display_icon,
        "location_type": location_type_ref(loc.location_type) if loc.location_type_id else None,
    }


class SiteMapOutlineSerializer(_OpensMixin, serializers.ModelSerializer):
    """An outline on the Site map. ``display_label`` and ``display_color``
    are what the map draws: the outline's own label and colour, else its
    location's code (or name) and its location type's colour (or the
    location's own)."""

    site_id = TenantScopedPrimaryKeyRelatedField(source="site", queryset=Site.objects.all())
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(),
        required=False, allow_null=True,
    )
    location = serializers.SerializerMethodField()
    points = serializers.JSONField()
    display_label = serializers.CharField(read_only=True)
    display_color = serializers.CharField(read_only=True)
    # The floor plan "Open floor plan" opens (see _OpensMixin).
    opens = serializers.SerializerMethodField()
    opens_hidden = serializers.SerializerMethodField()
    opens_id = TenantScopedPrimaryKeyRelatedField(
        source="opens", queryset=FloorPlan.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_location(self, obj):
        return _location_ref(obj.location) if obj.location_id else None

    def validate_points(self, value):
        return clean_points(value)

    def validate_color(self, value):
        return hex_color_or_blank(value)

    def validate_label(self, value):
        return (value or "").strip()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        inst = self.instance
        site = attrs.get("site", inst.site if inst else None)
        location = attrs.get("location", inst.location if inst else None)
        if location is not None and ("location" in attrs or "site" in attrs):
            if site is None or location.site_id != site.id or not self._visible(location):
                raise serializers.ValidationError(
                    {"location_id": "Pick a location at this outline's site."}
                )
        self._check_opens(attrs)
        return attrs

    def _visible(self, location) -> bool:
        request = self.context.get("request")
        if request is None:
            return True
        tenant = _get_active_tenant(request)
        return rbac.restrict_queryset(
            Location.objects.filter(pk=location.pk), request.user, tenant, "location", "view",
        ).exists()

    class Meta:
        model = SiteMapOutline
        fields = ["id", "site_id", "location_id", "location", "points", "label", "color",
                  "z", "locked", "display_label", "display_color",
                  "opens", "opens_id", "opens_hidden", "created_at", "updated_at"]
        read_only_fields = ["id", "location", "display_label", "display_color",
                            "opens", "opens_hidden", "created_at", "updated_at"]


def _subtree(location) -> list:
    """``location`` and every location nested under it - one query."""
    children: dict = {}
    for pk, parent in Location.objects.filter(site_id=location.site_id).values_list(
        "pk", "parent_id"
    ):
        children.setdefault(parent, []).append(pk)
    out, todo = [], [location.pk]
    while todo:
        pk = todo.pop()
        if pk in out:
            continue
        out.append(pk)
        todo.extend(children.get(pk, []))
    return out


class SiteMapOutlineViewSet(TenantScopedViewSet):
    """Building outlines on the Site map (``sitemapoutline``). Filters:
    ``?site=``, ``?location=``. An outline of a location the reader may not
    view is left out of every action."""

    queryset = SiteMapOutline.objects.order_by("z", "created_at", "pk")
    serializer_class = SiteMapOutlineSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        from .topology_views import _uuid_param

        qs = super().get_queryset().select_related(
            "site", "location", "location__location_type", "opens__stack"
        )
        if not self.request:
            return qs
        tenant = _get_active_tenant(self.request)
        readable = rbac.restrict_queryset(
            Location.objects.filter(tenant=tenant), self.request.user, tenant,
            "location", "view",
        )
        qs = qs.filter(Q(location__isnull=True) | Q(location__in=readable.values("pk")))
        params = self.request.query_params
        site = _uuid_param(params, "site")
        if site:
            qs = qs.filter(site_id=site)
        location = _uuid_param(params, "location")
        if location:
            qs = qs.filter(location_id=location)
        return qs

    @extend_schema(
        summary="What is inside an outline's location",
        responses={200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "The location (with its type), counts of the sub-locations, rooms, "
                "racks and devices in it and under it that the reader may view, its "
                "floor plans and the site-wide ones, and `open_floor_id`: the floor "
                "the map's Open floor plan button opens - the outline's own Opens "
                "target when it has one the reader may view."
            ),
        )},
    )
    @action(detail=True, methods=["get"])
    def drilldown(self, request, pk=None):
        outline = self.get_object()
        tenant = _get_active_tenant(request)
        user = request.user

        def visible(qs, slug):
            return rbac.restrict_queryset(qs, user, tenant, slug, "view")

        loc = outline.location if outline.location_id else None
        counts = None
        stacks_q = Q(site_id=outline.site_id, location__isnull=True)
        if loc is not None:
            ids = _subtree(loc)
            inside = Q(location_id__in=ids) | Q(room__location_id__in=ids)
            counts = {
                "locations": visible(
                    Location.objects.filter(tenant=tenant, pk__in=ids), "location"
                ).count() - 1,
                "rooms": visible(
                    Room.objects.filter(tenant=tenant, location_id__in=ids), "room"
                ).count(),
                "racks": visible(Rack.objects.filter(tenant=tenant).filter(inside), "rack")
                .count(),
                "devices": visible(
                    Device.objects.filter(tenant=tenant).filter(inside), "device"
                ).count(),
            }
            stacks_q |= Q(location_id__in=ids)

        stacks = list(
            visible(FloorPlanStack.objects.filter(tenant=tenant).filter(stacks_q), "floorplan")
            .select_related("location")
        )
        floors: dict = {}
        for f in visible(
            FloorPlan.objects.filter(tenant=tenant, stack__in=stacks), "floorplan"
        ).order_by("floor_order", "name", "pk").values("pk", "stack_id"):
            floors.setdefault(f["stack_id"], []).append(f["pk"])

        def rank(s):
            # The location's own floor plans first (its own before those of
            # the locations inside it), then the site-wide ones.
            if s.location_id is None:
                return (2, s.name.lower())
            return (0 if loc is not None and s.location_id == loc.pk else 1, s.name.lower())

        plans = []
        for s in sorted(stacks, key=rank):
            ids_ = floors.get(s.pk, [])
            plans.append({
                "id": str(s.pk),
                "name": s.name,
                "location": {"id": str(s.location_id), "name": s.location.name}
                if s.location_id else None,
                "site_wide": s.location_id is None,
                "floor_count": len(ids_),
                "first_floor_id": str(ids_[0]) if ids_ else None,
            })
        open_floor = next((p["first_floor_id"] for p in plans if p["first_floor_id"]), None)
        # The outline's own Opens target, when the reader may view it, wins.
        if outline.opens_id and visible(
            FloorPlan.objects.filter(tenant=tenant, pk=outline.opens_id), "floorplan"
        ).exists():
            open_floor = str(outline.opens_id)
        return Response({
            "id": str(outline.pk),
            "display_label": outline.display_label,
            "display_color": outline.display_color,
            "site": {"id": str(outline.site_id), "name": outline.site.name},
            "location": _location_ref(loc),
            "counts": counts,
            "floor_plans": plans,
            "open_floor_id": open_floor,
        })
