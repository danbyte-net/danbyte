"""A site-wide floor plan made from a view of the Site map.

``POST /api/floor-plans/from-map/`` takes a box of the map (``bbox`` =
south, west, north, east in degrees), the site, a name and a cell size, and
optionally the view rendered as an image by the browser. It makes a
site-wide floor plan whose grid spans the box at true scale, puts the image
under it as the background, and copies the site's building outlines inside
the box onto it as areas linked to the same locations.

Scale: the map is Web Mercator. Across one view (a campus, at most
``MAX_GRID`` cells of at most ``MAX_CELL_MM``, ~2.5 km) the projection's
scale is taken as constant at the box's middle latitude; a metre on the map
is ``cos(latitude)`` of a metre at the equator. Positions inside the box are
mapped linearly in Mercator units onto the grid, exactly as the image is
stretched over it, so outlines land on the buildings in the picture.

The server never fetches map tiles: the browser renders the view from the
tiles it already shows (docs/features/site-map.md, Airgapped servers). A
browser that cannot read the tiles makes the plan with the outlines only.
"""
from __future__ import annotations

import html
import json
import math
import re
from dataclasses import dataclass

from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError

from auth_api import rbac

from .models import FloorPlan, Location, Site, SiteMapOutline

EARTH_CIRCUMFERENCE_M = 40_075_016.686
MAX_LAT = 85.05112878
MAX_GRID = 512
MIN_CELL_MM = 50
MAX_CELL_MM = 5000
DEFAULT_CELL_MM = 1000
MAX_AREA_POINTS = 200

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_EDGE = 8192
MAX_IMAGE_PIXELS = 40_000_000
IMAGE_FORMATS = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}


# ── projection ──────────────────────────────────────────────────────────────


def merc_x(lng: float) -> float:
    """Longitude as a fraction of the Web Mercator world's width (0 at
    -180°, 1 at 180°)."""
    return (lng + 180.0) / 360.0


def merc_y(lat: float) -> float:
    """Latitude as a fraction of the world's height (0 at the top)."""
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    phi = math.radians(lat)
    return (1.0 - math.asinh(math.tan(phi)) / math.pi) / 2.0


def lat_of(my: float) -> float:
    """The latitude at Mercator ``my`` (the inverse of ``merc_y``)."""
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * my))))


@dataclass(frozen=True)
class Frame:
    """A map box as a plan grid."""

    south: float
    west: float
    north: float
    east: float
    width_m: float
    height_m: float
    cell_mm: int
    grid_width: int
    grid_height: int

    @property
    def x0(self) -> float:
        return merc_x(self.west)

    @property
    def x1(self) -> float:
        return merc_x(self.east)

    @property
    def y0(self) -> float:
        return merc_y(self.north)

    @property
    def y1(self) -> float:
        return merc_y(self.south)

    def to_cells(self, lat: float, lng: float) -> tuple[float, float]:
        """A point as grid cells (x right, y down), linear in Mercator units
        across the box like the stretched background image."""
        cx = (merc_x(lng) - self.x0) / (self.x1 - self.x0) * self.grid_width
        cy = (merc_y(lat) - self.y0) / (self.y1 - self.y0) * self.grid_height
        return cx, cy


def metres_per_unit(south: float, north: float) -> float:
    """Metres per Mercator world-width unit at the box's middle latitude."""
    mid = lat_of((merc_y(north) + merc_y(south)) / 2.0)
    return EARTH_CIRCUMFERENCE_M * math.cos(math.radians(mid))


def frame(bbox, cell_mm: int | None = None) -> Frame:
    """The grid for ``bbox`` (south, west, north, east): its real extent in
    metres, the cell size - ``cell_mm``, raised when the box would need more
    than ``MAX_GRID`` cells across - and the grid size in whole cells.

    Raises ``ValidationError`` on a box that is not one, or too large for a
    plan even at ``MAX_CELL_MM``."""
    south, west, north, east = _clean_bbox(bbox)
    per = metres_per_unit(south, north)
    width_m = (merc_x(east) - merc_x(west)) * per
    height_m = (merc_y(south) - merc_y(north)) * per
    cell = int(cell_mm or DEFAULT_CELL_MM)
    if not MIN_CELL_MM <= cell <= MAX_CELL_MM:
        raise ValidationError(
            {"cell_mm": [f"Between {MIN_CELL_MM} and {MAX_CELL_MM} mm."]}
        )
    # The smallest cell that fits the longer side into MAX_GRID cells. The
    # small slack keeps a box the browser already snapped to whole cells at
    # the cell it was snapped to.
    need = math.ceil(max(width_m, height_m) * 1000.0 / MAX_GRID - 0.01)
    cell = max(cell, need)
    if cell > MAX_CELL_MM:
        span = MAX_GRID * MAX_CELL_MM / 1_000_000
        raise ValidationError(
            {"bbox": [f"The view is too large for a floor plan: zoom in to "
                      f"{span:g} km across or less."]}
        )
    gw = max(1, min(MAX_GRID, round(width_m * 1000.0 / cell)))
    gh = max(1, min(MAX_GRID, round(height_m * 1000.0 / cell)))
    return Frame(south, west, north, east, width_m, height_m, cell, gw, gh)


def _clean_bbox(raw) -> tuple[float, float, float, float]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip().startswith("[") else raw.split(",")
        except ValueError:
            raw = None
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        raise ValidationError({"bbox": ["[south, west, north, east] in degrees."]})
    try:
        vals = [float(v) for v in raw]
    except (TypeError, ValueError):
        raise ValidationError({"bbox": ["[south, west, north, east] in degrees."]}) from None
    if not all(math.isfinite(v) for v in vals):
        raise ValidationError({"bbox": ["[south, west, north, east] in degrees."]})
    south, west, north, east = vals
    if not (-MAX_LAT <= south < north <= MAX_LAT and -180 <= west < east <= 180):
        raise ValidationError({"bbox": ["South below north and west of east, on the map."]})
    return south, west, north, east


# ── outlines → areas ────────────────────────────────────────────────────────


def clip_to_grid(points, width: float, height: float) -> list[tuple[float, float]]:
    """``points`` (a closed ring, not repeated) clipped to the rectangle
    0..width × 0..height (Sutherland-Hodgman: the clip window is convex)."""

    def clip(pts, inside, cut):
        out = []
        n = len(pts)
        for i in range(n):
            cur, prev = pts[i], pts[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cut(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cut(prev, cur))
        return out

    def at_x(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))

    def at_y(y):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)

    pts = [(float(x), float(y)) for x, y in points]
    for inside, cut in (
        (lambda p: p[0] >= 0, at_x(0.0)),
        (lambda p: p[0] <= width, at_x(float(width))),
        (lambda p: p[1] >= 0, at_y(0.0)),
        (lambda p: p[1] <= height, at_y(float(height))),
    ):
        if not pts:
            break
        pts = clip(pts, inside, cut)
    return pts


def _tidy(pts) -> list[list[float]]:
    """Rounded to the areas' 3 decimals, with repeated and collinear points
    dropped."""
    out: list[list[float]] = []
    for x, y in pts:
        p = [round(x, 3), round(y, 3)]
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    changed = True
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, b, c = out[i - 1], out[i], out[(i + 1) % len(out)]
            if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-9:
                out.pop(i)
                changed = True
                break
    return out


def _simplify(pts: list[list[float]], limit: int) -> list[list[float]]:
    """Drop the points that matter least (smallest triangle with their
    neighbours) until at most ``limit`` remain."""
    pts = list(pts)
    while len(pts) > limit:
        n = len(pts)
        areas = [
            abs((pts[i][0] - pts[i - 1][0]) * (pts[(i + 1) % n][1] - pts[i - 1][1])
                - (pts[i][1] - pts[i - 1][1]) * (pts[(i + 1) % n][0] - pts[i - 1][0]))
            for i in range(n)
        ]
        pts.pop(areas.index(min(areas)))
    return pts


def outline_cells(points, fr: Frame) -> list[list[float]] | None:
    """An outline's ``[lat, lng]`` ring as area points in cells, clipped to
    the grid; None when nothing of it is inside."""
    ring = [fr.to_cells(lat, lng) for lat, lng in points]
    clipped = _tidy(clip_to_grid(ring, fr.grid_width, fr.grid_height))
    if len(clipped) < 3:
        return None
    if len(clipped) > MAX_AREA_POINTS:
        clipped = _simplify(clipped, MAX_AREA_POINTS)
    return clipped


# ── attribution and image ───────────────────────────────────────────────────

_TAG = re.compile(r"<[^>]*>")


def plain_attribution(raw: str) -> str:
    """A tile attribution as plain text: tags and entities resolved, the
    "Report a map issue" link (a link, not a credit) left out."""
    text = html.unescape(_TAG.sub("", raw or ""))
    parts = [" ".join(p.split()) for p in text.split("·")]
    parts = [p for p in parts if p and p.lower() != "report a map issue"]
    return " · ".join(parts)[:500]


def check_image(upload) -> str:
    """The extension for an uploaded background, after checking it is a PNG,
    JPEG or WebP no larger than the caps. Raises ``ValidationError``."""
    from PIL import Image

    if upload.size > MAX_IMAGE_BYTES:
        raise ValidationError({"background_image": [
            f"At most {MAX_IMAGE_BYTES // (1024 * 1024)} MB."
        ]})
    try:
        upload.seek(0)
        with Image.open(upload) as img:
            fmt = (img.format or "").upper()
            w, h = img.size
            if fmt not in IMAGE_FORMATS:
                raise ValidationError({"background_image": ["A PNG, JPEG or WebP image."]})
            if max(w, h) > MAX_IMAGE_EDGE or w * h > MAX_IMAGE_PIXELS:
                raise ValidationError({"background_image": [
                    f"At most {MAX_IMAGE_EDGE} px a side and "
                    f"{MAX_IMAGE_PIXELS // 1_000_000} megapixels."
                ]})
            img.verify()
    except ValidationError:
        raise
    except Exception:  # noqa: BLE001 - anything Pillow can't read is not an image
        raise ValidationError({"background_image": ["Not a readable image."]}) from None
    upload.seek(0)
    return IMAGE_FORMATS[fmt]


# ── the endpoint ────────────────────────────────────────────────────────────


def _visible_outlines(request, tenant, site):
    """The site's outlines the reader may view - none without the outline
    view grant - leaving out those linked to a location they may not view."""
    from django.db.models import Q

    user = request.user
    if not rbac.has_action(user, tenant, "sitemapoutline", "view"):
        return SiteMapOutline.objects.none()
    readable = rbac.restrict_queryset(
        Location.objects.filter(tenant=tenant), user, tenant, "location", "view"
    )
    qs = rbac.restrict_queryset(
        SiteMapOutline.objects.filter(tenant=tenant, site=site),
        user, tenant, "sitemapoutline", "view",
    )
    return (
        qs.filter(Q(location__isnull=True) | Q(location__in=readable.values("pk")))
        .select_related("location", "location__location_type")
        .order_by("z", "created_at", "pk")
    )


def create_from_map(view, request):
    """``POST /api/floor-plans/from-map/`` - see the module docstring and
    docs/features/floor-plans.md (Plans made from the Site map)."""
    from audit.context import cause

    from .serializers import FloorPlanAreaSerializer, FloorPlanSerializer
    from .site_map_views import effective_tiles
    from .topology_views import _uuid_param

    tenant = view._tenant_or_403()
    body = request.data
    name = body.get("name")
    name = name.strip() if isinstance(name, str) else ""
    if not name:
        raise ValidationError({"name": ["Name the floor plan."]})
    sid = _uuid_param({"site_id": body.get("site_id")}, "site_id") \
        if body.get("site_id") else None
    site = rbac.restrict_queryset(
        Site.objects.filter(tenant=tenant, pk=sid) if sid else Site.objects.none(),
        request.user, tenant, "site", "view",
    ).first()
    if site is None:
        raise ValidationError({"site_id": ["Pick a site."]})
    raw_cell = body.get("cell_mm")
    try:
        cell_mm = int(raw_cell) if raw_cell not in (None, "") else None
    except (TypeError, ValueError):
        raise ValidationError({"cell_mm": ["A whole number of millimetres."]}) from None
    fr = frame(body.get("bbox"), cell_mm)
    zoom = body.get("zoom")
    try:
        zoom = int(zoom) if zoom not in (None, "") else None
    except (TypeError, ValueError):
        raise ValidationError({"zoom": ["A whole number."]}) from None
    basemap = body.get("basemap") or "map"
    if basemap not in ("map", "sat"):
        raise ValidationError({"basemap": ["map or sat."]})

    upload = request.FILES.get("background_image")
    ext = check_image(upload) if upload is not None else None
    attribution = ""
    if upload is not None:
        tiles = effective_tiles()
        attribution = plain_attribution(
            tiles["satellite"]["attribution"] if basemap == "sat" else tiles["attribution"]
        )

    description = "Made from the Site map."
    if attribution:
        description += f" Background: {attribution}"
    plan_ser = FloorPlanSerializer(data={
        "name": name,
        "site_id": str(site.pk),
        "location_id": None,
        "grid_width": fr.grid_width,
        "grid_height": fr.grid_height,
        "cell_mm": fr.cell_mm,
        "description": description,
        "state": {"from_map": {
            "bbox": [fr.south, fr.west, fr.north, fr.east],
            "zoom": zoom,
            "basemap": basemap if upload is not None else None,
            "attribution": attribution,
        }},
    }, context=view.get_serializer_context())
    plan_ser.is_valid(raise_exception=True)

    created, skipped = 0, []
    with transaction.atomic(), cause("Made from the Site map"):
        plan = plan_ser.save(tenant=tenant)
        if not rbac.restrict_queryset(
            FloorPlan.objects.filter(pk=plan.pk), request.user, tenant, "floorplan", "add",
        ).exists():
            raise PermissionDenied(
                "The created or updated object is outside your permission scope."
            )
        if upload is not None:
            plan.background_image.save(f"site-map-{plan.pk.hex[:8]}.{ext}", upload, save=True)
        for z, outline in enumerate(_visible_outlines(request, tenant, site)):
            pts = outline_cells(outline.points, fr)
            if pts is None:
                continue
            label = outline.label or (outline.location.code if outline.location_id else "")
            area = FloorPlanAreaSerializer(data={
                "floor_plan_id": str(plan.pk),
                "shape": "polygon",
                "points": pts,
                "location_id": str(outline.location_id) if outline.location_id else None,
                "label": label[:64],
                "color": outline.display_color or "",
                "z": z,
            }, context=view.get_serializer_context())
            if area.is_valid():
                area.save()
                created += 1
            else:
                skipped.append(outline.display_label or str(outline.pk))
    plan = FloorPlan.objects.select_related("site", "location", "stack").get(pk=plan.pk)
    data = FloorPlanSerializer(plan, context=view.get_serializer_context()).data
    data["areas_created"] = created
    data["outlines_skipped"] = skipped
    return data


class FromMapRequestSerializer(serializers.Serializer):
    """The request, for the schema; the endpoint parses it itself (a
    multipart form carries ``bbox`` as text)."""

    name = serializers.CharField()
    site_id = serializers.UUIDField()
    bbox = serializers.CharField(help_text="[south, west, north, east] in degrees.")
    cell_mm = serializers.IntegerField(required=False)
    zoom = serializers.IntegerField(required=False)
    basemap = serializers.ChoiceField(choices=["map", "sat"], required=False)
    background_image = serializers.ImageField(required=False)
