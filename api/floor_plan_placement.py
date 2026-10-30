"""Floor plans P3: placing objects on a floor.

* ``placeable`` - the devices, racks and cabinets of a plan's site that the
  Place picker offers, ranked: those in the room (or location) near the
  pointer first, then those of the floor's location, then the rest of the
  site; each with where it is already placed.
* ``room_mismatches`` - placed objects whose tile stands in a room's area on
  this floor while the object names another room (or none). Rooms are never
  set from a placement; the editor offers the change and a write applies it.
* ``tile_photos`` - the photo a device or rack tile shows as its icon.
* ``version_conflicts`` - the per-object check behind a 409 on save.
"""
from __future__ import annotations

import math

from django.db.models import Case, Exists, IntegerField, OuterRef, Q, Value, When
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import ValidationError

from .models import (
    Cabinet,
    Device,
    FloorPlanTile,
    ImageAttachment,
    Location,
    Rack,
)
from .natural import natural

#: kind → (model, RBAC slug, the tile's link field)
PLACEABLE = {
    "device": (Device, "device", "device"),
    "rack": (Rack, "rack", "rack"),
    "cabinet": (Cabinet, "cabinet", "cabinet"),
}

#: Candidates one ``placeable`` call answers at most.
PLACEABLE_MAX = 200


def location_subtree(location) -> set:
    """``location`` and every location nested under it (one query)."""
    if location is None:
        return set()
    children: dict = {}
    for pk, parent in Location.objects.filter(site_id=location.site_id).values_list(
        "pk", "parent_id"
    ):
        children.setdefault(parent, []).append(pk)
    out, todo = set(), [location.pk]
    while todo:
        pk = todo.pop()
        if pk in out:
            continue
        out.add(pk)
        todo.extend(children.get(pk, ()))
    return out


def _ref(obj, *fields):
    if obj is None:
        return None
    return {"id": str(obj.pk), **{f: getattr(obj, f, "") for f in fields}}


def placeable(plan, user, tenant, *, q="", kinds=None, near_room=None,
              near_location=None, unplaced=False, limit=50, view=None):
    """Ranked placement candidates for ``plan``. ``rank`` is 0 for the near
    room (or near location and the locations inside it), 1 for the floor's
    location and the locations inside it, 2 for the rest of the site.
    ``unplaced`` keeps only objects of the floor's location (or its rooms)
    placed on no plan. A device in a rack or a cabinet is placed with it and
    never offered on its own. ``view`` - ``(source, crop)`` when ``plan`` is
    a live view: "this floor" is then the source's tiles inside the crop."""
    from auth_api import rbac

    site_id = plan.location.site_id
    floor_locs = location_subtree(plan.location)
    near_locs = (
        location_subtree(near_location)
        if near_location is not None and near_location.site_id == site_id
        else set()
    )
    if near_room is not None and near_room.location.site_id != site_id:
        near_room = None
    visible_plans = rbac.restrict_queryset(
        plan.__class__.objects.filter(tenant=tenant), user, tenant, "floorplan", "view"
    )
    rows = []
    for kind, (model, slug, link) in PLACEABLE.items():
        if kinds and kind not in kinds:
            continue
        qs = model.objects.filter(tenant=tenant, site_id=site_id)
        if kind == "device":
            qs = qs.filter(rack__isnull=True, cabinet__isnull=True)
        qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
        if q:
            qs = qs.filter(name__icontains=q)
        if unplaced:
            qs = qs.filter(
                Q(location_id__in=floor_locs) | Q(room__location_id__in=floor_locs)
            ).exclude(Exists(FloorPlanTile.objects.filter(**{link: OuterRef("pk")})))
        whens = []
        if near_room is not None:
            whens.append(When(room_id=near_room.pk, then=Value(0)))
        if near_locs:
            whens.append(When(location_id__in=near_locs, then=Value(0)))
        whens.append(When(location_id__in=floor_locs, then=Value(1)))
        qs = qs.annotate(
            rank=Case(*whens, default=Value(2), output_field=IntegerField())
        ).select_related("room", "location", "status", "role")
        if kind == "device":
            qs = qs.select_related("device_type")
        for obj in qs.order_by("rank", natural("name"), "pk")[:limit]:
            rows.append((kind, link, obj))
    rows.sort(key=lambda r: (r[2].rank, r[2].name.lower(), str(r[2].pk)))
    rows = rows[:limit]

    # Where each candidate already stands: one query per kind present.
    here_plan, here_tiles = plan.pk, None
    if view is not None:
        from .floor_plan_snapshots import in_crop

        src, crop = view
        here_plan = src.pk
        here_tiles = {t.pk for t, _e in in_crop("tiles", src.tiles.all(), crop)}
    placed: dict = {}
    for kind, (_model, _slug, link) in PLACEABLE.items():
        ids = [o.pk for k, _l, o in rows if k == kind]
        if not ids:
            continue
        tiles = FloorPlanTile.objects.filter(**{f"{link}_id__in": ids}).values_list(
            f"{link}_id", "id", "floor_plan_id", "floor_plan__name", "floor_plan__stack__name"
        )
        seen = set(visible_plans.filter(
            pk__in={t[2] for t in tiles}
        ).values_list("pk", flat=True))
        for obj_id, tile_id, plan_id, plan_name, stack_name in tiles:
            entry = placed.setdefault((kind, obj_id), {"count": 0, "on": []})
            entry["count"] += 1
            if plan_id in seen:
                entry["on"].append({
                    "floor_plan": {"id": str(plan_id), "name": plan_name,
                                   "stack": stack_name or ""},
                    "tile_id": str(tile_id),
                    "this_floor": plan_id == here_plan
                    and (here_tiles is None or tile_id in here_tiles),
                })
    photos = object_photos([(k, o) for k, _l, o in rows], user, tenant)
    out = []
    for kind, _link, obj in rows:
        where = placed.get((kind, obj.pk), {"count": 0, "on": []})
        out.append({
            "kind": kind,
            "id": str(obj.pk),
            "name": obj.name,
            "rank": obj.rank,
            "room": _ref(obj.room, "name", "code", "color"),
            "location": _ref(obj.location, "name"),
            "status": _ref(obj.status, "name", "color"),
            "role": _ref(obj.role, "name", "color", "icon"),
            "photo": photos.get((kind, obj.pk)),
            "placed_count": where["count"],
            "placed_on": where["on"],
        })
    return out


# ── Where a tile stands ────────────────────────────────────────────────────


def _in_polygon(px, py, pts) -> bool:
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            x = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < x:
                inside = not inside
    return inside


def area_contains(area, px, py) -> bool:
    """Whether the point (cells) lies in ``area`` - a rectangle turned about
    its centre, or a polygon."""
    if area.shape == "polygon":
        return len(area.points or []) >= 3 and _in_polygon(px, py, area.points)
    cx, cy = area.x + area.width / 2, area.y + area.height / 2
    a = math.radians(-(area.rotation or 0))
    dx, dy = px - cx, py - cy
    lx = dx * math.cos(a) - dy * math.sin(a)
    ly = dx * math.sin(a) + dy * math.cos(a)
    return abs(lx) <= area.width / 2 and abs(ly) <= area.height / 2


def room_area_at(areas, px, py):
    """The topmost area linked to a room that holds the point, or None.
    ``areas`` in draw order (z, then created)."""
    for area in reversed(areas):
        if area.room_id and area_contains(area, px, py):
            return area
    return None


def room_mismatches(plan, user, tenant):
    """Each placed device, rack or cabinet of ``plan`` whose tile centre lies
    in a room's area while the object names another room (or none):
    ``{kind, id, name, tile_id, room, area_room, can_change}``."""
    from auth_api import rbac

    areas = list(
        plan.areas.filter(room__isnull=False)
        .select_related("room")
        .order_by("z", "created_at", "id")
    )
    if not areas:
        return []
    tiles = plan.tiles.filter(
        Q(device__isnull=False) | Q(rack__isnull=False) | Q(cabinet__isnull=False)
    ).select_related("device__room", "rack__room", "cabinet__room").order_by("y", "x", "id")
    found = []  # (kind, obj, tile, area)
    for t in tiles:
        kind = "device" if t.device_id else "rack" if t.rack_id else "cabinet"
        obj = getattr(t, kind)
        area = room_area_at(areas, t.x + t.width / 2, t.y + t.height / 2)
        if area is None or obj.room_id == area.room_id:
            continue
        found.append((kind, obj, t, area))
    if not found:
        return []
    out = []
    seen = set()
    for kind, (model, slug, _link) in PLACEABLE.items():
        ids = {obj.pk for k, obj, _t, _a in found if k == kind}
        if not ids:
            continue
        viewable = set(rbac.restrict_queryset(
            model.objects.filter(tenant=tenant, pk__in=ids), user, tenant, slug, "view"
        ).values_list("pk", flat=True))
        changeable = set(rbac.restrict_queryset(
            model.objects.filter(tenant=tenant, pk__in=ids), user, tenant, slug, "change"
        ).values_list("pk", flat=True))
        for k, obj, tile, area in found:
            if k != kind or obj.pk not in viewable or (k, obj.pk) in seen:
                continue
            seen.add((k, obj.pk))
            out.append({
                "kind": k,
                "id": str(obj.pk),
                "name": obj.name,
                "tile_id": str(tile.pk),
                "room": _ref(obj.room, "name", "code", "color"),
                "area_room": _ref(area.room, "name", "code", "color"),
                "can_change": obj.pk in changeable,
            })
    out.sort(key=lambda r: (r["name"].lower(), r["id"]))
    return out


# ── Photos ─────────────────────────────────────────────────────────────────


def _url(field):
    if not field:
        return None
    try:
        return field.url
    except ValueError:
        return None


def object_photos(objects, user, tenant) -> dict:
    """``{(kind, pk): photo}`` for the devices and racks among ``objects``
    (``(kind, obj)`` pairs; a device with its ``device_type`` loaded) that
    have a photo the reader may see: the object's first image (its
    thumbnail), else - a device - its type's front image. ``photo`` is
    ``{url, aspect (height / width or null), source, width_mm}``."""
    from auth_api import rbac

    from .topology_enrich import _photo_sizes

    want: dict = {"device": {}, "rack": {}}
    for kind, obj in objects:
        if kind in want and obj is not None:
            want[kind][obj.pk] = obj
    out: dict = {}
    for kind, by_pk in want.items():
        if not by_pk:
            continue
        model, slug, _link = PLACEABLE[kind]
        visible = set(rbac.restrict_queryset(
            model.objects.filter(tenant=tenant, pk__in=list(by_pk)),
            user, tenant, slug, "view",
        ).values_list("pk", flat=True))
        if not visible:
            continue
        first: dict = {}
        for img in ImageAttachment.objects.filter(
            tenant=tenant,
            content_type__app_label=model._meta.app_label,
            content_type__model=model._meta.model_name,
            object_id__in=visible,
        ).order_by("sort_order", "created_at"):
            first.setdefault(img.object_id, img)
        types = {}
        if kind == "device":
            types = {
                o.device_type_id: o.device_type
                for pk, o in by_pk.items()
                if pk in visible and pk not in first and o.device_type_id
                and o.device_type.front_image
            }
        sizes = _photo_sizes(types.values()) if types else {}
        for pk, obj in by_pk.items():
            if pk not in visible:
                continue
            dt = obj.device_type if kind == "device" and obj.device_type_id else None
            width_mm = float(dt.width_mm) if dt is not None and dt.width_mm else None
            photo = None
            img = first.get(pk)
            if img is not None:
                url = _url(img.thumbnail) or _url(img.image)
                if url:
                    aspect = (
                        round(img.height / img.width, 6)
                        if img.width and img.height else None
                    )
                    photo = {"url": url, "aspect": aspect, "source": kind,
                             "width_mm": width_mm}
            elif dt is not None and dt.pk in sizes:
                url = _url(dt.front_image)
                size = sizes.get(dt.pk)
                if url:
                    photo = {"url": url, "aspect": size[0] if size else None,
                             "source": "type", "width_mm": width_mm}
            if photo:
                out[(kind, pk)] = photo
    return out


def tile_photos(tiles, user, tenant) -> dict:
    """``{tile id: photo}`` for the device and rack tiles among ``tiles``."""
    pairs = []
    for t in tiles:
        if t.device_id:
            pairs.append(("device", t.device))
        elif t.rack_id:
            pairs.append(("rack", t.rack))
    photos = object_photos(pairs, user, tenant)
    out = {}
    for t in tiles:
        key = ("device", t.device_id) if t.device_id else ("rack", t.rack_id)
        if key in photos:
            out[t.pk] = photos[key]
    return out


# ── Save conflicts ─────────────────────────────────────────────────────────


def parse_version(value, key="version"):
    """The ``updated_at`` an edit was based on, or None when not sent."""
    if value in (None, ""):
        return None
    stamp = parse_datetime(value) if isinstance(value, str) else None
    if stamp is None:
        raise ValidationError({key: "An updated_at timestamp."})
    return stamp


def changed_by(tenant, obj_id) -> str:
    """Who last changed the object, from the change log ('' when unknown)."""
    from audit.models import ChangeLogEntry

    entry = (
        ChangeLogEntry.objects.filter(tenant=tenant, object_id=str(obj_id))
        .order_by("-timestamp")
        .values_list("user_name", flat=True)
        .first()
    )
    return entry or ""
