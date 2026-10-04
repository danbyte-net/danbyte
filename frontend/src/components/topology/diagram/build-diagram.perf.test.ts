import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramMode } from "./types"

// Scale: a 600-device, 1,500-link fabric through the Diagram pipeline, and
// a sparse site of 2,400 devices with 900 cables. The timings are logged
// for comparison, not asserted - CI machines vary too much for a
// wall-clock gate. A map's first build pays for dagre's ranking; a rebuild
// of the same graph (another mode, line or label setting) reuses the ranks,
// and a drag re-plans only the routes the moved card touched. In the app
// both run in a worker (diagram.worker.ts), off the main thread.

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

/** A site of many unconnected devices: 200 firewalls each cabled to a
 * PDU and a few servers, 1,600 devices with no cables at all. */
function sparse(): TopologyGraph {
  const nodes: TopoNode[] = []
  const edges: TopoEdge[] = []
  const device = (name: string, role: keyof typeof ROLES) => {
    nodes.push({
      id: `dev:${name}`,
      type: "device",
      data: { name, device_id: name, role: ROLES[role] },
    })
    return `dev:${name}`
  }
  let n = 0
  for (let i = 0; i < 200; i++) {
    const fw = device(`fw-${i + 1}`, "spine")
    const pdu = device(`pdu-${i + 1}`, "leaf")
    const link = (a: string, ap: string, b: string, bp: string) =>
      edges.push({
        id: `s${++n}`,
        source: a,
        target: b,
        type: "cable",
        data: {
          cable_id: `s${n}`,
          pairs: [{ a: ap, b: bp, a_port: ap, b_port: bp }],
        },
      })
    link(fw, "mgmt0", pdu, "outlet1")
    for (let k = 0; k < (i % 4) + 2; k++)
      link(fw, `ethernet1/${k + 1}`, device(`srv-${i}-${k}`, "server"), "eno1")
  }
  while (nodes.length < 2400) device(`spare-${nodes.length}`, "server")
  return { nodes, edges }
}

const ms = (t: number) => `${Math.round(performance.now() - t)} ms`

describe("buildDiagram at scale", () => {
  const graph = fabric()

  it("has the size it claims", () => {
    expect(graph.nodes).toHaveLength(600)
    expect(graph.edges).toHaveLength(1500)
  })

  for (const mode of ["simple", "detailed"] as DiagramMode[])
    it(`builds and re-anchors 600 cards · ${mode}`, () => {
      const opts = {
        mode,
        line: "elbow" as const,
        colorMode: "cable" as const,
        measure: approxMeasure,
      }
      const t0 = performance.now()
      const built = buildDiagram(graph, opts)
      const first = ms(t0)
      const t1 = performance.now()
      buildDiagram(graph, { ...opts, line: "straight" })
      const rebuilt = ms(t1)
      const t2 = performance.now()
      const re = relinkDiagram(built.model, built.nodes)
      const relink = ms(t2)
      // A drag: one leaf moves, then another.
      const drag = (from: typeof built.model, id: string) => {
        const t = performance.now()
        const out = relinkDiagram(
          from,
          built.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  position: { x: n.position.x + 90, y: n.position.y - 60 },
                }
              : n
          )
        )
        return { out, took: ms(t) }
      }
      const d1 = drag(re.model, "dev:leaf-40")
      const d2 = drag(d1.out.model, "dev:leaf-41")
      // stderr: vitest keeps console output of passing tests to itself.
      process.stderr.write(
        `diagram ${mode}: build ${first}, rebuild ${rebuilt}, ` +
          `relink ${relink}, drags ${d1.took} / ${d2.took} ` +
          `(${built.nodes.length} cards, ${built.edges.length} links)\n`
      )
      expect(built.nodes).toHaveLength(600)
      expect(re.edges).toHaveLength(built.edges.length)
      expect(d2.out.edges).toHaveLength(built.edges.length)

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

  it("builds a sparse 2,400-device site", () => {
    const site = sparse()
    for (const mode of ["simple", "detailed"] as DiagramMode[]) {
      const t = performance.now()
      const built = buildDiagram(site, {
        mode,
        line: "straight",
        colorMode: "cable",
        measure: approxMeasure,
      })
      process.stderr.write(
        `sparse site ${mode}: build ${ms(t)} ` +
          `(${site.nodes.length} cards, ${site.edges.length} cables)\n`
      )
      expect(built.nodes).toHaveLength(2400)
    }
  }, 120_000)
})
