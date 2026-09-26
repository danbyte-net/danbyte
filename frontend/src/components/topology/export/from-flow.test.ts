// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import type {
  DiagramDocument,
  DiagramEnd,
  DiagramNode,
} from "@/lib/diagram/types"
import { DEV, devId, fabricGraph } from "../__fixtures__/fabric-graph"
import { sizeOf } from "../node-registry"
import { build } from "../topology-canvas"
import type { NodeStyle } from "../topology-canvas"
import { fromFlow } from "./from-flow"

// The Wiring, Hierarchy and Flat tabs export in the Diagram's Simple look:
// a compact role-coloured card centred on each of their cards, and one
// straight line per device pair between the facing side midpoints.

const META = { title: "Fabric", generated_at: "2026-09-26T12:00:00Z" }

function flow(nodeStyle: NodeStyle) {
  return build(fabricGraph, {
    colorMode: "cable",
    nodeStyle,
    direction: "TB",
  })
}

function atSideMid(n: DiagramNode, p: DiagramEnd): boolean {
  const mids = [
    { x: n.x + n.w / 2, y: n.y },
    { x: n.x + n.w, y: n.y + n.h / 2 },
    { x: n.x + n.w / 2, y: n.y + n.h },
    { x: n.x, y: n.y + n.h / 2 },
  ]
  return mids.some((m) => Math.hypot(m.x - p.x, m.y - p.y) < 0.01)
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|")

describe("fromFlow", () => {
  for (const style of ["stencil", "hierarchy", "flat"] as NodeStyle[])
    it(`draws the ${style} tab as Simple cards and lines`, () => {
      const { nodes, edges } = flow(style)
      const doc = fromFlow(nodes, edges, [], {
        meta: META,
        measure: approxMeasure,
      })
      expect(doc.meta.mode).toBe("simple")

      // One card per device, centred on the tab's own card.
      const devices = nodes.filter((n) =>
        ["device", "hier", "flat"].includes(n.type ?? "")
      )
      expect(doc.nodes).toHaveLength(devices.length)
      const byId = new Map(doc.nodes.map((n) => [n.id, n]))
      for (const n of devices) {
        const s = sizeOf(n)
        const d = byId.get(n.id)!
        expect(d.x + d.w / 2).toBeCloseTo(n.position.x + s.width / 2, 6)
        expect(d.y + d.h / 2).toBeCloseTo(n.position.y + s.height / 2, 6)
        expect(d.nubs).toBeUndefined()
      }

      // One straight line per device pair for the wiring, from side
      // midpoint to side midpoint.
      const wiring = doc.links.filter(
        (l) => l.sem === "cable" || l.sem === "bundle"
      )
      const pairs = wiring.map((l) => pairKey(l.source.node, l.target.node))
      expect(new Set(pairs).size).toBe(pairs.length)
      for (const l of doc.links) {
        expect(l.kind).toBe("straight")
        expect(l.points).toEqual([])
        expect(atSideMid(byId.get(l.source.node)!, l.source)).toBe(true)
        expect(atSideMid(byId.get(l.target.node)!, l.target)).toBe(true)
      }
      const uplinks = wiring.find(
        (l) =>
          pairKey(l.source.node, l.target.node) ===
          pairKey(devId("spine1"), devId("leaf1"))
      )!
      expect(uplinks).toMatchObject({ sem: "bundle", labels: { mid: ["2x"] } })
      expect(doc.links.filter((l) => l.sem === "ghost")).toHaveLength(1)
    })

  it("gives a card its role colour, its IP and a link back, no pill", () => {
    const { nodes, edges } = flow("stencil")
    const doc = fromFlow(nodes, edges, [], {
      meta: META,
      measure: approxMeasure,
      origin: "https://danbyte.example",
    })
    const byId = new Map(doc.nodes.map((n) => [n.id, n]))
    const spine = byId.get(devId("spine1"))!
    expect(spine).toMatchObject({
      fill: "#6366f1",
      ink: "#ffffff",
      title: "spine-01",
      lines: ["10.0.0.1"],
      link: `https://danbyte.example/devices/${DEV.spine1}`,
    })
    expect(doc.nodes.filter((n) => n.pill)).toEqual([])
    // A single cable links back to itself.
    const fw = doc.links.find(
      (l) =>
        pairKey(l.source.node, l.target.node) ===
        pairKey(devId("fw1"), devId("leaf4"))
    )!
    expect(fw.link).toMatch(/^https:\/\/danbyte\.example\/cables\//)
  })

  it("leaves hidden cards out, with their lines", () => {
    const { nodes, edges } = flow("flat")
    const doc = fromFlow(
      nodes.map((n) => (n.id === devId("srv1") ? { ...n, hidden: true } : n)),
      edges,
      [],
      { meta: META, measure: approxMeasure }
    )
    expect(doc.nodes.map((n) => n.id)).not.toContain(devId("srv1"))
    for (const l of doc.links)
      expect([l.source.node, l.target.node]).not.toContain(devId("srv1"))
  })

  it("is written by the SVG and draw.io writers", () => {
    const { nodes, edges } = flow("stencil")
    const doc: DiagramDocument = fromFlow(nodes, edges, [], {
      meta: META,
      measure: approxMeasure,
    })
    for (const [text, type] of [
      [toSvg(doc, { measure: approxMeasure }), "image/svg+xml"],
      [toDrawio([doc], { measure: approxMeasure }), "text/xml"],
    ] as const) {
      const dom = new DOMParser().parseFromString(text, type)
      expect(dom.getElementsByTagName("parsererror")).toHaveLength(0)
    }
  })
})
