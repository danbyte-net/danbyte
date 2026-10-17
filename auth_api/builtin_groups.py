"""The built-in RBAC groups (Administrator / Operator / Read-only).

Seeded by migration 0007 (and brought to the 0.17 wildcard rule by 0024); this
module is the *runtime* re-seeder. A ``TransactionTestCase`` ends by flushing
every table - including these groups and their wildcard grants - and under
``--keepdb`` that emptied state persists into the next test run, which then
fails on ``Group.DoesNotExist``. Such test classes call
:func:`ensure_builtin_groups` in ``tearDownClass`` to put the rows back.
Idempotent; safe to call anywhere.

"*" does not reach users, groups or permissions (``ACCESS_TYPES``), so the
Administrator grant names them; Operator and Read-only do not manage access.

A "*" grant carries only the verbs it lists. The Administrator grant lists the
money verbs (``MONEY_VERBS``): an administrator can grant them to themselves,
so withholding them protects nothing. Migration 0031 adds them on upgrade.
It does not list reveal, view_config or the other capability verbs.
"""
from __future__ import annotations

from .object_types import ACCESS_TYPES

# Contract cost and SLA service credits. Migration 0031 keeps a frozen copy.
MONEY_VERBS: tuple[str, ...] = ("view_credits", "view_cost")

# (group, description, actions, object types)
BUILTINS = [
    ("Administrator", "Full access to everything.",
     ["view", "add", "change", "delete", *MONEY_VERBS], ["*", *ACCESS_TYPES]),
    ("Operator",
     "Create and edit, but not delete. No access to users, groups or permissions.",
     ["view", "add", "change"], ["*"]),
    ("Read-only",
     "View everything except users, groups and permissions; change nothing.",
     ["view"], ["*"]),
]


def grant_names(name: str) -> tuple[str, str]:
    """The built-in grant's name as this module writes it (hyphen) and as
    migration 0007 wrote it (em dash)."""
    return (f"{name} - all objects", f"{name} — all objects")


def ensure_builtin_groups() -> None:
    from django.contrib.auth.models import Group

    from .models import GroupProfile, ObjectPermission

    for name, desc, actions, types in BUILTINS:
        group, _ = Group.objects.get_or_create(name=name)
        GroupProfile.objects.update_or_create(
            group=group, defaults={"description": desc, "built_in": True}
        )
        perms = list(ObjectPermission.objects.filter(name__in=grant_names(name)))
        if not perms:
            perms = [ObjectPermission.objects.create(
                name=grant_names(name)[0],
                description=f"Built-in grant for the {name} group.",
                enabled=True,
                object_types=list(types),
                actions=list(actions),
                constraints=None,
            )]
        for perm in perms:
            # A grant seeded before 0.17 gains the access types it is meant
            # to name, and one seeded before 0.18 the money verbs it is meant
            # to list (Administrator only). Additive: nothing is taken away,
            # and an existing grant's other types and verbs are left as edited.
            have = list(perm.object_types or [])
            missing = [t for t in types if t in ACCESS_TYPES and t not in have]
            have_acts = list(perm.actions or [])
            missing_acts = [a for a in actions if a in MONEY_VERBS and a not in have_acts]
            fields = []
            if missing:
                perm.object_types = have + missing
                fields.append("object_types")
            if missing_acts:
                perm.actions = have_acts + missing_acts
                fields.append("actions")
            if fields:
                perm.save(update_fields=[*fields, "updated_at"])
            perm.groups.add(group)
