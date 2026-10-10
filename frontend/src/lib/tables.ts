// Registry of every list table that passes a `tableId` to <DataTable>.
//
// The `id` is that `tableId` AND the `<table_id>` slug in
// /api/prefs/columns/<table_id>/ - keep them in sync (and slug-safe). A table
// listed here keeps its column layout per user, can get a tenant default in
// Admin → Table defaults, and shows up in User → Preferences → Tables.
//
// `api` is the list endpoint the table's rows come from - the path the page
// fetches. DataTable asks /api/list-fields/ what those rows carry and offers
// every other field, and every custom field, as a hidden column (#243). Every
// entry must decide: `null` for rows that are not one list's rows (a custom
// report, rows nested in another object) - a wrong path offers wrong columns.
// routes/-table-registry.test.ts fails on a tableId missing from here, and
// api/tests_list_fields.py on an `api` that is not a list.
export interface TableMeta {
  id: string
  label: string
  /** Where the table lives, shown as a hint in the settings list. */
  area: string
  /** The list endpoint the rows come from, or null (see above). */
  api: string | null
  /** RBAC object-type slug for round-trip data export/import (`/api/io/<slug>/`).
   * Set where a re-importable data round-trip makes sense; the backend's
   * `/api/io/types/` still gates whether the control actually shows. */
  ioType?: string
  /** `false` keeps a sub-table (a tab on a detail page) out of the
   * Preferences and Table defaults lists; its layout still saves. */
  settings?: false
}

type Row = [
  id: string,
  label: string,
  area: string,
  api: string | null,
  extra?: { ioType?: string; settings?: false },
]

const sub = { settings: false } as const

// One row per table: id, label, area, api, extras. Kept as a table on
// purpose - prettier would spread each row over six lines.
// prettier-ignore
const ROWS: Row[] = [
  // ─── IPAM ──────────────────────────────────────────────────────────────
  ["prefixes", "Prefixes", "IPAM", "/api/prefixes/", { ioType: "prefix" }],
  ["prefix-ips", "Prefix · IPs", "IPAM", "/api/ips/"],
  ["prefix-embedded", "Prefixes (embedded)", "IPAM", "/api/prefixes/"],
  ["ip-embedded", "IPs (embedded)", "IPAM", "/api/ips/"],
  ["ips", "IP addresses", "IPAM", "/api/ips/"],
  ["ip-ranges", "IP ranges", "IPAM", "/api/ip-ranges/"],
  ["aggregates", "Aggregates", "IPAM", "/api/aggregates/"],
  ["rirs", "RIRs", "IPAM", "/api/rirs/"],
  ["asns", "ASNs", "IPAM", "/api/asns/"],
  ["vlans", "VLANs", "IPAM", "/api/vlans/", { ioType: "vlan" }],
  ["vlan-groups", "VLAN groups", "IPAM", "/api/vlan-groups/"],
  ["vrfs", "VRFs", "IPAM", "/api/vrfs/", { ioType: "vrf" }],
  ["route-targets", "Route targets", "IPAM", "/api/route-targets/", { ioType: "routetarget" }],
  ["statuses", "Statuses", "IPAM", "/api/statuses/", { ioType: "ipstatus" }],
  ["ip-roles", "IP roles", "IPAM", "/api/ip-roles/", { ioType: "iprole" }],
  ["zones", "Zones", "IPAM", "/api/zones/"],
  ["services", "Services", "IPAM", "/api/services/", { ioType: "service" }],
  ["service-templates", "Service templates", "IPAM", "/api/service-templates/"],
  ["fhrp-groups", "FHRP groups", "IPAM", "/api/fhrp-groups/"],
  ["nat-rules", "NAT rules", "IPAM", "/api/nat-rules/"],
  ["macs", "MAC addresses", "IPAM", null],
  ["device-ips", "Device · IPs", "IPAM", "/api/ips/", sub],
  ["interface-ips", "Interface · IPs", "IPAM", "/api/ips/", sub],
  ["location-prefixes", "Location · Prefixes", "IPAM", "/api/prefixes/", sub],
  ["vlan-embedded", "VRF · VLANs", "IPAM", "/api/vlans/", sub],
  ["zone-vlans", "Zone · VLANs", "IPAM", "/api/vlans/", sub],
  ["ip-dns-records", "IP · DNS records", "IPAM", null, sub],
  ["dns-name-addresses", "DNS name · Addresses", "IPAM", "/api/ips/", sub],
  ["dns-name-records", "DNS name · Records", "IPAM", "/api/dns-records/", sub],
  ["mac-interfaces", "MAC · Interfaces", "IPAM", null, sub],
  ["mac-ips", "MAC · IPs", "IPAM", null, sub],
  ["mac-sightings", "MAC · Sightings", "IPAM", null, sub],
  ["mac-vm-interfaces", "MAC · VM interfaces", "IPAM", null, sub],

  // ─── Routing ───────────────────────────────────────────────────────────
  ["static-routes", "Static routes", "Routing", "/api/routing/static-routes/", { ioType: "staticroute" }],
  ["routing-policies", "Routing policies", "Routing", "/api/routing/policies/", { ioType: "routingpolicy" }],
  ["prefix-lists", "Prefix lists", "Routing", "/api/routing/prefix-lists/", { ioType: "prefixlist" }],
  ["community-lists", "Community lists", "Routing", "/api/routing/community-lists/", { ioType: "communitylist" }],
  ["as-path-lists", "AS-path lists", "Routing", "/api/routing/as-path-lists/", { ioType: "aspathlist" }],
  ["communities", "Communities", "Routing", "/api/routing/communities/", { ioType: "community" }],
  ["routing-keychains", "Routing keychains", "Routing", "/api/routing/keychains/", { ioType: "routingkeychain" }],
  ["bfd-profiles", "BFD profiles", "Routing", "/api/routing/bfd-profiles/", { ioType: "bfdprofile" }],
  ["ethernet-segments", "Ethernet segments", "Routing", "/api/routing/ethernet-segments/", { ioType: "ethernetsegment" }],
  ["bgp-sessions", "BGP sessions", "Routing", "/api/routing/bgp-sessions/", { ioType: "bgpsession" }],
  ["bgp-peer-groups", "BGP peer groups", "Routing", "/api/routing/bgp-peer-groups/", { ioType: "bgppeergroup" }],
  ["device-bgp-sessions", "BGP sessions (device)", "Routing", "/api/routing/bgp-sessions/"],
  ["ospf-areas", "OSPF areas", "Routing", "/api/routing/ospf-areas/", { ioType: "ospfarea" }],
  ["bgp-instances", "BGP instances", "Routing", "/api/routing/bgp-instances/", { ioType: "bgpinstance" }],
  ["ospf-instances", "OSPF instances", "Routing", "/api/routing/ospf-instances/", { ioType: "ospfinstance" }],
  ["isis-instances", "IS-IS instances", "Routing", "/api/routing/isis-instances/", { ioType: "isisinstance" }],
  ["eigrp-instances", "EIGRP instances", "Routing", "/api/routing/eigrp-instances/", { ioType: "eigrpinstance" }],
  ["vteps", "VTEPs", "Routing", "/api/routing/vteps/", { ioType: "vtep" }],
  ["embedded-bgp-sessions", "BGP sessions (embedded)", "Routing", "/api/routing/bgp-sessions/"],
  ["embedded-static-routes", "Static routes (embedded)", "Routing", "/api/routing/static-routes/"],
  ["embedded-vteps", "VTEPs (embedded)", "Routing", "/api/routing/vteps/"],
  ["device-static-routes", "Device · Static routes", "Routing", "/api/routing/static-routes/", sub],
  // Rules ride nested in their list's detail payload, not a list of their own.
  ["prefix-list-rules", "Prefix list · Rules", "Routing", null, sub],
  ["community-list-rules", "Community list · Rules", "Routing", null, sub],
  ["as-path-list-rules", "AS-path list · Rules", "Routing", null, sub],
  ["routing-policy-rules", "Routing policy · Rules", "Routing", null, sub],
  ["ethernet-segment-interfaces", "Ethernet segment · Interfaces", "Routing", null, sub],

  // ─── VPN ───────────────────────────────────────────────────────────────
  ["l2vpns", "L2VPNs", "VPN", "/api/l2vpns/"],
  ["embedded-l2vpns", "L2VPNs (embedded)", "VPN", "/api/l2vpns/"],
  ["tunnels", "Tunnels", "VPN", "/api/tunnels/"],
  ["tunnel-groups", "Tunnel groups", "VPN", "/api/tunnel-groups/"],
  ["ipsec-profiles", "IPsec profiles", "VPN", "/api/ipsec-profiles/"],
  ["embedded-tunnels", "Tunnels (embedded)", "VPN", "/api/tunnels/", sub],

  // ─── Organization ──────────────────────────────────────────────────────
  ["sites", "Sites", "Organization", "/api/sites/", { ioType: "site" }],
  ["regions", "Regions", "Organization", "/api/regions/"],
  ["locations", "Locations", "Organization", "/api/locations/"],
  ["tenants", "Tenants", "Organization", "/api/tenants/"],
  ["contacts", "Contacts", "Organization", "/api/contacts/"],
  ["contact-groups", "Contact groups", "Organization", "/api/contact-groups/"],
  ["contact-roles", "Contact roles", "Organization", "/api/contact-roles/"],
  ["site-locations-embedded", "Site · Locations", "Organization", "/api/locations/", sub],
  ["embedded-contacts", "Contacts (embedded)", "Organization", "/api/contacts/", sub],
  ["embedded-contact-groups", "Contact groups (embedded)", "Organization", "/api/contact-groups/", sub],

  // ─── DCIM ──────────────────────────────────────────────────────────────
  ["devices", "Devices", "DCIM", "/api/devices/", { ioType: "device" }],
  ["device-types", "Device types", "DCIM", "/api/device-types/", { ioType: "devicetype" }],
  ["device-roles", "Device roles", "DCIM", "/api/device-roles/", { ioType: "devicerole" }],
  ["manufacturers", "Manufacturers", "DCIM", "/api/manufacturers/", { ioType: "manufacturer" }],
  ["platforms", "Platforms", "DCIM", "/api/platforms/", { ioType: "platform" }],
  ["platform-groups", "Platform groups", "DCIM", "/api/platform-groups/"],
  ["module-types", "Module types", "DCIM", "/api/module-types/"],
  ["virtual-chassis", "Virtual chassis", "DCIM", "/api/virtual-chassis/"],
  ["racks", "Racks", "DCIM", "/api/racks/", { ioType: "rack" }],
  ["rack-types", "Rack types", "DCIM", "/api/rack-types/"],
  ["rack-roles", "Rack roles", "DCIM", "/api/rack-roles/", { ioType: "rackrole" }],
  ["embedded-racks", "Racks (embedded)", "DCIM", "/api/racks/"],
  ["cabinets", "Cabinets", "DCIM", "/api/cabinets/", { ioType: "cabinet" }],
  ["cabinet-types", "Cabinet types", "DCIM", "/api/cabinet-types/", { ioType: "cabinettype" }],
  ["cabinet-roles", "Cabinet roles", "DCIM", "/api/cabinet-roles/", { ioType: "cabinetrole" }],
  ["embedded-cabinets", "Cabinets (embedded)", "DCIM", "/api/cabinets/", sub],
  ["interfaces", "Interfaces", "DCIM", "/api/interfaces/", { ioType: "interface" }],
  ["cables", "Cables", "DCIM", "/api/cables/", { ioType: "cable" }],
  ["fiber-cables", "Fiber cables", "DCIM", "/api/cables/"],
  ["port-reservations", "Port reservations", "DCIM", "/api/port-reservations/"],
  ["port-utilization", "Port utilization", "DCIM", null],
  ["floor-plans", "Floor plans", "DCIM", "/api/floor-plans/"],
  ["floor-tile-types", "Floor tile types", "DCIM", "/api/floor-tile-types/"],
  ["embedded-devices", "Devices (embedded)", "DCIM", "/api/devices/", sub],
  ["embedded-device-types", "Device types (embedded)", "DCIM", "/api/device-types/", sub],
  ["embedded-cables", "Cables (embedded)", "DCIM", "/api/cables/", sub],
  ["rack-type-racks", "Rack type · Racks", "DCIM", "/api/racks/", sub],
  ["device-interfaces", "Device · Interfaces", "DCIM", "/api/interfaces/", sub],
  ["device-console-ports", "Device · Console ports", "DCIM", "/api/console-ports/", sub],
  ["device-console-server-ports", "Device · Console server ports", "DCIM", "/api/console-server-ports/", sub],
  ["device-power-ports", "Device · Power ports", "DCIM", "/api/power-ports/", sub],
  ["device-power-outlets", "Device · Power outlets", "DCIM", "/api/power-outlets/", sub],
  ["device-front-ports", "Device · Front ports", "DCIM", "/api/front-ports/", sub],
  ["device-rear-ports", "Device · Rear ports", "DCIM", "/api/rear-ports/", sub],
  ["device-inventory", "Device · Inventory", "DCIM", "/api/inventory-items/", sub],
  ["floorplan-racks", "Floor plan · Racks", "DCIM", "/api/racks/", sub],

  // ─── Power & circuits ──────────────────────────────────────────────────
  ["power-panels", "Power panels", "Power", "/api/power-panels/"],
  ["power-feeds", "Power feeds", "Power", "/api/power-feeds/"],
  ["embedded-power-feeds", "Power feeds (embedded)", "Power", "/api/power-feeds/", sub],
  ["circuits", "Circuits", "Circuits", "/api/circuits/"],
  ["circuit-types", "Circuit types", "Circuits", "/api/circuit-types/"],
  ["providers", "Providers", "Circuits", "/api/providers/"],
  ["provider-networks", "Provider networks", "Circuits", "/api/provider-networks/"],
  ["embedded-circuits", "Circuits (embedded)", "Circuits", "/api/circuits/", sub],

  // ─── Wireless ──────────────────────────────────────────────────────────
  ["wireless-lans", "Wireless LANs", "Wireless", "/api/wireless-lans/"],
  ["wireless-lan-groups", "Wireless LAN groups", "Wireless", "/api/wireless-lan-groups/"],
  ["embedded-wireless-lans", "Wireless LANs (embedded)", "Wireless", "/api/wireless-lans/", sub],

  // ─── Virtualization ────────────────────────────────────────────────────
  ["virtual-machines", "Virtual machines", "Virtualization", "/api/virtual-machines/", { ioType: "virtualmachine" }],
  ["clusters", "Clusters", "Virtualization", "/api/clusters/", { ioType: "cluster" }],
  ["cluster-types", "Cluster types", "Virtualization", "/api/cluster-types/", { ioType: "clustertype" }],
  ["cluster-groups", "Cluster groups", "Virtualization", "/api/cluster-groups/", { ioType: "clustergroup" }],
  ["virtual-switches", "Virtual switches", "Virtualization", "/api/virtual-switches/"],
  ["embedded-clusters", "Clusters (embedded)", "Virtualization", "/api/clusters/"],
  ["cluster-devices", "Cluster · Devices", "Virtualization", "/api/devices/", sub],
  ["switch-networks", "Virtual switch · Networks", "Virtualization", "/api/virt-networks/", sub],
  ["vm-disks-embedded", "VM · Disks", "Virtualization", null, sub],
  ["vm-snmp-arp", "VM · SNMP ARP", "Virtualization", null, sub],
  ["vm-snmp-interfaces", "VM · SNMP interfaces", "Virtualization", null, sub],

  // ─── Customize ─────────────────────────────────────────────────────────
  ["tags", "Tags", "Customize", "/api/tags/"],
  ["custom-fields", "Custom fields", "Customize", "/api/custom-fields/"],
  ["custom-field-groups", "Custom field groups", "Customize", "/api/custom-field-groups/"],
  ["saved-filters", "Saved views", "Customize", "/api/saved-filters/"],
  ["export-templates", "Export templates", "Customize", "/api/export-templates/"],
  ["label-templates", "Label templates", "Customize", "/api/label-templates/"],
  ["config-contexts", "Config contexts", "Customize", "/api/config-contexts/"],
  ["dashboards", "Dashboards", "Customize", "/api/dashboards/"],

  // ─── Governance & access ───────────────────────────────────────────────
  ["audit-log", "Audit log", "Governance", "/api/changelog/"],
  ["compliance-rules", "Compliance rules", "Governance", "/api/compliance-rules/"],
  ["compliance-violations", "Compliance violations", "Governance", null],
  ["users", "Users", "Access", "/api/users/"],
  ["groups", "Groups", "Access", "/api/groups/"],
  ["permissions", "Permissions", "Access", "/api/object-permissions/"],

  // ─── Monitoring ────────────────────────────────────────────────────────
  ["alerts", "Alerts", "Monitoring", null],
  ["monitoring-history", "Monitoring history", "Monitoring", null],
  ["monitoring-checks", "Monitoring checks", "Monitoring", null],
  ["monitoring-engines", "Monitoring engines", "Monitoring", "/api/monitoring/engines/"],
  ["alert-rules", "Alert rules", "Monitoring", "/api/monitoring/alert-rules/", { ioType: "alertrule" }],
  ["channels", "Channels", "Monitoring", "/api/monitoring/channels/", { ioType: "notificationchannel" }],
  ["silences", "Silences", "Monitoring", "/api/monitoring/silences/", { ioType: "silence" }],
  ["check-templates", "Check templates", "Monitoring", "/api/monitoring/templates/"],
  ["maintenance-events", "Maintenance", "Monitoring", "/api/monitoring/maintenance-events/"],
  ["watched-endpoints", "Watched endpoints", "Monitoring", "/api/monitoring/watched-endpoints/"],
  ["certificates", "Certificates", "Monitoring", "/api/monitoring/certificates/"],
  ["certificate-requests", "Certificate requests", "Monitoring", "/api/monitoring/certificate-requests/"],
  ["certificate-assignments", "Certificate · Assignments", "Monitoring", "/api/monitoring/certificate-assignments/", sub],
  ["certificate-bindings", "Certificate · Bindings", "Monitoring", "/api/monitoring/certificate-bindings/", sub],
  ["sla-agreements", "SLA agreements", "Monitoring", "/api/monitoring/sla-agreements/"],
  ["sla-members", "SLA · Members", "Monitoring", "/api/monitoring/sla-members/", sub],
  ["sla-exclusions", "SLA · Exclusions", "Monitoring", "/api/monitoring/sla-exclusions/", sub],
  ["sla-incidents", "SLA · Incidents", "Monitoring", null, sub],
  ["sla-template-agreements", "SLA template · Agreements", "Monitoring", null, sub],
  ["port-utilization-rules", "Port utilization rules", "Monitoring", "/api/monitoring/port-utilization-rules/"],
  ["subscriptions", "Subscriptions", "Monitoring", "/api/monitoring/subscriptions/"],
  ["my-subscriptions", "My subscriptions", "Monitoring", null],
  // Policy rows are per-object bindings computed for the page, not a list.
  ["monitoring-config-prefixes", "Monitoring config · Prefixes", "Monitoring", null],
  ["monitoring-config-devices", "Monitoring config · Devices", "Monitoring", null],
  ["monitoring-config-device-types", "Monitoring config · Device types", "Monitoring", null],
  ["monitoring-config-device-roles", "Monitoring config · Device roles", "Monitoring", null],
  ["monitoring-config-platforms", "Monitoring config · Platforms", "Monitoring", null],
  ["monitoring-config-sites", "Monitoring config · Sites", "Monitoring", null],
  ["monitoring-config-regions", "Monitoring config · Regions", "Monitoring", null],
  ["monitoring-config-profiles", "Monitoring config · Profiles", "Monitoring", null],
  ["monitoring-config-prefix-deny", "Monitoring config · Prefix deny", "Monitoring", null],

  // ─── Integrations ──────────────────────────────────────────────────────
  ["scripts", "Scripts", "Integrations", "/api/scripts/"],
  ["script-runs", "Script runs", "Integrations", "/api/scripts/runs/"],
  ["webhooks", "Webhooks", "Integrations", "/api/webhooks/", { ioType: "webhook" }],
  ["automation-targets", "Automation targets", "Integrations", "/api/automation-targets/", { ioType: "automationtarget" }],
  ["deploy-runs", "Deploy runs", "Integrations", "/api/deploy-runs/"],
  ["embedded-deploy-runs", "Deploy runs (embedded)", "Integrations", "/api/deploy-runs/", sub],
  ["config-drift", "Config drift", "Integrations", "/api/config-states/"],
  ["snmp-drift", "SNMP drift", "Integrations", null],
  ["windows-servers", "Windows servers", "Integrations", "/api/windows-connections/"],
  ["dhcp-scopes-all", "DHCP scopes", "Integrations", "/api/dhcp-scopes/"],
  ["dhcp-reservations-all", "DHCP reservations", "Integrations", "/api/dhcp-reservations/"],
  ["dhcp-leases-all", "DHCP leases", "Integrations", "/api/dhcp-leases/"],
  ["dhcp-scopes", "Windows server · DHCP scopes", "Integrations", "/api/dhcp-scopes/", sub],
  ["dhcp-reservations", "Windows server · DHCP reservations", "Integrations", "/api/dhcp-reservations/", sub],
  ["dhcp-leases", "Windows server · DHCP leases", "Integrations", "/api/dhcp-leases/", sub],
  ["dns-zones-all", "DNS zones", "Integrations", "/api/dns-zones/"],
  ["dns-records-all", "DNS records", "Integrations", "/api/dns-records/"],
  ["dns-zones", "Windows server · DNS zones", "Integrations", "/api/dns-zones/", sub],
  ["dns-drifts", "Windows server · DNS drift", "Integrations", "/api/dns-drifts/", sub],
  ["virtualization-sources", "Virtualization sources", "Integrations", "/api/virtualization-sources/"],
  ["source-hosts", "Virtualization source · Hosts", "Integrations", "/api/devices/", sub],
  ["source-vms", "Virtualization source · VMs", "Integrations", "/api/virtual-machines/", sub],
  ["placement-rules", "Virtualization source · Placement rules", "Integrations", "/api/virt-placement-rules/", sub],
  ["virt-sync-log", "Virtualization source · Sync log", "Integrations", null, sub],
  ["virt-changes", "Virtualization changes", "Integrations", "/api/virt-changes/", sub],
  ["zabbix-links", "Zabbix · Linked hosts", "Integrations", "/api/zabbix/links/"],
  ["zabbix-maintenance", "Zabbix · Maintenance", "Integrations", "/api/zabbix/maintenance/"],
  ["zabbix-adoption-rules", "Zabbix · Adoption rules", "Integrations", "/api/zabbix/adoption-rules/"],
  ["zabbix-provision-rules", "Zabbix · Template rules", "Integrations", "/api/zabbix/template-rules/"],
  ["zabbix-scope", "Zabbix · Scope", "Integrations", null],

  // ─── Planning & system ─────────────────────────────────────────────────
  ["planning-boards", "Boards", "Planning", "/api/planning/boards/"],
  ["task-statuses", "Task statuses", "Planning", "/api/planning/statuses/", sub],
  ["jobs", "Jobs", "System", null],
  ["backups", "Backups", "System", "/api/backups/"],
]

export const REGISTERED_TABLES: TableMeta[] = ROWS.map(
  ([id, label, area, api, extra]) => ({ id, label, area, api, ...extra })
)

/** The tables the Preferences and Table defaults pages list. */
export const TABLES: TableMeta[] = REGISTERED_TABLES.filter(
  (t) => t.settings !== false
)

const BY_ID = new Map(REGISTERED_TABLES.map((t) => [t.id, t]))

export function tableMeta(id: string | undefined): TableMeta | undefined {
  return id ? BY_ID.get(id) : undefined
}

export function tableLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

/** The list endpoint a registered table's rows come from, or null. */
export function tableApi(tableId: string | undefined): string | null {
  return tableMeta(tableId)?.api ?? null
}

export function ioTypeFor(tableId: string | undefined): string | undefined {
  return tableMeta(tableId)?.ioType
}
