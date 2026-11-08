"""Site roles read area types.

Area types are a tenant-wide catalog that floor-plan areas point at: a site
viewer and a site editor read them, only a tenant-wide editor writes them. A
new site role gets the type from ``site_role_catalog_types``; the roles built
before it gain it here - a viewer grant and an editor's ``- catalog view``.

A grant counts as a site role by the rules of 0028 to 0047. A hand-built
grant is left alone. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0046 = importlib.import_module(
    "auth_api.migrations.0046_site_roles_location_types_outlines"
)
_0047 = importlib.import_module(
    "auth_api.migrations.0047_site_roles_floor_plan_cable_paths"
)

NEW_CATALOGS = ["areatype"]
KNOWN = _0047.KNOWN | set(NEW_CATALOGS)


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


def _looks_like_catalog_view(perm) -> bool:
    """A silo editor's ``- catalog view`` grant as 0029 to 0046 left it."""
    types = perm.object_types
    if not isinstance(types, list) or list(perm.actions or []) != ["view"]:
        return False
    if perm.constraints or not perm.sites.exists():
        return False
    names = {t for t in types if isinstance(t, str)}
    known = (set(_0029.ROLE_CATALOGS) | set(_0046._0030.NEW_CATALOGS)
             | set(_0046._0033.NEW_CATALOGS) | set(_0046._0036.NEW_CATALOGS)
             | set(_0046._0041.NEW_CATALOGS) | set(_0046._0042.NEW_CATALOGS)
             | set(_0046.NEW_CATALOGS) | set(NEW_CATALOGS))
    return bool(names) and names <= known


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.VIEW_SUFFIX):
        if _looks_like_role(perm, _0028.VIEW_SUFFIX, {"view"}):
            _0028._add_types(perm, NEW_CATALOGS)
    for perm in ObjectPermission.objects.filter(name__endswith=_0029.CATALOG_SUFFIX):
        if _looks_like_catalog_view(perm):
            _0028._add_types(perm, NEW_CATALOGS)


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0047_site_roles_floor_plan_cable_paths"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
