"""Floor-plan snapshots: a rectangle of a plan as a plan of its own.

Two kinds (docs/features/floor-plans.md, "Snapshots"):

* An **independent copy** is an ordinary ``FloorPlan`` holding copies of the
  objects inside the crop, moved so the crop's corner is its origin. Objects
  that cross the crop's edge are clipped where their geometry allows it
  (axis-aligned unlinked tiles, raised floors, upright rectangles, polygons,
  walls and trays) and otherwise copied whole and reported. The raster
  background is cut with Pillow; a CAD drawing is copied and rendered again
  with ``cad_engine --clip`` through the usual RQ job.
* A **live view** (``kind="view"``) stores only its ``source`` and ``crop``.
  Every read of its contents is the source's objects inside the crop,
  translated; every write through it is translated back and applied to the
  source's rows - the same serializers, permissions, version checks and
  change log. Objects crossing the edge are shown (clipped by the canvas)
  but locked. There is one stored copy, so nothing ever needs syncing.

Coordinates: view cell ``(u, v)`` is source cell ``(u + crop.x, v + crop.y)``.
The crop is whole source cells. A view of a view is resolved to the root
source when it is made, so a view's source is never a view.
"""
from __future__ import annotations

import io
import math
import os
from dataclasses import dataclass

EPS = 1e-6

#: The contents kinds and the keys holding their coordinates.
XY_KINDS = ("tiles", "areas", "labels", "raised_floors")
POINT_KINDS = ("areas", "walls", "trays")


@dataclass(frozen=True)
class Crop:
    """A rectangle of whole source cells. ``w``/``h`` 0: nothing (a source
    that shrank past the view)."""

    x: int
    y: int
    w: int
    h: int

    @property
    def x2(self) -> int:
        return self.x + self.w

    @property
    def y2(self) -> int:
        return self.y + self.h

    @property
    def empty(self) -> bool:
        return self.w <= 0 or self.h <= 0

    def as_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


def _whole(v) -> int | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or not f.is_integer():
        return None
    return int(f)


def parse_crop(raw, grid_width: int, grid_height: int) -> Crop:
    """The crop a request asks for, checked: whole cells, at least one wide
    and high, inside the plan. ValueError with the reason otherwise."""
    if not isinstance(raw, dict):
        raise ValueError("A rectangle: x, y, w and h in cells.")
    vals = {k: _whole(raw.get(k)) for k in ("x", "y", "w", "h")}
    if any(v is None for v in vals.values()):
        raise ValueError("x, y, w and h must be whole cells.")
    c = Crop(**vals)
    if c.x < 0 or c.y < 0 or c.w < 1 or c.h < 1:
        raise ValueError("The rectangle must be at least one cell inside the plan.")
    if c.x2 > grid_width or c.y2 > grid_height:
        raise ValueError("The rectangle must lie inside the plan.")
    return c


def stored_crop(raw) -> Crop | None:
    if not isinstance(raw, dict):
        return None
    vals = {k: _whole(raw.get(k)) for k in ("x", "y", "w", "h")}
    if any(v is None for v in vals.values()):
        return None
    return Crop(**vals)


def effective_crop(view, source) -> Crop:
    """The view's crop, clamped to the source's grid as it is now."""
    c = stored_crop(view.crop) or Crop(0, 0, 0, 0)
    x2 = min(c.x2, source.grid_width)
    y2 = min(c.y2, source.grid_height)
    return Crop(c.x, c.y, max(0, x2 - c.x), max(0, y2 - c.y))


def is_view(plan) -> bool:
    return getattr(plan, "kind", "plan") == "view"


def resolve(plan):
    """``(source, crop)`` for a live view, ``(plan, None)`` for a plan - and
    for a view whose source is gone (it shows nothing of its own)."""
    if not is_view(plan) or plan.source_id is None:
        return plan, None
    src = plan.source
    return src, effective_crop(plan, src)


# ─── geometry ───────────────────────────────────────────────────────────────


def _turned_box(x, y, w, h, deg) -> tuple[float, float, float, float]:
    """The bounding box of an x/y/w/h rectangle turned ``deg`` about its
    centre."""
    if not deg or abs(math.remainder(deg, 180)) < EPS:
        return (x, y, x + w, y + h)
    r = math.radians(deg)
    c, s = abs(math.cos(r)), abs(math.sin(r))
    hw = (w * c + h * s) / 2
    hh = (w * s + h * c) / 2
    cx, cy = x + w / 2, y + h / 2
    return (cx - hw, cy - hh, cx + hw, cy + hh)


def tile_residual(orientation) -> float:
    """The turn a free tile is drawn with beyond its quarter turn
    (shapes.ts tileResidual)."""
    o = float(orientation or 0) % 360
    r = o - (round(o / 90) * 90) % 360
    if r > 180:
        r -= 360
    if r <= -180:
        r += 360
    return r


def tile_box(t):
    return _turned_box(t.x, t.y, t.width, t.height, tile_residual(t.orientation))


def area_box(a):
    if a.shape == "polygon" and a.points:
        return points_box(a.points)
    return _turned_box(a.x, a.y, a.width, a.height, a.rotation or 0)


def label_box(lb):
    w = lb.width or 0
    h = lb.height or 0
    if w or h:
        return _turned_box(lb.x, lb.y, w, h, lb.rotation or 0)
    return (lb.x, lb.y, lb.x, lb.y)


def raised_box(r):
    return (r.x, r.y, r.x + r.width, r.y + r.height)


def points_box(points):
    pts = _points(points)
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _points(points) -> list[tuple[float, float]]:
    out = []
    for p in points or []:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            out.append((x, y))
    return out


def classify_box(box, crop: Crop) -> str | None:
    """``"in"`` when the box lies inside the crop, ``"edge"`` when it
    crosses its edge, None when it is outside."""
    if box is None or crop.empty:
        return None
    x0, y0, x1, y1 = box
    if x0 >= crop.x - EPS and y0 >= crop.y - EPS and x1 <= crop.x2 + EPS \
            and y1 <= crop.y2 + EPS:
        return "in"
    if x0 < crop.x2 and x1 > crop.x and y0 < crop.y2 and y1 > crop.y:
        return "edge"
    return None


def clip_segment(p, q, crop: Crop):
    """Liang-Barsky: ``(t0, t1)`` of segment p→q inside the crop, or None."""
    x0, y0 = p
    dx, dy = q[0] - x0, q[1] - y0
    t0, t1 = 0.0, 1.0
    for pp, qq in ((-dx, x0 - crop.x), (dx, crop.x2 - x0),
                   (-dy, y0 - crop.y), (dy, crop.y2 - y0)):
        if abs(pp) < 1e-12:
            if qq < -EPS:
                return None
            continue
        t = qq / pp
        if pp < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1 + 1e-12:
            return None
    return t0, t1


def classify_line(points, crop: Crop) -> str | None:
    pts = _points(points)
    if not pts or crop.empty:
        return None
    if all(crop.x - EPS <= x <= crop.x2 + EPS and crop.y - EPS <= y <= crop.y2 + EPS
           for x, y in pts):
        return "in"
    for a, b in zip(pts, pts[1:], strict=False):
        t = clip_segment(a, b, crop)
        if t is not None:
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            if (t[1] - t[0]) * seg > EPS:
                return "edge"
    return None


def clip_polyline(points, crop: Crop) -> list[dict]:
    """The parts of a polyline inside the crop: ``[{"points": [...],
    "segs": [(orig_index, offset, length), ...]}]``, one per unbroken run.
    ``offset`` is how far into the original segment the run's segment starts
    (cell units); ``length`` its clipped length."""
    pts = _points(points)
    runs: list[dict] = []
    cur = None
    for i, (a, b) in enumerate(zip(pts, pts[1:], strict=False)):
        t = clip_segment(a, b, crop)
        seglen = math.hypot(b[0] - a[0], b[1] - a[1])
        if t is None or (t[1] - t[0]) * seglen <= EPS and seglen > EPS:
            cur = None
            continue
        t0, t1 = t
        start = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
        end = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
        if cur is None or t0 > EPS:
            cur = {"points": [start], "segs": []}
            runs.append(cur)
        cur["points"].append(end)
        cur["segs"].append((i, t0 * seglen, (t1 - t0) * seglen))
        if t1 < 1 - EPS:
            cur = None
    return [r for r in runs if len(r["points"]) >= 2]


def clip_polygon(points, crop: Crop) -> list[tuple[float, float]]:
    """Sutherland-Hodgman against the crop rectangle."""
    out = _points(points)
    edges = (
        (lambda p: p[0] >= crop.x, lambda a, b: _at_x(a, b, crop.x)),
        (lambda p: p[0] <= crop.x2, lambda a, b: _at_x(a, b, crop.x2)),
        (lambda p: p[1] >= crop.y, lambda a, b: _at_y(a, b, crop.y)),
        (lambda p: p[1] <= crop.y2, lambda a, b: _at_y(a, b, crop.y2)),
    )
    for inside, cut in edges:
        if not out:
            break
        src, out = out, []
        prev = src[-1]
        for p in src:
            if inside(p):
                if not inside(prev):
                    out.append(cut(prev, p))
                out.append(p)
            elif inside(prev):
                out.append(cut(prev, p))
            prev = p
    dedup: list[tuple[float, float]] = []
    for p in out:
        if not dedup or abs(p[0] - dedup[-1][0]) > EPS or abs(p[1] - dedup[-1][1]) > EPS:
            dedup.append(p)
    if len(dedup) > 1 and abs(dedup[0][0] - dedup[-1][0]) <= EPS \
            and abs(dedup[0][1] - dedup[-1][1]) <= EPS:
        dedup.pop()
    return dedup


def _at_x(a, b, x):
    t = (x - a[0]) / (b[0] - a[0])
    return (x, a[1] + (b[1] - a[1]) * t)


def _at_y(a, b, y):
    t = (y - a[1]) / (b[1] - a[1])
    return (a[0] + (b[0] - a[0]) * t, y)


def _r(v: float) -> float:
    return round(v, 6) + 0.0


# ─── translation of rows and payloads ───────────────────────────────────────


def _shift_points(points, dx, dy):
    out = []
    for p in points or []:
        if isinstance(p, (list, tuple)) and len(p) >= 2 and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) for v in p[:2]
        ):
            out.append([_r(p[0] + dx), _r(p[1] + dy), *p[2:]])
        else:
            out.append(p)
    return out


def shift(kind: str, row: dict, dx: float, dy: float) -> dict:
    """``row`` (a serialized row, or a write payload) moved by (dx, dy):
    its ``x``/``y`` and its ``points``, where it has them."""
    if not isinstance(row, dict):
        return row
    out = dict(row)
    if kind in XY_KINDS:
        for key, d in (("x", dx), ("y", dy)):
            v = out.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out[key] = _r(v + d)
    if kind in POINT_KINDS and isinstance(out.get("points"), list):
        out["points"] = _shift_points(out["points"], dx, dy)
    return out


#: The box (or line) of each contents kind, for classifying against a crop.
def classify(kind: str, obj, crop: Crop) -> str | None:
    if kind == "tiles":
        return classify_box(tile_box(obj), crop)
    if kind == "areas":
        return classify_box(area_box(obj), crop)
    if kind == "labels":
        return classify_box(label_box(obj), crop)
    if kind == "raised_floors":
        return classify_box(raised_box(obj), crop)
    return classify_line(obj.points, crop)


def in_crop(kind: str, objs, crop: Crop) -> list[tuple[object, bool]]:
    """The objects that show in a view: ``(obj, crosses_edge)``."""
    out = []
    for o in objs:
        c = classify(kind, o, crop)
        if c is not None:
            out.append((o, c == "edge"))
    return out


def view_data(kind: str, pairs, data: list[dict], crop: Crop) -> list[dict]:
    """Serialized rows of ``pairs`` in view coordinates, the ones crossing
    the edge marked ``crosses_edge``."""
    edge = {str(o.pk) for o, e in pairs if e}
    out = []
    for row in data:
        r = shift(kind, row, -crop.x, -crop.y)
        r["crosses_edge"] = str(row.get("id")) in edge
        out.append(r)
    return out


# ─── backgrounds ────────────────────────────────────────────────────────────


def crop_raster(src, dst, crop: Crop) -> bool:
    """Cut the source's background image to the crop onto ``dst``. The image
    is stretched over the grid, so the pixel box is the crop's share of it.
    False when there is none or it cannot be read (Pillow's decompression
    bomb guard stays on)."""
    from django.core.files.base import ContentFile
    from PIL import Image

    if not src.background_image:
        return False
    try:
        with src.background_image.open("rb") as fh:
            img = Image.open(fh)
            img.load()
    except Exception:  # noqa: BLE001 - an unreadable image is left out
        return False
    iw, ih = img.size
    gw, gh = max(1, src.grid_width), max(1, src.grid_height)
    left = int(math.floor(crop.x / gw * iw))
    top = int(math.floor(crop.y / gh * ih))
    right = max(left + 1, int(math.ceil(crop.x2 / gw * iw)))
    bottom = max(top + 1, int(math.ceil(crop.y2 / gh * ih)))
    out = img.crop((left, top, min(right, iw), min(bottom, ih)))
    fmt = (img.format or "PNG").upper()
    if fmt not in ("PNG", "JPEG", "WEBP", "GIF"):
        fmt = "PNG"
    if fmt == "JPEG" and out.mode not in ("RGB", "L"):
        out = out.convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format=fmt)
    ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}[fmt]
    base = os.path.splitext(os.path.basename(src.background_image.name))[0][:60]
    dst.background_image.save(f"{base}-crop{ext}", ContentFile(buf.getvalue()), save=False)
    return True


def _rot(x, y, deg):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return (x * c - y * s, x * s + y * c)


def drawing_clip(d, cell_mm: int, crop: Crop):
    """``(clip, placed_box_mm)`` for drawing ``d`` under ``crop``: the part
    of the drawing (drawing units, ``{min_x, min_y, max_x, max_y}``) the crop
    covers, and where that part sits on the source plan in mm (``{x, y,
    width, height}``). None when the drawing is not ready or misses the
    crop. The placement turns in quarter turns, so the part stays
    axis-aligned."""
    from . import cad_render

    ext = d.extents if isinstance(d.extents, dict) else None
    if d.status != "ready" or not ext or crop.empty:
        return None
    w, h = cad_render.size_units(d)
    s = d.mm_per_unit or 1.0
    box = cad_render.placed_box_mm(d)
    rot = int((d.placement or {}).get("rotation", 0) or 0)
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2

    def to_units(px, py):
        ux, uy = _rot((px - cx) / s, (py - cy) / s, -rot)
        sx, sy = ux + w / 2, uy + h / 2
        return sx + ext["min_x"], ext["max_y"] - sy

    def to_mm(x, y):
        sx, sy = x - ext["min_x"], ext["max_y"] - y
        rx, ry = _rot((sx - w / 2) * s, (sy - h / 2) * s, rot)
        return rx + cx, ry + cy

    corners = [to_units(px * cell_mm, py * cell_mm)
               for px in (crop.x, crop.x2) for py in (crop.y, crop.y2)]
    clip = {
        "min_x": max(ext["min_x"], min(c[0] for c in corners)),
        "min_y": max(ext["min_y"], min(c[1] for c in corners)),
        "max_x": min(ext["max_x"], max(c[0] for c in corners)),
        "max_y": min(ext["max_y"], max(c[1] for c in corners)),
    }
    if clip["max_x"] - clip["min_x"] <= 0 or clip["max_y"] - clip["min_y"] <= 0:
        return None
    placed = [to_mm(x, y) for x in (clip["min_x"], clip["max_x"])
              for y in (clip["min_y"], clip["max_y"])]
    x0 = min(p[0] for p in placed)
    y0 = min(p[1] for p in placed)
    return clip, {"x": x0, "y": y0, "width": max(p[0] for p in placed) - x0,
                  "height": max(p[1] for p in placed) - y0}


def copy_drawing(src, dst, crop: Crop) -> bool:
    """A copy of the source's CAD drawing on ``dst`` that renders only the
    crop's part (``clip``), placed where that part was. The file is copied
    (as Clone does) and the normal render job queued. A drawing not yet
    processed is copied whole, shifted, to be processed as it is. False when
    there is no drawing or it misses the crop."""
    from django.core.files.base import ContentFile

    from . import cad_render
    from .models import FloorPlanDrawing

    d = FloorPlanDrawing.objects.filter(floor_plan=src, tenant=src.tenant).first()
    if d is None or not d.source:
        return False
    cut = drawing_clip(d, src.cell_mm, crop)
    placement = dict(d.placement or {})
    if cut is not None:
        clip, placed = cut
        placement["x_mm"] = placed["x"] - crop.x * src.cell_mm
        placement["y_mm"] = placed["y"] - crop.y * src.cell_mm
    elif d.status == "ready":
        return False
    else:
        clip = None
        placement["x_mm"] = float(placement.get("x_mm", 0) or 0) - crop.x * src.cell_mm
        placement["y_mm"] = float(placement.get("y_mm", 0) or 0) - crop.y * src.cell_mm
    copy = FloorPlanDrawing(tenant=dst.tenant, floor_plan=dst)
    for f in FloorPlanDrawing._meta.concrete_fields:
        if f.name in ("id", "tenant", "floor_plan", "source", "rendered", "variants",
                      "created_at", "updated_at"):
            continue
        setattr(copy, f.attname, getattr(d, f.attname))
    copy.variants = {}
    copy.clip = clip
    copy.placement = placement
    copy.status = "queued"
    copy.error = ""
    copy.rendered_bytes = 0
    copy.rendered_elements = 0
    if clip is not None:
        copy.extents = clip
    with d.source.open("rb") as fh:
        copy.source.save(os.path.basename(d.source.name), ContentFile(fh.read()), save=False)
    copy.save()
    cad_render.enqueue(copy.pk, copy.source.name)
    return True


def view_drawing(view, src, crop: Crop, context: dict):
    """The drawing a live view shows: the source's, rendered for the crop's
    part only (a cached server render keyed by the clip and the source's
    render, so a new source file renders again), placed in the view's
    coordinates. None when the source has no drawing or it misses the crop."""
    from types import SimpleNamespace

    from django.core.files.storage import default_storage

    from . import cad_render
    from .models import FloorPlanDrawing
    from .serializers import FloorPlanDrawingSerializer

    d = FloorPlanDrawing.objects.filter(floor_plan=src, tenant=src.tenant).first()
    if d is None:
        return None
    d.floor_plan = src
    body = FloorPlanDrawingSerializer(d, context=context).data
    body["view_of"] = {"id": str(src.pk), "name": src.name}
    if d.status != "ready":
        return {**body, "rendered_url": None, "clip": None}
    cut = drawing_clip(d, src.cell_mm, crop)
    if cut is None:
        return None
    clip, placed = cut
    status, url, elements, error = "queued", None, 0, ""
    try:
        _key, entry, _queued = cad_render.request_variant(d, [], False, clip)
    except cad_render.TooManyRenders:
        entry = None
    if entry is not None:
        status = entry.get("status") or "queued"
        error = entry.get("error", "")
        elements = entry.get("elements", 0)
        if status == "ready" and entry.get("file"):
            url = default_storage.url(entry["file"])
    placement = {
        **(body.get("placement") or {}),
        "x_mm": placed["x"] - crop.x * src.cell_mm,
        "y_mm": placed["y"] - crop.y * src.cell_mm,
    }
    shim = SimpleNamespace(extents=clip, mm_per_unit=d.mm_per_unit, placement=placement)
    w, h = cad_render.size_units(shim)
    return {
        **body,
        "status": status,
        "error": error,
        "rendered_url": url,
        "rendered_elements": elements,
        "extents": clip,
        "clip": clip,
        "size": {"width": w, "height": h},
        "size_mm": {"width": w * d.mm_per_unit, "height": h * d.mm_per_unit},
        "placement": placement,
        "bounds_mm": cad_render.placed_box_mm(shim),
        "transform_mm": cad_render.transform_mm(shim),
        "fit": None,
    }


# ─── copying ────────────────────────────────────────────────────────────────


def _new(obj, plan, **changes):
    obj.pk = None
    obj.id = None
    obj._state.adding = True
    obj.floor_plan = plan
    for k, v in changes.items():
        setattr(obj, k, v)
    obj.save()
    return obj


def _name(obj) -> str:
    return str(obj)[:128]


def _clip_rect(x, y, w, h, crop: Crop):
    x0, y0 = max(x, crop.x), max(y, crop.y)
    x1, y1 = min(x + w, crop.x2), min(y + h, crop.y2)
    return x0, y0, x1 - x0, y1 - y0


def copy_contents(src, dst, crop: Crop) -> list[dict]:
    """Copy what the crop holds from ``src`` onto ``dst``, moved so the
    crop's corner is the origin. Objects crossing the edge are clipped where
    their geometry allows; the rest are copied whole and listed in the
    answer (``{"kind", "id", "name"}``, ids of the copies)."""
    from .models import FloorPlanTile

    dx, dy = -crop.x, -crop.y
    whole: list[dict] = []

    link_fields = list(FloorPlanTile.LINK_FIELDS.values())
    for t in src.tiles.select_related("tile_type").order_by("y", "x", "id"):
        c = classify("tiles", t, crop)
        if c is None:
            continue
        name = _name(t)
        if c == "edge" and tile_residual(t.orientation) == 0 \
                and not any(getattr(t, f"{f}_id") for f in link_fields):
            x, y, w, h = _clip_rect(t.x, t.y, t.width, t.height, crop)
            _new(t, dst, x=x + dx, y=y + dy, width=w, height=h)
            continue
        t = _new(t, dst, x=t.x + dx, y=t.y + dy)
        if c == "edge":
            whole.append({"kind": "tile", "id": str(t.pk), "name": name})

    for a in src.areas.order_by("z", "created_at", "id"):
        c = classify("areas", a, crop)
        if c is None:
            continue
        name = _name(a)
        if c == "in":
            _new(a, dst, x=a.x + dx, y=a.y + dy,
                 points=_shift_points(a.points, dx, dy) if a.points else a.points)
        elif a.shape == "polygon":
            pts = clip_polygon(a.points, crop)
            if len(pts) < 3:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            _new(a, dst, points=[[_r(x + dx), _r(y + dy)] for x, y in pts],
                 x=_r(min(xs) + dx), y=_r(min(ys) + dy),
                 width=_r(max(xs) - min(xs)), height=_r(max(ys) - min(ys)))
        elif abs(math.remainder(a.rotation or 0, 180)) < EPS:
            x, y, w, h = _clip_rect(a.x, a.y, a.width, a.height, crop)
            _new(a, dst, x=x + dx, y=y + dy, width=w, height=h)
        else:
            a = _new(a, dst, x=a.x + dx, y=a.y + dy)
            whole.append({"kind": "area", "id": str(a.pk), "name": name})

    for lb in src.labels.order_by("z", "created_at", "id"):
        c = classify("labels", lb, crop)
        if c is None:
            continue
        name = _name(lb)
        lb = _new(lb, dst, x=lb.x + dx, y=lb.y + dy)
        if c == "edge":
            whole.append({"kind": "label", "id": str(lb.pk), "name": name})

    for r in src.raised_floor_areas.order_by("y", "x", "id"):
        if classify("raised_floors", r, crop) is None:
            continue
        x, y, w, h = _clip_rect(r.x, r.y, r.width, r.height, crop)
        _new(r, dst, x=x + dx, y=y + dy, width=w, height=h)

    for wall in src.walls.order_by("label", "id"):
        c = classify("walls", wall, crop)
        if c is None:
            continue
        if c == "in":
            _new(wall, dst, points=_shift_points(wall.points, dx, dy))
            continue
        openings = [o for o in (wall.openings or []) if isinstance(o, dict)]
        for run in clip_polyline(wall.points, crop):
            kept = []
            for j, (seg, offset, length) in enumerate(run["segs"]):
                for o in openings:
                    if o.get("seg") != seg:
                        continue
                    try:
                        a, b = float(o.get("from")) - offset, float(o.get("to")) - offset
                    except (TypeError, ValueError):
                        continue
                    if a >= -EPS and b <= length + EPS:
                        kept.append({**o, "seg": j, "from": _r(max(a, 0)),
                                     "to": _r(min(b, length))})
            pts = [[_r(x + dx), _r(y + dy)] for x, y in run["points"]]
            _new(wall, dst, points=pts, openings=kept)

    for tray in src.trays.order_by("name", "id"):
        c = classify("trays", tray, crop)
        if c is None:
            continue
        if c == "in":
            _new(tray, dst, points=_shift_points(tray.points, dx, dy))
            continue
        runs = clip_polyline(tray.points, crop)
        base = tray.name
        for n, run in enumerate(runs, 1):
            name = base if n == 1 else f"{base} ({n})"[:64]
            pts = [[_r(x + dx), _r(y + dy)] for x, y in run["points"]]
            _new(tray, dst, points=pts, name=name)
    return whole


# ─── making, unlinking, deleting ────────────────────────────────────────────


def _blank_plan_fields(src, crop: Crop) -> dict:
    """What a snapshot takes from its source: the crop's size, the scale,
    the layout and the view preferences."""
    return {
        "grid_width": max(1, crop.w),
        "grid_height": max(1, crop.h),
        "cell_mm": src.cell_mm,
        "ceiling_mm": src.ceiling_mm,
        "layout_mode": src.layout_mode,
        "background_opacity": src.background_opacity,
        "state": dict(src.state or {}),
    }


def make_snapshot(src, crop: Crop, *, name: str, mode: str, stack=None):
    """``(plan, crossing)``: a new floor plan of ``crop`` of ``src`` - a live
    view (``mode="view"``) or an independent copy. ``stack`` None makes a
    floor plan of its own named ``name`` at the source's location (site-wide
    when the source is); else the snapshot is the stack's new top floor.
    Call inside a transaction."""
    from django.utils import timezone

    from .floor_stacks import location_error, next_order
    from .models import FloorPlan, FloorPlanStack

    if stack is None:
        stack = FloorPlanStack.objects.create(
            tenant_id=src.tenant_id, site_id=src.site_id, location_id=src.location_id,
            name=name,
        )
        order = 0
    else:
        order = next_order(stack)
    # The source's location, unless the target floor plan does not span it.
    location = src.location if location_error(src.location, stack) is None \
        else stack.location
    plan = FloorPlan(
        tenant_id=src.tenant_id, site_id=stack.site_id, location=location, name=name,
        stack=stack, floor_order=order,
        kind="view" if mode == "view" else "plan", source=src, crop=crop.as_dict(),
        snapshot_at=timezone.now(), **_blank_plan_fields(src, crop),
    )
    if mode != "view":
        crop_raster(src, plan, crop)
    plan.save()
    crossing: list[dict] = []
    if mode != "view":
        crossing = copy_contents(src, plan, crop)
        copy_drawing(src, plan, crop)
    return plan, crossing


def unlink(view) -> list[dict]:
    """Make a live view an independent copy of what it shows now, in place
    (same id, address and floor). Call inside a transaction."""
    src, crop = resolve(view)
    if crop is None or src is view:
        view.kind = "plan"
        view.save(update_fields=["kind", "updated_at"])
        return []
    for k, v in _blank_plan_fields(src, crop).items():
        if k != "state":
            setattr(view, k, v)
    view.kind = "plan"
    view.crop = crop.as_dict()
    crop_raster(src, view, crop)
    view.save()
    crossing = copy_contents(src, view, crop)
    copy_drawing(src, view, crop)
    return crossing


def views_of(plans):
    """The live views showing any of ``plans`` (other than those plans)."""
    from .models import FloorPlan

    ids = [p.pk for p in plans]
    return list(
        FloorPlan.objects.filter(kind="view", source_id__in=ids)
        .exclude(pk__in=ids).select_related("stack").order_by("name", "pk")
    )


def view_label(v) -> str:
    if v.stack_id and v.stack.name != v.name:
        return f"{v.stack.name} · {v.name}"
    return v.name


def refuse_while_viewed(plans) -> None:
    """A 409 naming the live views that still show one of ``plans``:
    deleting a source would leave them showing nothing. Unlink or delete
    them first."""
    from rest_framework.exceptions import APIException

    views = views_of(plans)
    if not views:
        return

    class InUse(APIException):
        status_code = 409
        default_code = "has_views"

    names = [view_label(v) for v in views]
    raise InUse({
        "detail": "Live views still show this plan: " + ", ".join(names)
                  + ". Unlink or delete them first.",
        "views": [{"id": str(v.pk), "name": n} for v, n in zip(views, names, strict=True)],
    })


def frame(view) -> None:
    """Give a live view (in memory, never saved) its source's grid at the
    crop's size, scale and layout - what it is drawn with."""
    src, crop = resolve(view)
    if crop is None:
        return
    view.grid_width = max(1, crop.w)
    view.grid_height = max(1, crop.h)
    view.cell_mm = src.cell_mm
    view.ceiling_mm = src.ceiling_mm
    view.layout_mode = src.layout_mode
    view.background_opacity = src.background_opacity


class _StoredFile:
    def __init__(self, name: str):
        self.name = name

    def __bool__(self) -> bool:
        return bool(self.name)

    def open(self, mode="rb"):
        from django.core.files.storage import default_storage

        return default_storage.open(self.name, mode)


def view_drawing_for_pdf(view):
    """A live view's rendered part of the drawing as ``floor_plan_pdf`` reads
    a drawing, once the server render exists; None until then."""
    from types import SimpleNamespace

    from . import cad_render
    from .models import FloorPlanDrawing

    src, crop = resolve(view)
    if crop is None:
        return None
    d = FloorPlanDrawing.objects.filter(floor_plan=src, tenant=src.tenant).first()
    if d is None:
        return None
    cut = drawing_clip(d, src.cell_mm, crop)
    if cut is None:
        return None
    clip, placed = cut
    entry = (d.variants or {}).get(cad_render.variant_key(d, [], False, clip)) or {}
    if entry.get("status") != "ready" or not entry.get("file"):
        return None
    placement = {
        **(d.placement or {}),
        "x_mm": placed["x"] - crop.x * src.cell_mm,
        "y_mm": placed["y"] - crop.y * src.cell_mm,
    }
    return SimpleNamespace(
        rendered=_StoredFile(entry["file"]), placement=placement, extents=clip,
        mm_per_unit=d.mm_per_unit, source_name=d.source_name, status="ready",
    )
