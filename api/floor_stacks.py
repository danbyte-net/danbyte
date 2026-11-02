"""Floors of a floor plan (floor plans P1a).

A ``FloorPlanStack`` is a floor plan as an operator sees it - a building or a
hall - and each ``FloorPlan`` in it is one floor, ordered by ``floor_order``.
These are the user actions on floors, shared by the API and the tests. None
of them runs on its own: nothing is grouped, merged or renamed unless someone
asks.

The rules:

* a floor plan names a site and, optionally, a location of it; a site-wide
  floor plan (no location) spans the whole site;
* a floor's site is its floor plan's; its location is the floor plan's
  location or a location nested under it (so floors may be modelled as
  Locations) - or, in a site-wide floor plan, any location of the site or
  none (a site-wide floor);
* a floor's name is unique inside its floor plan;
* moving a floor changes only its stack, order and - when it lies outside the
  target's location - its location; tiles, drawings and links stay;
* a floor plan left with no floors by a move, a merge or a delete goes too.

Every function takes rows the caller has already scoped to the tenant and to
the user's permissions; each checks that the rows share a tenant and a site.
"""
from __future__ import annotations

import math

from django.db import transaction
from django.db.models import Max
from rest_framework.exceptions import PermissionDenied, ValidationError

from .models import FloorPlan, FloorPlanStack, unique_stack_name

ORDER_STEP = 10


def ordered_floors(stack):
    return FloorPlan.objects.filter(stack=stack).order_by("floor_order", "name", "pk")


def within(location, root) -> bool:
    """Whether ``location`` is ``root`` or nested under it (same site)."""
    if location is None or root is None or location.site_id != root.site_id:
        return False
    seen = set()
    node = location
    while node is not None and node.pk not in seen:
        if node.pk == root.pk:
            return True
        seen.add(node.pk)
        node = node.parent
    return False


def in_scope(location, owner) -> bool:
    """Whether ``location`` lies in what ``owner`` (a floor plan or a floor)
    spans: its location and the locations inside it, or - with no location
    - any location of its site."""
    if location is None:
        return False
    if owner.location_id is not None:
        return within(location, owner.location)
    return location.site_id == owner.site_id


def location_error(location, stack) -> str | None:
    """Why ``location`` (None: the whole site) cannot be the location of a
    floor of ``stack``."""
    if location is None:
        if stack.location_id is not None:
            return f"Pick {stack.location.name} or a location inside it."
        return None
    if location.tenant_id != stack.tenant_id or location.site_id != stack.site_id:
        return f"Pick a location at {stack.site.name}."
    if not in_scope(location, stack):
        return f"Pick {stack.location.name} or a location inside it."
    return None


def name_clash(tenant_id, site_id, location_id, name, exclude=None) -> bool:
    """Whether a floor plan named ``name`` already exists at that location
    (or, with no location, among the site's site-wide floor plans)."""
    qs = FloorPlanStack.objects.filter(tenant_id=tenant_id, name=name)
    if location_id is not None:
        qs = qs.filter(location_id=location_id)
    else:
        qs = qs.filter(site_id=site_id, location__isnull=True)
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return qs.exists()


def clash_message(location_id) -> str:
    return ("This location already has a floor plan with that name."
            if location_id is not None
            else "This site already has a site-wide floor plan with that name.")


def next_order(stack, exclude=None) -> int:
    qs = FloorPlan.objects.filter(stack=stack)
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    top = qs.aggregate(m=Max("floor_order"))["m"]
    return 0 if top is None else top + ORDER_STEP


def name_taken(stack, name, exclude=None) -> bool:
    qs = FloorPlan.objects.filter(stack=stack, name=name)
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return qs.exists()


def drop_if_empty(stack) -> bool:
    """Delete ``stack`` when it has no floors left. True when it went."""
    if stack is None or FloorPlan.objects.filter(stack=stack).exists():
        return False
    FloorPlanStack.objects.filter(pk=stack.pk).delete()
    return True


def _renumber(floors, basements: int | None = None) -> None:
    """Give ``floors`` (in the wanted order) 0, 10, 20…, the first
    ``basements`` of them below zero (default: as many as lead the order
    with a negative ``floor_order`` now, so a ground floor stays 0); saves
    only the rows that change, one by one, so each change is in the change
    log."""
    if basements is None:
        basements = 0
        for plan in floors:
            if plan.floor_order is None or plan.floor_order >= 0:
                break
            basements += 1
    for i, plan in enumerate(floors):
        want = (i - basements) * ORDER_STEP
        if plan.floor_order != want:
            plan.floor_order = want
            plan.save(update_fields=["floor_order", "updated_at"])


# ─── aligned floors (building levels) ───────────────────────────────────────


def stack_elevations(floors) -> dict:
    """``{floor pk: elevation in mm}`` for ``floors`` (one stack's, in
    order, lowest first). A set ``elevation_mm`` is kept; the others are
    worked out from their neighbours: a storey is the floor below's ceiling
    plus this floor's slab. With none set, the lowest floor whose
    ``floor_order`` is 0 or more is at 0 (the ground), basements below it."""
    floors = list(floors)
    if not floors:
        return {}
    elev: list[int | None] = [
        int(f.elevation_mm) if f.elevation_mm is not None else None for f in floors
    ]
    if all(e is None for e in elev):
        ground = next((i for i, f in enumerate(floors) if (f.floor_order or 0) >= 0),
                      len(floors) - 1)
        elev[ground] = 0
    for i in range(1, len(floors)):
        if elev[i] is None and elev[i - 1] is not None:
            below = floors[i - 1]
            elev[i] = elev[i - 1] + int(below.ceiling_mm) + int(floors[i].slab_mm)
    for i in range(len(floors) - 2, -1, -1):
        if elev[i] is None and elev[i + 1] is not None:
            above = floors[i + 1]
            elev[i] = elev[i + 1] - int(above.slab_mm) - int(floors[i].ceiling_mm)
    return {f.pk: int(e or 0) for f, e in zip(floors, elev, strict=True)}


def floor_elevation(plan) -> int | None:
    """``plan``'s elevation: its own when set; on a floor of an aligned
    stack, computed from the floors of the stack; else None."""
    if plan.elevation_mm is not None:
        return int(plan.elevation_mm)
    stack = plan.stack if plan.stack_id else None
    if stack is None or not stack.aligned:
        return None
    return stack_elevations(ordered_floors(stack)).get(plan.pk)


def _hull(points):
    """The convex hull of ``points`` (``[(x, y)]``), counter-clockwise."""
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _seg_dist(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    n = dx * dx + dy * dy
    t = 0.0 if n == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / n))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


#: How far (cells) a wall point may sit off the outline and still be on it.
OUTER_TOLERANCE = 0.5


def outer_walls(walls) -> list:
    """The walls a new level takes with **Copy outer walls**: those marked
    ``exterior``; with none marked, those that run along the outline of the
    building - the convex hull of every wall point - with each vertex and
    each segment's midpoint within half a cell of it. A partition that
    meets the outline only at its ends is left out; so is a wall set back
    from the hull (the inside corner of an L-shaped building) - mark such
    walls exterior to have them copied."""
    walls = [w for w in walls if len(w.points or []) >= 2]
    marked = [w for w in walls if w.exterior]
    if marked:
        return marked
    pts = [(float(x), float(y)) for w in walls for x, y in w.points]
    hull = _hull(pts)
    if len(hull) < 3:
        return []
    edges = list(zip(hull, hull[1:] + hull[:1], strict=True))

    def on_hull(p) -> bool:
        return min(_seg_dist(p, a, b) for a, b in edges) <= OUTER_TOLERANCE

    out = []
    for w in walls:
        ps = [(float(x), float(y)) for x, y in w.points]
        mids = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(ps, ps[1:], strict=False)]
        if all(on_hull(p) for p in ps + mids):
            out.append(w)
    return out


def _copy_walls(src, dst) -> int:
    """Copy ``src``'s outer walls onto ``dst``, openings cleared, marked
    exterior. Answers how many."""
    from .models import FloorPlanWall

    n = 0
    for w in outer_walls(FloorPlanWall.objects.filter(floor_plan=src).order_by("label", "id")):
        FloorPlanWall.objects.create(
            floor_plan=dst, label=w.label, points=w.points, height_mm=None,
            thickness_mm=w.thickness_mm, color=w.color, openings=[], exterior=True,
        )
        n += 1
    return n


def _copy_background(src, dst) -> None:
    """``src``'s background picture and CAD drawing on ``dst``, whole."""
    from .floor_plan_snapshots import Crop, copy_drawing, crop_raster

    whole = Crop(0, 0, src.grid_width, src.grid_height)
    if src.background_image and crop_raster(src, dst, whole):
        dst.save(update_fields=["background_image", "updated_at"])
    copy_drawing(src, dst, whole)


def add_floor(stack, name: str, *, position: int | None = None, copy_from=None,
              below: bool = False, same_footprint: bool = False,
              copy_walls: bool = False, copy_background: bool = False):
    """A new, empty floor named ``name`` at ``position`` in the stack's order
    (0 = lowest; None = on top, or with ``below`` at the bottom - a
    basement, with a negative ``floor_order``). ``copy_from`` (a floor of
    the same stack) lends its grid size, scale, background opacity and
    layout mode.

    ``same_footprint`` (needs ``copy_from``) makes the stack aligned and the
    new floor a level of it: it also takes the geo anchor, slab and align
    offset, its elevation is left to be computed, and on request the outer
    walls (:func:`outer_walls`, openings cleared) and the background are
    copied. One transaction; every row is written through ``save()``, so
    each is in the change log."""
    name = (name or "").strip()
    if not name:
        raise ValidationError({"name": ["Name the floor."]})
    if len(name) > FloorPlan._meta.get_field("name").max_length:
        raise ValidationError({"name": ["At most 128 characters."]})
    if name_taken(stack, name):
        raise ValidationError(
            {"name": ["This floor plan already has a floor with that name."]}
        )
    if copy_from is not None and copy_from.stack_id != stack.pk:
        raise ValidationError({"copy_from": ["Pick a floor of this floor plan."]})
    if same_footprint and copy_from is None:
        raise ValidationError({"copy_from": ["Pick the floor whose footprint to share."]})
    if same_footprint and copy_from.kind == "view":
        raise ValidationError({"copy_from": ["A live view has no footprint of its own."]})
    with transaction.atomic():
        floors = list(ordered_floors(stack))
        if position is None and below and floors:
            order = min(f.floor_order for f in floors) - ORDER_STEP
        else:
            order = next_order(stack)
        plan = FloorPlan(
            tenant_id=stack.tenant_id, site_id=stack.site_id,
            location_id=stack.location_id, stack=stack,
            name=name, floor_order=order,
        )
        if copy_from is not None:
            for f in ("grid_width", "grid_height", "cell_mm", "ceiling_mm",
                      "background_opacity", "layout_mode"):
                setattr(plan, f, getattr(copy_from, f))
        if same_footprint:
            for f in ("slab_mm", "align_dx", "align_dy", "align_rot",
                      "geo_bbox", "geo_mpc", "geo_zoom", "geo_basemap"):
                setattr(plan, f, getattr(copy_from, f))
            plan.elevation_mm = None
        plan.save()
        if position is not None:
            position = max(0, min(int(position), len(floors)))
            basements = sum(1 for f in floors if f.floor_order < 0)
            floors.insert(position, plan)
            _renumber(floors, basements + (1 if below or position < basements else 0))
        if same_footprint:
            if not stack.aligned:
                stack.aligned = True
                stack.save(update_fields=["aligned", "updated_at"])
            if copy_walls:
                _copy_walls(copy_from, plan)
            if copy_background:
                _copy_background(copy_from, plan)
                if plan.geo_bbox and copy_from.geo_captured_at:
                    plan.geo_captured_at = copy_from.geo_captured_at
                    plan.save(update_fields=["geo_captured_at", "updated_at"])
    return plan


def reorder(stack, order: list) -> list:
    """Put the stack's floors in ``order`` (every floor id, once)."""
    floors = {str(p.pk): p for p in ordered_floors(stack)}
    ids = [str(x) for x in order or []]
    if len(ids) != len(set(ids)) or set(ids) != set(floors):
        raise ValidationError({"order": ["List every floor of this floor plan once."]})
    with transaction.atomic():
        _renumber([floors[i] for i in ids])
    return [floors[i] for i in ids]


def move_floor(plan, target):
    """Move ``plan`` to the top of floor plan ``target`` at the same site. A
    floor whose location lies outside the target's location takes the
    target's location (a site-wide target keeps the floor's location). The
    floor plan it leaves goes when it is empty."""
    if target.pk == plan.stack_id:
        raise ValidationError({"stack_id": ["The floor is already in that floor plan."]})
    if target.tenant_id != plan.tenant_id or target.site_id != plan.site_id:
        raise ValidationError({"stack_id": ["Pick a floor plan at the same site."]})
    if name_taken(target, plan.name):
        raise ValidationError({
            "name": [f"{target.name} already has a floor named {plan.name} - rename one first."]
        })
    source = plan.stack
    with transaction.atomic():
        plan.stack = target
        plan.floor_order = next_order(target)
        fields = ["stack", "floor_order", "updated_at"]
        if location_error(plan.location, target):
            plan.location = target.location
            fields.append("location")
        plan.save(update_fields=fields)
        drop_if_empty(source)
    return plan


def split_floor(plan, name: str | None = None):
    """Make ``plan`` a floor plan of its own, at its floor plan's location
    (site-wide when that is), named ``name`` (default: the floor's name,
    numbered when taken)."""
    source = plan.stack
    if source is None or FloorPlan.objects.filter(stack=source).count() < 2:
        raise ValidationError("This floor is already a floor plan of its own.")
    location_id, site_id = source.location_id, source.site_id
    name = (name or "").strip()
    if name:
        if name_clash(plan.tenant_id, site_id, location_id, name):
            raise ValidationError({"name": [clash_message(location_id)]})
    else:
        name = unique_stack_name(plan.tenant_id, location_id, plan.name, site_id=site_id)
    with transaction.atomic():
        stack = FloorPlanStack.objects.create(
            tenant_id=plan.tenant_id, site_id=site_id, location_id=location_id,
            name=name[:128],
        )
        plan.stack = stack
        plan.floor_order = 0
        plan.save(update_fields=["stack", "floor_order", "updated_at"])
    return stack


def merge_stacks(target, sources: list):
    """Move every floor of ``sources`` (in their order, after the target's
    floors) into ``target``, then delete the emptied sources. Refused when
    two floors would share a name; the clashes are listed."""
    sources = [s for s in sources if s.pk != target.pk]
    if not sources:
        raise ValidationError({"stacks": ["Pick at least one other floor plan."]})
    for s in sources:
        if s.tenant_id != target.tenant_id or s.site_id != target.site_id:
            raise ValidationError({"stacks": ["Pick floor plans at the same site."]})
    seen = set(FloorPlan.objects.filter(stack=target).values_list("name", flat=True))
    clashes = []
    moving = []
    for s in sources:
        for plan in ordered_floors(s):
            if plan.name in seen:
                clashes.append(f"{s.name} · {plan.name}")
            seen.add(plan.name)
            moving.append(plan)
    if clashes:
        raise ValidationError({
            "stacks": ["Floors with the same name - rename them first: " + ", ".join(clashes)],
            "clashes": clashes,
        })
    with transaction.atomic():
        order = next_order(target)
        for plan in moving:
            plan.stack = target
            plan.floor_order = order
            order += ORDER_STEP
            fields = ["stack", "floor_order", "updated_at"]
            if location_error(plan.location, target):
                plan.location = target.location
                fields.append("location")
            plan.save(update_fields=fields)
        for s in sources:
            drop_if_empty(s)
    return target


# ─── risers through levels ──────────────────────────────────────────────────


def _frame_to_level(fx_mm: float, fy_mm: float, plan) -> tuple[float, float]:
    """A point of the aligned frame (mm) in ``plan``'s cells."""
    cx, cy = plan.grid_width / 2, plan.grid_height / 2
    x = fx_mm / plan.cell_mm - cx - (plan.align_dx or 0)
    y = fy_mm / plan.cell_mm - cy - (plan.align_dy or 0)
    r = math.radians(-(plan.align_rot or 0))
    return x * math.cos(r) - y * math.sin(r) + cx, x * math.sin(r) + y * math.cos(r) + cy


def shaft_levels(tile) -> list[dict]:
    """The levels of ``tile``'s aligned floor plan (other than its own),
    each with the riser standing at its place there, or None:
    ``[{"floor": FloorPlan, "tile": FloorPlanTile | None}]``, lowest
    first."""
    from .cable_routing import shaft_risers

    plan = tile.floor_plan
    stack = plan.stack if plan.stack_id else None
    if stack is None or not stack.aligned:
        return []
    hits = shaft_risers(plan, [tile]).get(tile.pk, [])
    at = {}
    for h in hits:
        at.setdefault(h.floor_plan_id, h)
    return [
        {"floor": f, "tile": at.get(f.pk)}
        for f in ordered_floors(stack) if f.kind == "plan" and f.pk != plan.pk
    ]


def riser_through(tile, floor_ids, *, may_add, may_delete) -> list[dict]:
    """Make the riser ``tile`` reach exactly the levels ``floor_ids`` (of its
    aligned floor plan): a riser of the same type, size and label is placed
    at the same place on each level that has none, and on a level left out
    the riser standing there goes - when it is linked to nothing, else it
    only stops being a riser. ``may_add(plan)`` / ``may_delete(tile)`` are
    the caller's permission checks. Risers at one place pair on their own
    (cable_routing.shaft_risers). One transaction, each row saved (logged).
    Answers :func:`shaft_levels` after."""
    from .cable_routing import tile_frame_mm
    from .models import FloorPlanTile

    if not tile.riser:
        raise ValidationError({"riser": ["Tick Riser first."]})
    levels = shaft_levels(tile)
    if not levels:
        raise ValidationError({"floors": ["Only on a floor plan with aligned floors."]})
    by_id = {str(lv["floor"].pk): lv for lv in levels}
    want = {str(x) for x in floor_ids or []}
    unknown = want - set(by_id)
    if unknown:
        raise ValidationError({"floors": ["Pick levels of this floor plan."]})
    plan = tile.floor_plan
    fx, fy = tile_frame_mm(tile, plan)
    with transaction.atomic():
        for fid, lv in by_id.items():
            floor, there = lv["floor"], lv["tile"]
            if fid in want and there is None:
                if not tile.tile_type_id and not tile.role_type_id:
                    raise ValidationError(
                        {"floors": ["Give the riser a tile type first."]}
                    )
                if not may_add(floor):
                    raise PermissionDenied(f"You may not add tiles to {floor.name}.")
                turn = round(((floor.align_rot or 0) - (plan.align_rot or 0)) / 90) % 2
                scale = plan.cell_mm / floor.cell_mm
                w, h = tile.width * scale, tile.height * scale
                if turn:
                    w, h = h, w
                cx, cy = _frame_to_level(fx, fy, floor)
                x, y = cx - w / 2, cy - h / 2
                if floor.layout_mode == "grid":
                    w, h = max(1, round(w)), max(1, round(h))
                    x, y = round(cx - w / 2), round(cy - h / 2)
                x = max(0, min(x, floor.grid_width - w))
                y = max(0, min(y, floor.grid_height - h))
                FloorPlanTile.objects.create(
                    floor_plan=floor, x=x, y=y, width=w, height=h,
                    tile_type_id=tile.tile_type_id, role_type_id=tile.role_type_id,
                    label=tile.label, orientation=tile.orientation, riser=True,
                )
            elif fid not in want and there is not None:
                if not may_delete(there):
                    raise PermissionDenied(f"You may not remove the riser on {floor.name}.")
                linked = any(getattr(there, f + "_id") for f in FloorPlanTile.LINK_FIELDS.values())
                if linked:
                    there.riser = False
                    there.riser_to = None
                    there.save(update_fields=["riser", "riser_to", "updated_at"])
                else:
                    there.delete()
    return shaft_levels(FloorPlanTile.objects.select_related("floor_plan__stack").get(pk=tile.pk))
