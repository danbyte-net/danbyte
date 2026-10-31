"""The geo anchor of a floor plan made from the Site map, and what it allows.

A plan made from the Site map (api/floor_plan_from_map.py) spans a box of
the map: ``geo_bbox`` [south, west, north, east] in degrees, mapped onto the
grid linearly in Web Mercator units, exactly as the background image is
stretched over it. With that tie stored the plan can:

* **Refresh its map** - the browser renders the same box from the current
  tiles and uploads it through ``POST background/`` with ``map_refresh=1``;
  only the background and ``geo_captured_at`` change.
* **Expand** - ``POST expand/`` with a larger box grows the grid in whole
  cells. Growing west or north moves every object on the plan by the cells
  added there, in one transaction, so each keeps its real-world place. The
  background is the browser's render of the new box when it could read the
  tiles, else the old image placed where it belongs on a larger canvas.
* **Re-import outlines** - ``POST import-outlines/`` offers (``dry_run``) and
  adds (``apply``) the site's map outlines inside the box that no area on
  the plan stands for yet.
* Place devices at their GPS position and show its footprint on the map.

The server never fetches map tiles (docs/features/site-map.md).
"""
from __future__ import annotations

import io
import math

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from rest_framework import status as drf_status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from auth_api import rbac

from .floor_plan_from_map import (
    MAX_GRID,
    MAX_IMAGE_EDGE,
    MAX_IMAGE_PIXELS,
    Frame,
    _clean_bbox,
    _visible_outlines,
    check_image,
    lat_of,
    merc_x,
    merc_y,
    metres_per_unit,
    outline_cells,
    plain_attribution,
)
from .models import FloorPlan

#: Slack, in cells, when a box is turned into whole cells.
SLACK = 0.01


def lng_of(mx: float) -> float:
    return mx * 360.0 - 180.0


def has_anchor(plan) -> bool:
    return getattr(plan, "kind", "plan") != "view" and isinstance(plan.geo_bbox, list) \
        and len(plan.geo_bbox) == 4


def geo_data(plan) -> dict | None:
    if not has_anchor(plan):
        return None
    fm = (plan.state or {}).get("from_map") if isinstance(plan.state, dict) else None
    return {
        "bbox": [float(v) for v in plan.geo_bbox],
        "mpc": plan.geo_mpc,
        "zoom": plan.geo_zoom,
        "basemap": plan.geo_basemap or None,
        "captured_at": plan.geo_captured_at.isoformat() if plan.geo_captured_at else None,
        "attribution": (fm or {}).get("attribution", "") if isinstance(fm, dict) else "",
    }


def plan_frame(plan) -> Frame:
    """The plan's box as the grid it has now."""
    s, w, n, e = (float(v) for v in plan.geo_bbox)
    per = metres_per_unit(s, n)
    return Frame(
        s, w, n, e,
        (merc_x(e) - merc_x(w)) * per, (merc_y(s) - merc_y(n)) * per,
        plan.cell_mm, plan.grid_width, plan.grid_height,
    )


def set_anchor(plan, bbox, *, zoom=None, basemap="", captured=False) -> None:
    """Store ``bbox`` as ``plan``'s anchor (not saved)."""
    s, w, n, e = bbox
    per = metres_per_unit(s, n)
    plan.geo_bbox = [s, w, n, e]
    plan.geo_mpc = (merc_x(e) - merc_x(w)) * per / max(1, plan.grid_width)
    if zoom is not None and 0 <= zoom <= 30:
        plan.geo_zoom = zoom
    plan.geo_basemap = basemap or ""
    if captured:
        plan.geo_captured_at = timezone.now()
    state = dict(plan.state or {})
    fm = dict(state.get("from_map") or {})
    fm["bbox"] = [s, w, n, e]
    if zoom is not None:
        fm["zoom"] = zoom
    if basemap:
        fm["basemap"] = basemap
    state["from_map"] = fm
    plan.state = state


def gps_cell(plan, lat, lng) -> tuple[float, float] | None:
    """Where ``lat``/``lng`` falls on ``plan``'s grid, in cells; None off
    the grid or for a plan with no anchor."""
    if not has_anchor(plan) or lat is None or lng is None:
        return None
    x, y = plan_frame(plan).to_cells(float(lat), float(lng))
    if not (0 <= x <= plan.grid_width and 0 <= y <= plan.grid_height):
        return None
    return round(x, 3), round(y, 3)


def footprint(plan) -> dict:
    s, w, n, e = (float(v) for v in plan.geo_bbox)
    return {
        "id": str(plan.pk),
        "name": plan.name,
        "stack": plan.stack.name if plan.stack_id else "",
        "site_id": str(plan.site_id) if plan.site_id else None,
        "bbox": [s, w, n, e],
    }


# ── parsing ────────────────────────────────────────────────────────────────


def _parse_zoom(raw):
    if raw in (None, ""):
        return None
    try:
        z = int(raw)
    except (TypeError, ValueError):
        raise ValidationError({"zoom": ["A whole number."]}) from None
    if not 0 <= z <= 30:
        raise ValidationError({"zoom": ["0 to 30."]})
    return z


def _parse_basemap(raw):
    basemap = raw or "map"
    if basemap not in ("map", "sat"):
        raise ValidationError({"basemap": ["map or sat."]})
    return basemap


def _attribution(basemap: str) -> str:
    from .site_map_views import effective_tiles

    tiles = effective_tiles()
    return plain_attribution(
        tiles["satellite"]["attribution"] if basemap == "sat" else tiles["attribution"]
    )


def _anchored(plan):
    from . import floor_plan_snapshots as snaps

    if snaps.is_view(plan):
        src = plan.source.name if plan.source_id else "its source"
        raise ValidationError({"detail": [
            f"This view shows {src}. Change the map there."
        ]})
    if not has_anchor(plan):
        raise ValidationError({"detail": ["This plan was not made from the Site map."]})


def _store_background(plan, upload, ext, basemap, zoom) -> None:
    plan.background_image.save(f"site-map-{plan.pk.hex[:8]}.{ext}", upload, save=False)
    plan.geo_basemap = basemap
    if zoom is not None:
        plan.geo_zoom = zoom
    plan.geo_captured_at = timezone.now()
    state = dict(plan.state or {})
    fm = dict(state.get("from_map") or {})
    fm.update({"basemap": basemap, "attribution": _attribution(basemap)})
    if zoom is not None:
        fm["zoom"] = zoom
    state["from_map"] = fm
    plan.state = state


# ── refresh ────────────────────────────────────────────────────────────────


def refresh_background(request, plan) -> FloorPlan:
    """``POST background/`` with ``map_refresh=1``: the browser's render of
    the plan's box from the current tiles as its new background - checked
    like a render for a new plan - and the capture date. Nothing drawn on
    the plan moves."""
    from audit.context import cause

    _anchored(plan)
    upload = request.FILES.get("background_image")
    if upload is None:
        raise ValidationError({"background_image": ["The rendered map."]})
    ext = check_image(upload)
    basemap = _parse_basemap(request.data.get("basemap"))
    zoom = _parse_zoom(request.data.get("zoom"))
    with transaction.atomic(), cause("Map refreshed from the Site map"):
        plan = FloorPlan.objects.select_for_update().get(pk=plan.pk)
        _store_background(plan, upload, ext, basemap, zoom)
        plan.save()
    return plan


# ── expand ─────────────────────────────────────────────────────────────────


def growth(plan, bbox) -> tuple[int, int, int, int, list[float]]:
    """``(left, top, right, bottom, snapped)``: the whole cells ``bbox``
    adds on each side of ``plan``'s box - the cells keep their size in
    Mercator units, so nothing already drawn is resampled - and the box
    grown by exactly those cells. ValidationError for a box that does not
    hold the plan's (shrinking is not supported)."""
    s, w, n, e = (float(v) for v in plan.geo_bbox)
    ns, nw, nn, ne = bbox
    x0, x1, y0, y1 = merc_x(w), merc_x(e), merc_y(n), merc_y(s)
    cx = (x1 - x0) / plan.grid_width
    cy = (y1 - y0) / plan.grid_height
    sides = (
        (x0 - merc_x(nw)) / cx,
        (y0 - merc_y(nn)) / cy,
        (merc_x(ne) - x1) / cx,
        (merc_y(ns) - y1) / cy,
    )
    if any(v < -SLACK - 0.5 for v in sides):
        raise ValidationError({"bbox": [
            "Expand only grows a plan: every side must stay where it is or move out."
        ]})
    left, top, right, bottom = (max(0, math.ceil(v - SLACK)) for v in sides)
    snapped = [
        lat_of(y1 + bottom * cy), lng_of(x0 - left * cx),
        lat_of(y0 - top * cy), lng_of(x1 + right * cx),
    ]
    return left, top, right, bottom, snapped


def _shift_pts(points, dx, dy):
    from .floor_plan_snapshots import _shift_points

    return _shift_points(points, dx, dy)


def _shift_legs(legs, dx, dy):
    def mv(p):
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            return [round(p[0] + dx, 6), round(p[1] + dy, 6), *p[2:]]
        return p

    out = []
    for leg in legs or []:
        if not isinstance(leg, dict):
            out.append(leg)
            continue
        leg = dict(leg)
        for side in ("from", "to"):
            end = leg.get(side)
            if isinstance(end, dict) and end.get("at") is not None:
                leg[side] = {**end, "at": mv(end["at"])}
        for key in ("points", "waypoints"):
            if isinstance(leg.get(key), list):
                leg[key] = [mv(p) for p in leg[key]]
        if isinstance(leg.get("trays"), list):
            leg["trays"] = [
                {**t, **{k: mv(t[k]) for k in ("entry", "exit") if t.get(k) is not None}}
                if isinstance(t, dict) else t
                for t in leg["trays"]
            ]
        out.append(leg)
    return out


def shift_contents(plan, dx: int, dy: int) -> dict:
    """Move everything drawn on ``plan`` by (dx, dy) cells, each row saved
    (and so logged) on its own: tiles (risers too), areas, labels (back
    labels and a view's own buttons included), walls with their doors,
    trays, raised floors, stored cable paths, a CAD drawing's placement and
    the crops of the live views showing the plan. Call inside a
    transaction. Answers the count of each kind moved."""
    from .models import FloorPlanCablePath, FloorPlanDrawing

    moved: dict[str, int] = {}
    if not dx and not dy:
        return moved
    # The stored paths are read before anything moves and saved last, with
    # the flag they had: moving their tiles and trays together is not a
    # change of route (the signals would mark them out of date).
    paths = list(FloorPlanCablePath.objects.filter(floor_plan=plan).order_by("pk"))
    for t in plan.tiles.all().order_by("pk"):
        t.x += dx
        t.y += dy
        t.save()
        moved["tiles"] = moved.get("tiles", 0) + 1
    for r in plan.raised_floor_areas.all().order_by("pk"):
        r.x += dx
        r.y += dy
        r.save()
        moved["raised_floors"] = moved.get("raised_floors", 0) + 1
    for a in plan.areas.all().order_by("pk"):
        a.x += dx
        a.y += dy
        if a.points:
            a.points = _shift_pts(a.points, dx, dy)
        a.save()
        moved["areas"] = moved.get("areas", 0) + 1
    for lb in plan.labels.all().order_by("pk"):
        lb.x += dx
        lb.y += dy
        lb.save()
        moved["labels"] = moved.get("labels", 0) + 1
    for rel, key in (("walls", "walls"), ("trays", "trays")):
        for row in getattr(plan, rel).all().order_by("pk"):
            row.points = _shift_pts(row.points, dx, dy)
            row.save()
            moved[key] = moved.get(key, 0) + 1
    for p in paths:
        p.legs = _shift_legs(p.legs, dx, dy)
        p.save()
        moved["cable_paths"] = moved.get("cable_paths", 0) + 1
    d = FloorPlanDrawing.objects.filter(floor_plan=plan).first()
    if d is not None:
        pl = dict(d.placement or {})
        pl["x_mm"] = float(pl.get("x_mm", 0) or 0) + dx * plan.cell_mm
        pl["y_mm"] = float(pl.get("y_mm", 0) or 0) + dy * plan.cell_mm
        d.placement = pl
        d.save()
        moved["drawing"] = 1
    for v in FloorPlan.objects.filter(source=plan, kind="view").order_by("pk"):
        c = v.crop
        if isinstance(c, dict) and all(isinstance(c.get(k), (int, float)) for k in "xy"):
            v.crop = {**c, "x": int(c["x"]) + dx, "y": int(c["y"]) + dy}
            v.save()
            moved["views"] = moved.get("views", 0) + 1
    return moved


def pad_background(plan, old_w: int, old_h: int, dx: int, dy: int) -> bool:
    """The old background on a canvas covering the grown grid, at the place
    its box now has in it - nothing fetched, the new margins left empty.
    False when there is no background or it can't be read."""
    from PIL import Image

    if not plan.background_image:
        return False
    try:
        with plan.background_image.open("rb") as f:
            img = Image.open(f)
            img.load()
    except Exception:  # noqa: BLE001 - a missing or unreadable file stays as it is
        return False
    jpeg = (img.format or "").upper() == "JPEG"
    w, h = img.size
    sx, sy = w / old_w, h / old_h
    big_w, big_h = plan.grid_width * sx, plan.grid_height * sy
    scale = min(1.0, MAX_IMAGE_EDGE / max(big_w, big_h),
                math.sqrt(MAX_IMAGE_PIXELS / (big_w * big_h)))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))))
        sx, sy = sx * scale, sy * scale
    mode, fill = ("RGB", (255, 255, 255)) if jpeg else ("RGBA", (0, 0, 0, 0))
    canvas = Image.new(mode, (max(1, round(plan.grid_width * sx)),
                              max(1, round(plan.grid_height * sy))), fill)
    canvas.paste(img.convert(mode), (round(dx * sx), round(dy * sy)))
    buf = io.BytesIO()
    canvas.save(buf, "JPEG" if jpeg else "PNG", **({"quality": 90} if jpeg else {}))
    ext = "jpg" if jpeg else "png"
    plan.background_image.save(
        f"site-map-{plan.pk.hex[:8]}.{ext}", ContentFile(buf.getvalue()), save=False
    )
    return True


def expand(view, request, plan):
    """``POST expand/``: ``{"bbox": [s, w, n, e], "version"?, "basemap"?,
    "zoom"?}`` and optionally ``background_image`` (multipart), the
    browser's render of the new box. See the module docstring."""
    from audit.context import cause

    from .floor_plan_placement import changed_by, parse_version
    from .serializers import FloorPlanSerializer

    _anchored(plan)
    body = request.data
    bbox = _clean_bbox(body.get("bbox"))
    stamp = parse_version(body.get("version"))
    upload = request.FILES.get("background_image")
    ext = check_image(upload) if upload is not None else None
    basemap = _parse_basemap(body.get("basemap") or plan.geo_basemap or "map")
    zoom = _parse_zoom(body.get("zoom"))
    tenant = view._tenant_or_403()

    with transaction.atomic():
        plan = FloorPlan.objects.select_for_update(of=("self",)).select_related(
            "site", "location", "stack"
        ).get(pk=plan.pk)
        if stamp is not None and stamp != plan.updated_at:
            return Response(
                {"detail": "Changed elsewhere since you opened the plan.",
                 "conflicts": [{
                     "kind": "plan", "id": str(plan.pk),
                     "current": FloorPlanSerializer(
                         plan, context=view.get_serializer_context()).data,
                     "changed_by": changed_by(tenant, plan.pk),
                 }]},
                status=drf_status.HTTP_409_CONFLICT,
            )
        left, top, right, bottom, snapped = growth(plan, bbox)
        if not (left or top or right or bottom):
            raise ValidationError({"bbox": ["Move an edge out to grow the plan."]})
        gw = plan.grid_width + left + right
        gh = plan.grid_height + top + bottom
        if gw > MAX_GRID or gh > MAX_GRID:
            span = MAX_GRID * plan.cell_mm / 1000
            raise ValidationError({"bbox": [
                f"That makes the plan {gw} × {gh} cells; a plan has at most "
                f"{MAX_GRID} a side, {span:g} m at {plan.cell_mm / 1000:g} m a cell. "
                "Expand less, or make a new plan from the Site map with larger cells."
            ]})
        old_w, old_h = plan.grid_width, plan.grid_height
        with cause(f"Expanded {plan.name} from the Site map"[:255]):
            moved = shift_contents(plan, left, top)
            plan.grid_width, plan.grid_height = gw, gh
            set_anchor(plan, snapped, basemap=plan.geo_basemap)
            if upload is not None:
                _store_background(plan, upload, ext, basemap, zoom)
                background = "rendered"
            else:
                background = "padded" if pad_background(plan, old_w, old_h, left, top) \
                    else "none"
            plan.save()
        if not rbac.restrict_queryset(
            FloorPlan.objects.filter(pk=plan.pk), request.user, tenant, "floorplan", "change",
        ).exists():
            raise PermissionDenied("You may not change this plan.")
    plan = FloorPlan.objects.select_related("site", "location", "stack").get(pk=plan.pk)
    data = FloorPlanSerializer(plan, context=view.get_serializer_context()).data
    data["expanded"] = {
        "left": left, "top": top, "right": right, "bottom": bottom,
        "moved": moved, "background": background,
    }
    return Response(data)


# ── re-import outlines ─────────────────────────────────────────────────────


def _close(a, b, tol=0.05) -> bool:
    if len(a) != len(b):
        return False
    return all(abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol for p, q in zip(a, b, strict=True))


def outline_candidates(request, tenant, plan) -> list[tuple[object, list]]:
    """The site's outlines inside the plan's box that no area on it stands
    for: one linked to a location no area on the plan is linked to, or an
    unlinked one no area of the same label or outline matches."""
    fr = plan_frame(plan)
    areas = list(plan.areas.only("location_id", "label", "points", "shape"))
    linked = {a.location_id for a in areas if a.location_id}
    labels = {a.label for a in areas if a.label and not a.location_id}
    shapes = [a.points for a in areas if a.shape == "polygon" and a.points]
    out = []
    for o in _visible_outlines(request, tenant, plan.site):
        if o.location_id and o.location_id in linked:
            continue
        pts = outline_cells(o.points, fr)
        if pts is None:
            continue
        if not o.location_id and (
            (o.label and o.label in labels) or any(_close(pts, s) for s in shapes)
        ):
            continue
        out.append((o, pts))
    return out


def add_outline_areas(view, plan, pairs, z0: int = 0) -> tuple[int, list[str]]:
    """Each ``(outline, points)`` as an area of ``plan`` linked to the
    outline's location, as the original import makes them."""
    from .serializers import FloorPlanAreaSerializer

    created, skipped = 0, []
    for i, (outline, pts) in enumerate(pairs):
        label = outline.label or (outline.location.code if outline.location_id else "")
        area = FloorPlanAreaSerializer(data={
            "floor_plan_id": str(plan.pk),
            "shape": "polygon",
            "points": pts,
            "location_id": str(outline.location_id) if outline.location_id else None,
            "label": label[:64],
            "color": outline.display_color or "",
            "z": z0 + i,
        }, context=view.get_serializer_context())
        if area.is_valid():
            area.save()
            created += 1
        else:
            skipped.append(outline.display_label or str(outline.pk))
    return created, skipped


def import_outlines(view, request, plan):
    """``POST import-outlines/``: ``{"dry_run": true}`` lists the outlines
    on offer (``{"outlines": [{id, label, location, color}]}``);
    ``{"apply": [outline ids]}`` adds those of them still on offer as areas
    and answers ``{"created", "skipped", "outlines"}``."""
    from django.db.models import Max

    from audit.context import cause

    _anchored(plan)
    tenant = view._tenant_or_403()

    def rows(pairs):
        return [{
            "id": str(o.pk),
            "label": o.display_label,
            "location": (
                {"id": str(o.location_id), "name": o.location.name}
                if o.location_id else None
            ),
            "color": o.display_color or "",
        } for o, _p in pairs]

    apply = request.data.get("apply") if hasattr(request.data, "get") else None
    if apply is None or request.data.get("dry_run") in (True, "true", "1", 1):
        return Response({"outlines": rows(outline_candidates(request, tenant, plan))})
    if not isinstance(apply, list):
        raise ValidationError({"apply": ["A list of outline ids."]})
    if not rbac.has_action(request.user, tenant, "floorplanarea", "add"):
        raise PermissionDenied("You may not add areas.")
    wanted = {str(v) for v in apply}
    with transaction.atomic(), cause(f"Outlines imported into {plan.name}"[:255]):
        pairs = [(o, p) for o, p in outline_candidates(request, tenant, plan)
                 if str(o.pk) in wanted]
        z0 = (plan.areas.aggregate(m=Max("z"))["m"] or 0) + 1
        created, skipped = add_outline_areas(view, plan, pairs, z0)
    return Response({
        "created": created,
        "skipped": skipped,
        "outlines": rows(outline_candidates(request, tenant, plan)),
    })
