import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import { edgeWaypoints, layoutNodes } from "./layout"

// Scale guard: the layout pipeline must stay interactive on a ~150-device
// fabric (3 sites × core pair + 4 dist + 12 access + 24 servers). A
// regression here is what a user experiences as "the topology froze".

function fabric(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const port = (name: string) => ({ name, kind: "interface" as const })
  const addNode = (id: string, ports: string[]) =>
    nodes.push({
      id,
      type: "device",
      position: { x: 0, y: 0 },
      data: { name: id, ports: ports.map(port) },
    })
  const link = (a: string, ap: string, b: string, bp: string) =>
    edges.push({
      id: `e:${a}:${ap}:${b}:${bp}`,
      source: a,
      target: b,
      sourceHandle: ap,
      targetHandle: bp,
      data: { sem: "cable", baseS: ap, baseT: bp },
    } as Edge)

  for (const site of ["s1", "s2", "s3"]) {
    addNode(`${site}-core1`, ["t49", "t50", "t1", "t2", "t3", "t4", "h1"])
    addNode(`${site}-core2`, ["t49", "t50", "t1", "t2", "t3", "t4"])
    link(`${site}-core1`, "t49", `${site}-core2`, "t49")
    link(`${site}-core1`, "t50", `${site}-core2`, "t50")
    for (let d = 1; d <= 4; d++) {
      addNode(`${site}-dist${d}`, ["u1", "u2", "g1", "g2", "g3"])
      link(`${site}-dist${d}`, "u1", `${site}-core1`, `t${d}`)
      link(`${site}-dist${d}`, "u2", `${site}-core2`, `t${d}`)
      for (let a = 1; a <= 3; a++) {
        const asw = `${site}-asw${d}${a}`
        addNode(asw, ["g48", "g1", "g2"])
        link(asw, "g48", `${site}-dist${d}`, `g${a}`)
        for (let s = 1; s <= 2; s++) {
          const srv = `${site}-srv${d}${a}${s}`
          addNode(srv, ["eno1"])
          link(srv, "eno1", asw, `g${s}`)
        }
      }
    }
  }
  link("s1-core1", "h1", "s2-core1", "h1")
  link("s2-core1", "h1", "s3-core1", "h1")
  return { nodes, edges }
}

describe("topology layout at scale", () => {
  it("lays out ~150 stencil nodes fast enough to feel instant", () => {
    const { nodes, edges } = fabric()
    expect(nodes.length).toBeGreaterThan(120)
    const t0 = performance.now()
    const { nodes: laid } = layoutNodes(nodes, edges)
    const wp = edgeWaypoints(laid, edges, "LR")
    const ms = performance.now() - t0
    expect(laid).toHaveLength(nodes.length)
    expect(wp).toBeInstanceOf(Map)
    // Interactive budget: a full layout+routing pass must stay well under a
    // second - the page runs it twice per rebuild.
    expect(ms).toBeLessThan(1000)
  })

  it("tiered (Levels) layout stays fast too", () => {
    const { nodes, edges } = fabric()
    const levels = new Map<string, number>()
    for (const n of nodes) {
      const tier = n.id.includes("core")
        ? 0
        : n.id.includes("dist")
          ? 1
          : n.id.includes("asw")
            ? 2
            : 3
      levels.set(n.id, tier)
    }
    const t0 = performance.now()
    const { nodes: laid } = layoutNodes(nodes, edges, undefined, "TB", levels)
    const ms = performance.now() - t0
    expect(laid).toHaveLength(nodes.length)
    expect(ms).toBeLessThan(1000)
  })
})
