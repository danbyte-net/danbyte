import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramMode } from "./types"

// Scale: a 600-device, 1,500-link fabric through the Diagram pipeline. The
// timings are logged for comparison, not asserted - CI machines vary too
// much for a wall-clock gate. The dagre layout dominates, as it does for the
// Wiring and Flat views on the same graph.

const ROLES = {
  spine: { name: "Spine", color: "#6366f1" },
  leaf: { name: "Leaf", color: "#0ea5e9" },
  server: { name: "Server", color: "#10b981" },
}

function fabric(): TopologyGraph {
  const nodes: TopoNode[] = []
  const edges: TopoEdge[] = []
  const device = (name: string, role: keyof typeof ROLES) => {
    const id = `dev:${name}`
    nodes.push({
      id,
      type: "device",
      data: {
        name,
        device_id: name,
        role: ROLES[role],
        card: {
          fields: ["monitor", "primary_ip", "loopback"],
          source: "default",
          values: {
            primary_ip: {
              id: `ip-${name}`,
              address: `10.${nodes.length >> 8}.${nodes.length & 255}.1`,
              cidr: "",
            },
            loopback: [],
          },
        },
      },
    })
    return id
  }
  let n = 0
  const cable = (a: string, ap: string, b: string, bp: string) => {
    n++
    edges.push({
      id: `c${n}`,
      source: a,
      target: b,
      type: "cable",
      data: {
        cable_id: `c${n}`,
        pairs: [{ a: ap, b: bp, a_port: ap, b_port: bp }],
      },
    })
  }
  const spines = Array.from({ length: 12 }, (_, i) =>
    device(`spine-${i + 1}`, "spine")
  )
  const leaves = Array.from({ length: 100 }, (_, i) =>
    device(`leaf-${i + 1}`, "leaf")
  )
  // Every leaf to 8 spines: 800 links.
  leaves.forEach((leaf, i) => {
    for (let k = 0; k < 8; k++) {
      const s = (i + k) % spines.length
      cable(spines[s], `Ethernet1/${i + 1}`, leaf, `Ethernet1/${49 + k}`)
    }
  })
  // 488 servers, the first 212 dual-homed: 700 links.
  for (let i = 0; i < 488; i++) {
    const srv = device(`srv-${i + 1}`, "server")
    cable(leaves[i % 100], `Ethernet1/${1 + Math.floor(i / 100)}`, srv, "eno1")
    if (i < 212)
      cable(
        leaves[(i + 1) % 100],
        `Ethernet1/${10 + Math.floor(i / 100)}`,
        srv,
        "eno2"
      )
  }
  return { nodes, edges }
}

describe("buildDiagram at scale", () => {
  const graph = fabric()

  it("has the size it claims", () => {
    expect(graph.nodes).toHaveLength(600)
    expect(graph.edges).toHaveLength(1500)
  })

  for (const mode of ["simple", "detailed"] as DiagramMode[])
    it(`builds and re-anchors 600 cards · ${mode}`, () => {
      const t0 = performance.now()
      const built = buildDiagram(graph, {
        mode,
        line: "elbow",
        colorMode: "cable",
        measure: approxMeasure,
      })
      const t1 = performance.now()
      const re = relinkDiagram(built.model, built.nodes)
      const t2 = performance.now()
      // stderr: vitest keeps console output of passing tests to itself.
      process.stderr.write(
        `diagram ${mode}: build ${Math.round(t1 - t0)} ms, ` +
          `relink ${Math.round(t2 - t1)} ms ` +
          `(${built.nodes.length} cards, ${built.edges.length} links)\n`
      )
      expect(built.nodes).toHaveLength(600)
      expect(re.edges).toHaveLength(built.edges.length)

      // A saved arrangement pins every card: no layout, only routing.
      const positions = Object.fromEntries(
        built.nodes.map((c) => [c.id, [c.position.x, c.position.y]])
      ) as Record<string, [number, number]>
      const t3 = performance.now()
      const saved = buildDiagram(graph, {
        mode,
        line: "elbow",
        colorMode: "cable",
        positions,
        measure: approxMeasure,
      })
      process.stderr.write(
        `diagram ${mode}, saved arrangement: ` +
          `build ${Math.round(performance.now() - t3)} ms\n`
      )
      expect(saved.nodes.map((c) => c.position)).toEqual(
        built.nodes.map((c) => c.position)
      )
    }, 120_000)
})
