"""The built-in RBAC groups (Administrator / Operator / Read-only).

Seeded by migration 0007; this module is the *runtime* re-seeder. A
``TransactionTestCase`` ends by flushing every table — including these groups
and their wildcard grants — and under ``--keepdb`` that emptied state persists
into the next test run, which then fails on ``Group.DoesNotExist``. Such test
classes call :func:`ensure_builtin_groups` in ``tearDownClass`` to put the
rows back. Idempotent; safe to call anywhere.
"""
from __future__ import annotations

BUILTINS = [
    ("Administrator", "Full access to everything.", ["view", "add", "change", "delete"]),
    ("Operator", "Create and edit, but not delete.", ["view", "add", "change"]),
    ("Read-only", "View everything, change nothing.", ["view"]),
]


def ensure_builtin_groups() -> None:
    from django.contrib.auth.models import Group

    from .models import GroupProfile, ObjectPermission

    for name, desc, actions in BUILTINS:
        group, _ = Group.objects.get_or_create(name=name)
        GroupProfile.objects.update_or_create(
            group=group, defaults={"description": desc, "built_in": True}
        )
        perm, _ = ObjectPermission.objects.get_or_create(
            name=f"{name} — all objects",
            defaults={
                "description": f"Built-in grant for the {name} group.",
                "enabled": True,
                "object_types": ["*"],
                "actions": actions,
                "constraints": None,
            },
        )
        perm.groups.add(group)
