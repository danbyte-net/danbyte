"""All-object grants stop reaching users, groups and permissions.

From 0.17 the "*" wildcard covers every object type except user, group and
objectpermission. A grant reaches those only by naming them, and change on
user is what makes someone an administrator. So that no deployment loses its
administrators, this names the three types on the "*" grants that were
administrator grants:

* grants with view, add, change and delete, whatever their tenant, site or
  row scope, except the built-in Operator and Read-only grants;
* grants carrying grant_superuser (a verb only the user type honours);
* grants whose only holder is the built-in Administrator group.

Every other "*" grant loses the three types - that is the fix. If that leaves
no active account able to manage the deployment while one could before, the
three types go back on the enabled, tenant-unscoped "*" grants with change
that reach an active account, and a warning is printed; the 0.17.0 upgrade
note says the same in the app.

It also rewrites the built-in Operator and Read-only descriptions while they
are still the seeded text. A second run changes nothing. Reverse is a no-op:
under the old engine ["*", "user", ...] meant exactly ["*"].
"""
import sys

from django.db import migrations, models

# Frozen copy of auth_api.object_types.ACCESS_TYPES; a test pins the two.
ACCESS_TYPES = ["user", "group", "objectpermission"]
CRUD = {"view", "add", "change", "delete"}
# 0007 seeded these names with an em dash, builtin_groups.py with a hyphen.
ADMIN_GRANT_NAMES = {"Administrator — all objects", "Administrator - all objects"}
OTHER_BUILTIN_GRANT_NAMES = {
    "Operator — all objects",
    "Operator - all objects",
    "Read-only — all objects",
    "Read-only - all objects",
}
DESCRIPTIONS = {
    "Operator": (
        "Create and edit, but not delete.",
        "Create and edit, but not delete. No access to users, groups or permissions.",
    ),
    "Read-only": (
        "View everything, change nothing.",
        "View everything except users, groups and permissions; change nothing.",
    ),
}


def _admin_group_ids(apps):
    """The built-in Administrator group; if it was renamed, the built-in group
    on a seeded Administrator grant."""
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


def _is_admin_grant(perm, admin_gids):
    if perm.name in OTHER_BUILTIN_GRANT_NAMES:
        return False
    actions = set(perm.actions or [])
    if CRUD <= actions or "grant_superuser" in actions:
        return True
    # Held by the Administrator group and nobody else: an Administrator grant
    # that was edited down. Shared with another group it is not, or the fix
    # would hand that group user administration.
    group_ids = set(perm.groups.values_list("pk", flat=True))
    return bool(group_ids) and group_ids <= admin_gids and not perm.users.exists()


def _add_access(perm) -> bool:
    types = list(perm.object_types or [])
    missing = [t for t in ACCESS_TYPES if t not in types]
    if not missing:
        return False
    perm.object_types = types + missing
    perm.save()
    return True


def _reaches_active_user(apps, perm) -> bool:
    User = apps.get_model("auth", "User")
    if perm.users.filter(is_active=True).exists():
        return True
    return User.objects.filter(is_active=True, groups__in=perm.groups.all()).exists()


def _deployment_admin_exists(apps, *, wildcard_counts: bool) -> bool:
    """Can an active account manage the deployment? Mirrors
    permissions.can_manage_deployment: a superuser, the legacy admin role or
    users.manage slug, or an enabled tenant-unscoped grant with change on
    user - where ``wildcard_counts`` says whether "*" still reaches user."""
    User = apps.get_model("auth", "User")
    UserProfile = apps.get_model("auth_api", "UserProfile")
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")

    if User.objects.filter(is_active=True, is_superuser=True).exists():
        return True
    profiles = UserProfile.objects.filter(user__is_active=True)
    if profiles.filter(role="admin").exists():
        return True
    if (
        profiles.exclude(role__in=("admin", "reader"))
        .filter(permissions__contains=["users.manage"])
        .exists()
    ):
        return True
    for perm in ObjectPermission.objects.filter(enabled=True, tenants__isnull=True):
        types = perm.object_types or []
        if "change" not in (perm.actions or []):
            continue
        if "user" in types or (wildcard_counts and "*" in types):
            if _reaches_active_user(apps, perm):
                return True
    return False


def _keep_old_access(apps) -> list[str]:
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    kept = []
    for perm in ObjectPermission.objects.filter(enabled=True, tenants__isnull=True):
        if "*" not in (perm.object_types or []) or "change" not in (perm.actions or []):
            continue
        if _reaches_active_user(apps, perm) and _add_access(perm):
            kept.append(perm.name)
    return kept


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    GroupProfile = apps.get_model("auth_api", "GroupProfile")

    had_admin = _deployment_admin_exists(apps, wildcard_counts=True)
    admin_gids = _admin_group_ids(apps)
    for perm in ObjectPermission.objects.all():
        if "*" in (perm.object_types or []) and _is_admin_grant(perm, admin_gids):
            _add_access(perm)

    for name, (old, new) in DESCRIPTIONS.items():
        GroupProfile.objects.filter(
            built_in=True, group__name=name, description=old
        ).update(description=new)

    if had_admin and not _deployment_admin_exists(apps, wildcard_counts=False):
        kept = _keep_old_access(apps)
        if kept:
            sys.stdout.write(
                "\n  WARNING: no account could manage users without them, so these "
                "all-object grants keep users, groups and permissions: "
                + ", ".join(sorted(kept))
                + ". Put your administrators in the Administrator group, then "
                "remove those three types from these grants.\n"
            )


class Migration(migrations.Migration):

    dependencies = [
        ('auth_api', '0023_ldapgroupmapping_grants_superuser'),
    ]

    operations = [
        migrations.AlterField(
            model_name='objectpermission',
            name='object_types',
            field=models.JSONField(default=list, help_text='Object-type slugs this permission covers (see object_types registry). "*" = every type except user, group and objectpermission, which must be named.'),
        ),
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
