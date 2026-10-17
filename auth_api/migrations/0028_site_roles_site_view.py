"""Bring the one-click site roles up to their 0.18 definition (#414, #415).

A site role is the grant set ``auth_api.api.assemble_site_role`` builds:
``<label> - site edit`` (view/add/change/delete, limited to sites), with
``<label> - read all`` unless it is a silo, or ``<label> - site view``
(view, limited to sites). Two things changed:

* Site viewers, and silo site editors, had no view on the site record, so
  they couldn't open their own site (#415). A viewer grant gains ``site``;
  a silo editor gets ``<label> - site record``: view on ``site``, limited to
  the same sites, held by the same users and groups.
* Services, NAT rules, VLAN groups and the other types that belong to a site
  through their device, VM, prefix or cluster are now site-scoped (#414) and
  part of both roles. The grants gain them.

A grant counts as a site role only when it still looks like one: the name
suffix, exactly the role's actions, limited to sites, and only site-bound or
catalog types including device, prefix and IP address. A hand-built grant is
left alone. Types an administrator removed earlier are not added back - only
the ones new in this release.

A second run changes nothing. Reverse is a no-op.
"""
from django.db import migrations

EDIT_SUFFIX = " - site edit"
VIEW_SUFFIX = " - site view"
READ_ALL_SUFFIX = " - read all"
RECORD_SUFFIX = " - site record"
CRUD = {"view", "add", "change", "delete"}

# Frozen: the role's types before this release (SITE_PATHS less site and
# sitesettings) and the catalog types it gains under site separation.
OLD_ROLE_TYPES = {
    "antenna", "auxport", "bgpaddressfamily", "bgpinstance", "bgpsession",
    "cabinet", "circuittermination", "cluster", "consoleport",
    "consoleserverport", "device", "devicebay", "devicecredential",
    "eigrpinstance", "eigrpinterface", "floorplan", "floorplandrawing",
    "floorplanraisedfloorarea", "floorplantile", "floorplantray",
    "floorplanwall", "frontport", "interface", "inventoryitem", "ipaddress",
    "isisinstance", "isisinterface", "ldpinstance", "location", "macaddress",
    "module", "modulebay", "ospfinstance", "ospfinterface", "oxidizednodelink",
    "portreservation", "powerfeed", "poweroutlet", "powerport", "powerpanel",
    "prefix", "rack", "rearport", "sshhostkey", "staticroute",
    "virtualmachine", "virtualmachinegroup", "vlan", "vminterface", "vtep",
    "vtepmembership",
}
CATALOG_TYPES = {
    "tag", "devicetype", "manufacturer", "status", "iprole", "vrf",
    "routetarget", "customfield", "customfieldgroup", "zone",
    "interfacetemplate", "consoleporttemplate", "consoleserverporttemplate",
    "powerporttemplate", "poweroutlettemplate", "rearporttemplate",
    "frontporttemplate", "auxporttemplate", "antennatemplate",
    "devicebaytemplate", "modulebaytemplate", "inventoryitemtemplate",
    "devicetypeservice",
}
# Site-bound and part of the roles from this release on.
NEW_ROLE_TYPES = [
    "fhrpgroupassignment", "iprange", "l2vpntermination", "natrule",
    "redistribution", "service", "sitemarker", "tunneltermination",
    "virtualchassis", "virtualdisk", "virtualswitch", "vlangroup",
]
CORE = {"device", "prefix", "ipaddress"}
KNOWN = OLD_ROLE_TYPES | CATALOG_TYPES | set(NEW_ROLE_TYPES) | {"site"}


def _looks_like_role(perm, suffix, actions) -> bool:
    types = perm.object_types
    if not perm.name.endswith(suffix) or not isinstance(types, list):
        return False
    if set(perm.actions or []) != actions or len(perm.actions) != len(actions):
        return False
    if perm.constraints:
        return False
    names = {t for t in types if isinstance(t, str)}
    return CORE <= names and names <= KNOWN and perm.sites.exists()


def _add_types(perm, extra) -> bool:
    missing = [t for t in extra if t not in perm.object_types]
    if not missing:
        return False
    perm.object_types = sorted([*perm.object_types, *missing])
    perm.save(update_fields=["object_types"])
    return True


def forwards(apps, schema_editor):
    ObjectPermission = apps.get_model("auth_api", "ObjectPermission")
    for perm in ObjectPermission.objects.filter(name__endswith=VIEW_SUFFIX):
        if _looks_like_role(perm, VIEW_SUFFIX, {"view"}):
            _add_types(perm, ["site", *NEW_ROLE_TYPES])

    for perm in ObjectPermission.objects.filter(name__endswith=EDIT_SUFFIX):
        if not _looks_like_role(perm, EDIT_SUFFIX, CRUD):
            continue
        _add_types(perm, NEW_ROLE_TYPES)
        label = perm.name[: -len(EDIT_SUFFIX)]
        if ObjectPermission.objects.filter(
            name=f"{label}{READ_ALL_SUFFIX}", object_types=["*"], actions=["view"],
            sites__isnull=True,
        ).exists():
            continue  # reads everything already, the site record included
        record_name = f"{label}{RECORD_SUFFIX}"[:128]
        if ObjectPermission.objects.filter(
            name=record_name, object_types=["site"], actions=["view"]
        ).exists():
            continue
        record = ObjectPermission.objects.create(
            name=record_name, object_types=["site"], actions=["view"],
            enabled=perm.enabled,
        )
        record.tenants.set(perm.tenants.all())
        record.sites.set(perm.sites.all())
        record.users.set(perm.users.all())
        record.groups.set(perm.groups.all())


class Migration(migrations.Migration):
    dependencies = [
        ("auth_api", "0027_userprofile_totp_last_used_step"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
