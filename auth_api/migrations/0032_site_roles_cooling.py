"""Site roles gain cooling sources and feeds (#434).

A cooling source belongs to a site and a feed to its source's site, like power
panels and feeds, so a site editor manages the cooling plant of their sites
and a site viewer sees it. A new site role gets both from ``site_role_types``;
the roles built before them gain them here.

A grant counts as a site role by the rules of 0028 to 0030 (name suffix,
exactly the role's actions, limited to sites, only the role's known types). A
hand-built grant is left alone. A second run changes nothing. Reverse is a
no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")
_0030 = importlib.import_module("auth_api.migrations.0030_site_roles_support_coverage")

NEW_TYPES = ["coolingsource", "coolingfeed"]
NEW_CATALOGS: list[str] = []
KNOWN = _0030.KNOWN | set(NEW_TYPES)


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
        ("auth_api", "0031_administrator_money_verbs"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
