import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramEdgeData, DiagramMode } from "./types"

// Scale for Phase 6: 400 cards in a 20 x 20 grid and 2,000 cables, every
// one with a /31 (a third dual-stack), drawn Cyclical - the row links that
// jump cards become arcs, the rest bendy - with subnet chips, end
// addresses and port names. The timings are logged for comparison, not
// asserted: CI machines vary too much for a wall-clock gate.

const SIDE = 20

function grid(): {
  graph: TopologyGraph
  positions: Record<string, [number, number]>
} {
  const nodes: TopoNode[] = []
  const positions: Record<string, [number, number]> = {}
  const id = (r: number, c: number) => `dev:g${r}-${c}`
  for (let r = 0; r < SIDE; r++)
    for (let c = 0; c < SIDE; c++) {
      nodes.push({
        id: id(r, c),
        type: "device",
        data: {
          name: `sw-${r}-${c}`,
          device_id: `g${r}-${c}`,
          role: { name: "Leaf", color: "#0ea5e9" },
        },
      })
      positions[id(r, c)] = [c * 240, r * 260]
    }
  const edges: TopoEdge[] = []
  const hops: [number, number][] = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 0],
    [1, 1],
    [1, -1],
  ]
  let n = 0
  for (const [dr, dc] of hops)
    for (let r = 0; r + dr < SIDE; r++)
      for (let c = 0; c < SIDE; c++) {
        const c2 = c + dc
        if (c2 < 0 || c2 >= SIDE || edges.length >= 2000) continue
        n++
        const s = id(r, c)
        const t = id(r + dr, c2)
        const v4 = {
          cidr: `10.${n >> 8}.${n & 255}.0/31`,
          family: 4 as const,
          a: `10.${n >> 8}.${n & 255}.0`,
          b: `10.${n >> 8}.${n & 255}.1`,
        }
        const v6 = {
          cidr: `2001:db8:${n}::/127`,
          family: 6 as const,
          a: `2001:db8:${n}::`,
          b: `2001:db8:${n}::1`,
        }
        edges.push({
          id: `e:c${n}:${s}:${t}`,
          source: s,
          target: t,
          type: "cable",
          data: {
            cable_id: `c${n}`,
            pairs: [
              {
                a: `${s}:Ethernet1/${n % 48}`,
                b: `${t}:Ethernet1/${(n + 7) % 48}`,
                a_port: `Ethernet1/${n % 48}`,
                b_port: `Ethernet1/${(n + 7) % 48}`,
                subnets: n % 3 ? [v4] : [v4, v6],
              },
            ],
          },
        })
      }
  return { graph: { nodes, edges }, positions }
}

describe("Cyclical and link labels at scale", () => {
  const { graph, positions } = grid()

  it("has the size it claims", () => {
    expect(graph.nodes).toHaveLength(400)
    expect(graph.edges).toHaveLength(2000)
  })

  for (const mode of ["simple", "detailed"] as DiagramMode[])
    it(`plans 2,000 cables · ${mode}`, () => {
      const t0 = performance.now()
      const built = buildDiagram(graph, {
        mode,
        line: "cyclical",
        colorMode: "cable",
        positions,
        measure: approxMeasure,
      })
      const t1 = performance.now()
      const re = relinkDiagram(built.model, built.nodes)
      const t2 = performance.now()
      let arcs = 0
      let asked = 0
      let shown = 0
      for (const e of built.edges) {
        const d = e.data as DiagramEdgeData | undefined
        if (d?.arc) arcs++
        for (const p of d?.plan ?? [])
          for (const end of ["a", "b"] as const)
            if (p.ips && end in p.ips) {
              asked++
              if (p.ips[end]) shown++
            }
      }
      // stderr: vitest keeps console output of passing tests to itself.
      process.stderr.write(
        `cyclical ${mode}: build ${Math.round(t1 - t0)} ms, ` +
          `relink ${Math.round(t2 - t1)} ms ` +
          `(${built.nodes.length} cards, ${built.edges.length} links, ` +
          `${arcs} arcs, addresses ${shown}/${asked})\n`
      )
      expect(re.edges).toHaveLength(built.edges.length)
      expect(arcs).toBeGreaterThan(300)
      expect(
        built.edges.every((e) => (e.data as DiagramEdgeData).plan?.length)
      ).toBe(true)
    }, 120_000)
})
