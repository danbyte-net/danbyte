import { naturalCompare } from "@/lib/natural-sort"

// The legend rows of the coloured provider network cards (#540), shared by
// the map's legend and the Routing tab's. Pure, so the Routing document
// (built off the main thread too) can take it without the legend's React.

/** The colours the map's provider network cards wear (#540), once each:
 * named by the provider when the colour is the provider's, else by the
 * network that set its own. An uncoloured network is the neutral card and
 * needs no key. */
export function providerNetworkLegend(
  nodes: readonly { type?: string; data: unknown }[]
): { name: string; color: string }[] {
  const out = new Map<string, { name: string; color: string }>()
  for (const n of nodes) {
    if (n.type !== "provider_network") continue
    const d = n.data as {
      name?: string
      color?: string
      provider?: { name?: string; color?: string }
    }
    if (!d.color) continue
    const own = d.color !== d.provider?.color
    const name = (own ? d.name : d.provider?.name) ?? ""
    const key = `${name}|${d.color}`
    if (name && !out.has(key)) out.set(key, { name, color: d.color })
  }
  return [...out.values()].sort((a, b) => naturalCompare(a.name, b.name))
}
