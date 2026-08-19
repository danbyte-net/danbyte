"""Planned-change services: resolve a target, stage a change set, apply it.

Kept out of the viewset because three surfaces need the same logic - the
serializer (to compute ``stale``), create (to diff and snapshot) and apply (to
re-validate and write).

Applying writes through the **target's own serializer**, never ``setattr``. A
plan can set ``Device.rack_id`` or ``site_id``, and the cross-field invariants
that keep rack placement coherent live in ``DeviceSerializer.validate``; a raw
attribute write would happily put a device in a rack it cannot fit in. The
serializer also re-runs the tenant-scoped, site-fenced FK fields.
"""
from __future__ import annotations

from django.apps import apps
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from api.editable_fields import serializer_for

from .diffing import stale_keys, validate_payload
from .models import PlannedChangeKind, PlannedChangeState


class StaleValue(Exception):
    """The live object moved since the plan was written.

    Carries what changed so the caller can offer "it's X now - apply anyway?"
    rather than a bare validation error.
    """

    def __init__(self, keys, live_display):
        super().__init__("The object changed since this was planned.")
        self.keys = keys
        self.live_display = live_display


def model_for_label(object_type: str):
    try:
        return apps.get_model(object_type)
    except (LookupError, ValueError):
        return None


def resolve_target(pc):
    """The live target row, or None when the label doesn't resolve, the row is
    gone, or this is a create. Deliberately unscoped - callers gate with
    ``_can_act_on_object``."""
    if pc.kind == PlannedChangeKind.CREATE or pc.object_id is None:
        return None
    model = model_for_label(pc.object_type)
    if model is None:
        return None
    return model._default_manager.filter(pk=pc.object_id).first()


def is_stale(pc) -> bool:
    """Computed, never stored: a column would need a writer, and the only honest
    writer is a hook on every save of every audited model. Apply re-checks this
    synchronously and refuses with a 409, which is stronger than a flag that can
    go out of date."""
    if pc.state != PlannedChangeState.PLANNED:
        return False
    if pc.kind == PlannedChangeKind.CREATE:
        return False  # nothing to be stale against
    obj = resolve_target(pc)
    if obj is None:
        return False
    return bool(stale_keys(obj, pc.before))


def apply_change(pc, request, *, force=False):
    """Write the planned change into Danbyte's record and mark the plan applied.

    Every check fails closed. Raises ``ValidationError``/``PermissionDenied``, or
    ``StaleValue`` when the premise has changed and ``force`` is not set.

    This updates *Danbyte's* record only - pushing the change to hardware is the
    separate automation/deploy path.
    """
    if pc.state != PlannedChangeState.PLANNED:
        raise ValidationError(
            "This change was already applied."
            if pc.state == PlannedChangeState.APPLIED
            else "This change was cancelled."
        )
    if pc.kind == PlannedChangeKind.CREATE:
        return _apply_create(pc, request)
    return _apply_update(pc, request, force=force)


def _target_gate(request, pc, action):
    from audit.api import _can_act_on_object

    if not _can_act_on_object(request, pc.object_type, str(pc.object_id), action):
        raise PermissionDenied(
            f"You do not have permission to {action} this "
            f"{pc.object_type.split('.')[-1]}."
        )


def _apply_update(pc, request, *, force=False):
    from audit.api import _can_act_on_object, _object_site_id

    # The TARGET's change permission, row- and site-scoped. Holding rights on
    # the task is not permission to rewrite a device.
    _target_gate(request, pc, "change")

    model = model_for_label(pc.object_type)
    obj = resolve_target(pc)
    if obj is None:
        raise ValidationError("The target object no longer exists.")

    drifted = stale_keys(obj, pc.before)
    if drifted and not force:
        from .diffing import _display_of, current_write_value

        raise StaleValue(
            drifted,
            {
                k: _display_of(model, k, current_write_value(obj, k))
                for k in drifted
            },
        )

    serializer_cls = serializer_for(model)
    if serializer_cls is None:  # pragma: no cover - guarded by a registry test
        raise ValidationError("This object type can't be written through the API.")

    with transaction.atomic():
        ser = serializer_cls(
            obj, data=pc.payload, partial=True, context={"request": request}
        )
        ser.is_valid(raise_exception=True)
        ser.save()

        # Re-check AFTER the write: a plan that sets site_id could otherwise
        # push the object out of the applier's own scope. Raising here rolls the
        # write back with it.
        if not _can_act_on_object(
            request, pc.object_type, str(pc.object_id), "change"
        ):
            raise PermissionDenied(
                "This change would move the object outside your permission scope."
            )

        if force and drifted:
            # Record what was actually overwritten, not the stale premise.
            from .diffing import current_write_value

            pc.before = {
                **pc.before,
                **{k: current_write_value(obj, k) for k in drifted},
            }
        _finish(pc, request, _object_site_id(pc.object_type, str(pc.object_id)))
        _journal(pc, request, obj)
    return pc


def _apply_create(pc, request):
    """Create the planned object. Gated on **add**, not change - making a new
    interface is not the same right as editing an existing one."""
    from audit.api import _object_site_id
    from auth_api import rbac

    from .models import TaskLink

    model = model_for_label(pc.object_type)
    if model is None:
        raise ValidationError({"object_type": "Unknown object type."})
    slug = model._meta.model_name
    if not rbac.has_action(request.user, pc.tenant, slug, "add"):
        raise PermissionDenied(f"You do not have permission to add a {slug}.")

    serializer_cls = serializer_for(model)
    if serializer_cls is None:
        raise ValidationError("This object type can't be created through the API.")

    with transaction.atomic():
        ser = serializer_cls(data=pc.payload, context={"request": request})
        ser.is_valid(raise_exception=True)
        obj = _save_scoped(ser, model, pc.tenant)

        pc.created_object_id = obj.pk
        pc.object_id = obj.pk
        site_id = _object_site_id(pc.object_type, str(obj.pk))
        _finish(pc, request, site_id)
        # The task now touches a real object - say so in Linked objects.
        TaskLink.objects.get_or_create(
            task=pc.task, object_type=pc.object_type, object_id=obj.pk,
            defaults={"tenant": pc.tenant, "object_site_id": site_id},
        )
        _journal(pc, request, obj, created=True)
    return pc


def _save_scoped(ser, model, tenant):
    """Save a new object, stamping the tenant when the model carries one (most
    do; components inherit it through their device)."""
    if any(f.name == "tenant" for f in model._meta.fields):
        return ser.save(tenant=tenant)
    return ser.save()


def _finish(pc, request, site_id):
    pc.object_site_id = site_id
    pc.state = PlannedChangeState.APPLIED
    pc.applied_at = timezone.now()
    pc.applied_by = request.user if request.user.is_authenticated else None
    pc.save(update_fields=[
        "before", "object_id", "created_object_id", "object_site_id", "state",
        "applied_at", "applied_by", "updated_at",
    ])


def _journal(pc, request, obj, *, created=False):
    """Leave a note on the TARGET saying why it changed.

    The change-log entry is automatic (audited model + a normal save), but it
    can't know the change came from a task. This is the bit that makes the
    object's own history explain itself.
    """
    from audit.models import JournalEntry, JournalKind

    lines = [
        f"{d.get('label') or d['field']}: "
        f"{d.get('from') or '-'} → {d.get('to') or '-'}"
        for d in (pc.display or [])
    ]
    what = "Created from" if created else "Applied planned change from"
    body = f"{what} task «{pc.task.title}»"
    if lines:
        body += ": " + "; ".join(lines)
    user = request.user if request.user.is_authenticated else None
    JournalEntry.objects.create(
        tenant=pc.tenant,
        object_type=pc.object_type,
        object_id=str(obj.pk),
        object_site_id=pc.object_site_id,
        created_by=user,
        author_name=getattr(user, "username", "") or "",
        kind=JournalKind.INFO,
        comments=body,
    )


__all__ = [
    "StaleValue",
    "apply_change",
    "is_stale",
    "model_for_label",
    "resolve_target",
    "validate_payload",
]
