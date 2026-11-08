"""What a delete or a switch-off of users, groups and permissions may not
take, one row at a time or many (bulk select).

* Nobody deletes or deactivates their own account.
* Only a superuser deletes or deactivates a superuser account, and the last
  active superuser stays.
* The built-in Administrator grant is neither deleted nor disabled: without
  it nobody but a superuser manages access.
* A deployment admin who holds that power through grants keeps it: the last
  grant that gives them user management, and the groups it reaches them
  through, stay when the change would take all of them.

The answers are reasons per row, ``{pk: why}``, as
:meth:`api.bulk_delete.SafeBulkDeleteMixin.bulk_blockers` takes them; the
single delete refuses the same rows with the same reason.
"""
from __future__ import annotations

from django.contrib.auth.models import User

SELF = "You can't delete or deactivate your own account."
SUPERUSER_TARGET = "Only a superuser may modify a superuser account."
LAST_SUPERUSER = "The last active superuser stays."
BUILTIN_ADMIN_GRANT = "The built-in Administrator grant stays."
OWN_GRANT = "You manage users through this permission."
OWN_GROUP = "You manage users through this group."


def user_blockers(actor, users) -> dict:
    """Reasons the ``users`` may not be deleted or deactivated by ``actor``."""
    out: dict = {}
    for u in users:
        if u.pk == actor.pk:
            out[u.pk] = SELF
        elif u.is_superuser and not actor.is_superuser:
            out[u.pk] = SUPERUSER_TARGET
    going = {u.pk for u in users if u.pk not in out}
    active = set(
        User.objects.filter(is_superuser=True, is_active=True).values_list("pk", flat=True)
    )
    if active and active <= going:
        for pk in active:
            out[pk] = LAST_SUPERUSER
    return out


def _management_path(actor):
    """``[(grant pk, direct, {group pks})]``: the enabled, tenant-unscoped
    grants naming ``change`` on ``user`` that reach ``actor`` - what makes a
    non-superuser a deployment admin (``can_manage_deployment``) - with how
    each reaches them. ``None`` when grants are not what makes them one: a
    superuser, or the legacy ``users.manage`` slug."""
    from .models import ObjectPermission
    from .permissions import user_perms

    if actor.is_superuser or "users.manage" in user_perms(actor):
        return None
    own_groups = set(actor.groups.values_list("pk", flat=True))
    out = []
    grants = (
        ObjectPermission.objects.filter(enabled=True, tenants__isnull=True)
        .prefetch_related("users", "groups")
        .distinct()
    )
    for p in grants:
        if "user" not in (p.object_types or []) or "change" not in (p.actions or []):
            continue
        direct = any(u.pk == actor.pk for u in p.users.all())
        via = {g.pk for g in p.groups.all()} & own_groups
        if direct or via:
            out.append((p.pk, direct, via))
    return out


def permission_blockers(actor, perms) -> dict:
    """Reasons the grants ``perms`` may not be deleted or disabled by
    ``actor``."""
    from .api import _is_builtin_admin_grant

    out = {p.pk: BUILTIN_ADMIN_GRANT for p in perms if _is_builtin_admin_grant(p)}
    path = _management_path(actor)
    if path:
        going = {p.pk for p in perms}
        if all(pk in going for pk, _, _ in path):
            for pk, _, _ in path:
                out.setdefault(pk, OWN_GRANT)
    return out


def group_blockers(actor, groups) -> dict:
    """Reasons the ``groups`` may not be deleted by ``actor`` (built-in
    groups are the viewset's own rule)."""
    out: dict = {}
    path = _management_path(actor)
    if not path:
        return out
    going = {g.pk for g in groups}
    if any(direct or (via - going) for _, direct, via in path):
        return out
    for _, _, via in path:
        for pk in via & going:
            out[pk] = OWN_GROUP
    return out
