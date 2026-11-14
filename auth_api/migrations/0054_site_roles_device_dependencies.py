"""Site roles gain device dependencies (#450).

A dependency belongs to its downstream device's site, else its upstream's,
so a site editor records the dependencies of their sites' devices and a site
viewer reads them. Dependency media are the catalog those rows point at: a
site viewer and a site editor read them, only a tenant-wide editor writes
them (a site-local medium under site separation, as the other catalogs). A
new site role gets both from ``site_role_types`` and
``site_role_catalog_types``; the roles built before them gain them here - the
type for viewers and editors, the catalog for viewers and an editor's
``- catalog view``.

A grant counts as a site role by the rules of 0028 to 0052. A hand-built
grant is left alone. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0051 = importlib.import_module("auth_api.migrations.0051_site_roles_sensitivity_labels")
_0052 = importlib.import_module("auth_api.migrations.0052_site_roles_vulnerability_exceptions")

NEW_TYPES = ["devicedependency"]
NEW_CATALOGS = ["dependencymedium"]
# The medium is a catalog with locality, as 0028's are.
CATALOG_TYPES = set(NEW_CATALOGS)
KNOWN = _0052.KNOWN | set(NEW_TYPES) | set(NEW_CATALOGS)


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
    """A silo editor's ``- catalog view`` grant as 0029 to 0053 left it."""
    types = perm.object_types
    if not isinstance(types, list):
        return False
    stripped = [t for t in types if t not in NEW_CATALOGS]
    if not stripped:
        return False
    return _0051._looks_like_catalog_view(_0051._View(stripped, perm))


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
        ("auth_api", "0053_layout_presets"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
