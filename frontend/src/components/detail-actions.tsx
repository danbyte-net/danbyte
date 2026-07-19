import { useRouterState } from "@tanstack/react-router"

import { TableActions } from "@/components/table-actions"

// Detail-route segment → RBAC object slug. `/prefixes/<uuid>` is a "prefix".
const SEGMENT_SLUG: Record<string, string> = {
  prefixes: "prefix",
  ips: "ipaddress",
  "ip-ranges": "iprange",
  devices: "device",
  sites: "site",
  "virtual-machines": "virtualmachine",
  vlans: "vlan",
  vrfs: "vrf",
  "route-targets": "routetarget",
  statuses: "ipstatus",
  "ip-roles": "iprole",
  services: "service",
  racks: "rack",
  "rack-roles": "rackrole",
  interfaces: "interface",
  cables: "cable",
  "device-types": "devicetype",
  "module-types": "moduletype",
  "device-roles": "devicerole",
  platforms: "platform",
  manufacturers: "manufacturer",
  contacts: "contact",
  "contact-groups": "contactgroup",
  "contact-roles": "contactrole",
  circuits: "circuit",
  "circuit-types": "circuittype",
  providers: "provider",
  locations: "location",
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
  webhooks: "webhook",
  "automation-targets": "automationtarget",
}

/**
 * Import/Export for an object **detail** page, derived from the route so it can
 * drop into any `/<thing>/<uuid>` header with no props. Mounts in the page's own
 * action bar (next to Edit/Delete) — not the global top bar.
 *
 * Special case: on a **prefix** page the Import/Export acts on the *IPs inside
 * that prefix* (the workflow that replaced the old "IPs" dropdown).
 */
export function DetailActions() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const m = pathname.match(/^\/([a-z-]+)\/([0-9a-fA-F-]{36})\/?$/)
  if (!m) return null
  const segment = m[1]
  const id = m[2]
  const slug = SEGMENT_SLUG[segment]
  if (!slug) return null

  if (segment === "prefixes") {
    return (
      <TableActions
        ioType="ipaddress"
        name="IPs in this prefix"
        exportFilter={{ prefix: id }}
      />
    )
  }

  return <TableActions ioType={slug} selectedIds={[id]} />
}
