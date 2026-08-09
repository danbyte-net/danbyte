"""Planned-change services: resolve a target, snapshot it, apply the change.

Kept out of the viewset because three surfaces need the same logic — the
serializer (to compute ``stale``), create (to snapshot the current value) and
apply (to re-validate and write). All of them lean on
:mod:`api.editable_fields`, so plan-time and apply-time validation are literally
the same code.

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

from api.editable_fields import (
    coerce_value,
    field_for,
    read_value,
    serializer_for,
)

from .models import PlannedChangeState


class _Missing:
    """Distinguishes "the target or field is gone" from "the value is None"."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<missing>"


_MISSING = _Missing()


class StaleValue(Exception):
    """The live value moved since the plan was written.

    Carries the live value so the caller can offer "now it's X — apply anyway?"
    rather than a bare validation error.
    """

    def __init__(self, current_value, current_display, live_value, live_display):
        super().__init__("The current value changed since this was planned.")
        self.current_value = current_value
        self.current_display = current_display
        self.live_value = live_value
        self.live_display = live_display


def model_for_label(object_type: str):
    try:
        return apps.get_model(object_type)
    except (LookupError, ValueError):
        return None


def resolve_target(pc):
    """The live target row, or None when the label doesn't resolve or the row is
    gone. Deliberately unscoped — callers gate with ``_can_act_on_object``."""
    model = model_for_label(pc.object_type)
    if model is None:
        return None
    return model._default_manager.filter(pk=pc.object_id).first()


def descriptor_for(pc):
    """The field descriptor, or None if the field has left the allow-list."""
    model = model_for_label(pc.object_type)
    if model is None:
        return None
    return field_for(model, pc.field)


def live_value_for(pc):
    """The target's current db value for this change's field, or ``_MISSING``."""
    obj = resolve_target(pc)
    spec = descriptor_for(pc)
    if obj is None or spec is None:
        return _MISSING
    return read_value(obj, spec)[0]


def snapshot(model, spec, obj, tenant, raw_new):
    """Validate the proposed value and capture the current one.

    Returns ``(new_value, new_display, current_value, current_display)``.
    """
    new_value, new_display = coerce_value(model, spec, raw_new, tenant=tenant)
    current_value, current_display = read_value(obj, spec)
    if new_value == current_value:
        raise ValidationError(
            {"new_value": "That is already the current value."}
        )
    return new_value, new_display, current_value, current_display


def apply_change(pc, request, *, force=False):
    """Write the planned value into Danbyte's record and mark the plan applied.

    Every check fails closed. Raises ``ValidationError``/``PermissionDenied``, or
    ``StaleValue`` when the premise has changed and ``force`` is not set.

    Note this updates *Danbyte's* record only — pushing the change to hardware
    is the separate automation/deploy path.
    """
    from audit.api import _can_act_on_object, _object_site_id

    if pc.state != PlannedChangeState.PLANNED:
        raise ValidationError(
            "This change was already applied."
            if pc.state == PlannedChangeState.APPLIED
            else "This change was cancelled."
        )

    # The TARGET's change permission, row- and site-scoped. Holding rights on
    # the task is not permission to rewrite a device.
    if not _can_act_on_object(request, pc.object_type, str(pc.object_id), "change"):
        raise PermissionDenied(
            f"You do not have permission to change this "
            f"{pc.object_type.split('.')[-1]}."
        )

    model = model_for_label(pc.object_type)
    obj = resolve_target(pc)
    spec = descriptor_for(pc)
    if obj is None:
        raise ValidationError("The target object no longer exists.")
    if spec is None:
        raise ValidationError({"field": "That field can no longer be changed here."})

    live_value, live_display = read_value(obj, spec)
    if live_value != pc.current_value and not force:
        raise StaleValue(
            pc.current_value, pc.current_display, live_value, live_display
        )

    tenant = pc.tenant
    # Re-coerce: the referenced Status/VLAN/Site may have been deleted since.
    new_value, new_display = coerce_value(model, spec, pc.new_value, tenant=tenant)

    serializer_cls = serializer_for(model)
    if serializer_cls is None:  # pragma: no cover - guarded by a registry test
        raise ValidationError("This object type can't be written through the API.")

    with transaction.atomic():
        ser = serializer_cls(
            obj, data={pc.field: new_value}, partial=True,
            context={"request": request},
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

        if force:
            # Record what was actually overwritten, not the stale premise.
            pc.current_value, pc.current_display = live_value, live_display
        pc.new_display = new_display
        pc.state = PlannedChangeState.APPLIED
        pc.applied_at = timezone.now()
        pc.applied_by = request.user if request.user.is_authenticated else None
        pc.object_site_id = _object_site_id(pc.object_type, str(pc.object_id))
        pc.save(update_fields=[
            "current_value", "current_display", "new_display", "state",
            "applied_at", "applied_by", "object_site_id", "updated_at",
        ])
        _journal_the_apply(pc, request)
    return pc


def _journal_the_apply(pc, request):
    """Leave a note on the TARGET saying why it changed.

    The change-log entry is automatic (audited model + a normal save), but it
    can't know the change came from a task. This is the bit that makes the
    object's own history explain itself.
    """
    from audit.models import JournalEntry, JournalKind

    spec = descriptor_for(pc)
    label = spec.label if spec is not None else pc.field
    user = request.user if request.user.is_authenticated else None
    JournalEntry.objects.create(
        tenant=pc.tenant,
        object_type=pc.object_type,
        object_id=str(pc.object_id),
        object_site_id=pc.object_site_id,
        created_by=user,
        author_name=getattr(user, "username", "") or "",
        kind=JournalKind.INFO,
        comments=(
            f"Applied planned change from task «{pc.task.title}»: "
            f"{label} {pc.current_display or '—'} → {pc.new_display or '—'}"
        ),
    )
