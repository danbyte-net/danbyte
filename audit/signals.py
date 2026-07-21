"""Model signals that write change-log entries.

Connected per-model in ``apps.ready()`` so they only fire for audited models.
pre_save snapshots the old row; post_save diffs it; post_delete records removal.

Limitations (v1): bulk operations (`queryset.update/delete`, `bulk_create`) and
m2m edits (tags) don't fire these signals, so they aren't logged — single-object
CRUD via the API / admin / shell is covered.
"""
from __future__ import annotations

import datetime
import decimal
import uuid

from django.db.models.fields.files import FieldFile
from django.db.models.signals import post_delete, post_save, pre_save


from .context import current_request_id, current_user
from .models import ChangeAction, ChangeLogEntry

_SKIP_FIELDS = {"created_at", "updated_at"}

# Secrets must never enter the change log in cleartext — not in the field diff,
# not in the pre/post snapshots. EncryptedJSONField columns decrypt
# transparently on read (so a naive getattr() would log the plaintext), and a
# few models keep credentials in plain columns. Redacted fields log "•••" when
# set / None when empty: the trail still shows *that* a secret exists, never
# its value. (Consequence: a rotation from one secret to another produces no
# diff entry — by design; even revealing a hash would aid offline guessing.)
# The classifier lives in core.secret_fields so exports and share links use
# the exact same definition of "secret" as the audit trail.
from core.secret_fields import is_secret_field as _is_secret  # noqa: E402


def _ser(v):
    if isinstance(v, (uuid.UUID, decimal.Decimal)):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    # FileField / ImageField → store the file name, not the FieldFile object
    # (which isn't JSON serializable).
    if isinstance(v, FieldFile):
        return v.name or None
    return v


def _field_dict(instance) -> dict:
    out = {}
    for f in instance._meta.concrete_fields:
        if f.name in _SKIP_FIELDS:
            continue
        if _is_secret(instance, f):
            out[f.name] = "•••" if getattr(instance, f.attname) else None
            continue
        out[f.name] = _ser(getattr(instance, f.attname))
    return out


def _safe_repr(instance) -> str:
    """``str(instance)`` for the log, but never crash the operation being logged:
    a model's ``__str__`` may dereference a related row that's already been
    deleted mid-cascade (e.g. TunnelTermination -> interface), which raises
    DoesNotExist. Fall back to a stable type+pk label in that case."""
    try:
        return str(instance)[:255]
    except Exception:  # noqa: BLE001 — logging must not break the delete/save
        return f"{instance._meta.label} {instance.pk}"[:255]


def _record(instance, action, changes, pre=None, post=None):
    from .site_capture import entry_site_id

    user = current_user()
    ChangeLogEntry.objects.create(
        tenant_id=getattr(instance, "tenant_id", None),
        user=user,
        user_name=(user.get_username() if user else ""),
        action=action,
        object_type=instance._meta.label_lower,
        object_label=instance._meta.verbose_name.title(),
        object_id=str(instance.pk),
        object_repr=_safe_repr(instance),
        object_site_id=entry_site_id(instance),
        changes=changes,
        pre_change=pre,
        post_change=post,
        request_id=current_request_id(),
    )


def _snapshot(sender, instance, **kwargs):
    if instance.pk:
        old = sender.objects.filter(pk=instance.pk).first()
        instance._audit_old = _field_dict(old) if old else None
    else:
        instance._audit_old = None


def _on_save(sender, instance, created, **kwargs):
    if created:
        _record(instance, ChangeAction.CREATE, {}, post=_field_dict(instance))
        return
    old = getattr(instance, "_audit_old", None)
    new = _field_dict(instance)
    if old is None:
        return
    changes = {
        k: {"old": old.get(k), "new": v}
        for k, v in new.items()
        if old.get(k) != v
    }
    if not changes:
        return
    _record(instance, ChangeAction.UPDATE, changes, pre=old, post=new)


def _on_delete(sender, instance, **kwargs):
    _record(instance, ChangeAction.DELETE, {}, pre=_field_dict(instance))


def connect(models: list) -> None:
    for model in models:
        key = model._meta.label_lower
        pre_save.connect(_snapshot, sender=model, dispatch_uid=f"audit:pre:{key}")
        post_save.connect(_on_save, sender=model, dispatch_uid=f"audit:save:{key}")
        post_delete.connect(
            _on_delete, sender=model, dispatch_uid=f"audit:del:{key}"
        )
