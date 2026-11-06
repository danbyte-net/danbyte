"""Site roles read sensitivity labels.

Sensitivity labels are a tenant-wide catalog PDF reports are marked with: a
site viewer and a site editor read them so their reports can carry one, only
a tenant-wide editor writes them. A new site role gets the type from
``site_role_catalog_types`` (``SITE_ROLE_EXTRA_CATALOGS``); the roles built
before it gain it here - a viewer grant and an editor's ``- catalog view``.

A grant counts as a site role by the rules of 0028 to 0050. A hand-built
grant is left alone. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0029 = importlib.import_module("auth_api.migrations.0029_site_roles_catalog_view")
_0049 = importlib.import_module("auth_api.migrations.0049_site_roles_routing_rows")
_0050 = importlib.import_module("auth_api.migrations.0050_site_roles_rpki_caches")

NEW_CATALOGS = ["sensitivitylabel"]
KNOWN = _0050.KNOWN | set(NEW_CATALOGS)


def _looks_like_catalog_view(perm) -> bool:
    """A silo editor's ``- catalog view`` grant as 0029 to 0050 left it."""
    types = perm.object_types
    if not isinstance(types, list) or list(perm.actions or []) != ["view"]:
        return False
    if perm.constraints or not perm.sites.exists():
        return False
    names = {t for t in types if isinstance(t, str)}
    extra = set(_0050.NEW_CATALOGS) | set(NEW_CATALOGS)
    if not names or not names - extra:
        return False
    stripped = [t for t in types if t not in extra]
    return _0049._looks_like_catalog_view(_View(stripped, perm))


class _View:
    """``perm`` with ``types`` in place of its own, for an earlier check."""

    def __init__(self, types, perm):
        self.object_types = types
        self.actions = perm.actions
        self.constraints = perm.constraints
        self.sites = perm.sites


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    for perm in ObjectPermission.objects.filter(name__endswith=_0028.VIEW_SUFFIX):
        if _0050._looks_like_role(perm, _0028.VIEW_SUFFIX, {"view"}):
            _0028._add_types(perm, NEW_CATALOGS)
    for perm in ObjectPermission.objects.filter(name__endswith=_0029.CATALOG_SUFFIX):
        if _looks_like_catalog_view(perm):
            _0028._add_types(perm, NEW_CATALOGS)


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0050_site_roles_rpki_caches"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
