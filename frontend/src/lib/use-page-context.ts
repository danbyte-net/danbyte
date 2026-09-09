import { useRouterState } from "@tanstack/react-router"

import type { PageContext } from "@/lib/use-chat-socket"

/** URL segment → the object type the assistant knows it by. */
const ROUTE_TYPES: Record<string, string> = {
  devices: "device",
  "virtual-machines": "virtual machine",
  sites: "site",
  locations: "location",
  racks: "rack",
  prefixes: "prefix",
  ips: "IP address",
  "ip-ranges": "IP range",
  vlans: "VLAN",
  vrfs: "VRF",
  circuits: "circuit",
  providers: "provider",
  clusters: "cluster",
  "device-types": "device type",
  manufacturers: "manufacturer",
  tenants: "tenant",
  interfaces: "interface",
  cables: "cable",
  tunnels: "tunnel",
  aggregates: "aggregate",
  regions: "region",
  contacts: "contact",
  platforms: "platform",
  scripts: "script",
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the person is looking at, when they are looking at one object.
 *
 * Read from the URL rather than from page state, so it works on every
 * detail page without each one having to opt in. The label comes from the
 * document title, which detail pages already set to the object's name. */
export function usePageContext(): PageContext | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const type = ROUTE_TYPES[parts[0]]
  const id = parts[1]
  if (!type || !UUID.test(id)) return null
  const title = typeof document === "undefined" ? "" : document.title
  return { type, id, label: title.split("·")[0].split("|")[0].trim() }
}
