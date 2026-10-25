"""Site roles gain application group assignments (#436).

An assignment belongs to its device's or VM's site, so a site editor assigns
groups to their sites' devices and VMs and a site viewer sees them.
Application groups are the catalog those rows (and installed software) point
at, read like the catalogs of 0029. A new site role gets both from
``site_role_types`` and ``site_role_catalog_types``; the roles built before
them gain them here.

A grant counts as a site role by the rules of 0028 to 0035 (name suffix,
exactly the role's actions, limited to sites, only the role's known types). A
hand-built grant is left alone. A second run changes nothing. Reverse is a
no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0030 = importlib.import_module("auth_api.migrations.0030_site_roles_support_coverage")
_0033 = importlib.import_module("auth_api.migrations.0033_site_roles_applications")
_0035 = importlib.import_module("auth_api.migrations.0035_site_roles_application_flows")

NEW_TYPES = ["applicationgroupassignment"]
NEW_CATALOGS = ["applicationgroup"]
KNOWN = _0035.KNOWN | set(NEW_TYPES) | set(NEW_CATALOGS)


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
    """A silo editor's ``- catalog view`` grant as 0029 made it."""
    types = perm.object_types
    if not isinstance(types, list) or list(perm.actions or []) != ["view"]:
        return False
    if perm.constraints or not perm.sites.exists():
        return False
    names = {t for t in types if isinstance(t, str)}
    known = (set(_0029.ROLE_CATALOGS) | set(_0030.NEW_CATALOGS) | set(_0033.NEW_CATALOGS)
             | set(NEW_CATALOGS))
    return names and names <= known


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.VIEW_SUFFIX):
        if _looks_like_role(perm, _0028.VIEW_SUFFIX, {"view"}):
            _0028._add_types(perm, NEW_TYPES + NEW_CATALOGS)
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.EDIT_SUFFIX):
        if _looks_like_role(perm, _0028.EDIT_SUFFIX, _0028.CRUD):
            _0028._add_types(perm, NEW_TYPES)
    for perm in ObjectPermission.objects.filter(name__endswith=_0029.CATALOG_SUFFIX):
        if _looks_like_catalog_view(perm):
            _0028._add_types(perm, NEW_CATALOGS)


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0035_site_roles_application_flows"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
