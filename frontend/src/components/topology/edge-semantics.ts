import type { Edge } from "@xyflow/react"

import type { TopoEdge, TopologyGraph } from "@/lib/api"
import type { EdgeSem } from "./edge-style"
import type { GroupEdgeInfo } from "./group-node"
import { groupLagEdges } from "./lag-bundles"
import type { LagBundle } from "./lag-bundles"

// What each payload edge means on the map - a cable, a folded aggregate, a
// Flat-view pair bundle, a ghost, a BGP session, a trace-map link - before
// any view decides how to lay it out or draw it.

/** One member of a Flat-view bundled edge (the underlying cable's data). */
export type BundleMember = NonNullable<TopoEdge["data"]>

/** Edge semantics that carry node-avoiding routing. */
export const ROUTABLE: ReadonlySet<string> = new Set<EdgeSem>([
  "cable",
  "lagbundle",
  "bundle",
  "groupedge",
])

interface Ends {
  id: string
  source: string
  target: string
}

/** One edge of the map, classified. Ends keep the payload's orientation. */
export type EdgeClass =
  | (Ends & { sem: "groupedge"; group: GroupEdgeInfo | undefined })
  | (Ends & { sem: "membership" | "through" })
  | (Ends & { sem: "bgp" | "ghost"; raw: TopoEdge["data"] })
  | (Ends & {
      sem: "cable"
      raw: TopoEdge["data"]
      /** Flat view: the one cable joining a device pair - drawn card to
       * card rather than port to port. */
      byPair?: boolean
    })
  | (Ends & {
      sem: "lagbundle"
      lag: LagBundle["lag"]
      /** The member cables, in payload order - never empty. */
      cables: BundleMember[]
    })
  | (Ends & { sem: "bundle"; cables: BundleMember[] })

export interface ClassifyOptions {
  /** "lag" folds an aggregate's member cables into one edge; "pair" folds
   * every cable between a device pair (Flat view); "none" keeps each. */
  fold: "lag" | "pair" | "none"
  /** Device mini-map: drop the cables leaving these ports of the origin. */
  originId?: string
  hiddenPorts?: Set<string>
}

/**
 * Classify and fold a payload's edges. Order is stable: unfolded edges in
 * payload order, then aggregates, then Flat-view pair bundles - the layout
 * is sensitive to it.
 */
export function classifyEdges(
  graph: TopologyGraph,
  opts: ClassifyOptions
): EdgeClass[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id))
  const out: EdgeClass[] = []
  const pairs = new Map<
    string,
    { source: string; target: string; cables: BundleMember[] }
  >()
  const lagFold =
    opts.fold === "lag"
      ? groupLagEdges(graph.edges)
      : { bundles: [], rest: graph.edges }
  for (const e of lagFold.rest) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    const ends = { id: e.id, source: e.source, target: e.target }
    // Aggregated group-to-group edge (group_by mode).
    if (e.type === "group") {
      out.push({
        ...ends,
        sem: "groupedge",
        group: e.data as unknown as GroupEdgeInfo | undefined,
      })
      continue
    }
    // Trace graphs: device→port membership + patch-panel pass-through.
    if (e.type === "membership" || e.type === "through") {
      out.push({ ...ends, sem: e.type })
      continue
    }
    // A BGP session between two cards; an LLDP "ghost" link (SNMP-adjacent,
    // no cable).
    if (e.type === "bgp" || e.type === "ghost") {
      out.push({ ...ends, sem: e.type, raw: e.data })
      continue
    }

    // Hide edges whose origin-side port was toggled off (device mini map).
    const first: { a_port?: string; b_port?: string } | undefined =
      e.data?.pairs?.[0]
    if (
      opts.hiddenPorts?.size &&
      opts.originId &&
      ((e.source === opts.originId &&
        first?.a_port &&
        opts.hiddenPorts.has(first.a_port)) ||
        (e.target === opts.originId &&
          first?.b_port &&
          opts.hiddenPorts.has(first.b_port)))
    )
      continue

    if (opts.fold === "pair") {
      const key = [e.source, e.target].sort().join(">")
      let b = pairs.get(key)
      if (!b) {
        b = { source: e.source, target: e.target, cables: [] }
        pairs.set(key, b)
      }
      if (e.data) b.cables.push(e.data)
      continue
    }
    out.push({ ...ends, sem: "cable", raw: e.data })
  }

  for (const b of lagFold.bundles)
    out.push({
      id: `lag:${b.key}`,
      source: b.source,
      target: b.target,
      sem: "lagbundle",
      lag: b.lag,
      cables: b.edges.map((e) => e.data).filter(Boolean) as BundleMember[],
    })

  for (const [key, b] of pairs) {
    const ends = { id: `f:${key}`, source: b.source, target: b.target }
    // A pair joined by ONE cable is that cable, not a bundle of one.
    if (b.cables.length === 1)
      out.push({ ...ends, sem: "cable", raw: b.cables[0], byPair: true })
    else out.push({ ...ends, sem: "bundle", cables: b.cables })
  }
  return out
}

/**
 * Orient hub → leaf: dagre ranks along edge direction, and the backend's
 * uuid-sorted endpoints put leaves on random sides of their switch. Making
 * the higher-degree device the source ranks cores before distribution
 * before access before servers - consistently one direction. Only routable
 * edges flip; every edge counts toward degree.
 */
export function orientHubToLeaf<TEdge extends Edge>(
  edges: TEdge[]
): { edges: TEdge[]; flipped: Set<string> } {
  const deg = new Map<string, number>()
  for (const ed of edges) {
    deg.set(ed.source, (deg.get(ed.source) ?? 0) + 1)
    deg.set(ed.target, (deg.get(ed.target) ?? 0) + 1)
  }
  const flipped = new Set<string>()
  const out = edges.map((ed) => {
    const sem = (ed.data as { sem?: string } | undefined)?.sem
    if (!ROUTABLE.has(sem ?? "")) return ed
    if ((deg.get(ed.target) ?? 0) <= (deg.get(ed.source) ?? 0)) return ed
    flipped.add(ed.id)
    return {
      ...ed,
      source: ed.target,
      target: ed.source,
      sourceHandle: ed.targetHandle,
      targetHandle: ed.sourceHandle,
    }
  })
  return { edges: out, flipped }
}
