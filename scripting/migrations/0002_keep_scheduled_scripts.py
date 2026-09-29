"""Keep the schedules that ran before 0.17 running.

From 0.17 a schedule fires only while its owner may run the script (and, for
a trusted script, trust it). Before, a schedule ran whatever the owner's
grants said, so an owner in the built-in Administrator or Operator group -
neither carries run - had schedules that would silently stop on upgrade.

For each owner of an enabled schedule who could not run it, this adds a grant
named "Scheduled scripts (0.17 upgrade): <username>" with run, limited by a
row constraint to those scripts, and a second one with trust for the
trusted ones among them. That is nothing the owner could not already do:
they could make the schedule fire whenever they liked. A schedule with no
active owner, or whose owner is no longer in the script's tenant, is not
carried over - that schedule stopping is the point - and is listed in a
warning. A second run adds nothing (the owner now holds run). Reverse is a
no-op.
"""
import sys

from django.core.exceptions import FieldError
from django.db import migrations
from django.db.models import Q

ACCESS_TYPES = ("user", "group", "objectpermission")
NAME = "Scheduled scripts (0.17 upgrade): {username}"
TRUST_NAME = "Trusted scheduled scripts (0.17 upgrade): {username}"


def _covers(types, slug):
    types = types or []
    return slug in types or ("*" in types and slug not in ACCESS_TYPES)


def _in_tenant(apps, user, tenant_id) -> bool:
    """permissions.user_tenants, from the other side."""
    UserProfile = apps.get_model("auth_api", "UserProfile")
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    profile = UserProfile.objects.filter(user=user).first()
    if profile is None:
        return False
    if profile.role == "admin" or profile.tenants.filter(pk=tenant_id).exists():
        return True
    return ObjectPermission.objects.filter(
        Q(users=user) | Q(groups__in=user.groups.all()),
        enabled=True, tenants=tenant_id,
    ).exists()


def _may(apps, user, script, action) -> bool:
    """rbac.can_act_on for one script, on the frozen models."""
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    Script = apps.get_model("scripting", "Script")
    perms = ObjectPermission.objects.filter(
        Q(users=user) | Q(groups__in=user.groups.all()), enabled=True,
    ).distinct()
    for perm in perms:
        tenant_ids = set(perm.tenants.values_list("pk", flat=True))
        if tenant_ids and script.tenant_id not in tenant_ids:
            continue
        if not _covers(perm.object_types, "script") or action not in (perm.actions or []):
            continue
        c = perm.constraints
        if not c:
            return True
        dicts = [c] if isinstance(c, dict) else [d for d in c if isinstance(d, dict)]
        if not any(dicts):
            return True
        q = Q()
        for d in dicts:
            q |= Q(**d)
        try:
            if Script.objects.filter(pk=script.pk).filter(q).exists():
                return True
        except (FieldError, ValueError, TypeError):
            continue
    return False


def _grant(apps, name, action, user, scripts):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    perm = ObjectPermission.objects.create(
        name=name[:128],
        description=(
            "Made by the 0.17 upgrade, which made a schedule need the "
            f"{action} permission, so this owner's schedules keep running. "
            "Limited to those scripts."
        ),
        enabled=True,
        object_types=["script"],
        actions=[action],
        constraints={"id__in": sorted(str(s.pk) for s in scripts)},
    )
    perm.users.add(user)


def forwards(apps, schema_editor):
    Script = apps.get_model("scripting", "Script")

    by_owner: dict = {}
    stopped = []
    for script in (
        Script.objects.filter(enabled=True, schedule_enabled=True)
        .select_related("owner")
    ):
        owner = script.owner
        if owner is not None and owner.is_superuser and owner.is_active:
            continue
        if owner is None or not owner.is_active:
            stopped.append(f"{script.name} (no active owner)")
            continue
        if not _in_tenant(apps, owner, script.tenant_id):
            stopped.append(f"{script.name} ({owner.username} is not in its tenant)")
            continue
        need = by_owner.setdefault(owner.pk, (owner, [], []))
        if not _may(apps, owner, script, "run"):
            need[1].append(script)
        if script.trusted and not _may(apps, owner, script, "trust"):
            need[2].append(script)

    kept = []
    for owner, run, trust in by_owner.values():
        if run:
            _grant(apps, NAME.format(username=owner.username), "run", owner, run)
        if trust:
            _grant(apps, TRUST_NAME.format(username=owner.username), "trust", owner, trust)
        kept += [f"{s.name} ({owner.username})" for s in {*run, *trust}]
    if kept:
        sys.stdout.write(
            "\n  Scheduled scripts whose owners could not run them keep running "
            "through a grant limited to them: " + ", ".join(sorted(kept)) + ".\n"
        )
    if stopped:
        sys.stdout.write(
            "\n  WARNING: these scheduled scripts now skip their runs; each "
            "script's Schedule tab says why: " + ", ".join(sorted(stopped)) + ".\n"
        )


class Migration(migrations.Migration):

    dependencies = [
        ("scripting", "0001_initial"),
        ("auth_api", "0025_narrow_kept_access"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
