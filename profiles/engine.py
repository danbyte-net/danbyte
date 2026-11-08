"""The device profile engine: what a device's or VM's profiles want, what is
there, and the writes that bring the two together.

**Effective items.** An object's assignments in order; for each, its
profile's chain root first. Lists (application groups, tags) are the union
in that order, each item once. Single values (the platform, one custom field
key) take the first value in assignment order, and within one assignment the
child's over the parent's. Each item is owned by the first assignment that
wants it.

**The ledger.** Every row a profile wrote, or took over from another profile
on the same object, has one :class:`~profiles.models.DeviceProfileItemLink`.
A row that was there before the profile came is *present*: never claimed,
never removed. A link whose row is gone is *missing*; it comes back only on
*Re-apply* (``restore``).

**Per kind.**

=================  ================================  ======================================
Kind               Written                           Let go (no assignment wants it)
=================  ================================  ======================================
Application group  ``assign_group`` when not          ``unassign_group``: its own
                   assigned; a group assigned by     untouched/edited rule handles the
                   hand is present                   installs
Tag                added when missing                removed if the profile added it
Custom field       set while blank                   cleared while it still holds the
                                                     profile's value and was blank before
Platform           set while blank                   the same as a custom field
=================  ================================  ======================================

When the assignment that owns an item goes, the next assignment that wants it
takes the link over (*moved*); an untouched single value then takes that
assignment's value. Writes are ordinary ORM saves, so the change log records
each one as the caller.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from django.db import transaction
from django.utils import timezone

from .models import DeviceProfileAssignment, DeviceProfileItemLink

KIND_GROUP = "application_group"
KIND_TAG = "tag"
KIND_CF = "custom_field"
KIND_PLATFORM = "platform"

#: Section order and labels, as the preview reports them.
SECTIONS = [
    (KIND_GROUP, "Application groups"),
    (KIND_TAG, "Tags"),
    (KIND_CF, "Custom fields"),
    (KIND_PLATFORM, "Platform"),
]

_SINGLE = {KIND_CF, KIND_PLATFORM}


def blank(value) -> bool:
    return value is None or value == "" or value == []


# ─── hosts ───────────────────────────────────────────────────────────────────


def host_kwargs(host) -> dict:
    from api.models import Device

    return {"device": host} if isinstance(host, Device) else {"virtual_machine": host}


def host_slug(host) -> str:
    return host._meta.model_name  # "device" | "virtualmachine"


def host_ref(host) -> dict:
    return {"type": host_slug(host), "id": str(host.pk), "name": host.name}


def _assignments(host):
    return list(
        DeviceProfileAssignment.objects.filter(**host_kwargs(host))
        .select_related("profile").order_by("position", "created_at")
    )


# ─── effective items ─────────────────────────────────────────────────────────


@dataclass
class Item:
    kind: str
    key: str            # ledger item_id: group:<id>, tag:<id>, cf:<key>, platform
    value: object       # ApplicationGroup, Tag, the CF value, Platform
    label: str
    owner: DeviceProfileAssignment
    source: object      # the profile in the chain the item comes from


def _cf_keys(host) -> set[str]:
    from customization.models import CustomField

    return set(
        CustomField.objects.filter(tenant_id=host.tenant_id, applies_to__contains=[host_slug(host)])
        .values_list("key", flat=True)
    )


def profile_items(profile, owner) -> list[Item]:
    """One profile's items with its chain applied, before other assignments."""
    out: dict[str, Item] = {}
    chain = profile.chain()
    for p in chain:
        for row in p.application_group_items.select_related("group").order_by("position"):
            key = f"group:{row.group_id}"
            out.setdefault(key, Item(KIND_GROUP, key, row.group, row.group.name, owner, p))
        for tag in p.add_tags.order_by("name"):
            key = f"tag:{tag.pk}"
            out.setdefault(key, Item(KIND_TAG, key, tag, tag.name, owner, p))
    for p in reversed(chain):  # single values: the child first
        if p.platform_id:
            out.setdefault("platform", Item(KIND_PLATFORM, "platform", p.platform,
                                            p.platform.name, owner, p))
        for k, v in (p.cf_values or {}).items():
            if blank(v):
                continue
            key = f"cf:{k}"
            out.setdefault(key, Item(KIND_CF, key, v, k, owner, p))
    return list(out.values())


def effective_items(host, assignments) -> tuple[dict[str, Item], list[tuple[Item, str]]]:
    """``({key: item}, skipped)`` for ``assignments`` (in order) on ``host``.
    ``skipped`` names items the host cannot take, with the reason."""
    keys = None
    items: dict[str, Item] = {}
    skipped: list[tuple[Item, str]] = []
    for a in assignments:
        for item in profile_items(a.profile, a):
            if item.key in items:
                continue
            if item.kind == KIND_CF:
                keys = _cf_keys(host) if keys is None else keys
                if item.label not in keys:
                    skipped.append((item, f"No custom field {item.label} on this kind of object."))
                    continue
            items[item.key] = item
    return items, skipped


# ─── plan ────────────────────────────────────────────────────────────────────

CREATE = "create"          # written now
CHANGE = "change"          # an untouched single value takes a new owner's value
PRESENT = "present"        # the profile's row is there
BY_HAND = "by_hand"        # there before the profile; never claimed
HAS_VALUE = "has_value"    # a single value already set; left alone
MISSING = "missing"        # the profile wrote it, someone removed it
EDITED = "edited"          # the profile wrote it, someone changed it


@dataclass
class Step:
    item: Item
    action: str
    link: DeviceProfileItemLink | None = None
    moved: bool = False


@dataclass
class Plan:
    host: object
    steps: list[Step] = field(default_factory=list)
    releases: list[DeviceProfileItemLink] = field(default_factory=list)
    skipped: list[tuple[Item, str]] = field(default_factory=list)


def _host_state(host) -> dict:
    from api.models import ApplicationGroupAssignment

    return {
        "groups": {a.group_id: a for a in ApplicationGroupAssignment.objects.filter(
            **host_kwargs(host))},
        "tags": set(host.tags.values_list("pk", flat=True)),
    }


def _single_current(host, item_or_link_key: str):
    if item_or_link_key == "platform":
        return str(host.platform_id) if host.platform_id else None
    return (host.custom_fields or {}).get(item_or_link_key[3:])


def _single_wanted(item: Item):
    return str(item.value.pk) if item.kind == KIND_PLATFORM else item.value


def plan(host, assignments, *, links=None, restore_for=frozenset()) -> Plan:
    """What bringing ``host`` in line with ``assignments`` would do. ``links``
    are the host's ledger rows (default: every assignment's on the host,
    including ones about to go)."""
    if links is None:
        links = list(DeviceProfileItemLink.objects.filter(
            assignment__in=DeviceProfileAssignment.objects.filter(**host_kwargs(host))))
    by_key = {link.item_id: link for link in links}
    state = _host_state(host)
    items, skipped = effective_items(host, assignments)
    out = Plan(host=host, skipped=skipped)
    for key, item in items.items():
        link = by_key.pop(key, None)
        restore = item.owner.pk in restore_for
        if item.kind in (KIND_GROUP, KIND_TAG):
            there = (item.value.pk in state["groups"] if item.kind == KIND_GROUP
                     else item.value.pk in state["tags"])
            if there:
                action = PRESENT if link else BY_HAND
            elif link and not restore:
                action = MISSING
            else:
                action = CREATE
        else:
            cur = _single_current(host, key)
            wanted = _single_wanted(item)
            if link is None:
                action = CREATE if blank(cur) else HAS_VALUE
            elif blank(cur):
                action = CREATE if restore else MISSING
            elif cur == link.baseline.get("value"):
                action = PRESENT if cur == wanted else CHANGE
            else:
                action = EDITED
        moved = link is not None and link.assignment_id != item.owner.pk
        out.steps.append(Step(item, action, link, moved))
    out.releases = list(by_key.values())
    return out


# ─── apply ───────────────────────────────────────────────────────────────────


def _link(item: Item, host, object_type: str, object_id, baseline: dict, link=None):
    if link is None:
        link = DeviceProfileItemLink(tenant_id=host.tenant_id, item_kind=item.kind,
                                     item_id=item.key)
    link.assignment = item.owner
    link.object_type = object_type
    link.object_id = object_id
    link.baseline = baseline
    link.save()
    return link


def _write(step: Step, host, dirty: set) -> None:
    from api import applications as groups
    from audit.bulk import log_tag_change

    item, link = step.item, step.link
    if item.kind == KIND_GROUP:
        assignment, _installs = groups.assign_group(item.value, **host_kwargs(host))
        _link(item, host, "applicationgroupassignment", assignment.pk, {}, link)
    elif item.kind == KIND_TAG:
        host.tags.add(item.value)
        log_tag_change(host, added=[item.value.name])
        # Tag ids are not UUIDs: the row is the tag on the host, the item id
        # names the tag.
        _link(item, host, host_slug(host), host.pk, {"added": True}, link)
    else:
        before = None if link is None else link.baseline.get("before")
        wanted = _single_wanted(item)
        if item.kind == KIND_PLATFORM:
            host.platform = item.value
            dirty.add("platform")
            object_type, object_id = "platform", item.value.pk
        else:
            host.custom_fields = {**(host.custom_fields or {}), item.label: wanted}
            dirty.add("custom_fields")
            object_type, object_id = host_slug(host), host.pk
        _link(item, host, object_type, object_id, {"value": wanted, "before": before}, link)


def _release(link: DeviceProfileItemLink, host, state: dict, dirty: set) -> str | None:
    """Let go of a row no assignment wants. Returns ``removed``, ``kept`` or
    None when the row was already gone."""
    from api import applications as groups
    from audit.bulk import log_tag_change

    outcome = None
    kind = link.item_kind
    if kind == KIND_GROUP:
        aga = next((a for a in state["groups"].values() if a.pk == link.object_id), None)
        if aga is not None:
            groups.unassign_group(aga)
            outcome = "removed"
        elif uuid.UUID(link.item_id[6:]) in state["groups"]:
            outcome = "kept"  # assigned again by hand after the profile's went
    elif kind == KIND_TAG:
        tag_id = int(link.item_id[4:])
        if tag_id in state["tags"] and link.baseline.get("added"):
            tag = host.tags.filter(pk=tag_id).first()
            if tag is not None:
                host.tags.remove(tag)
                log_tag_change(host, removed=[tag.name])
                outcome = "removed"
    else:
        cur = _single_current(host, link.item_id)
        if not blank(cur):
            if cur == link.baseline.get("value") and blank(link.baseline.get("before")):
                if kind == KIND_PLATFORM:
                    host.platform = None
                    dirty.add("platform")
                else:
                    cf = dict(host.custom_fields or {})
                    cf.pop(link.item_id[3:], None)
                    host.custom_fields = cf
                    dirty.add("custom_fields")
                outcome = "removed"
            else:
                outcome = "kept"
    link.delete()
    return outcome


@dataclass
class Result:
    created: list[Item] = field(default_factory=list)
    changed: list[Item] = field(default_factory=list)
    removed: int = 0
    kept: int = 0
    moved: int = 0

    def counts(self) -> dict:
        return {"removed": self.removed, "kept": self.kept, "moved": self.moved}


def _record_state(host, p: Plan, assignments) -> None:
    missing: dict = {}
    edited: dict = {}
    for s in p.steps:
        if s.action == MISSING:
            missing[s.item.owner.pk] = missing.get(s.item.owner.pk, 0) + 1
        elif s.action == EDITED:
            edited[s.item.owner.pk] = edited.get(s.item.owner.pk, 0) + 1
    now = timezone.now()
    for a in assignments:
        m, e = missing.get(a.pk, 0), edited.get(a.pk, 0)
        state = (DeviceProfileAssignment.STATE_MISSING if m
                 else DeviceProfileAssignment.STATE_EDITED if e
                 else DeviceProfileAssignment.STATE_OK)
        # A queryset update: bookkeeping, not a change anyone made.
        DeviceProfileAssignment.objects.filter(pk=a.pk).update(
            state=state, missing_count=m, edited_count=e, reconciled_at=now)
        a.state, a.missing_count, a.edited_count, a.reconciled_at = state, m, e, now


def sync_host(host, *, exclude=frozenset(), restore_for=frozenset()) -> Result:
    """Bring ``host`` in line with its assignments, less ``exclude`` (ids of
    assignments about to go, whose rows are moved or released here)."""
    with transaction.atomic():
        everyone = _assignments(host)
        staying = [a for a in everyone if a.pk not in exclude]
        p = plan(host, staying, restore_for=restore_for)
        result = Result()
        state = _host_state(host)
        dirty: set = set()
        for link in p.releases:
            outcome = _release(link, host, state, dirty)
            if outcome is not None:
                setattr(result, outcome, getattr(result, outcome) + 1)
        for step in p.steps:
            if step.moved:
                if step.link.assignment_id in exclude:
                    result.moved += 1
                step.link.assignment = step.item.owner
                step.link.save(update_fields=["assignment"])
            if step.action == CREATE:
                _write(step, host, dirty)
                result.created.append(step.item)
                step.action = PRESENT
            elif step.action == CHANGE:
                _write(step, host, dirty)
                result.changed.append(step.item)
                step.action = PRESENT
        if dirty:
            host.save(update_fields=[*sorted(dirty), "updated_at"])
        _record_state(host, p, staying)
    return result


# ─── assign / unassign ───────────────────────────────────────────────────────


class ProfileError(ValueError):
    """An assignment the profile or the object refuses; the message is the
    reason, for a 400."""


def check_applies(profile, host) -> None:
    if profile.tenant_id != host.tenant_id:
        raise ProfileError("The profile and the object belong to different tenants.")
    if host_slug(host) == "device" and not profile.applies_to_devices:
        raise ProfileError(f"{profile.name} is not for devices.")
    if host_slug(host) == "virtualmachine" and not profile.applies_to_vms:
        raise ProfileError(f"{profile.name} is not for virtual machines.")


def assign(profile, host, *, position=None, user=None):
    """Give ``profile`` to ``host`` (at the end unless ``position``) and
    write what it wants. Returns ``(assignment, result)``."""
    from django.db.models import Max

    check_applies(profile, host)
    hk = host_kwargs(host)
    with transaction.atomic():
        if DeviceProfileAssignment.objects.filter(profile=profile, **hk).exists():
            raise ProfileError("Already assigned here.")
        if position is None:
            top = DeviceProfileAssignment.objects.filter(**hk).aggregate(m=Max("position"))["m"]
            position = 0 if top is None else top + 1
        assignment = DeviceProfileAssignment(
            tenant_id=profile.tenant_id, profile=profile, position=position,
            created_by=user if getattr(user, "pk", None) else None, **hk,
        )
        assignment.save()
        result = sync_host(host)
    assignment.refresh_from_db()
    return assignment, result


def unassign(assignment) -> dict:
    """Take the profile off its object: rows another assignment wants move to
    it, the rest are released by the per-kind rules. Returns the counts."""
    host = assignment.parent
    with transaction.atomic():
        result = sync_host(host, exclude={assignment.pk})
        assignment.delete()
    return result.counts()


def reapply(assignment) -> Result:
    """Bring the object in line, restoring what was removed by hand from the
    rows this assignment owns."""
    return sync_host(assignment.parent, restore_for={assignment.pk})


def set_host_profiles(profiles, host, *, user=None) -> dict:
    """Make ``host``'s profiles exactly ``profiles``, in that order. Returns
    the profile ids ``{"assigned": [...], "unassigned": [...]}``."""
    for p in profiles:
        check_applies(p, host)
    hk = host_kwargs(host)
    out = {"assigned": [], "unassigned": []}
    with transaction.atomic():
        have = {a.profile_id: a for a in _assignments(host)}
        wanted = [p.pk for p in profiles]
        gone = [a for pid, a in have.items() if pid not in wanted]
        for position, p in enumerate(profiles):
            a = have.get(p.pk)
            if a is None:
                DeviceProfileAssignment(
                    tenant_id=p.tenant_id, profile=p, position=position,
                    created_by=user if getattr(user, "pk", None) else None, **hk,
                ).save()
                out["assigned"].append(p.pk)
            elif a.position != position:
                a.position = position
                a.save(update_fields=["position"])
        sync_host(host, exclude={a.pk for a in gone})
        for a in gone:
            a.delete()
            out["unassigned"].append(a.profile_id)
    return out


# ─── preview and permissions ─────────────────────────────────────────────────


def required_permissions(profile, host, op: str) -> list[tuple[str, str]]:
    """``[(object type, action)]`` assigning (``op="assign"``), re-applying
    (``"reapply"``) or unassigning (``"unassign"``) ``profile`` takes at the
    object's site: the assignment itself, then every kind the profile
    writes."""
    act = "delete" if op == "unassign" else "add"
    need = []
    if op != "reapply":
        need.append(("deviceprofileassignment", act))
    chain = profile.chain()
    if any(p.application_group_items.exists() for p in chain):
        need += [("applicationgroupassignment", act), ("installedsoftware", act)]
    if any(p.platform_id or p.cf_values or p.add_tags.exists() for p in chain):
        need.append((host_slug(host), "change"))
    return need


def missing_permissions(user, tenant, needs, host) -> list[dict]:
    """The entries of ``needs`` ``user`` lacks at ``host``'s site."""
    from auth_api import rbac
    from auth_api.object_types import _registry

    if getattr(user, "is_superuser", False):
        return []
    registry = _registry()
    out = []
    for slug, action in needs:
        if slug == host_slug(host):
            ok = rbac.can_act_on(user, tenant, slug, action, host)
        elif not rbac.has_action(user, tenant, slug, action):
            ok = False
        else:
            scope = rbac.site_scope(user, tenant, slug, action)
            ok = scope is None or (host.site_id is not None and host.site_id in scope)
        if not ok:
            label = registry.get(slug, {}).get("label", slug)
            out.append({"type": slug, "action": action, "label": label})
    return out


def missing_text(missing: list[dict]) -> str:
    parts = [f"{m['action']} {m['label'].lower()}" for m in missing]
    return "Missing permission at this object's site: " + ", ".join(parts) + "."


def _item_ref(item: Item, reason: str = "") -> dict:
    out = {"key": item.key, "label": item.label, "from": item.source.name}
    if item.kind == KIND_CF:
        out["value"] = item.value
    if reason:
        out["reason"] = reason
    return out


def preview(profile, host, *, user=None, tenant=None) -> dict:
    """What assigning ``profile`` to ``host`` would create, change and skip,
    and the permissions the caller is missing. Nothing is written."""
    current = _assignments(host)
    already = any(a.profile_id == profile.pk for a in current)
    if already:
        mine = next(a for a in current if a.profile_id == profile.pk)
        assignments = current
    else:
        top = max((a.position for a in current), default=-1)
        mine = DeviceProfileAssignment(pk=uuid.uuid4(), tenant_id=profile.tenant_id,
                                       profile=profile, position=top + 1, **host_kwargs(host))
        assignments = [*current, mine]
    p = plan(host, assignments)
    names = {a.pk: a.profile.name for a in assignments}
    sections = {kind: {"label": label, "create": [], "change": [], "present": [], "skip": []}
                for kind, label in SECTIONS}
    wanted = {i.key for i in profile_items(profile, mine)}
    for s in p.steps:
        if s.item.key not in wanted:
            continue
        box = sections[s.item.kind]
        if s.item.owner.pk != mine.pk:
            box["present"].append(_item_ref(
                s.item, f"From profile {names.get(s.item.owner.pk, '')}".strip()))
        elif s.action == CREATE:
            box["create"].append(_item_ref(s.item))
        elif s.action == CHANGE:
            box["change"].append(_item_ref(s.item))
        elif s.action == HAS_VALUE:
            box["skip"].append(_item_ref(s.item, "Already has a value."))
        elif s.action == BY_HAND:
            box["present"].append(_item_ref(s.item, "Already there."))
        elif s.action == MISSING:
            box["skip"].append(_item_ref(s.item, "Removed by hand; Re-apply restores it."))
        elif s.action == EDITED:
            box["skip"].append(_item_ref(s.item, "Edited by hand."))
        else:
            box["present"].append(_item_ref(s.item))
    for item, reason in p.skipped:
        if item.owner.pk == mine.pk:
            sections[item.kind]["skip"].append(_item_ref(item, reason))
    needs = required_permissions(profile, host, "assign")
    missing = missing_permissions(user, tenant, needs, host) if user is not None else []
    refused = ""
    try:
        check_applies(profile, host)
    except ProfileError as exc:
        refused = str(exc)
    return {
        "profile": {"id": str(profile.pk), "name": profile.name, "slug": profile.slug},
        "object": host_ref(host),
        "already_assigned": already,
        "refused": refused,
        "sections": [{"kind": k, **sections[k]} for k, _l in SECTIONS],
        "missing_permissions": missing,
    }


def from_profile(object_type: str, object_ids) -> dict:
    """``{object id: {"id", "name"}}`` of the profile that wrote each row -
    one ledger query for a page of rows."""
    rows = (DeviceProfileItemLink.objects
            .filter(object_type=object_type, object_id__in=list(object_ids))
            .values_list("object_id", "assignment__profile_id", "assignment__profile__name"))
    return {str(oid): {"id": str(pid), "name": name} for oid, pid, name in rows}
