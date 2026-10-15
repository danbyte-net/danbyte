"""The one-click site roles read the catalogs their types use (#425).

A silo site editor (``<label> - site edit`` with no ``<label> - read all``)
had no view on device types, roles, platforms, statuses, tags, custom fields
and the other catalogs its own objects point at, so the Add device pickers
were empty and an import by name failed. A site viewer had the same gap.

* A silo editor gets ``<label> - catalog view``: view on those catalogs,
  limited to the same sites, held by the same users and groups.
* A viewer grant (``<label> - site view``) gains the catalog types.

A grant counts as a site role only when it still looks like one, the same
test as 0028. A second run changes nothing. Reverse is a no-op.
"""
import importlib

from django.db import migrations

_0028 = importlib.import_module("auth_api.migrations.0028_site_roles_site_view")

CATALOG_SUFFIX = " - catalog view"

# Frozen: auth_api.site_paths.site_role_catalog_types() in this release.
ROLE_CATALOGS = [
    "asn", "bfdprofile", "bgppeergroup", "cabinetrole", "cabinettype",
    "clustergroup", "clustertype", "customfield", "customfieldgroup",
    "devicerole", "devicetype", "floortiletype", "iprole", "manufacturer",
    "moduleinterfacetemplate", "moduletype", "ospfarea", "platform", "rackrole",
    "racktype", "routingkeychain", "routingpolicy", "status", "tag", "vrf",
    "zone",
]
KNOWN = _0028.KNOWN | set(ROLE_CATALOGS)


def _looks_like_role(perm, suffix, actions) -> bool:
    """0028's test, with this release's catalog types counted as known."""
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
            _0028._add_types(perm, ROLE_CATALOGS)

    for perm in ObjectPermission.objects.filter(name__endswith=_0028.EDIT_SUFFIX):
        if not _looks_like_role(perm, _0028.EDIT_SUFFIX, _0028.CRUD):
            continue
        label = perm.name[: -len(_0028.EDIT_SUFFIX)]
        if ObjectPermission.objects.filter(
            name=f"{label}{_0028.READ_ALL_SUFFIX}", object_types=["*"],
            actions=["view"], sites__isnull=True,
        ).exists():
            continue  # reads everything already
        name = f"{label}{CATALOG_SUFFIX}"[:128]
        if ObjectPermission.objects.filter(name=name, actions=["view"]).exists():
            continue
        grant = ObjectPermission.objects.create(
            name=name, object_types=list(ROLE_CATALOGS), actions=["view"],
            enabled=perm.enabled,
        )
        grant.tenants.set(perm.tenants.all())
        grant.sites.set(perm.sites.all())
        grant.users.set(perm.users.all())
        grant.groups.set(perm.groups.all())


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0028_site_roles_site_view"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
