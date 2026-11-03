"""Site roles read RPKI caches.

RPKI caches are a tenant-wide catalog that BGP instances point at: a site
viewer and a site editor read them, only a tenant-wide editor writes them. A
new site role gets the type from ``site_role_catalog_types``; the roles built
before it gain it here - a viewer grant and an editor's ``- catalog view``.
ROAs are tenant-wide and no site row points at them, so no site role reads
them.

A grant counts as a site role by the rules of 0028 to 0049. A hand-built
grant is left alone. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0049 = importlib.import_module("auth_api.migrations.0049_site_roles_routing_rows")

NEW_CATALOGS = ["rpkicache"]
KNOWN = _0049.KNOWN | set(NEW_CATALOGS)


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
            _0028._add_types(perm, NEW_CATALOGS)
    for perm in ObjectPermission.objects.filter(name__endswith=_0029.CATALOG_SUFFIX):
        # A silo editor's ``- catalog view`` grant as 0029 to 0049 left it.
        if _0049._looks_like_catalog_view(perm):
            _0028._add_types(perm, NEW_CATALOGS)


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0049_site_roles_routing_rows"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
