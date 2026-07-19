"""Object-type → ORM path to its Site, for site-scoped ObjectPermissions.

A permission with a non-empty ``sites`` set narrows each object type's queryset
by filtering ``<path>__in=<site ids>`` (for the *view* action, rows whose site
is NULL are also visible — shared context — but never writable; see
``rbac._perm_q``). Types absent from this map have no site and therefore IGNORE
site scope (the grant applies tenant-wide for them) — e.g. VRFs, tags, catalog
objects.

Keep keys as the RBAC object-type slugs (model ``_meta.model_name``).
"""
from __future__ import annotations

SITE_PATHS: dict[str, str] = {
    # Direct site FK.
    "device": "site",
    "prefix": "site",
    "vlan": "site",           # nullable: site VLAN = local, NULL = shared/global

    "ipaddress": "site",      # added in B (auto-assigned from the prefix)
    "rack": "site",
    "cluster": "site",
    "virtualmachine": "site",
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
    "inventoryitem": "device__site",
    "devicebay": "device__site",
    "modulebay": "device__site",
    "module": "device__site",
    "macaddress": "assigned_interface__device__site",
    "vminterface": "vm__site",
    "circuittermination": "site",
    "floorplan": "location__site",
    "floorplantile": "floor_plan__location__site",
    "floorplantray": "floor_plan__location__site",
    # A site's own scope is itself.
    "site": "id",
    # Per-site settings rows — a change grant scoped to sites=[X] makes its
    # holders "site admins" of X (see core.site_settings).
    "sitesettings": "site",
}

# Catalog types that can be "local to a site" (owning_site FK, NULL = global
# to the tenant). Unlike SITE_PATHS these are only site-scoped while the
# tenant's ENHANCED SITE SEPARATION flag is on — with it off, catalogs behave
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
    "devicebaytemplate": "device_type__owning_site",
    "modulebaytemplate": "device_type__owning_site",
    "inventoryitemtemplate": "device_type__owning_site",
    "devicetypeservice": "device_type__owning_site",
}


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
