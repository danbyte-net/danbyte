// Registry of list tables that participate in saved column preferences.
//
// The `id` is the `tableId` passed to <DataTable> AND the `<table_id>` slug
// in /auth/prefs/columns/<table_id>/ — keep them in sync. Adding a table here
// makes it show up in User → Preferences → Tables and Admin → Table defaults;
// wiring `tableId="<id>"` on the matching <DataTable> is what actually turns
// persistence on for that page.
export interface TableMeta {
  id: string
  label: string
  /** Where the table lives, shown as a hint in the settings list. */
  area: string
  /** RBAC object-type slug for round-trip data export/import (`/api/io/<slug>/`).
   * Set where a re-importable data round-trip makes sense; the backend's
   * `/api/io/types/` still gates whether the control actually shows. */
  ioType?: string
}

export const TABLES: TableMeta[] = [
  { id: "prefixes", label: "Prefixes", area: "IPAM", ioType: "prefix" },
  { id: "prefix-ips", label: "Prefix · IPs", area: "IPAM" },
  { id: "prefix-embedded", label: "Prefixes (embedded)", area: "IPAM" },
  { id: "ip-embedded", label: "IPs (embedded)", area: "IPAM" },
  { id: "vlans", label: "VLANs", area: "IPAM", ioType: "vlan" },
  { id: "vrfs", label: "VRFs", area: "IPAM", ioType: "vrf" },
  {
    id: "route-targets",
    label: "Route targets",
    area: "IPAM",
    ioType: "routetarget",
  },
  { id: "statuses", label: "Statuses", area: "IPAM", ioType: "ipstatus" },
  { id: "ip-roles", label: "IP roles", area: "IPAM", ioType: "iprole" },
  { id: "services", label: "Services", area: "IPAM", ioType: "service" },
  { id: "sites", label: "Sites", area: "Organization", ioType: "site" },
  { id: "tenants", label: "Tenants", area: "Organization" },
  {
    id: "manufacturers",
    label: "Manufacturers",
    area: "DCIM",
    ioType: "manufacturer",
  },
  {
    id: "device-types",
    label: "Device types",
    area: "DCIM",
    ioType: "devicetype",
  },
  {
    id: "device-roles",
    label: "Device roles",
    area: "DCIM",
    ioType: "devicerole",
  },
  { id: "platforms", label: "Platforms", area: "DCIM", ioType: "platform" },
  { id: "devices", label: "Devices", area: "DCIM", ioType: "device" },
  { id: "racks", label: "Racks", area: "DCIM", ioType: "rack" },
  { id: "embedded-racks", label: "Racks (embedded)", area: "DCIM" },
  {
    id: "embedded-clusters",
    label: "Clusters (embedded)",
    area: "Virtualization",
  },
  { id: "rack-roles", label: "Rack roles", area: "DCIM", ioType: "rackrole" },
  { id: "interfaces", label: "Interfaces", area: "DCIM", ioType: "interface" },
  { id: "cables", label: "Cables", area: "DCIM", ioType: "cable" },
  {
    id: "virtual-machines",
    label: "Virtual machines",
    area: "Virtualization",
    ioType: "virtualmachine",
  },
  {
    id: "clusters",
    label: "Clusters",
    area: "Virtualization",
    ioType: "cluster",
  },
  {
    id: "cluster-types",
    label: "Cluster types",
    area: "Virtualization",
    ioType: "clustertype",
  },
  {
    id: "cluster-groups",
    label: "Cluster groups",
    area: "Virtualization",
    ioType: "clustergroup",
  },
  { id: "tags", label: "Tags", area: "Customize" },
  { id: "custom-fields", label: "Custom fields", area: "Customize" },
  { id: "audit-log", label: "Audit log", area: "Governance" },
  { id: "alerts", label: "Alerts", area: "Monitoring" },
  {
    id: "alert-rules",
    label: "Alert rules",
    area: "Monitoring",
    ioType: "alertrule",
  },
  {
    id: "channels",
    label: "Channels",
    area: "Monitoring",
    ioType: "notificationchannel",
  },
  { id: "silences", label: "Silences", area: "Monitoring", ioType: "silence" },
  {
    id: "monitoring-config-prefixes",
    label: "Monitoring config · Prefixes",
    area: "Monitoring",
  },
  {
    id: "monitoring-config-devices",
    label: "Monitoring config · Devices",
    area: "Monitoring",
  },
  {
    id: "monitoring-config-device-types",
    label: "Monitoring config · Device types",
    area: "Monitoring",
  },
  {
    id: "monitoring-config-device-roles",
    label: "Monitoring config · Device roles",
    area: "Monitoring",
  },
  {
    id: "monitoring-config-profiles",
    label: "Monitoring config · Profiles",
    area: "Monitoring",
  },
  {
    id: "monitoring-config-prefix-deny",
    label: "Monitoring config · Prefix deny",
    area: "Monitoring",
  },
  {
    id: "webhooks",
    label: "Webhooks",
    area: "Integrations",
    ioType: "webhook",
  },
  {
    id: "automation-targets",
    label: "Automation targets",
    area: "Integrations",
    ioType: "automationtarget",
  },
  { id: "deploy-runs", label: "Deploy runs", area: "Integrations" },
  { id: "config-drift", label: "Config drift", area: "Integrations" },
]

export function tableLabel(id: string): string {
  return TABLES.find((t) => t.id === id)?.label ?? id
}

export function ioTypeFor(tableId: string | undefined): string | undefined {
  if (!tableId) return undefined
  return TABLES.find((t) => t.id === tableId)?.ioType
}
