import type { TopoEdge, TopologyGraph } from "@/lib/api"
import { emptyHidden, normalizeHidden } from "@/components/hidden-objects"
import type { HiddenSet } from "@/components/hidden-objects"

/** What the map's eye toggles have switched off: site names, location
 * names, role names, link families, single node ids and single lines
 * (`edges`: the payload's edge ids - a cable, an LLDP neighbour, a BGP
 * session). Saved with a view (`state.hidden`); the default map keeps its
 * own per browser. A view saved before the groups existed holds a flat
 * list of node ids - that list is `devices`. */
export const TOPO_HIDDEN_KEYS = [
  "sites",
  "locations",
  "roles",
  "kinds",
  "devices",
  "edges",
] as const
export type TopoHidden = HiddenSet<(typeof TOPO_HIDDEN_KEYS)[number]>

export const NO_TOPO_HIDDEN: TopoHidden = emptyHidden(TOPO_HIDDEN_KEYS)

export function readTopoHidden(raw: unknown): TopoHidden {
  return normalizeHidden(raw, TOPO_HIDDEN_KEYS, "devices")
}

/** The hidden set as a view saves it. `edges` is written only when a line
 * is hidden, so a view that hides none saves as it did before lines could
 * be hidden one by one. */
export function savedTopoHidden(h: TopoHidden): Partial<TopoHidden> {
  if (h.edges.length) return h
  const rest: Partial<TopoHidden> = { ...h }
  delete rest.edges
  return rest
}

export const NO_SITE = "No site"
export const NO_LOCATION = "No location"
export const NO_ROLE = "No role"
/** The link family LLDP ghosts are listed and hidden under. The key is
 * what every saved view's `state.hidden.kinds` stores - show it with
 * `familyLabel`, never rename it. */
export const DISCOVERED = "Discovered"
/** The link family BGP sessions are listed and hidden under. */
export const BGP_SESSIONS = "BGP sessions"
/** The link family of cables with no cable type. A stored key, like
 * DISCOVERED. */
export const UNTYPED = "Untyped"

/** A link family as the page names it: LLDP neighbours are "LLDP" and
 * untyped cables "No type", while the stored keys stay as saved views and
 * this browser's hidden set already hold them. */
export function familyLabel(family: string): string {
  if (family === DISCOVERED) return "LLDP"
  if (family === UNTYPED) return "No type"
  return family
}

/** The family a link is listed and hidden under - cables by media type,
 * LLDP ghosts as their own; null for the aggregates and pass-through
 * strands, which are how the canvas draws, not objects. */
export function linkFamily(e: TopoEdge): string | null {
  if (e.type === "ghost") return DISCOVERED
  if (e.type === "bgp") return BGP_SESSIONS
  if (e.type === "cable" || !e.type) return e.data?.cable_type || UNTYPED
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

/** Whether a line is off the map: hidden on its own, or its family is. */
export function edgeHidden(e: TopoEdge, h: TopoHidden): boolean {
  if (h.edges.includes(e.id)) return true
  const fam = linkFamily(e)
  return fam !== null && h.kinds.includes(fam)
}

/** A line as the canvas draws it: the fields that say which of the
 * payload's edges it stands for. */
interface DrawnLine {
  id: string
  source: string
  target: string
  data?: unknown
}

/**
 * The payload edges a drawn line stands for, for Hide: the edge itself, or
 * - for what the canvas folds - its cables. A LAG or a bundle is its member
 * cables between the same two devices; any part of a breakout (its trunk
 * or a leg) is the whole cable.
 */
export function drawnEdgeIds(line: DrawnLine, g: TopologyGraph): string[] {
  if (g.edges.some((e) => e.id === line.id)) return [line.id]
  const d = line.data as
    | {
        cableId?: string
        fan?: unknown
        raw?: { cable_id?: string }
        cables?: { cable_id?: string }[]
      }
    | undefined
  const cables = new Set(
    [
      d?.cableId,
      d?.raw?.cable_id,
      ...(d?.cables ?? []).map((c) => c.cable_id),
    ].filter((c): c is string => !!c)
  )
  if (!cables.size) return []
  const ends = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const pair = d?.fan ? null : ends(line.source, line.target)
  return g.edges
    .filter(
      (e) =>
        !!e.data?.cable_id &&
        cables.has(e.data.cable_id) &&
        (pair === null || ends(e.source, e.target) === pair)
    )
    .map((e) => e.id)
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

/** How many of this map's nodes are hidden, whatever hid them, and the
 * lines hidden one by one - the chip's count. A view saved against one
 * filter can carry ids the current query never returns; those are not on
 * this map. */
export function hiddenOnMap(g: TopologyGraph, h: TopoHidden): number {
  const lines = h.edges.length
    ? g.edges.filter((e) => h.edges.includes(e.id)).length
    : 0
  return g.nodes.filter((n) => nodeHidden(n, h)).length + lines
}
