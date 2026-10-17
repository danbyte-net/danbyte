"""The built-in Administrator grant lists view_credits and view_cost.

A "*" grant carries only the verbs it lists, so before 0.18 administrators saw
neither SLA service credits nor support-contract cost unless a grant named
those verbs. Administrators manage the grants and could give themselves both,
so the built-in Administrator grant now lists them; Operator and Read-only do
not.

Only the seeded grant changes: one of the names 0007 or builtin_groups wrote,
held by the built-in Administrator group (0024's rule, so a renamed group still
counts) and by no other group. A grant shared with another group is left alone
and a note names it, or that group would gain the verbs. Copies under other
names are not touched. Additive; a second run changes nothing. Reverse is a
no-op.
"""
import importlib
import sys

from django.db import migrations

_0024 = importlib.import_module("auth_api.migrations.0024_wildcard_excludes_access")

# Frozen copy of auth_api.builtin_groups.MONEY_VERBS; a test pins the two.
MONEY_VERBS = ["view_credits", "view_cost"]


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")

    admin_gids = _0024._admin_group_ids(apps)
    if not admin_gids:
        return
    shared = []
    for perm in ObjectPermission.objects.filter(name__in=_0024.ADMIN_GRANT_NAMES):
        group_ids = set(perm.groups.values_list("pk", flat=True))
        if not group_ids & admin_gids:
            continue
        if not group_ids <= admin_gids:
            shared.append(perm.name)
            continue
        have = list(perm.actions or [])
        missing = [a for a in MONEY_VERBS if a not in have]
        if missing:
            perm.actions = have + missing
            perm.save()
    if shared:
        sys.stdout.write(
            "\n  NOTE: these Administrator grants are shared with other groups, so "
            "they did not gain view_credits and view_cost: "
            + ", ".join(sorted(shared))
            + ". Add the verbs by hand if those groups should see costs and credits.\n"
        )


class Migration(migrations.Migration):

    dependencies = [
        ("auth_api", "0030_site_roles_support_coverage"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
