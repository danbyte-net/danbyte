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

from django.db import transaction
from django.db.models import Max
from rest_framework.exceptions import ValidationError

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


def _renumber(floors) -> None:
    """Give ``floors`` (in the wanted order) 0, 10, 20…; saves only the rows
    that change, one by one, so each change is in the change log."""
    for i, plan in enumerate(floors):
        want = i * ORDER_STEP
        if plan.floor_order != want:
            plan.floor_order = want
            plan.save(update_fields=["floor_order", "updated_at"])


def add_floor(stack, name: str, *, position: int | None = None, copy_from=None):
    """A new, empty floor named ``name`` at ``position`` in the stack's order
    (0 = lowest; None = on top). ``copy_from`` (a floor of the same stack)
    lends its grid size, scale, background opacity and layout mode."""
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
    with transaction.atomic():
        plan = FloorPlan(
            tenant_id=stack.tenant_id, site_id=stack.site_id,
            location_id=stack.location_id, stack=stack,
            name=name, floor_order=next_order(stack),
        )
        if copy_from is not None:
            for f in ("grid_width", "grid_height", "cell_mm", "ceiling_mm",
                      "background_opacity", "layout_mode"):
                setattr(plan, f, getattr(copy_from, f))
        plan.save()
        if position is not None:
            floors = [p for p in ordered_floors(stack) if p.pk != plan.pk]
            position = max(0, min(int(position), len(floors)))
            floors.insert(position, plan)
            _renumber(floors)
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
