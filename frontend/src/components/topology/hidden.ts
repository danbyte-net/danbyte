import type { TopoEdge, TopologyGraph } from "@/lib/api"
import { emptyHidden, normalizeHidden } from "@/components/hidden-objects"
import type { HiddenSet } from "@/components/hidden-objects"

/** What the map's eye toggles have switched off: site names, location
 * names, role names, link families, single node ids. Saved with a view
 * (`state.hidden`); the default map keeps its own per browser. A view saved
 * before the groups existed holds a flat list of node ids - that list is
 * `devices`. */
export const TOPO_HIDDEN_KEYS = [
  "sites",
  "locations",
  "roles",
  "kinds",
  "devices",
] as const
export type TopoHidden = HiddenSet<(typeof TOPO_HIDDEN_KEYS)[number]>

export const NO_TOPO_HIDDEN: TopoHidden = emptyHidden(TOPO_HIDDEN_KEYS)

export function readTopoHidden(raw: unknown): TopoHidden {
  return normalizeHidden(raw, TOPO_HIDDEN_KEYS, "devices")
}

export const NO_SITE = "No site"
export const NO_LOCATION = "No location"
export const NO_ROLE = "No role"
/** The link family LLDP ghosts are listed and hidden under. */
export const DISCOVERED = "Discovered"
/** The link family BGP sessions are listed and hidden under. */
export const BGP_SESSIONS = "BGP sessions"

/** The family a link is listed and hidden under - cables by media type,
 * LLDP ghosts as their own; null for the aggregates and pass-through
 * strands, which are how the canvas draws, not objects. */
export function linkFamily(e: TopoEdge): string | null {
  if (e.type === "ghost") return DISCOVERED
  if (e.type === "bgp") return BGP_SESSIONS
  if (e.type === "cable" || !e.type) return e.data?.cable_type || "Untyped"
  return null
}

/** Whether a node is off the map: taken off by hand, or its site, location
 * or role is switched off. A site/location aggregate goes with its site or
 * location. */
export function nodeHidden(
  n: TopologyGraph["nodes"][number],
  h: TopoHidden
): boolean {
  if (h.devices.includes(n.id)) return true
  if (n.type === "group") {
    const kind = (n.data as { kind?: string }).kind
    return kind === "site"
      ? h.sites.includes(n.data.name)
      : kind === "location"
        ? h.locations.includes(n.data.name)
        : false
  }
  return (
    h.sites.includes(n.data.site ?? NO_SITE) ||
    h.locations.includes(n.data.location ?? NO_LOCATION) ||
    h.roles.includes(n.data.role?.name ?? NO_ROLE)
  )
}

export function edgeHidden(e: TopoEdge, h: TopoHidden): boolean {
  const fam = linkFamily(e)
  return fam !== null && h.kinds.includes(fam)
}

/** The graph the canvas draws. A cable to a card that is not drawn has
 * nowhere to land, so it goes with the card; a hidden link family goes
 * without touching the cards. Positions are the caller's - hiding never
 * re-runs the layout. */
export function applyHidden(g: TopologyGraph, h: TopoHidden): TopologyGraph {
  const nodes = g.nodes.filter((n) => !nodeHidden(n, h))
  const present = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter(
    (e) => present.has(e.source) && present.has(e.target) && !edgeHidden(e, h)
  )
  return { ...g, nodes, edges }
}

/** How many of this map's nodes are hidden, whatever hid them - the chip's
 * count. A view saved against one filter can carry ids the current query
 * never returns; those are not on this map. */
export function hiddenOnMap(g: TopologyGraph, h: TopoHidden): number {
  return g.nodes.filter((n) => nodeHidden(n, h)).length
}
