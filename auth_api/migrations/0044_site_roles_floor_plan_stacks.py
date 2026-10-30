"""Site roles gain floor plan stacks.

A floor plan stack (the floors of a building or hall) belongs to its
location's site. Its endpoints follow the ``floorplan`` grant, which site roles
already hold; the type is listed so a role names everything at its sites, as
it does for floor-plan drawings. A new site role gets it from
``site_role_types``; the roles built before it gain it here.

A grant counts as a site role by the rules of 0028 to 0043 (name suffix,
exactly the role's actions, limited to sites, only the role's known types). A
hand-built grant is left alone. A second run changes nothing. Reverse is a
no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0043 = importlib.import_module("auth_api.migrations.0043_site_roles_rooms")

NEW_TYPES = ["floorplanstack"]
KNOWN = _0043.KNOWN | set(NEW_TYPES)


def _looks_like_role(perm, suffix, actions) -> bool:
    types = perm.object_types
    if not perm.name.endswith(suffix) or not isinstance(types, list):
        return False
    if set(perm.actions or []) != actions or len(perm.actions) != len(actions):
        return False
    if perm.constraints:
        return False
    names = {t for t in types if isinstance(t, str)}
    return _0028.CORE <= names and names <= KNOWN and perm.sites.exists()


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.VIEW_SUFFIX):
        if _looks_like_role(perm, _0028.VIEW_SUFFIX, {"view"}):
            _0028._add_types(perm, NEW_TYPES)
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.EDIT_SUFFIX):
        if _looks_like_role(perm, _0028.EDIT_SUFFIX, _0028.CRUD):
            _0028._add_types(perm, NEW_TYPES)


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0043_site_roles_rooms"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
