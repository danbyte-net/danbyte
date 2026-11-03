import { describe, expect, it } from "vitest"
import type { Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { toDrawio } from "@/lib/diagram/drawio"
import { toSvg } from "@/lib/diagram/svg"
import type { DiagramDocument, Rect } from "@/lib/diagram/types"
import { devId, fabricGraph, groupedGraph } from "./__fixtures__/fabric-graph"
import { buildDiagram } from "./diagram/build-diagram"
import { CARD, cardLayout } from "./diagram/card-layout"
import { chassisFrame, chassisGeometry, stripLeast } from "./diagram/chassis"
import { cardNode, fitBox } from "./diagram/to-document"
import type { DiagramCardData } from "./diagram/types"
import { hierCardBox } from "./hier-card"
import {
  GROUP_H,
  GROUP_MAX_W,
  GROUP_TEXT,
  GROUP_W,
  groupBox,
} from "./group-size"
import { sizeOf } from "./node-registry"

// A card's name is never cut: the card grows to fit it, up to about twice
// its old widest, and wraps past that. These pin the sizing, the layout
// reserving the real size, and the exports printing every row.

const m = approxMeasure
const LONG =
  "Sede Ceas de Medicina Interna e Cirurgia Geral Bloco Norte Piso 3 " +
  "Ala Este Sala de Equipamentos Principal"
const WIDE = "Sede Ceas de Medicina Interna Bloco Norte"

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const rectOf = (n: Node): Rect => {
  const w = n.width ?? 0
  const h = n.height ?? 0
  const [ox, oy] = n.origin ?? [0, 0]
  return { x: n.position.x - ox * w, y: n.position.y - oy * h, w, h }
}

function renamed(graph: TopologyGraph, id: string, name: string) {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, name } } : n
    ),
  }
}

describe("site and provider network cards", () => {
  it("keep their least box for a short name", () => {
    expect(groupBox({ kind: "site", name: "DC1", device_count: 3 }, m)).toEqual(
      { width: GROUP_W, height: GROUP_H, rows: ["DC1"] }
    )
  })

  it("grow to fit a whole name, measured", () => {
    const b = groupBox({ kind: "site", name: WIDE, device_count: 12 }, m)
    const nameW = Math.ceil(
      m(WIDE, GROUP_TEXT.NAME_SIZE, GROUP_TEXT.NAME_WEIGHT)
    )
    expect(b.rows).toEqual([WIDE])
    expect(b.width).toBeGreaterThan(GROUP_W)
    expect(b.width).toBeGreaterThan(nameW + GROUP_TEXT.CHROME_X)
    expect(b.height).toBe(GROUP_H)
  })

  it("wrap past twice their least width and grow taller", () => {
    const b = groupBox({ kind: "location", name: LONG, device_count: 1 }, m)
    expect(GROUP_MAX_W).toBe(2 * GROUP_W)
    expect(b.rows.length).toBeGreaterThan(1)
    expect(b.rows.join(" ")).toBe(LONG)
    expect(b.width).toBeLessThanOrEqual(GROUP_MAX_W)
    expect(b.height).toBe(GROUP_H + (b.rows.length - 1) * GROUP_TEXT.NAME_LH)
  })

  it("size a provider network round its icon, count and provider", () => {
    const pn = {
      kind: "provider_network",
      name: WIDE,
      circuit_count: 2,
      provider: { name: "Carrier" },
    }
    const site = groupBox({ kind: "site", name: WIDE, device_count: 2 }, m)
    expect(groupBox(pn, m).width).toBeGreaterThan(site.width)
  })

  it("are what the node registry reserves", () => {
    const n = {
      id: "grp:x",
      type: "sitegroup",
      position: { x: 0, y: 0 },
      data: { kind: "site", name: LONG, device_count: 1, roles: [] },
    } as Node
    const b = groupBox(n.data, m)
    expect(sizeOf(n)).toEqual({ width: b.width, height: b.height })
  })
})

describe("the layout reserves the real card size", () => {
  it("widens a Diagram card for its name and keeps it off its neighbours", () => {
    const graph = renamed(fabricGraph, devId("leaf1"), WIDE)
    const { nodes } = buildDiagram(graph, {
      mode: "simple",
      line: "straight",
      colorMode: "cable",
      measure: m,
    })
    const leaf = nodes.find((n) => n.id === devId("leaf1"))!
    const box = (leaf.data as DiagramCardData).diagram.box
    expect(box.w).toBeGreaterThan(CARD.MAX_W)
    expect(box.title.text).toBe(WIDE)
    expect([leaf.width, leaf.height]).toEqual([box.w, box.h])
    const cards = nodes.filter((n) => n.type === "card").map(rectOf)
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++)
        expect(overlap(cards[i], cards[j])).toBe(false)
  })

  it("lays a grouped map out with its site cards' real sizes", () => {
    const graph = renamed(groupedGraph, groupedGraph.nodes[0].id, LONG)
    const { nodes } = buildDiagram(graph, {
      mode: "simple",
      line: "straight",
      colorMode: "cable",
      measure: m,
    })
    const big = nodes.find((n) => n.id === groupedGraph.nodes[0].id)!
    const want = groupBox(graph.nodes[0].data, m)
    expect([big.width, big.height]).toEqual([want.width, want.height])
    const rects = nodes.filter((n) => n.type === "sitegroup").map(rectOf)
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(overlap(rects[i], rects[j])).toBe(false)
  })

  it("sizes a Hierarchy card from its wrapped header", () => {
    const data = { ...fabricGraph.nodes[0].data, name: LONG }
    const hierCard = hierCardBox(data, { measure: m })
    expect(hierCard.titleRows.length).toBeGreaterThan(1)
    const s = sizeOf({
      id: "h",
      type: "hier",
      position: { x: 0, y: 0 },
      data: { ...data, hierCard },
    })
    expect(s.width).toBe(Math.max(190, hierCard.w))
    expect(s.height).toBeGreaterThan(hierCard.h)
  })
})

describe("virtual chassis frames", () => {
  it("lengthen the name strip to the whole name, members centred", () => {
    const sizes = [
      { w: 100, h: 30 },
      { w: 100, h: 30 },
    ]
    const least = stripLeast(LONG, m)
    const plain = chassisGeometry("v", sizes, [], "L")
    const g = chassisGeometry("v", sizes, [], "L", least)
    expect(plain.h).toBeLessThan(least)
    expect(g.h).toBe(least)
    expect(g.w).toBe(plain.w)
    expect(g.strip.h).toBe(least)
    // Still centred: the stack's offsets are unchanged.
    expect(g.offsets).toEqual(plain.offsets)
    const f = chassisFrame(
      "L",
      [
        { x: 0, y: 0, w: 100, h: 30 },
        { x: 0, y: 34, w: 100, h: 30 },
      ],
      least
    )
    expect(f.h).toBe(least)
    expect(f.y + f.h / 2).toBe(32)
  })
})

describe("the exports print the whole name", () => {
  const doc = (box: ReturnType<typeof cardLayout>, name: string) => {
    const node = cardNode(
      "dev:x",
      { x: 300, y: 100 },
      box,
      { name, lines: [{ key: "ip", text: "10.0.0.1" }] },
      { measure: m }
    )
    const d: DiagramDocument = {
      meta: { title: "t", generated_at: "2026-01-01T00:00:00Z" },
      bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
      bands: [],
      nodes: [node],
      links: [],
      notes: [],
    }
    return { node, d }
  }

  it("carries the full name and its rows in the document", () => {
    const box = cardLayout(
      { name: LONG, lines: [{ key: "ip", text: "10.0.0.1" }] },
      null,
      m
    )
    const { node } = doc(box, LONG)
    expect(node.title).toBe(LONG)
    expect(node.place?.titleRows?.map((r) => r.text)).toEqual(
      box.titleRows.map((r) => r.text)
    )
  })

  it("writes every row to the SVG and draw.io, with no ellipsis", () => {
    const box = cardLayout(
      { name: LONG, lines: [{ key: "ip", text: "10.0.0.1" }] },
      null,
      m
    )
    const { d } = doc(box, LONG)
    const svg = toSvg(d, { measure: m })
    for (const r of box.titleRows) expect(svg).toContain(`>${r.text}<`)
    expect(svg).not.toContain("…")
    const drawio = toDrawio([d], { measure: m })
    expect(drawio).toContain(
      box.titleRows.map((r) => r.text).join("&lt;br&gt;")
    )
    expect(drawio).not.toContain("…")
  })

  it("writes a single-row name whole, past the old 240 px cap", () => {
    const box = cardLayout({ name: WIDE, lines: [] }, null, m)
    expect(box.w).toBeGreaterThan(CARD.MAX_W)
    const { d } = doc(box, WIDE)
    expect(toSvg(d, { measure: m })).toContain(`>${WIDE}<`)
  })

  it("wraps a fixed box's name (a site card) to the box", () => {
    const b = fitBox(
      { name: LONG, lines: [{ key: "count", text: "3 devices" }] },
      { w: GROUP_MAX_W, h: GROUP_H },
      m
    )
    expect(b.w).toBe(GROUP_MAX_W)
    expect(b.titleRows.length).toBeGreaterThan(1)
    for (const r of b.titleRows) {
      expect(r.x).toBe(GROUP_MAX_W / 2)
      expect(r.w).toBeLessThanOrEqual(GROUP_MAX_W)
    }
    expect(b.titleRows.map((r) => r.text).join(" ")).toBe(LONG)
  })
})
