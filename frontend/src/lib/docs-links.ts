// Route → documentation page. The topbar's book button resolves the current
// URL against this map (longest prefix wins) and deep-links the docs page for
// the screen the user is on; unmapped routes fall back to the docs home.
//
// Keys are app route prefixes ("/devices" also covers "/devices/<id>/edit");
// values are docs paths as the static site serves them (".md" dropped,
// "index.md" → its directory). Adding a page? Add its mapping here — the
// repo's docs-link hook reminds you when a new route ships without one.

export const DOCS_LINKS: Record<string, string> = {
  "/": "features/dashboard/",
  "/search": "features/search-and-macs/",
  "/jobs": "features/jobs/",
  "/audit-log": "features/change-log/",
  "/notifications": "features/monitoring/",
  "/import/netbox": "features/netbox-import/",
  "/import": "features/import-export/",
  "/label-templates": "features/label-templates/",
  "/export-templates": "features/export-templates/",
  "/tenants": "models/tenant/",
  "/sites": "features/regions-locations/",
  "/locations": "features/regions-locations/",
  "/regions": "features/regions-locations/",
  "/contacts": "features/contacts/",
  "/contact-groups": "features/contacts/",
  "/contact-roles": "features/contacts/",
  "/planning": "features/planning/",
  "/maintenance": "features/maintenance/",
  "/prefixes": "features/prefix-crud/",
  "/ips": "ipam/",
  "/ip-ranges": "ipam/",
  "/aggregates": "ipam/",
  "/asns": "ipam/",
  "/rirs": "ipam/",
  "/vlans": "features/ipam-objects/",
  "/vlan-groups": "features/ipam-objects/",
  "/vrfs": "features/ipam-objects/",
  "/route-targets": "features/ipam-objects/",
  "/l2vpns": "features/ipam-objects/",
  "/fhrp-groups": "features/ipam-objects/",
  "/zones": "models/zone/",
  "/statuses": "features/catalogs-and-settings/",
  "/saved-filters": "features/saved-views/",
  "/ip-statuses": "features/catalogs-and-settings/",
  "/ip-roles": "features/catalogs-and-settings/",
  "/macs": "features/search-and-macs/",
  "/devices/compliance": "features/compliance/",
  "/devices": "dcim/devices/",
  "/virtual-chassis": "dcim/virtual-chassis/",
  "/device-types": "dcim/device-catalog/",
  "/module-types": "dcim/device-catalog/",
  "/manufacturers": "dcim/device-catalog/",
  "/device-roles": "dcim/device-catalog/",
  "/platforms": "dcim/device-catalog/",
  "/platform-groups": "dcim/device-catalog/",
  "/racks": "dcim/racks/",
  "/rack-types": "dcim/racks/",
  "/rack-roles": "dcim/racks/",
  "/floorplans": "features/floor-plans/",
  "/floor-tile-types": "features/floor-plans/",
  "/site-map": "features/site-map/",
  "/topology": "features/topology/",
  "/interfaces": "dcim/interfaces/",
  "/cables": "dcim/cabling/",
  "/fiber-cables": "dcim/cabling/",
  "/fiber": "dcim/fiber/",
  "/services": "dcim/devices/",
  "/service-templates": "dcim/devices/",
  "/clusters": "features/clusters/",
  "/cluster-types": "features/clusters/",
  "/cluster-groups": "features/clusters/",
  "/virtual-machines": "features/virtual-machines/",
  "/virtual-switches": "features/virtual-switches/",
  "/virtual-topology": "features/virtual-switches/",
  "/circuits": "features/circuits/",
  "/circuit-types": "features/circuits/",
  "/providers": "features/circuits/",
  "/provider-networks": "features/circuits/",
  "/power-panels": "features/power/",
  "/power-feeds": "features/power/",
  "/wireless-lans": "features/wireless/",
  "/wireless-lan-groups": "features/wireless/",
  "/tunnels": "features/vpn/",
  "/tunnel-groups": "features/vpn/",
  "/ipsec-profiles": "features/vpn/",
  "/monitoring": "features/monitoring/",
  "/monitoring-engines": "features/monitoring/",
  "/watched-endpoints": "features/monitoring/",
  "/channels": "features/monitoring/",
  "/alert-rules": "features/monitoring/",
  "/alerts": "features/monitoring/",
  "/silences": "features/monitoring/",
  "/certificates": "monitoring/certificates/",
  "/certificate-issuers": "monitoring/certificates/",
  "/certificate-requests": "monitoring/certificates/",
  "/compliance": "features/compliance/",
  "/compliance-rules": "features/compliance/",
  "/config-drift": "features/iac-runner/",
  "/automation-targets": "features/iac-runner/",
  "/deploy-runs": "features/iac-runner/",
  "/webhooks": "features/webhooks/",
  "/windows-servers": "features/windows-sync/",
  "/dhcp-scopes": "features/windows-sync/",
  "/dhcp-reservations": "features/windows-sync/",
  "/dhcp-leases": "features/windows-sync/",
  "/dns-zones": "features/windows-sync/",
  "/dns-records": "features/windows-sync/",
  "/virtualization-sources": "features/external-sync/",
  "/settings/integrations": "features/external-sync/",
  "/tags": "features/tags-and-custom-fields/",
  "/custom-fields": "features/tags-and-custom-fields/",
  "/custom-field-groups": "features/tags-and-custom-fields/",
  "/config-contexts": "features/config-contexts/",
  "/users": "features/permissions/",
  "/groups": "features/permissions/",
  "/permissions": "features/permissions/",
  "/settings/sso": "features/sso/",
  "/settings/ldap": "features/permissions/",
  "/settings/tenant-ldap": "features/permissions/",
  "/settings/sites": "access/site-separation/",
  "/settings/floorplan": "features/floor-plans/",
  "/settings/components": "dcim/device-catalog/",
  "/settings/monitoring": "features/monitoring/",
  "/settings/monitoring-defaults": "features/monitoring/",
  "/settings/snmp": "features/snmp-discovery/",
  "/settings/snmp-sensors": "features/snmp-discovery/",
  "/settings/connect": "features/device-access/",
  "/settings/updates": "getting-started/upgrading/",
  "/settings/plugins": "architecture/plugins/",
  "/settings/maps": "features/site-map/",
  "/settings/table-defaults": "features/table-preferences/",
  "/settings/device-fields": "dcim/devices/",
  "/settings": "access/",
}

/** The docs URL for an app pathname — longest-prefix match, or the docs home. */
export function docsUrlFor(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/"
  let best = ""
  for (const prefix of Object.keys(DOCS_LINKS)) {
    if (
      (path === prefix || path.startsWith(prefix + "/")) &&
      prefix.length > best.length
    ) {
      best = prefix
    }
  }
  return best ? `/docs/${DOCS_LINKS[best]}` : "/docs/"
}

/** Whether the current page has a specific docs page (vs the home fallback). */
export function hasDocsPage(pathname: string): boolean {
  return docsUrlFor(pathname) !== "/docs/"
}
