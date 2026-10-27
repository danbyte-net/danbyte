"""Loading a page's tags as plain lists (#296).

``prefetch_related("tags")`` hands every row a django-taggit queryset of its
own - built, filtered and ordered per row only to hold that row's tags - and
that costs about 0.2 ms a row: a third of a second on 1,600 interfaces. The
:data:`TAGS` prefetch runs the same single query but leaves each row a list
in ``prefetched_tags``; :func:`tags_of` reads it, and falls back to
``obj.tags.all()`` for an object that was loaded without it.

A tag write through the manager (``obj.tags.add/remove/set/clear``) drops the
list, as taggit drops its own prefetch cache, so the next read sees the change.
"""
from __future__ import annotations

from django.db.models import Prefetch

TAGS_ATTR = "prefetched_tags"

# Shared by the list querysets. Without a queryset of its own a Prefetch is
# safe to reuse, and naming it twice on one queryset runs it once.
TAGS = Prefetch("tags", to_attr=TAGS_ATTR)


def tags_of(obj):
    """The object's tags: the list a :data:`TAGS` prefetch left, else a query."""
    got = obj.__dict__.get(TAGS_ATTR)
    return got if got is not None else obj.tags.all()


def forget_prefetched_tags(sender, instance, action, **kwargs):
    """``m2m_changed`` on the tag through model: drop the stale list."""
    if action.startswith("post_"):
        instance.__dict__.pop(TAGS_ATTR, None)


# ─── Name uniqueness among the tags a tenant sees ──────────────────────
#
# The database keeps ``name`` unique per tenant only, and deployment-global
# tags (``tenant`` NULL, from before tags were tenant-scoped) share a name
# with tenant tags on older installs. From here on a name - trimmed, case
# ignored - may exist once among what a tenant sees: its own tags (site-local
# ones included) and the global ones. A global tag sees every tenant's. The
# rule is checked on create and rename; existing pairs stay until merged.


def tag_name_key(name) -> str:
    """The comparison form of a tag name: trimmed, case-folded."""
    return (name or "").strip().lower()


def _keyed(qs):
    from django.db.models.functions import Lower, Trim

    return qs.annotate(name_key=Lower(Trim("name")))


def tag_name_clash(name, *, tenant, exclude_pk=None):
    """The existing tag a tag called ``name`` in ``tenant`` would collide with.

    ``tenant`` None is a deployment-global tag, which every tenant sees, so
    it collides with a tag of that name in any tenant."""
    from django.db.models import F, Q

    from core.models import Tag

    key = tag_name_key(name)
    if not key:
        return None
    qs = _keyed(Tag.objects.all()).filter(name_key=key)
    if tenant is not None:
        qs = qs.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return (
        qs.select_related("tenant", "owning_site")
        .order_by(F("tenant").asc(nulls_first=True), "pk")
        .first()
    )


def tag_scope_label(tag) -> str:
    if tag.tenant_id is None:
        return "global, shared by all tenants"
    if tag.owning_site_id:
        return f"local to site {tag.owning_site.name}"
    return f"tenant {tag.tenant.name}"


def tag_clash_message(tag) -> str:
    return f'A tag named "{tag.name}" already exists ({tag_scope_label(tag)}).'


def find_visible_tag(name, tenant):
    """The tag called ``name`` (trimmed, case ignored) that ``tenant`` sees,
    its own before a global one - what an import or sync should reuse
    instead of creating a second tag of the same name."""
    from django.db.models import F, Q

    from core.models import Tag

    key = tag_name_key(name)
    if not key:
        return None
    qs = _keyed(Tag.objects.all()).filter(name_key=key)
    qs = qs.filter(Q(tenant=tenant) | Q(tenant__isnull=True)) if tenant else qs.filter(
        tenant__isnull=True
    )
    return qs.order_by(F("tenant").asc(nulls_last=True), "pk").first()


def duplicate_name_groups(qs) -> list[list]:
    """Groups of tags in ``qs`` whose names collide, in name order."""
    groups: dict[str, list] = {}
    for tag in qs:
        groups.setdefault(tag_name_key(tag.name), []).append(tag)
    return [groups[k] for k in sorted(groups) if len(groups[k]) > 1]


def merge_tags(source, target) -> dict:
    """Move every object tagged ``source`` onto ``target`` and delete
    ``source``, in one transaction. An object carrying both keeps a single
    ``target`` assignment. Each touched object gets a change-log entry; the
    deleted tag logs its own delete. Scope checks are the caller's."""
    from collections import defaultdict

    from django.db import transaction

    from audit.bulk import log_tag_merge
    from core.models import TaggedItem

    with transaction.atomic():
        items = list(
            TaggedItem.objects.select_for_update().filter(tag=source)
            .select_related("content_type")
        )
        have = set(
            TaggedItem.objects.filter(tag=target).values_list("content_type_id", "object_id")
        )
        move_ids, drop_ids = [], []
        moved_keys, dropped_keys = defaultdict(set), defaultdict(set)
        for item in items:
            key = (item.content_type_id, item.object_id)
            if key in have:
                drop_ids.append(item.pk)
                dropped_keys[item.content_type].add(item.object_id)
            else:
                have.add(key)
                move_ids.append(item.pk)
                moved_keys[item.content_type].add(item.object_id)
        if drop_ids:
            TaggedItem.objects.filter(pk__in=drop_ids).delete()
        if move_ids:
            TaggedItem.objects.filter(pk__in=move_ids).update(tag=target)

        def objects(keys):
            out = []
            for ct, ids in keys.items():
                model = ct.model_class()
                if model is not None:
                    out.extend(model._default_manager.filter(pk__in=ids))
            return out

        log_tag_merge(objects(moved_keys), objects(dropped_keys), source.name, target.name)
        source.delete()
    return {"moved": len(move_ids), "already_tagged": len(drop_ids)}
