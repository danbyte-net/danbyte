"""Site roles read module power port templates.

A module type's power ports are part of the module catalog, read like its
interface templates (0029): a site viewer and a site editor's ``- catalog
view`` see them, only a tenant-wide editor writes them. A new site role gets
them from ``site_role_catalog_types``; the roles built before them gain them
here.

A grant counts as a site role by the rules of 0028 to 0054. A hand-built
grant is left alone. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0051 = importlib.import_module("auth_api.migrations.0051_site_roles_sensitivity_labels")
_0054 = importlib.import_module("auth_api.migrations.0054_site_roles_device_dependencies")

NEW_TYPES = []
NEW_CATALOGS = ["modulepowerporttemplate"]
# Read through its module type: no locality of its own.
CATALOG_TYPES = set()
KNOWN = _0054.KNOWN | set(NEW_CATALOGS)


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
    """A silo editor's ``- catalog view`` grant as 0029 to 0054 left it."""
    types = perm.object_types
    if not isinstance(types, list):
        return False
    stripped = [t for t in types if t not in NEW_CATALOGS + _0054.NEW_CATALOGS]
    if not stripped:
        return False
    return _0051._looks_like_catalog_view(_0051._View(stripped, perm))


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
        ("auth_api", "0054_site_roles_device_dependencies"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
