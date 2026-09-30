"""The per-row VLAN rules the edit form enforces, for the VLAN bulk update.

A bulk update writes with one ``UPDATE``, so the serializer never sees the
rows. Two of its rules matter once a selection moves (#176):

* a VLAN group only takes VIDs inside its range, and
* the VID namespace is the group, else the site (#159) - a move must not
  repeat a VID there, against the rest of the tenant or within the selection.

The database refuses a repeat too, but as a bare 409; these name the VIDs and
the place, so the operator can see which rows to leave out.
"""
from __future__ import annotations

import uuid
from collections import Counter, defaultdict

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework.exceptions import ValidationError

from api.models import VLAN, Site, VLANGroup


def resolve_fenced(request, tenant, model, pk, field: str):
    """The row a bulk update's ``field`` names, looked up the way the edit
    form's field is: in the active tenant, behind the site fence - so under
    enhanced site separation a site-scoped user can't set another site's local
    VRF, zone or status. ``None`` for an empty value (a clear)."""
    if not pk:
        return None
    from api.serializers import _site_fence

    qs = _site_fence(model.objects.filter(tenant=tenant), request, tenant)
    try:
        return qs.get(pk=pk)
    except (model.DoesNotExist, DjangoValidationError, ValueError, TypeError):
        raise ValidationError({field: "Not found in this tenant."}) from None


def resolve_group(request, tenant, pk) -> VLANGroup | None:
    """The target group of a bulk move. ``None`` (or an empty value) takes
    the VLANs out of their group."""
    return resolve_fenced(request, tenant, VLANGroup, pk, "group_id")


def _vids(vids) -> str:
    vids = sorted(vids)
    return f"VLAN {vids[0]}" if len(vids) == 1 else "VLANs " + ", ".join(map(str, vids))


def _are(vids) -> str:
    return "is" if len(vids) == 1 else "are"


def check_vlan_moves(rows, updates: dict, group: VLANGroup | None, tenant) -> None:
    """Raise a field error when writing ``updates`` to ``rows`` would break
    the group range or repeat a VID in its namespace."""
    moving_group = "group_id" in updates
    if not moving_group and "site_id" not in updates:
        return
    field = "group_id" if moving_group else "site_id"

    if group is not None:
        outside = {v.vlan_id for v in rows if not group.min_vid <= v.vlan_id <= group.max_vid}
        if outside:
            raise ValidationError({"group_id": (
                f"{_vids(outside)} {_are(outside)} outside {group.name}'s range "
                f"({group.min_vid}–{group.max_vid})."
            )})

    def ref(value):
        # One spelling for a UUID, whether it came off a row or a payload.
        return str(uuid.UUID(str(value))) if value else None

    def space(v):
        gid = ref(updates["group_id"]) if moving_group else ref(v.group_id)
        if gid:
            return ("group", gid)
        return ("site", ref(updates["site_id"]) if "site_id" in updates else ref(v.site_id))

    # Every selected row lands somewhere; only a place a row actually moved
    # into can gain a repeat - the rest already satisfy the constraint.
    landed = defaultdict(list)
    moved_into = set()
    for v in rows:
        where = space(v)
        landed[where].append(v.vlan_id)
        before = ("group", ref(v.group_id)) if v.group_id else ("site", ref(v.site_id))
        if where != before:
            moved_into.add(where)

    selected = [v.pk for v in rows]
    clashes = {}
    for where in moved_into:
        vids = landed[where]
        repeat = {vid for vid, n in Counter(vids).items() if n > 1}
        kind, key = where
        taken = VLAN.objects.filter(tenant=tenant, vlan_id__in=set(vids)).exclude(pk__in=selected)
        if kind == "group":
            taken = taken.filter(group_id=key)
        else:
            taken = taken.filter(group__isnull=True, site_id=key)
        repeat.update(taken.values_list("vlan_id", flat=True))
        if repeat:
            clashes[where] = repeat
    if not clashes:
        return

    groups = dict(VLANGroup.objects.filter(
        pk__in=[k for (kind, k) in clashes if kind == "group"]).values_list("pk", "name"))
    sites = dict(Site.objects.filter(
        pk__in=[k for (kind, k) in clashes if kind == "site" and k]).values_list("pk", "name"))
    names = {str(k): v for k, v in {**groups, **sites}.items()}

    def place(where):
        kind, key = where
        if kind == "group":
            return f"in {names.get(key, 'the group')}"
        return f"at {names[key]}" if key in names else "with no site"

    raise ValidationError({field: "; ".join(
        f"{_vids(vids)} would repeat {place(where)}"
        for where, vids in sorted(clashes.items(), key=lambda kv: min(kv[1]))
    ) + "."})
