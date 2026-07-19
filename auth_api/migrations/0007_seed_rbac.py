"""Seed the built-in RBAC groups and migrate existing users onto them.

Built-ins (object_types = ["*"] → every type, so future types are covered):
  * Administrator — all actions
  * Operator      — view + add + change
  * Read-only     — view

Existing users: superuser or role=admin → Administrator; role=reader →
Read-only; anything else (custom) → Operator. Tenant membership is untouched,
so nobody loses access — the new precision is opt-in.
"""
from django.db import migrations

BUILTINS = [
    ("Administrator", "Full access to everything.", ["view", "add", "change", "delete"]),
    ("Operator", "Create and edit, but not delete.", ["view", "add", "change"]),
    ("Read-only", "View everything, change nothing.", ["view"]),
]


def seed(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    GroupProfile = apps.get_model("auth_api", "GroupProfile")
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    UserProfile = apps.get_model("auth_api", "UserProfile")
    User = apps.get_model("auth", "User")

    by_name = {}
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
        perm.object_types = ["*"]
        perm.actions = actions
        perm.save()
        perm.groups.add(group)
        by_name[name] = group

    # Map existing users onto a built-in group.
    for user in User.objects.all():
        prof = UserProfile.objects.filter(user=user).first()
        role = prof.role if prof else "reader"
        if user.is_superuser or role == "admin":
            target = by_name["Administrator"]
        elif role == "reader":
            target = by_name["Read-only"]
        else:
            target = by_name["Operator"]
        user.groups.add(target)


def unseed(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Group.objects.filter(name__in=[b[0] for b in BUILTINS]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0006_userprofile_auth_source_userprofile_mfa_email_and_more"),
        ("auth", "0012_alter_user_first_name_max_length"),
    ]

    operations = [migrations.RunPython(seed, unseed)]
