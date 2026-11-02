"""A floor's two background layers.

Drawn in this order:

* **Base (map)** - a Site map snapshot at true scale (``FloorPlanMap``). The
  levels of one building (an aligned floor plan) share one row: the picture
  is stored once and belongs to the building. A level shares it when it is
  added with the same footprint, or when the map is made from any level.
  Every level at or above ground shows it; a basement (a level of an
  aligned floor plan below ground, ``floor_order`` < 0) does not, unless
  its ``map_shown`` says so. A floor that is not a level has a map of its
  own. In 3D the map lies on the ground level only.
* **Floor drawing** - the floor's own picture (``background_image``) or CAD
  drawing (``FloorPlanDrawing``), over the map. One or the other.

Each layer has an opacity (``map_opacity``; the picture's
``background_opacity`` or the drawing's ``placement.opacity``) and a
visibility switch (``map_shown``; ``background_shown``).

The server never fetches tiles: the browser renders the map box from the
tile server and uploads it (docs/features/site-map.md). The map's capture
date, basemap and zoom are mirrored onto each floor's ``geo_*`` fields, which
the ``geo`` read and older clients use.
"""
from __future__ import annotations

import math

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .models import FloorPlan, FloorPlanMap

#: How far a box may be from the grid's real size (fraction) and still be
#: taken as its frame.
FRAME_TOLERANCE = 0.02


# ── reading ────────────────────────────────────────────────────────────────


def _aligned(plan) -> bool:
    return bool(plan.stack_id and plan.stack.aligned)


def is_basement(plan) -> bool:
    """A level below ground of an aligned floor plan."""
    return _aligned(plan) and (plan.floor_order or 0) < 0


def map_visible(plan) -> bool:
    """Whether ``plan`` draws its base map: one set by hand wins; else
    every floor but a basement."""
    if not plan.base_map_id:
        return False
    if plan.map_shown is not None:
        return bool(plan.map_shown)
    return not is_basement(plan)


def is_ground(plan) -> bool:
    """The ground level of an aligned floor plan - the lowest floor with an
    order of 0 or more (as ``floor_stacks.stack_elevations`` has it) - or
    any floor that is not a level."""
    if not _aligned(plan):
        return True
    floors = list(
        FloorPlan.objects.filter(stack_id=plan.stack_id, kind="plan")
        .order_by("floor_order", "name", "pk").values_list("pk", "floor_order")
    )
    if not floors:
        return True
    ground = next((pk for pk, order in floors if (order or 0) >= 0), floors[-1][0])
    return ground == plan.pk


def map_in_3d(plan) -> bool:
    """The 3D room lays the map on the ground level only, never on a
    basement's slab."""
    return map_visible(plan) and not is_basement(plan) and is_ground(plan)


def _url(f) -> str | None:
    if not f:
        return None
    try:
        return f.url
    except ValueError:
        return None


def map_data(plan, source=None, *, count: bool = True) -> dict | None:
    """The base map as the plan reads it, or None. ``source`` is the plan
    whose map a live view shows."""
    owner = source or plan
    if not owner.base_map_id:
        return None
    m = owner.base_map
    return {
        "id": str(m.pk),
        "image": _url(m.image),
        "bbox": [float(v) for v in m.bbox] if isinstance(m.bbox, list) else None,
        "zoom": m.zoom,
        "basemap": m.basemap,
        "attribution": m.attribution,
        "captured_at": m.captured_at.isoformat() if m.captured_at else None,
        # Floors drawing it: more than one on a building's levels.
        "floors": m.floors.count() if count else None,
    }


# ── writing ────────────────────────────────────────────────────────────────


def _mirror(row) -> None:
    """The map's date, basemap and zoom on each floor over it (the ``geo``
    read). Saved one by one, so each floor's change log shows the map
    changed under it (the map row is logged too)."""
    for f in FloorPlan.objects.filter(base_map=row).order_by("pk"):
        f.geo_captured_at, f.geo_basemap, f.geo_zoom = row.captured_at, row.basemap, row.zoom
        f.save(update_fields=["geo_captured_at", "geo_basemap", "geo_zoom", "updated_at"])


def _delete_file(name: str) -> None:
    if not name:
        return
    from django.core.files.storage import default_storage

    def go():
        try:
            default_storage.delete(name)
        except OSError:
            pass

    transaction.on_commit(go)


def levels_for_map(plan) -> list:
    """The floors a map made on ``plan`` lies under: ``plan``, and on an
    aligned floor plan every other level of the same grid and scale that
    has no other map - the building's footprint. Live views draw their
    source's."""
    if not _aligned(plan):
        return [plan]
    qs = FloorPlan.objects.filter(
        stack_id=plan.stack_id, kind="plan", grid_width=plan.grid_width,
        grid_height=plan.grid_height, cell_mm=plan.cell_mm,
    ).exclude(pk=plan.pk)
    if plan.base_map_id:
        qs = qs.filter(base_map__isnull=True) | qs.filter(base_map_id=plan.base_map_id)
    else:
        qs = qs.filter(base_map__isnull=True)
    return [plan, *qs.order_by("floor_order", "pk")]


def store_map(plan, upload, ext: str, *, basemap: str, zoom, attribution: str):
    """The browser's render of ``plan``'s geo box as its base map: the
    picture of the map it has (shared by the building's levels, so each of
    them gets it) or a new map under it and the levels of its building
    that have none. Call inside a transaction, after the anchor is set.
    Answers the map."""
    row = plan.base_map if plan.base_map_id else None
    old = row.image.name if row is not None and row.image else ""
    if row is None:
        row = FloorPlanMap(tenant_id=plan.tenant_id, site_id=plan.site_id)
    row.bbox = [float(v) for v in plan.geo_bbox]
    row.basemap = basemap
    if zoom is not None:
        row.zoom = zoom
    row.attribution = (attribution or "")[:512]
    row.captured_at = timezone.now()
    row.image.save(f"site-map.{ext}", upload, save=False)
    row.save()
    if old and old != row.image.name:
        _delete_file(old)
    if not plan.base_map_id:
        for f in levels_for_map(plan):
            if f.pk != plan.pk and not f.geo_bbox:
                # A level of the building with no tie to the map yet takes
                # this level's.
                f.geo_bbox, f.geo_mpc = plan.geo_bbox, plan.geo_mpc
                f.save(update_fields=["geo_bbox", "geo_mpc", "updated_at"])
            if f.pk != plan.pk and _key(f.geo_bbox) != _key(plan.geo_bbox):
                continue
            f.base_map = row
            f.save(update_fields=["base_map", "updated_at"])
        plan.base_map = row
    _mirror(row)
    plan.refresh_from_db(fields=["geo_captured_at", "geo_basemap", "geo_zoom"])
    return row


def _key(bbox):
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    return tuple(round(float(v), 9) for v in bbox)


def detach_map(plan) -> None:
    """Give ``plan`` a map of its own when it shares one - before its box
    changes (Expand) - by copying the picture. Call inside a transaction."""
    from django.core.files.base import ContentFile

    if not plan.base_map_id:
        return
    row = plan.base_map
    if not row.floors.exclude(pk=plan.pk).exists():
        return
    try:
        with row.image.open("rb") as fh:
            data = fh.read()
    except OSError:
        plan.base_map = None
        return
    copy = FloorPlanMap(
        tenant_id=row.tenant_id, site_id=row.site_id, bbox=row.bbox, zoom=row.zoom,
        basemap=row.basemap, attribution=row.attribution, captured_at=row.captured_at,
    )
    ext = (row.image.name.rsplit(".", 1)[-1] or "png")[:5]
    copy.image.save(f"site-map.{ext}", ContentFile(data), save=False)
    copy.save()
    plan.base_map = copy


def copy_map(src, dst, crop=None) -> None:
    """``src``'s map as a map of ``dst``'s own (a clone or a snapshot copy),
    cut to ``crop`` (whole cells of ``src``) when given. Not saved."""
    import io

    from django.core.files.base import ContentFile
    from PIL import Image

    if not src.base_map_id or not src.base_map.image:
        return
    row = src.base_map
    try:
        with row.image.open("rb") as fh:
            raw = fh.read()
    except OSError:
        return
    bbox = row.bbox
    ext = (row.image.name.rsplit(".", 1)[-1] or "png").lower()[:5]
    if crop is not None:
        try:
            img = Image.open(io.BytesIO(raw))
            img.load()
        except Exception:  # noqa: BLE001 - an unreadable map is left out
            return
        iw, ih = img.size
        gw, gh = max(1, src.grid_width), max(1, src.grid_height)
        left = int(math.floor(crop.x / gw * iw))
        top = int(math.floor(crop.y / gh * ih))
        right = min(iw, max(left + 1, int(math.ceil(crop.x2 / gw * iw))))
        bottom = min(ih, max(top + 1, int(math.ceil(crop.y2 / gh * ih))))
        out = img.crop((left, top, right, bottom))
        fmt = "JPEG" if (img.format or "").upper() == "JPEG" else "PNG"
        if fmt == "JPEG" and out.mode not in ("RGB", "L"):
            out = out.convert("RGB")
        buf = io.BytesIO()
        out.save(buf, format=fmt, **({"quality": 90} if fmt == "JPEG" else {}))
        raw = buf.getvalue()
        ext = "jpg" if fmt == "JPEG" else "png"
        bbox = _crop_bbox(src, crop) or bbox
    copy = FloorPlanMap(
        tenant_id=row.tenant_id, site_id=dst.site_id or row.site_id, bbox=bbox,
        zoom=row.zoom, basemap=row.basemap, attribution=row.attribution,
        captured_at=row.captured_at,
    )
    copy.image.save(f"site-map.{ext}", ContentFile(raw), save=False)
    copy.save()
    dst.base_map = copy
    dst.map_opacity = src.map_opacity
    dst.map_shown = src.map_shown


def _crop_bbox(src, crop):
    """The box of ``crop`` of ``src``'s grid, when it has a geo anchor."""
    from .floor_plan_from_map import lat_of, merc_x, merc_y
    from .floor_plan_geo import has_anchor, lng_of

    if not has_anchor(src):
        return None
    s, w, n, e = (float(v) for v in src.geo_bbox)
    x0, x1, y0, y1 = merc_x(w), merc_x(e), merc_y(n), merc_y(s)
    cx = (x1 - x0) / max(1, src.grid_width)
    cy = (y1 - y0) / max(1, src.grid_height)
    return [
        lat_of(y0 + crop.y2 * cy), lng_of(x0 + crop.x * cx),
        lat_of(y0 + crop.y * cy), lng_of(x0 + crop.x2 * cx),
    ]


def _unanchor(floor_ids) -> None:
    """Untie each floor from the map: no geo anchor, so the next From site
    map frames it anew. The old box stays in ``state.from_map.bbox`` - only
    where the dialog opens, never a lock."""
    for f in FloorPlan.objects.filter(pk__in=list(floor_ids)).order_by("pk"):
        f.geo_bbox = f.geo_mpc = f.geo_zoom = f.geo_captured_at = None
        f.geo_basemap = ""
        f.save(update_fields=["geo_bbox", "geo_mpc", "geo_zoom", "geo_captured_at",
                              "geo_basemap", "updated_at"])


def remove_map(plan) -> None:
    """Take the map away - from every floor it lies under (one building's
    map is one map) - and delete its picture. The geo anchor of each of
    those floors goes too. Call inside a transaction."""
    if not plan.base_map_id:
        return
    row = plan.base_map
    ids = list(row.floors.values_list("pk", flat=True))
    # Its picture goes with it (api/signals.py).
    row.delete()
    _unanchor(ids)
    plan.base_map = None
    plan.refresh_from_db(fields=["geo_bbox", "geo_mpc", "geo_zoom", "geo_captured_at",
                                 "geo_basemap", "base_map"])


def drop_orphan(map_id) -> None:
    """Delete a map no floor lies over any more, with its picture."""
    if map_id is None:
        return
    row = FloorPlanMap.objects.filter(pk=map_id).first()
    if row is None or row.floors.exists():
        return
    row.delete()


# ── framing a plan that has no anchor ──────────────────────────────────────


def check_frame(plan, bbox, cells=None) -> None:
    """A box given to anchor ``plan`` must be the grid's real size - its
    cells at ``cell_mm`` - give or take :data:`FRAME_TOLERANCE`. ``cells``
    (width, height) is the size the grid grows to with it, if larger."""
    from .floor_plan_from_map import merc_x, merc_y, metres_per_unit

    s, w, n, e = bbox
    per = metres_per_unit(s, n)
    width_m = (merc_x(e) - merc_x(w)) * per
    height_m = (merc_y(s) - merc_y(n)) * per
    gw, gh = cells or (plan.grid_width, plan.grid_height)
    want_w = gw * plan.cell_mm / 1000
    want_h = gh * plan.cell_mm / 1000
    if abs(width_m - want_w) > want_w * FRAME_TOLERANCE or \
            abs(height_m - want_h) > want_h * FRAME_TOLERANCE:
        raise ValidationError({"bbox": [
            f"Frame {want_w:g} × {want_h:g} m: the grid at its cell size."
        ]})
