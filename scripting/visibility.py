"""Who sees a script.

RBAC decides whether a user may work with scripts at all; this decides
*which* ones, and can only ever narrow that further: a script is visible to
its owner, to the users and groups it was shared with, and - when published
- to everyone in the tenant.
"""
from __future__ import annotations

from django.db.models import Q


def visible_filter(user) -> Q:
    """The Q for scripts ``user`` may see. Superusers see them all."""
    if getattr(user, "is_superuser", False):
        return Q()
    if not getattr(user, "is_authenticated", False):
        return Q(pk__in=[])
    return (
        Q(visibility="global")
        | Q(owner=user)
        | Q(visibility="users", shared_users=user)
        | Q(visibility="groups", shared_groups__in=user.groups.all())
    )


def visible_scripts(qs, user):
    return qs.filter(visible_filter(user)).distinct()


def can_see(script, user) -> bool:
    if getattr(user, "is_superuser", False):
        return True
    if script.visibility == "global" or script.owner_id == getattr(user, "id", None):
        return True
    if script.visibility == "users":
        return script.shared_users.filter(pk=user.pk).exists()
    if script.visibility == "groups":
        return script.shared_groups.filter(pk__in=user.groups.values("pk")).exists()
    return False
