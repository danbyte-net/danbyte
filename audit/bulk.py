"""Explicit change-log writes for bulk operations.

Bulk endpoints use ``queryset.update()`` / ``queryset.delete()`` for one
round-trip, which **bypass** model signals — so they'd otherwise be invisible.
Call these helpers around the bulk op to record one entry per affected object.

Usage:
    qs = self.get_queryset().filter(pk__in=ids)
    rows = list(qs)                 # snapshot OLD values before the write
    n = qs.update(**updates)
    log_bulk_update(rows, updates)

    rows = list(qs)                 # snapshot before delete
    qs.delete()
    log_bulk_delete(rows)
"""
from __future__ import annotations

from .context import current_request_id, current_user
from .models import ChangeAction, ChangeLogEntry
from .signals import _ser


def _entry(instance, action, changes, user, rid):
    from .site_capture import entry_site_id

    return ChangeLogEntry(
        tenant_id=getattr(instance, "tenant_id", None),
        user=user,
        user_name=(user.get_username() if user else ""),
        action=action,
        object_type=instance._meta.label_lower,
        object_label=instance._meta.verbose_name.title(),
        object_id=str(instance.pk),
        object_repr=str(instance)[:255],
        object_site_id=entry_site_id(instance),
        changes=changes,
        request_id=rid,
    )


def log_bulk_update(rows, updates: dict) -> None:
    """One UPDATE entry per row whose value actually changed. ``updates`` keys
    are model attnames (``status``, ``vrf_id``, …) as passed to ``.update()``."""
    user = current_user()
    rid = current_request_id()
    entries = []
    for r in rows:
        changes = {}
        for k, v in updates.items():
            old = _ser(getattr(r, k, None))
            new = _ser(v)
            if old != new:
                changes[k] = {"old": old, "new": new}
        if changes:
            entries.append(_entry(r, ChangeAction.UPDATE, changes, user, rid))
    if entries:
        ChangeLogEntry.objects.bulk_create(entries)


def log_bulk_delete(rows) -> None:
    """One DELETE entry per removed row."""
    user = current_user()
    rid = current_request_id()
    entries = [_entry(r, ChangeAction.DELETE, {}, user, rid) for r in rows]
    if entries:
        ChangeLogEntry.objects.bulk_create(entries)


def log_tag_change(instance, added=(), removed=()) -> None:
    """Record a tag add/remove on one object (m2m doesn't fire save signals)."""
    if not added and not removed:
        return
    user = current_user()
    changes = {
        "tags": {"old": sorted(removed) or None, "new": sorted(added) or None}
    }
    _entry(instance, ChangeAction.UPDATE, changes, user, current_request_id()).save()


def apply_and_log_bulk_tags(qs, add_tag_ids, remove_tag_ids, tenant=None) -> None:
    """Resolve tag ids → Tag rows, apply add/remove across ``qs``, and record
    one changelog entry per object whose tag set actually changed.

    Two things the naive per-object ``tags.add(*ids)`` loop got wrong: taggit's
    ``add()``/``remove()`` take Tag instances or *names*, never pks (raw ids
    raise ValueError on add and silently no-op on remove), and m2m operations
    fire no save signals, so the changes never reached the change log.

    Pass ``tenant`` so foreign-tenant tag ids are silently dropped — tags are
    tenant-scoped now, and this raw path bypasses the serializer's scoped
    field (legacy NULL-tenant tags stay attachable)."""
    if not add_tag_ids and not remove_tag_ids:
        return
    from django.db.models import Q

    from core.models import Tag

    tag_qs = Tag.objects.filter(id__in={*add_tag_ids, *remove_tag_ids})
    if tenant is not None:
        tag_qs = tag_qs.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
    tags = {t.id: t for t in tag_qs}
    add = [tags[i] for i in add_tag_ids if i in tags]
    remove = [tags[i] for i in remove_tag_ids if i in tags]
    for obj in qs.prefetch_related("tags"):
        current = {t.id for t in obj.tags.all()}
        added = [t.name for t in add if t.id not in current]
        removed = [t.name for t in remove if t.id in current]
        if add:
            obj.tags.add(*add)
        if removed:
            obj.tags.remove(*removed)
        log_tag_change(obj, added=added, removed=removed)
