"""Narrow what 0024 left on all-object grants.

0024 named users, groups and permissions on every "*" grant with view, add,
change and delete, including grants limited to sites or by row constraints.
Neither limit narrows those three types, so the holders of a "full control of
site X" grant became user administrators of the whole deployment. And when no
other administrator would have remained, 0024 kept the three types on every
unscoped "*" grant with change - the built-in Operator grant included - so
every Operator, and everyone who joins the group later, stayed one.

This takes the three types off every "*" grant except an administrator
grant:

* one carrying grant_superuser (a verb only the user type honours);
* one held only by the built-in Administrator group;
* one with view, add, change and delete that is limited neither to sites nor
  by row constraints (a tenant limit is fine: that stays a tenant admin),
  and is not the built-in Operator or Read-only grant.

If that leaves no active account able to manage the deployment while one
could before, the accounts that lost it get one grant of their own, named
KEPT_NAME, with the three types and the verbs they had - those reached
through a custom grant when there are any, the built-in groups' members only
when there are not - and a warning is printed. The shared grants stay
trimmed, so nobody who joins those groups later inherits it. The 0.17.0
upgrade note stays pending while that grant reaches someone.

A second run changes nothing. Reverse is a no-op: under the old engine the
removed types were implied by "*".
"""
import sys

from django.db import migrations

# Frozen copies; a test pins them to auth_api.object_types.ACCESS_TYPES and
# core.upgrade_notes.KEPT_ACCESS_GRANT.
ACCESS_TYPES = ["user", "group", "objectpermission"]
KEPT_NAME = "Kept user management (0.17 upgrade)"
CRUD = ["view", "add", "change", "delete"]
ADMIN_GRANT_NAMES = {"Administrator — all objects", "Administrator - all objects"}
OTHER_BUILTIN_GRANT_NAMES = {
    "Operator — all objects",
    "Operator - all objects",
    "Read-only — all objects",
    "Read-only - all objects",
}


def _admin_group_ids(apps):
    GroupProfile = apps.get_model("auth_api", "GroupProfile")
    ids = set(
        GroupProfile.objects.filter(built_in=True, group__name="Administrator")
        .values_list("group_id", flat=True)
    )
    if not ids:
        ids = set(
            GroupProfile.objects.filter(
                built_in=True,
                group__object_permissions__name__in=ADMIN_GRANT_NAMES,
            )
            .exclude(group__name__in=("Operator", "Read-only"))
            .values_list("group_id", flat=True)
        )
    return ids


def _constrained(value) -> bool:
    if isinstance(value, dict):
        return bool(value)
    if isinstance(value, list):
        return any(isinstance(d, dict) and d for d in value)
    return False


def _keeps_access(perm, admin_gids) -> bool:
    if perm.name in OTHER_BUILTIN_GRANT_NAMES:
        return False
    actions = set(perm.actions or [])
    if "grant_superuser" in actions:
        return True
    group_ids = set(perm.groups.values_list("pk", flat=True))
    if group_ids and group_ids <= admin_gids and not perm.users.exists():
        return True
    return (
        set(CRUD) <= actions
        and not perm.sites.exists()
        and not _constrained(perm.constraints)
    )


def _holders(apps, perm) -> set:
    User = apps.get_model("auth", "User")
    ids = set(perm.users.filter(is_active=True).values_list("pk", flat=True))
    ids |= set(
        User.objects.filter(is_active=True, groups__in=perm.groups.all())
        .values_list("pk", flat=True)
    )
    return ids


def _deployment_admins(apps) -> set:
    """Active accounts that can manage the deployment under the 0.17 rule.
    Mirrors permissions.can_manage_deployment: a superuser, the legacy admin
    role or users.manage slug, or an enabled tenant-unscoped grant with change
    that names user."""
    User = apps.get_model("auth", "User")
    UserProfile = apps.get_model("auth_api", "UserProfile")
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")

    ids = set(
        User.objects.filter(is_active=True, is_superuser=True).values_list("pk", flat=True)
    )
    profiles = UserProfile.objects.filter(user__is_active=True)
    ids |= set(profiles.filter(role="admin").values_list("user_id", flat=True))
    ids |= set(
        profiles.exclude(role__in=("admin", "reader"))
        .filter(permissions__contains=["users.manage"])
        .values_list("user_id", flat=True)
    )
    for perm in ObjectPermission.objects.filter(enabled=True, tenants__isnull=True):
        if "change" in (perm.actions or []) and "user" in (perm.object_types or []):
            ids |= _holders(apps, perm)
    return ids


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")

    before = _deployment_admins(apps)
    admin_gids = _admin_group_ids(apps)
    trimmed = []
    for perm in ObjectPermission.objects.all():
        types = list(perm.object_types or [])
        if "*" not in types or not any(t in ACCESS_TYPES for t in types):
            continue
        if _keeps_access(perm, admin_gids):
            continue
        perm.object_types = [t for t in types if t not in ACCESS_TYPES]
        perm.save()
        trimmed.append((perm, [t for t in types if t in ACCESS_TYPES]))

    if not before or _deployment_admins(apps):
        return

    # Nobody can manage users any more. Give the accounts that lost it a grant
    # of their own; prefer those a custom grant reached over the members of a
    # built-in group.
    custom, builtin = {}, {}
    for perm, had in trimmed:
        actions = set(perm.actions or [])
        if not perm.enabled or perm.tenants.exists():
            continue
        if "user" not in had or "change" not in actions:
            continue
        holders = _holders(apps, perm) & before
        if not holders:
            continue
        side = builtin if perm.name in OTHER_BUILTIN_GRANT_NAMES else custom
        for uid in holders:
            side.setdefault(uid, set()).update(a for a in actions if a in CRUD)
    keep = custom or builtin
    if not keep:
        return
    verbs = set().union(*keep.values())
    kept = ObjectPermission.objects.create(
        name=KEPT_NAME,
        description=(
            "Made by the 0.17 upgrade. All object types no longer covers "
            "users, groups and permissions, and these accounts managed users "
            "only through an all-object grant. Put your administrators in the "
            "Administrator group, then delete this grant."
        ),
        enabled=True,
        object_types=list(ACCESS_TYPES),
        actions=[a for a in CRUD if a in verbs],
        constraints=None,
    )
    kept.users.set(sorted(keep))
    User = apps.get_model("auth", "User")
    names = sorted(User.objects.filter(pk__in=keep).values_list("username", flat=True))
    sys.stdout.write(
        f'\n  WARNING: no account could manage users without it, so "{KEPT_NAME}" '
        "gives " + ", ".join(names) + " users, groups and permissions. Put your "
        "administrators in the Administrator group, then delete that grant.\n"
    )


class Migration(migrations.Migration):

    dependencies = [
        ("auth_api", "0024_wildcard_excludes_access"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
