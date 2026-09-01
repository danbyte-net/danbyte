import type { TopoEdge } from "@/lib/api"

export type LagEnd = { id: string; name: string } | null
export type EdgeLag = { a: LagEnd; b: LagEnd }

export interface LagBundle {
  key: string
  source: string
  target: string
  lag: { a: NonNullable<LagEnd>; b: NonNullable<LagEnd> }
  /** The member cables, in payload order. */
  edges: TopoEdge[]
}

/**
 * Fold the member cables of a link aggregation into one bundle per
 * (node pair, aggregate A, aggregate B). Only cable edges whose BOTH ends
 * belong to an aggregate qualify - a bundle is the pair of aggregates, so a
 * port-channel to two vPC peers is two bundles. Everything else comes back
 * in `rest`, in its original order.
 */
export function groupLagEdges(edges: TopoEdge[]): {
  bundles: LagBundle[]
  rest: TopoEdge[]
} {
  const byKey = new Map<string, LagBundle>()
  const rest: TopoEdge[] = []
  for (const e of edges) {
    const lag = e.data?.lag
    if (e.type !== "cable" || !lag?.a || !lag.b) {
      rest.push(e)
      continue
    }
    const key = `${e.source}>${e.target}|${lag.a.id}|${lag.b.id}`
    let b = byKey.get(key)
    if (!b) {
      b = { key, source: e.source, target: e.target, lag: { a: lag.a, b: lag.b }, edges: [] }
      byKey.set(key, b)
    }
    b.edges.push(e)
  }
  return { bundles: [...byKey.values()], rest }
}

/** "Po1 ⇄ Po10 ×2" */
export function lagBundleLabel(lag: EdgeLag, n: number): string {
  return `${lag.a?.name ?? "?"} ⇄ ${lag.b?.name ?? "?"} ×${n}`
}

/** The aggregate pair every cable in a set shares, or null when they differ
 * (or any lacks one). Lets the flat view's ×N bundle name the aggregates. */
export function sharedLag(cables: { lag?: EdgeLag }[]): EdgeLag | null {
  const first = cables[0]?.lag
  if (!first?.a || !first.b) return null
  for (const c of cables) {
    if (c.lag?.a?.id !== first.a.id || c.lag.b?.id !== first.b.id) return null
  }
  return first
}
