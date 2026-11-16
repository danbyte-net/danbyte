import { useRouterState } from "@tanstack/react-router"

import { useTableIO } from "@/components/table-io"
import { ExportMenu } from "@/components/action-ribbon"

// Detail-route segment → RBAC object slug. `/prefixes/<uuid>` is a "prefix".
const SEGMENT_SLUG: Record<string, string> = {
  prefixes: "prefix",
  ips: "ipaddress",
  "ip-ranges": "iprange",
  devices: "device",
  sites: "site",
  "virtual-machines": "virtualmachine",
  "vm-groups": "virtualmachinegroup",
  vlans: "vlan",
  vrfs: "vrf",
  "route-targets": "routetarget",
  statuses: "ipstatus",
  "ip-roles": "iprole",
  services: "service",
  racks: "rack",
  "rack-roles": "rackrole",
  "location-types": "locationtype",
  "area-types": "areatype",
  "sensitivity-labels": "sensitivitylabel",
  cabinets: "cabinet",
  "cabinet-roles": "cabinetrole",
  interfaces: "interface",
  cables: "cable",
  "device-types": "devicetype",
  "module-types": "moduletype",
  "device-roles": "devicerole",
  "dependency-media": "dependencymedium",
  platforms: "platform",
  manufacturers: "manufacturer",
  contacts: "contact",
  "contact-groups": "contactgroup",
  "contact-roles": "contactrole",
  circuits: "circuit",
  "circuit-types": "circuittype",
  providers: "provider",
  locations: "location",
  rooms: "room",
  regions: "region",
  clusters: "cluster",
  "cluster-types": "clustertype",
  "cluster-groups": "clustergroup",
  tunnels: "tunnel",
  "tunnel-groups": "tunnelgroup",
  aggregates: "aggregate",
  asns: "asn",
  rirs: "rir",
  "fhrp-groups": "fhrpgroup",
  "vlan-groups": "vlangroup",
  "wireless-lans": "wirelesslan",
  "wireless-lan-groups": "wirelesslangroup",
  "power-feeds": "powerfeed",
  "power-panels": "powerpanel",
  "cooling-sources": "coolingsource",
  "cooling-feeds": "coolingfeed",
  webhooks: "webhook",
  "automation-targets": "automationtarget",
  "config-contexts": "configcontext",
  "export-templates": "exporttemplate",
}

/**
 * Import/Export for an object **detail** page, derived from the route so any
 * `/<thing>/<uuid>` page gets it with no props. `DetailShell` lists the items
 * in the header's Export menu and mounts the import dialog beside it.
 *
 * Special case: on a **prefix** page the Import/Export acts on the *IPs inside
 * that prefix* (the workflow that replaced the old "IPs" dropdown).
 */
export function useDetailIO() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const m = pathname.match(/^\/([a-z-]+)\/([0-9a-fA-F-]{36})\/?$/)
  const segment = m?.[1] ?? ""
  const id = m?.[2] ?? ""
  const slug = SEGMENT_SLUG[segment] as string | undefined
  // Always called (hooks); off a detail route it asks for a slug no type has.
  const io = useTableIO(
    segment === "prefixes"
      ? {
          slug: "ipaddress",
          name: "IPs in this prefix",
          exportFilter: { prefix: id },
        }
      : { slug: slug ?? "", selectedIds: id ? [id] : [] }
  )
  if (!slug) return { available: false, items: null, dialog: null }
  return io
}

/** The route's Import / Export as a header's Export menu, for a detail page
 * that draws its own header instead of `DetailShell`. */
export function DetailActions() {
  const io = useDetailIO()
  if (!io.available) return null
  return (
    <>
      <ExportMenu>{io.items}</ExportMenu>
      {io.dialog}
    </>
  )
}
