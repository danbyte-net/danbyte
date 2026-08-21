import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import { edgeWaypoints, layoutNodes } from "./layout"
import { stencilSize } from "./stencil-node"

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

describe("aligned-card detour", () => {
  it("routes A→C around a card sitting dead between them", () => {
    // Three sites stacked in one column (the grouped view's triangle):
    // the A→C cable must NOT run straight through B.
    const mk = (id: string, y: number): Node => ({
      id,
      type: "flat",
      position: { x: 100, y },
      data: { name: id },
    })
    const nodes = [mk("a", 0), mk("b", 200), mk("c", 400)]
    const edges: Edge[] = [
      { id: "ab", source: "a", target: "b", data: { sem: "cable" } } as Edge,
      { id: "bc", source: "b", target: "c", data: { sem: "cable" } } as Edge,
      { id: "ac", source: "a", target: "c", data: { sem: "cable" } } as Edge,
    ]
    const wp = edgeWaypoints(nodes, edges, "TB")
    const detour = wp.get("ac")
    expect(detour).toBeDefined()
    // Both waypoints share an X clear of the cards' 100..~256 span.
    expect(detour![0][0]).toBe(detour![1][0])
    const x = detour![0][0]
    expect(x < 100 || x > 100 + 160).toBe(true)
  })
})

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

describe("density-adaptive gaps and lanes", () => {
  const port = (name: string) => ({ name, kind: "interface" as const })

  it("draws a 40-leaf fan plain - no lane wall, modest gap", () => {
    const hubPorts = Array.from({ length: 40 }, (_, i) => `p${i}`)
    const nodes: Node[] = [
      {
        id: "hub",
        type: "device",
        position: { x: 0, y: 0 },
        data: { name: "hub", ports: hubPorts.map(port) },
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `leaf${i}`,
        type: "device",
        position: { x: 0, y: 0 },
        data: { name: `leaf${i}`, ports: [port("eno1")] },
      })),
    ]
    const edges: Edge[] = hubPorts.map(
      (pn, i) =>
        ({
          id: `e${i}`,
          source: "hub",
          target: `leaf${i}`,
          sourceHandle: pn,
          targetHandle: "eno1",
          data: { sem: "cable", baseS: pn, baseT: "eno1" },
        }) as Edge
    )
    const { nodes: laid, waypoints } = layoutNodes(nodes, edges, undefined, "LR")
    // Leaves stack in a compact grid beside the hub (NetBox/visio style),
    // never strung out along one endless rank...
    const leaves = laid.filter((n) => n.id !== "hub")
    const xs = leaves.map((n) => n.position.x)
    const ys = leaves.map((n) => n.position.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2000)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2000)
    // ...and every cable rides its own street lane into the grid.
    const lanes = edges
      .map((e) => waypoints.get(e.id)?.[0])
      .filter((x): x is [number, number] => !!x)
    expect(lanes.length).toBe(40)
    expect(new Set(lanes.map((l) => l[1])).size).toBe(40)
  })

  it("gives parallel cables between ONE pair their own lanes + gap room", () => {
    const ports = Array.from({ length: 12 }, (_, i) => `p${i}`)
    const nodes: Node[] = ["a", "b"].map((id) => ({
      id,
      type: "device",
      position: { x: 0, y: 0 },
      data: { name: id, ports: ports.map(port) },
    }))
    const edges: Edge[] = ports.map(
      (pn, i) =>
        ({
          id: `e${i}`,
          source: "a",
          target: "b",
          sourceHandle: pn,
          targetHandle: pn,
          data: { sem: "cable", baseS: pn, baseT: pn },
        }) as Edge
    )
    const { waypoints } = layoutNodes(nodes, edges, undefined, "LR")
    // Every parallel cable rides its own distinct lane (keyed by edge id).
    const lanes = edges
      .map((e) => waypoints.get(e.id)?.[0][0])
      .filter((x): x is number => x !== undefined)
    expect(lanes.length).toBe(12)
    expect(new Set(lanes).size).toBe(12)
  })
})

describe("dense cards render as a faceplate bar", () => {
  it("a 100-port card is long on the port axis, slim on the other", () => {
    const ports = Array.from({ length: 100 }, (_, i) => ({
      name: `Gi1/${i}`,
      kind: "interface" as const,
    }))
    const { width, height } = stencilSize({ name: "big", ports } as never)
    // One 16px slot per port along the bar; the perpendicular stays a slim
    // label band + identity row.
    expect(Math.max(width, height)).toBeGreaterThanOrEqual(100 * 16)
    expect(Math.min(width, height)).toBeLessThanOrEqual(320)
  })
})
