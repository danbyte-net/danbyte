"""Site roles gain cooling intakes and outflows (#434).

Both are device components and belong to their device's site, like power
ports and outlets, so a site editor manages the cooling components of their
sites' devices and a site viewer sees them. A new site role gets both from
``site_role_types``; the roles built before them gain them here.

A grant counts as a site role by the rules of 0028 to 0033 (name suffix,
exactly the role's actions, limited to sites, only the role's known types). A
hand-built grant is left alone. A second run changes nothing. Reverse is a
no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0033 = importlib.import_module("auth_api.migrations.0033_site_roles_applications")

NEW_TYPES = ["coolingintake", "coolingoutflow"]
NEW_CATALOGS: list[str] = []
# Their device-type templates take the type's locality, as 0028's do.
CATALOG_TYPES = {"coolingintaketemplate", "coolingoutflowtemplate"}
KNOWN = _0033.KNOWN | set(NEW_TYPES) | CATALOG_TYPES


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
        ("auth_api", "0033_site_roles_applications"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
