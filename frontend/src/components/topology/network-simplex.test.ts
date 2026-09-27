import dagre from "@dagrejs/dagre"
import { describe, expect, it } from "vitest"

import { networkSimplex } from "./network-simplex"

// The array ranker must give exactly dagre's network-simplex ranks: every
// graph is laid out twice, once with dagre's own ranker and once with
// ours, and everything dagre writes back is compared.

type Graph = Parameters<typeof dagre.layout>[0]

const newGraph = (opts: { multigraph: boolean; compound: boolean }): Graph =>
  new dagre.graphlib.Graph(opts)

/** mulberry32: a small seeded generator, so a failure names its graph. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Shape {
  nodes: number
  edges: number
  /** Names that are array indices ("0", "7") sort first in graphlib. */
  numeric?: boolean
  multigraph?: boolean
  /** Put some nodes in clusters (a compound graph). */
  clusters?: boolean
  direction?: "LR" | "TB"
}

function randomGraph(seed: number, shape: Shape): Graph {
  const r = rng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const g = newGraph({
    multigraph: !!shape.multigraph,
    compound: !!shape.clusters,
  })
  g.setGraph({
    rankdir: shape.direction ?? "LR",
    nodesep: 20,
    ranksep: 40,
  })
  g.setDefaultEdgeLabel(() => ({}))
  const names: string[] = []
  for (let i = 0; i < shape.nodes; i++) {
    const name =
      shape.numeric && r() < 0.4
        ? String(Math.floor(r() * 50))
        : `n${Math.floor(r() * 1e6).toString(36)}-${i}`
    if (g.hasNode(name)) continue
    names.push(name)
    g.setNode(name, {
      width: 20 + Math.floor(r() * 80),
      height: 20 + Math.floor(r() * 40),
    })
  }
  if (shape.clusters && names.length > 4) {
    for (let c = 0; c < 3; c++) {
      const id = `cluster-${c}`
      g.setNode(id, { width: 0, height: 0 })
      for (const v of names) if (r() < 0.15) g.setParent(v, id)
    }
  }
  for (let i = 0; i < shape.edges && names.length > 1; i++) {
    const v = pick(names)
    const w = pick(names)
    if (v === w) continue
    const label = {
      weight: pick([0, 1, 1, 1, 2, 5]),
      minlen: pick([1, 1, 1, 2, 3]),
    }
    if (shape.multigraph) g.setEdge(v, w, label, `e${i}`)
    else g.setEdge(v, w, label)
  }
  return g
}

function copy(g: Graph, ranker: unknown): Graph {
  const h = newGraph({
    multigraph: g.isMultigraph(),
    compound: g.isCompound(),
  })
  h.setGraph({ ...g.graph(), ranker: ranker as "network-simplex" })
  h.setDefaultEdgeLabel(() => ({}))
  for (const v of g.nodes()) h.setNode(v, { ...g.node(v) })
  if (g.isCompound())
    for (const v of g.nodes()) {
      const p = g.parent(v)
      if (p) h.setParent(v, p)
    }
  for (const e of g.edges()) h.setEdge(e, { ...g.edge(e) })
  return h
}

/** Everything a layout writes back, in a form `toEqual` can compare. */
function laidOut(g: Graph) {
  return {
    nodes: g.nodes().map((v) => {
      const n = g.node(v) as {
        x?: number
        y?: number
        rank?: number
        order?: number
      }
      return [v, n.x, n.y, n.rank, n.order]
    }),
    edges: g.edges().map((e) => (g.edge(e) as { points?: unknown }).points),
  }
}

function same(g: Graph) {
  const theirs = copy(g, "network-simplex")
  const ours = copy(g, networkSimplex)
  let error: unknown = null
  try {
    dagre.layout(theirs)
  } catch (e) {
    error = e
  }
  // A graph dagre cannot lay out fails the same way with either ranker.
  if (error) {
    expect(() => dagre.layout(ours)).toThrow((error as Error).message)
    return
  }
  dagre.layout(ours)
  expect(laidOut(ours)).toEqual(laidOut(theirs))
}

// dagre's own ranker is the slow part of every comparison.
const SLOW = 120_000

describe("networkSimplex", () => {
  it("ranks like dagre on small random graphs", { timeout: SLOW }, () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919)
      const nodes = 1 + Math.floor(r() * 30)
      same(
        randomGraph(seed, {
          nodes,
          edges: Math.floor(r() * nodes * 2),
          direction: r() < 0.5 ? "LR" : "TB",
        })
      )
    }
  })

  it("ranks like dagre with parallel edges", { timeout: SLOW }, () => {
    for (let seed = 1; seed <= 30; seed++)
      same(randomGraph(1000 + seed, { nodes: 20, edges: 35, multigraph: true }))
  })

  it("ranks like dagre when names are array indices", { timeout: SLOW }, () => {
    for (let seed = 1; seed <= 50; seed++)
      same(randomGraph(2000 + seed, { nodes: 25, edges: 30, numeric: true }))
  })

  it(
    "ranks like dagre on sparse maps of many pieces",
    { timeout: SLOW },
    () => {
      // Mostly lone cards and small clusters - a large site's shape.
      for (let seed = 1; seed <= 10; seed++)
        same(randomGraph(3000 + seed, { nodes: 300, edges: 120 }))
    }
  )

  it("ranks like dagre on a denser graph", { timeout: SLOW }, () => {
    for (let seed = 1; seed <= 3; seed++)
      same(randomGraph(4000 + seed, { nodes: 60, edges: 120 }))
  })

  it("ranks like dagre on compound graphs", { timeout: SLOW }, () => {
    for (let seed = 1; seed <= 40; seed++)
      same(randomGraph(5000 + seed, { nodes: 25, edges: 35, clusters: true }))
  })

  it("ranks a single node", () => {
    same(randomGraph(1, { nodes: 1, edges: 0 }))
  })
})
