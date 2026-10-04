import { describe, expect, it } from "vitest"
import type { Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { boxOf } from "../__fixtures__/route-checks"
import { devId, fabricGraph } from "../__fixtures__/fabric-graph"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { PACK, packLoose } from "./pack"
import type { Loose } from "./pack"
import type { Rect } from "./types"

// Devices with no cable at all are laid out apart from the wired map: a
// grid block under it, one group per role (alphabetical, no role last),
// each group's devices by name. Saved positions are left alone.

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const loose = (
  id: string,
  group: string,
  w = 100,
  h = 40,
  name = id
): Loose => ({ id, group, name, w, h })

describe("packLoose", () => {
  it("packs a grid under the map, left-aligned and at least as wide", () => {
    const above: Rect = { x: -500, y: -200, w: 1000, h: 400 }
    const items = Array.from({ length: 30 }, (_, i) =>
      loose(`d${i}`, "Server", 100, 40, `srv-${i + 1}`)
    )
    const out = packLoose(items, above)
    expect(out.size).toBe(30)
    const xs = [...out.values()].map((p) => p.x)
    const ys = [...out.values()].map((p) => p.y)
    expect(Math.min(...xs) - 50).toBe(above.x)
    expect(Math.min(...ys) - 20).toBe(above.y + above.h + PACK.OFFSET)
    // Rows as wide as the map: 1000 px at 124 px a device.
    const perRow = Math.floor((1000 + PACK.GAP) / (100 + PACK.GAP))
    expect(new Set(ys).size).toBe(Math.ceil(30 / perRow))
    expect(Math.max(...xs) + 50).toBeLessThanOrEqual(above.x + above.w)
  })

  it("groups by role, alphabetical with no role last, by name inside", () => {
    const out = packLoose(
      [
        loose("a", "Server", 100, 40, "srv-10"),
        loose("b", "", 100, 40, "zz"),
        loose("c", "Console", 100, 40, "con-1"),
        loose("d", "Server", 100, 40, "srv-9"),
      ],
      null
    )
    const order = [...out.entries()]
      .sort(([, p], [, q]) => p.y - q.y || p.x - q.x)
      .map(([id]) => id)
    expect(order).toEqual(["c", "d", "a", "b"])
  })

  it("never overlaps, whatever the sizes", () => {
    const items = [
      ...Array.from({ length: 7 }, (_, i) => loose(`p${i}`, "Photo", 480, 64)),
      ...Array.from({ length: 23 }, (_, i) => loose(`c${i}`, "Card", 150, 40)),
      ...Array.from({ length: 3 }, (_, i) => loose(`n${i}`, "", 90, 90)),
    ]
    const out = packLoose(items, { x: 0, y: 0, w: 600, h: 300 })
    const rects = items.map((l) => {
      const c = out.get(l.id)!
      return { x: c.x - l.w / 2, y: c.y - l.h / 2, w: l.w, h: l.h }
    })
    for (let i = 0; i < rects.length; i++) {
      expect(rects[i].y).toBeGreaterThanOrEqual(300 + PACK.OFFSET)
      for (let j = i + 1; j < rects.length; j++)
        expect(overlap(rects[i], rects[j])).toBe(false)
    }
  })

  it("makes a 16:9-ish block when there is no wired map", () => {
    const items = Array.from({ length: 100 }, (_, i) => loose(`d${i}`, ""))
    const out = packLoose(items, null)
    const xs = [...out.values()].map((p) => p.x)
    const ys = [...out.values()].map((p) => p.y)
    const w = Math.max(...xs) - Math.min(...xs) + 100
    const h = Math.max(...ys) - Math.min(...ys) + 40
    expect(w / h).toBeGreaterThan(1.2)
    expect(w / h).toBeLessThan(2.6)
  })
})

describe("buildDiagram: devices with no cable", () => {
  // The fabric map plus a rack's worth of servers and consoles not cabled
  // yet - the kind of spare stock that spread a big site over far rows.
  const spare = (i: number, role: string | null) => ({
    id: `dev:0000${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
    type: "device" as const,
    data: {
      device_id: `0000${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
      name: `${role ?? "spare"}-${i}`.toLowerCase(),
      ...(role ? { role: { name: role, color: "#64748b" } } : {}),
    },
  })
  const graph: TopologyGraph = {
    ...fabricGraph,
    nodes: [
      ...fabricGraph.nodes,
      ...Array.from({ length: 40 }, (_, i) =>
        spare(i, i % 3 ? "Server" : null)
      ),
    ],
  }
  const build = (o: Partial<DiagramOptions> = {}) =>
    buildDiagram(graph, {
      mode: "simple",
      line: "straight",
      colorMode: "cable",
      measure: approxMeasure,
      ...o,
    })
  const wired = new Set(graph.edges.flatMap((e) => [e.source, e.target]))
  const cards = (nodes: Node[]) => nodes.filter((n) => n.type === "card")

  for (const direction of ["LR", "TB"] as const)
    it(`${direction}: packs them in a block under the wired map`, () => {
      const b = build({ direction })
      const all = cards(b.nodes)
      const on = all.filter((n) => wired.has(n.id)).map(boxOf)
      const off = all.filter((n) => !wired.has(n.id)).map(boxOf)
      expect(off).toHaveLength(41)
      const bottom = Math.max(...on.map((r) => r.y + r.h))
      const left = Math.min(...on.map((r) => r.x))
      for (const r of off) {
        expect(r.y).toBeGreaterThanOrEqual(bottom + PACK.OFFSET - 1)
        expect(r.x).toBeGreaterThanOrEqual(left - 1)
      }
      const rects = all.map(boxOf)
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          expect(overlap(rects[i], rects[j])).toBe(false)
    })

  it("leaves a device placed by hand where it was put", () => {
    const b = build()
    const id = spare(5, "Server").id
    const at: [number, number] = [-3000, -3000]
    const positions = Object.fromEntries([
      ...cards(b.nodes).map((n): [string, [number, number]] => [
        n.id,
        [n.position.x, n.position.y],
      ]),
      [id, at],
    ])
    // Every other spare unplaced: they pack; the placed one stays.
    for (const n of graph.nodes)
      if (!wired.has(n.id) && n.id !== id) delete positions[n.id]
    const again = build({ positions })
    const moved = again.nodes.find((n) => n.id === id)!
    expect([moved.position.x, moved.position.y]).toEqual(at)
    for (const n of cards(again.nodes))
      if (wired.has(n.id))
        expect([n.position.x, n.position.y]).toEqual(positions[n.id])
  })

  it("keeps them in their role's tier with Levels on", () => {
    const b = build({ roleOrder: ["Server"], direction: "TB" })
    const a = b.nodes.find((n) => n.id === spare(1, "Server").id)!
    const srv = b.nodes.find((n) => n.id === devId("srv1"))!
    // Level with the cabled server's tier, not in a block under the map.
    expect(a.position.y).toBeCloseTo(srv.position.y)
    const packed = build({ direction: "TB" }).nodes.find((n) => n.id === a.id)!
    expect(packed.position.y).toBeGreaterThan(srv.position.y)
  })
})
