"""Give each account 0025 kept user management for only the verbs it had.

0025 made one grant, KEPT_NAME, with the verbs of every account it kept and
gave it to all of them, so an account that could view and change users could
now add and delete them as well (#272). This splits that grant by account.

Each kept account's verbs are read again from the all-object grants that
reach it - enabled, not limited to tenants, with change, and trimmed by 0025
(a "*" grant that no longer names users, groups or permissions) - the custom
ones when there are any, the built-in groups' grants otherwise, as 0025
chose. Accounts with the same verbs share a grant: the set with the most
verbs keeps KEPT_NAME, each other set gets a grant of its own, KEPT_NAME plus
its verbs. An account none of whose grants still says what it had keeps the
grant as it is, and a warning names it. Every kept account keeps change on
users, so nobody is locked out.

A second run changes nothing. Reverse is a no-op.
"""
import sys

from django.db import migrations

# Frozen copies; a test pins them to 0025 and core.upgrade_notes.
ACCESS_TYPES = ["user", "group", "objectpermission"]
KEPT_NAME = "Kept user management (0.17 upgrade)"
CRUD = ["view", "add", "change", "delete"]
OTHER_BUILTIN_GRANT_NAMES = {
    "Operator — all objects",
    "Operator - all objects",
    "Read-only — all objects",
    "Read-only - all objects",
}


def _holders(apps, perm) -> set:
    User = apps.get_model("auth", "User")
    ids = set(perm.users.filter(is_active=True).values_list("pk", flat=True))
    ids |= set(
        User.objects.filter(is_active=True, groups__in=perm.groups.all())
        .values_list("pk", flat=True)
    )
    return ids


def _sources(apps):
    """``[(holders, verbs, built_in)]`` for the grants 0025 read verbs from."""
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    out = []
    for perm in ObjectPermission.objects.filter(enabled=True):
        types = list(perm.object_types or [])
        actions = set(perm.actions or [])
        if "*" not in types or any(t in ACCESS_TYPES for t in types):
            continue
        if "change" not in actions or perm.tenants.exists():
            continue
        out.append((
            _holders(apps, perm),
            {a for a in actions if a in CRUD},
            perm.name in OTHER_BUILTIN_GRANT_NAMES,
        ))
    return out


def _own_verbs(sources, uid) -> frozenset:
    custom, builtin = set(), set()
    for holders, verbs, built_in in sources:
        if uid in holders:
            (builtin if built_in else custom).update(verbs)
    return frozenset(custom or builtin)


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    User = apps.get_model("auth", "User")

    kept = ObjectPermission.objects.filter(name=KEPT_NAME).first()
    if kept is None:
        return
    sources = _sources(apps)
    by_verbs: dict[frozenset, list] = {}
    unknown = []
    for uid in kept.users.values_list("pk", flat=True):
        verbs = _own_verbs(sources, uid)
        if "change" in verbs:
            by_verbs.setdefault(verbs, []).append(uid)
        else:
            unknown.append(uid)
    if not unknown and len(by_verbs) <= 1:
        # One set of verbs: the grant says exactly that, nothing to split.
        for verbs in by_verbs:
            if set(kept.actions or []) != verbs:
                kept.actions = [a for a in CRUD if a in verbs]
                kept.save()
        return

    ordered = sorted(by_verbs.items(), key=lambda kv: (-len(kv[0]), sorted(kv[0])))
    own = []
    if not unknown and ordered:
        # The widest set keeps the grant (and its history).
        verbs, uids = ordered.pop(0)
        kept.actions = [a for a in CRUD if a in verbs]
        kept.save()
        kept.users.set(uids)
    else:
        # Accounts we can't read stay on the grant as it is.
        kept.users.set(unknown)
    for verbs, uids in ordered:
        listed = [a for a in CRUD if a in verbs]
        grant, _ = ObjectPermission.objects.get_or_create(
            name=f"{KEPT_NAME}: {', '.join(listed)}",
            defaults={
                "description": kept.description,
                "enabled": True,
                "object_types": list(ACCESS_TYPES),
                "actions": listed,
                "constraints": None,
            },
        )
        grant.users.add(*uids)
        own.append((grant.name, uids))
    for name, uids in own:
        names = sorted(User.objects.filter(pk__in=uids).values_list("username", flat=True))
        sys.stdout.write(
            f'\n  "{name}" now gives {", ".join(names)} only the verbs they had '
            f'(they were on "{KEPT_NAME}").\n'
        )
    if unknown:
        names = sorted(User.objects.filter(pk__in=unknown).values_list("username", flat=True))
        sys.stdout.write(
            f'\n  WARNING: no all-object grant still shows what {", ".join(names)} '
            f'had, so they keep "{KEPT_NAME}" as it is. Check what it gives them.\n'
        )


class Migration(migrations.Migration):

    dependencies = [
        ("auth_api", "0025_narrow_kept_access"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
