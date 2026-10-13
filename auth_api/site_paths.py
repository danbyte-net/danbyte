"""Object-type → ORM path to its Site, for site-scoped ObjectPermissions.

A permission with a non-empty ``sites`` set narrows each object type's queryset
by filtering ``<path>__in=<site ids>`` (for the *view* action, rows whose site
is NULL are also visible - shared context - but never writable; see
``rbac._perm_q``). Types absent from this map have no site and therefore IGNORE
site scope (the grant applies tenant-wide for them) - e.g. VRFs, tags, catalog
objects. A registered type that links to a site-bound row must be in SITE_PATHS
or in SITE_PATH_EXEMPT with its reason (auth_api.tests_site_paths_registry).

Keep keys as the RBAC object-type slugs (model ``_meta.model_name``).
"""
from __future__ import annotations

SITE_PATHS: dict[str, str] = {
    # Direct site FK.
    "device": "site",
    "prefix": "site",
    "vlan": "site",           # nullable: site VLAN = local, NULL = shared/global

    # An address's own site, else its prefix's: the site is only copied onto
    # the address when the prefix auto-assigns it, and an address inside
    # another site's prefix is that site's, not shared (#413). An explicit
    # site on the address wins (first set alternative, see site_in_q).
    "ipaddress": "site|prefix__site",
    "rack": "site",
    "cabinet": "site",
    "cluster": "site",
    "virtualmachine": "site",
    # A group belongs to exactly one cluster, so it inherits that cluster's site.
    "virtualmachinegroup": "cluster__site",
    "powerpanel": "site",
    "location": "site",
    # Indirect (one hop).
    "powerfeed": "power_panel__site",
    "interface": "device__site",
    "frontport": "device__site",
    "rearport": "device__site",
    "consoleport": "device__site",
    "consoleserverport": "device__site",
    "powerport": "device__site",
    "poweroutlet": "device__site",
    "auxport": "device__site",
    "antenna": "device__site",
    # Denormalized on the row (its port could be any of nine kinds).
    "portreservation": "site",
    "inventoryitem": "device__site",
    "devicebay": "device__site",
    "modulebay": "device__site",
    "module": "device__site",
    "macaddress": "assigned_interface__device__site",
    "sshhostkey": "device__site",
    "devicecredential": "device__site",
    "vminterface": "vm__site",
    "circuittermination": "site",
    "floorplan": "location__site",
    "floorplantile": "floor_plan__location__site",
    "floorplandrawing": "floor_plan__location__site",
    "floorplantray": "floor_plan__location__site",
    "floorplanraisedfloorarea": "floor_plan__location__site",
    "floorplanwall": "floor_plan__location__site",
    # A site's own scope is itself.
    "site": "id",
    # Per-site settings rows - a change grant scoped to sites=[X] makes its
    # holders "site admins" of X (see core.site_settings).
    "sitesettings": "site",
    # Routing rows hang off their device or VM (#217); the catalogs they reference
    # (policies, prefix lists, keychains) are tenant-wide.
    "staticroute": "device__site|virtual_machine__site",
    "bgpinstance": "device__site|virtual_machine__site",
    "bgpaddressfamily": "instance__device__site|instance__virtual_machine__site",
    "bgpsession": "instance__device__site|instance__virtual_machine__site",
    "ospfinstance": "device__site|virtual_machine__site",
    "ospfinterface": "instance__device__site|instance__virtual_machine__site",
    "isisinstance": "device__site|virtual_machine__site",
    "isisinterface": "instance__device__site|instance__virtual_machine__site",
    "eigrpinstance": "device__site|virtual_machine__site",
    "eigrpinterface": "instance__device__site|instance__virtual_machine__site",
    "vtep": "device__site",
    "ldpinstance": "device__site",
    "vtepmembership": "vtep__device__site",
    # An Oxidized node link follows the device or VM it backs (#386).
    "oxidizednodelink": "device__site|virtual_machine__site",
    # Rows that belong to a site through their device, VM, prefix, address or
    # cluster (#414). tests_site_paths_registry fails when a registered type
    # with such a link is neither here nor in SITE_PATH_EXEMPT.
    "service": (
        "device__site|virtual_machine__site|ip_address__site|ip_address__prefix__site"
    ),
    "natrule": "device__site",
    "vlangroup": "site|cluster__site",
    "iprange": "prefix__site",
    "virtualchassis": "master__site",
    "fhrpgroupassignment": "interface__device__site|vm_interface__vm__site",
    "l2vpntermination": "interface__device__site|vm_interface__vm__site|vlan__site",
    "tunneltermination": "interface__device__site|vm_interface__vm__site",
    "sitemarker": "device__site",
    "virtualdisk": "vm__site",
    "virtualswitch": "cluster__site",
    "redistribution": (
        "bgp_af__instance__device__site|bgp_af__instance__virtual_machine__site"
        "|ospf_instance__device__site|ospf_instance__virtual_machine__site"
        "|isis_instance__device__site|isis_instance__virtual_machine__site"
        "|eigrp_instance__device__site|eigrp_instance__virtual_machine__site"
    ),
    "deviceconfigsnapshot": "device__site",
    "deviceconfigstate": "device__site",
    "redfishendpoint": "device__site",
    "portutilizationrule": "device__site",
    "zabbixhostlink": "device__site",
    "zabbixchange": "device__site",
    "dhcpscope": "prefix__site",
    "dhcpreservation": "scope__prefix__site",
    "dhcplease": "scope__prefix__site",
    "dnsrecord": "ip_address__site|ip_address__prefix__site",
    "dnsdrift": "ip_address__site|ip_address__prefix__site",
    "virtchange": "vm__site",
    "certificatebinding": "target_ip__site|target_ip__prefix__site",
}

# Site-bound types the one-click site roles do NOT grant (auth_api.api.
# assemble_site_role). Site scope still narrows them for any grant that names
# them; the roles just leave them to an explicit grant. Integration records
# synced from an outside system, and device configuration history - that
# holds secrets, and device view never implies it (``view_config``).
SITE_ROLE_EXCLUDED: frozenset[str] = frozenset({
    "site",            # its own view-only grant (#415); never change/delete
    "sitesettings",    # the site-admin surface (core.site_settings)
    "deviceconfigsnapshot",
    "deviceconfigstate",
    "redfishendpoint",
    "portutilizationrule",
    "zabbixhostlink",
    "zabbixchange",
    "dhcpscope",
    "dhcpreservation",
    "dhcplease",
    "dnsrecord",
    "dnsdrift",
    "virtchange",
    "certificatebinding",
})

# Registered types that reference a site, device, VM, prefix, address or other
# site-bound row but are NOT site-scoped through SITE_PATHS, each with the
# reason. tests_site_paths_registry requires every such type to be in one map
# or the other, so a new model can't silently ignore site scope.
SITE_PATH_EXEMPT: dict[str, str] = {
    # Scoped by their viewset (monitoring _TargetScopedConfigurationMixin):
    # polymorphic targets with no single ORM path.
    "checkassignment": "scoped by its viewset through its target",
    "monitoringpolicy": "scoped by its viewset through its target",
    "alertrule": "scoped by its viewset through its target",
    "silence": "scoped by its viewset through its target",
    # Tenant-wide objects whose link is a filter or a member, not an owner.
    "notificationchannel": "tenant-wide; match_* fields are alert filters",
    "fhrpgroup": "tenant-wide; spans the interfaces of several devices",
    "wirelesslan": "tenant-wide; its VLAN is a reference",
    "prefixlistrule": "child of a tenant-wide prefix list; prefix is a reference",
    "virtnetwork": "tenant-wide integration record; its VLAN is a reference",
    # Integration configuration naming a site as a target, managed tenant-wide.
    "virtplacementrule": "integration config; the site is where it places VMs",
    "zabbixadoptionrule": "integration config; the site is where it adopts hosts",
    "zabbixconnection": "integration config; adopt_site is a default",
}

# Catalog types that can be "local to a site" (owning_site FK, NULL = global
# to the tenant). Unlike SITE_PATHS these are only site-scoped while the
# tenant's ENHANCED SITE SEPARATION flag is on - with it off, catalogs behave
# tenant-wide exactly as before. VLAN is absent on purpose: its `site` FK is
# already its locality and lives in SITE_PATHS unconditionally.
CATALOG_SITE_PATHS: dict[str, str] = {
    "tag": "owning_site",
    "devicetype": "owning_site",
    "manufacturer": "owning_site",
    "status": "owning_site",
    "iprole": "owning_site",
    "vrf": "owning_site",
    "routetarget": "owning_site",
    "customfield": "owning_site",
    "customfieldgroup": "owning_site",
    "zone": "owning_site",
    # Component templates inherit the locality of their owning DeviceType.
    "interfacetemplate": "device_type__owning_site",
    "consoleporttemplate": "device_type__owning_site",
    "consoleserverporttemplate": "device_type__owning_site",
    "powerporttemplate": "device_type__owning_site",
    "poweroutlettemplate": "device_type__owning_site",
    "rearporttemplate": "device_type__owning_site",
    "frontporttemplate": "device_type__owning_site",
    "auxporttemplate": "device_type__owning_site",
    "antennatemplate": "device_type__owning_site",
    "devicebaytemplate": "device_type__owning_site",
    "modulebaytemplate": "device_type__owning_site",
    "inventoryitemtemplate": "device_type__owning_site",
    "devicetypeservice": "device_type__owning_site",
}


def site_role_types() -> list[str]:
    """The site-bound types a site role manages at its sites: SITE_PATHS less
    SITE_ROLE_EXCLUDED. Also the set ``rbac.editable_sites`` reads, so a
    grant on an integration record never makes its holder a site editor."""
    return sorted(set(SITE_PATHS) - SITE_ROLE_EXCLUDED)


# A path may list alternatives with "|": a routing row belongs to a device OR
# a virtual machine, so its site is the device's or the VM's (#217). The row's
# site is the FIRST alternative that is set: an address's own site wins over
# its prefix's (#413), as in audit.site_capture. The helpers below are the
# only way a path becomes a query - use them rather than formatting
# ``f"{path}__in"`` yourself, or an alternative is lost.


def alternatives(path: str) -> list[str]:
    return path.split("|")


def _first_set(path: str, lookup: str, value):
    """Rows whose first set alternative matches ``<alt>__<lookup>=value``."""
    from django.db.models import Q

    q = Q()
    earlier_null = Q()
    for p in alternatives(path):
        q |= earlier_null & Q(**{f"{p}__{lookup}": value})
        earlier_null &= Q(**{f"{p}__isnull": True})
    return q


def site_in_q(path: str, site_ids):
    """Rows whose site - the first alternative that is set - is one of
    ``site_ids``."""
    return _first_set(path, "in", site_ids)


def site_null_q(path: str):
    """Rows with no site by any alternative - shared, not one site's."""
    from django.db.models import Q

    q = Q()
    for p in alternatives(path):
        q &= Q(**{f"{p}__isnull": True})
    return q


def site_tenant_q(path: str, tenant):
    """Rows whose site - the first alternative that is set - belongs to
    ``tenant``."""
    return _first_set(path, "tenant", tenant)


def site_path_for(slug: str, tenant) -> str | None:
    """The ORM path that scopes ``slug`` by site, or ``None``.

    ``SITE_PATHS`` always applies; ``CATALOG_SITE_PATHS`` only when the
    tenant's enhanced-site-separation flag is on. Every RBAC consumer
    (restrict_queryset / row_filter / site_scope / the write guards) resolves
    through here so the flag flips the whole catalog ruleset at once.
    """
    path = SITE_PATHS.get(slug)
    if path is not None:
        return path
    path = CATALOG_SITE_PATHS.get(slug)
    if path is None:
        return None
    from core.effective_settings import separation_enabled

    return path if separation_enabled(tenant) else None
