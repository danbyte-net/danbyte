// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import type { Node } from "@xyflow/react"

import type { TopoNode, TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import type {
  DiagramDocument,
  DiagramEnd,
  DiagramNode,
} from "@/lib/diagram/types"
import { DEV, devId, fabricGraph } from "../__fixtures__/fabric-graph"
import { applyHidden, NO_TOPO_HIDDEN } from "../hidden"
import { legendRows } from "../legend"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { NUB } from "./card-layout"
import { printLegend, toDocument } from "./to-document"
import type { DocumentOptions } from "./to-document"
import { routePolyline } from "@/lib/diagram/geometry"
import type { DiagramCardData } from "./types"

// The export document is drawn from the Diagram's model and where the cards
// are now - never the DOM - and carries only what the map means: no hidden
// cards, no dimming, no selection.

/** The fabric as `include=card` sends it: the monitoring pill, then IP,
 * Loopback and Serial. */
const cardGraph: TopologyGraph = {
  ...fabricGraph,
  nodes: fabricGraph.nodes.map((n, i): TopoNode => {
    if (n.data.panel) return n
    const ip = n.data.primary_ip
    return {
      ...n,
      data: {
        ...n.data,
        card: {
          fields: ["monitor", "status", "primary_ip", "loopback", "serial"],
          source: "default",
          values: {
            primary_ip: ip
              ? { id: `ip${i}`, address: ip, cidr: `${ip}/24` }
              : null,
            loopback: [
              {
                id: `lo${i}`,
                address: `10.255.0.${i + 1}`,
                cidr: `10.255.0.${i + 1}/32`,
              },
            ],
            serial: `FDO22${String(i).padStart(3, "0")}X`,
          },
        },
      },
    }
  }),
}

const META: DocumentOptions["meta"] = {
  title: "Fabric",
  generated_at: "2026-09-26T12:00:00Z",
}

function build(o: Partial<DiagramOptions> = {}, graph = cardGraph) {
  return buildDiagram(graph, {
    mode: "detailed",
    line: "straight",
    colorMode: "cable",
    direction: "TB",
    measure: approxMeasure,
    ...o,
  })
}

function exportOf(
  b: ReturnType<typeof build>,
  opts: Partial<DocumentOptions> = {},
  nodes: Node[] = b.nodes,
  withEdges = true
): DiagramDocument {
  return toDocument(
    b.model,
    { nodes, ...(withEdges ? { edges: b.edges } : {}) },
    [],
    { meta: META, measure: approxMeasure, ...opts }
  )
}

const byId = (doc: DiagramDocument) => new Map(doc.nodes.map((n) => [n.id, n]))

/** Is `p` on the edge of `n` (or at a nub's tip, `out` px beyond it)? */
function onEdge(n: DiagramNode, p: DiagramEnd, out = 0): boolean {
  const e = 0.01
  const within = (v: number, lo: number, hi: number) =>
    v >= lo - e && v <= hi + e
  const xs = [n.x - out, n.x + n.w + out]
  const ys = [n.y - out, n.y + n.h + out]
  return (
    (xs.some((x) => Math.abs(p.x - x) < e) && within(p.y, n.y, n.y + n.h)) ||
    (ys.some((y) => Math.abs(p.y - y) < e) && within(p.x, n.x, n.x + n.w))
  )
}

/** Is `p` the midpoint of one of `n`'s sides? */
function atSideMid(n: DiagramNode, p: DiagramEnd): boolean {
  const mids = [
    { x: n.x + n.w / 2, y: n.y },
    { x: n.x + n.w, y: n.y + n.h / 2 },
    { x: n.x + n.w / 2, y: n.y + n.h },
    { x: n.x, y: n.y + n.h / 2 },
  ]
  return mids.some((m) => Math.hypot(m.x - p.x, m.y - p.y) < 0.01)
}

function parse(xml: string, type: DOMParserSupportedType) {
  const dom = new DOMParser().parseFromString(xml, type)
  expect(dom.getElementsByTagName("parsererror")).toHaveLength(0)
  return dom
}

describe("toDocument", () => {
  it("draws each card where the canvas holds it, as the canvas lays it out", () => {
    const b = build()
    const doc = exportOf(b)
    const nodes = byId(doc)
    const cards = b.nodes.filter((n) => n.type === "card")
    expect(doc.nodes).toHaveLength(cards.length)
    for (const n of cards) {
      const { box, nubs } = (n.data as DiagramCardData).diagram
      const d = nodes.get(n.id)!
      expect([d.x, d.y, d.w, d.h]).toEqual([
        n.position.x - box.w / 2,
        n.position.y - box.h / 2,
        box.w,
        box.h,
      ])
      expect(d.title).toBe(box.title.text)
      expect(d.lines).toEqual(box.lines.map((l) => l.text))
      expect(d.place?.title).toEqual({
        x: d.x + box.title.x,
        y: d.y + box.title.y,
      })
      expect(d.nubs ?? []).toHaveLength(nubs.length)
    }
    const spine = nodes.get(devId("spine1"))!
    expect([spine.fill, spine.ink]).toEqual(["#6366f1", "#ffffff"])
    expect(spine.link).toBe(`/devices/${DEV.spine1}`)
    expect(doc.meta).toMatchObject({ title: "Fabric", mode: "detailed" })
  })

  it("follows the live positions, re-anchoring the links there", () => {
    const b = build()
    const at = { x: -3000, y: 40 }
    const moved = b.nodes.map((n) =>
      n.id === devId("srv1") ? { ...n, position: at } : n
    )
    // Without the canvas's edges the links are anchored from the nodes.
    const doc = exportOf(b, {}, moved, false)
    const srv = byId(doc).get(devId("srv1"))!
    expect([srv.x + srv.w / 2, srv.y + srv.h / 2]).toEqual([at.x, at.y])
    const touching = doc.links.filter(
      (l) => l.source.node === srv.id || l.target.node === srv.id
    )
    expect(touching.length).toBeGreaterThan(0)
    for (const l of touching) {
      const end = l.source.node === srv.id ? l.source : l.target
      expect(onEdge(srv, end, NUB.OUT)).toBe(true)
      // The server now sits far to the left: its lines leave its right.
      expect(end.side).toBe("right")
    }
  })

  it("leaves hidden cards and their links out", () => {
    const b = build()
    const nodes = b.nodes.map((n) =>
      n.id === devId("srv1") ? { ...n, hidden: true } : n
    )
    const doc = exportOf(b, {}, nodes)
    expect(byId(doc).has(devId("srv1"))).toBe(false)
    for (const l of doc.links)
      expect([l.source.node, l.target.node]).not.toContain(devId("srv1"))

    // A role switched off with the eyes never reaches the model at all.
    const hidden = { ...NO_TOPO_HIDDEN, roles: ["Server"] }
    const eyes = exportOf(build({}, applyHidden(cardGraph, hidden)))
    expect(eyes.nodes.map((n) => n.title)).not.toContain("srv-db-01")
    expect(eyes.nodes).toHaveLength(doc.nodes.length)
  })

  it("never carries search dimming or selection", () => {
    const plain = exportOf(build())
    const dimmed = exportOf(
      build({
        matched: new Set([devId("leaf1")]),
        focusNodeId: devId("leaf1"),
      })
    )
    expect(dimmed).toEqual(plain)
    expect(JSON.stringify(dimmed)).not.toMatch(/dimmed|selected|opacity/)
  })

  it("keeps each Detailed line on its own nub, port name along the line", () => {
    const doc = exportOf(build())
    const nodes = byId(doc)
    let onNubs = 0
    for (const l of doc.links)
      for (const end of [l.source, l.target]) {
        if (end.nub === undefined) continue
        const nub = nodes.get(end.node)!.nubs![end.nub]
        const tip = {
          top: { x: nub.x + nub.w / 2, y: nub.y },
          bottom: { x: nub.x + nub.w / 2, y: nub.y + nub.h },
          left: { x: nub.x, y: nub.y + nub.h / 2 },
          right: { x: nub.x + nub.w, y: nub.y + nub.h / 2 },
        }[nub.side]
        expect(end.x).toBeCloseTo(tip.x, 6)
        expect(end.y).toBeCloseTo(tip.y, 6)
        expect(end.side).toBe(nub.side)
        onNubs++
      }
    expect(onNubs).toBeGreaterThan(10)
    const lag = doc.links.filter(
      (l) => l.id.startsWith("lag") || l.sem === "bundle"
    )
    expect(lag.length).toBeGreaterThan(0)
    // Port names where the plan seated them, on the line.
    const cable = doc.links.find((l) => l.labels.a)!
    expect(cable.labels.a?.at).toBeTruthy()
  })

  it("writes a Simple document of a Detailed map for draw.io", () => {
    const b = build()
    const doc = exportOf(b, { mode: "simple" })
    expect(doc.meta.mode).toBe("simple")
    const nodes = byId(doc)
    for (const n of doc.nodes) expect(n.nubs).toBeUndefined()
    // The compact Simple card, centred where the Detailed one is.
    const spineLive = b.nodes.find((n) => n.id === devId("spine1"))!
    const spine = nodes.get(devId("spine1"))!
    expect(spine.w).toBe(b.model.base.get(devId("spine1"))!.w)
    expect(spine.x + spine.w / 2).toBe(spineLive.position.x)
    // Every line meets its cards at a side midpoint, no port names.
    for (const l of doc.links) {
      expect(atSideMid(nodes.get(l.source.node)!, l.source)).toBe(true)
      expect(atSideMid(nodes.get(l.target.node)!, l.target)).toBe(true)
      expect(l.labels.a).toBeUndefined()
      expect(l.labels.b).toBeUndefined()
    }
    // A pair's separate cables fold into one line with a count.
    const pair = (a: string, z: string) =>
      doc.links.filter(
        (l) =>
          (l.sem === "cable" || l.sem === "bundle") &&
          [l.source.node, l.target.node].sort().join() === [a, z].sort().join()
      )
    const uplinks = pair(devId("spine1"), devId("leaf1"))
    expect(uplinks).toHaveLength(1)
    expect(uplinks[0]).toMatchObject({ sem: "bundle", labels: { mid: ["2x"] } })
    expect(pair(devId("leaf3"), devId("srv1"))).toHaveLength(1)

    const file = parse(toDrawio([doc], { mode: "simple" }), "text/xml")
    expect(file.querySelectorAll("mxCell[edge='1']").length).toBe(
      doc.links.length
    )
    for (const cell of file.querySelectorAll("mxCell[edge='1']")) {
      const style = cell.getAttribute("style") ?? ""
      const exit = /exitX=([\d.]+);exitY=([\d.]+)/.exec(style)
      expect(exit).not.toBeNull()
      const [x, y] = [Number(exit![1]), Number(exit![2])]
      expect([x, y].some((v) => v === 0.5)).toBe(true)
    }
  })

  it("draws the Detailed picture of a Simple map on request", () => {
    const b = build({ mode: "simple" })
    const doc = exportOf(b, { mode: "detailed" })
    expect(doc.nodes.some((n) => n.nubs?.length)).toBe(true)
    expect(doc.links.some((l) => l.source.nub !== undefined)).toBe(true)
  })

  it("puts the monitoring pill in the card's top-left, in print colours", () => {
    const b = build({ mode: "simple" })
    const doc = exportOf(b, {
      monitor: { [DEV.leaf1]: { status: "down" } },
    })
    const leaf = byId(doc).get(devId("leaf1"))!
    expect(leaf.pill).toEqual({
      kind: "monitor",
      text: "Down",
      fill: "#fb2c36",
      ink: "#ffffff",
    })
    const r = leaf.place!.pill!
    expect(r.x).toBeGreaterThan(leaf.x)
    expect(r.y).toBeGreaterThan(leaf.y)
    expect(r.x + r.w).toBeLessThan(leaf.x + leaf.w / 2)
    // The pill's room was kept: the card is the size the canvas drew.
    const live = b.nodes.find((n) => n.id === devId("leaf1"))!
    expect(leaf.w).toBe(live.width)

    // The tenant's own name and colour; no monitoring: the status pill.
    const named = exportOf(b, {
      monitor: { [DEV.leaf1]: { status: "down" } },
      checkLabels: { down: { name: "Critical", color: "#7f1d1d" } },
    })
    const leaf2 = byId(named).get(devId("leaf1"))!
    expect(leaf2.pill).toMatchObject({ text: "Critical", fill: "#7f1d1d" })
    const oob = byId(named).get(devId("oob1"))!
    expect(oob.pill).toMatchObject({ kind: "status", text: "Decommissioning" })
  })

  it("keeps only the cards in the visible area and the lines between them", () => {
    const b = build()
    const spine = b.nodes.find((n) => n.id === devId("spine1"))!
    const area = {
      x: spine.position.x - 5,
      y: spine.position.y - 5,
      w: 10,
      h: 10,
    }
    const doc = exportOf(b, { area })
    expect(doc.nodes.map((n) => n.id)).toEqual([devId("spine1")])
    expect(doc.links).toHaveLength(0)
  })

  it("turns zones and bands into document bands", () => {
    const b = build()
    const doc = toDocument(
      b.model,
      { nodes: b.nodes, edges: b.edges },
      [
        {
          id: "z1",
          label: "Core",
          x: 0,
          y: 0,
          w: 400,
          h: 200,
          color: "#0ea5e9",
        },
        {
          id: "b1",
          label: "WAN",
          x: 500,
          y: 0,
          w: 200,
          h: 600,
          color: null,
          kind: "band",
          orient: "v",
        },
      ],
      { meta: META, measure: approxMeasure }
    )
    expect(doc.bands).toEqual([
      expect.objectContaining({ id: "zone:z1", kind: "zone", fill: "#0ea5e9" }),
      expect.objectContaining({
        id: "zone:b1",
        kind: "column",
        orient: "v",
        fill: null,
      }),
    ])
  })

  it("is drawn by the SVG writer as well-formed markup", () => {
    const doc = exportOf(build({ line: "elbow" }))
    const svg = toSvg(doc, { measure: approxMeasure, links: true })
    const dom = parse(svg, "image/svg+xml")
    expect(dom.querySelectorAll("#nodes > *").length).toBe(doc.nodes.length)
    // The bounds hold everything the document draws.
    const { x, y, w, h } = doc.bounds
    for (const n of doc.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(x)
      expect(n.y).toBeGreaterThanOrEqual(y)
      expect(n.x + n.w).toBeLessThanOrEqual(x + w)
      expect(n.y + n.h).toBeLessThanOrEqual(y + h)
    }
  })
})

/** The fabric with a /31 on every cable pair. */
const ipGraph: TopologyGraph = {
  ...cardGraph,
  edges: cardGraph.edges.map((e, i) =>
    e.data?.pairs
      ? {
          ...e,
          data: {
            ...e.data,
            pairs: e.data.pairs.map((p, j) => ({
              ...p,
              subnets: [
                {
                  cidr: `10.9.${i}.${4 * j}/31`,
                  family: 4 as const,
                  a: `10.9.${i}.${4 * j}`,
                  b: `10.9.${i}.${4 * j + 1}`,
                },
              ],
            })),
          },
        }
      : e
  ),
}

/** How far `p` lies from a polyline. */
function offLine(
  pts: readonly { x: number; y: number }[],
  p: { x: number; y: number }
) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const [dx, dy] = [b.x - a.x, b.y - a.y]
    const l2 = dx * dx + dy * dy
    const u = l2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
      : 0
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy))
  }
  return best
}

describe("link labels in the exports", () => {
  for (const mode of ["detailed", "simple"] as const)
    it(`${mode}: port names and addresses sit on their line, where the canvas put them`, () => {
      const b = build({ mode, line: "elbow" }, ipGraph)
      const doc = exportOf(b)
      let ends = 0
      for (const l of doc.links) {
        const poly = routePolyline(l)
        for (const label of [
          l.labels.a,
          l.labels.b,
          ...(l.labels.aIps ?? []),
          ...(l.labels.bIps ?? []),
        ]) {
          if (!label) continue
          ends++
          // Seated by the plan, on the line.
          expect(label.at, `${l.id} ${label.text}`).toBeTruthy()
          expect(offLine(poly, label.at!)).toBeLessThan(0.5)
        }
      }
      expect(ends).toBeGreaterThan(8)
      const svg = toSvg(doc, { measure: approxMeasure })
      // Each end label over a box of the page's colour, with no edge.
      const dom = parse(svg, "image/svg+xml")
      const texts = [...dom.querySelectorAll("#labels text")].filter((t) =>
        // The addresses, not the subnet chips.
        /^10\.9\.\d+\.\d+$/.test(t.textContent)
      )
      expect(texts.length).toBeGreaterThan(4)
      for (const t of texts) {
        const rect = t.parentElement!.querySelector("rect")!
        expect(rect.getAttribute("fill")).toBe("#ffffff")
        expect(rect.getAttribute("stroke")).toBeNull()
      }
      // draw.io: a child label on the line over the page's colour.
      const xml = parse(toDrawio([doc], { measure: approxMeasure }), "text/xml")
      const cells = [...xml.getElementsByTagName("mxCell")].filter((c) =>
        /-ip[ab]\d+$/.test(c.getAttribute("id") ?? "")
      )
      expect(cells.length).toBeGreaterThan(4)
      for (const c of cells) {
        expect(c.getAttribute("style")).toContain("edgeLabel")
        expect(c.getAttribute("style")).toContain(
          "labelBackgroundColor=#ffffff"
        )
        expect(c.getAttribute("value")).toMatch(/^10\.9\./)
      }
    })
})

describe("printLegend", () => {
  it("draws the legend in print colours", () => {
    const rows = printLegend(
      legendRows({
        viewStyle: "diagram",
        grouped: false,
        colorMode: "cable",
        roles: [{ name: "Spine", color: "6366f1" }, { name: "Other" }],
        monitorPill: true,
      })
    )
    expect(rows.slice(0, 3)).toEqual([
      { kind: "role", label: "Spine", fill: "#6366f1", ink: "#ffffff" },
      { kind: "role", label: "Other", fill: "#f4f4f5", ink: "#18181b" },
      { kind: "pill", label: "Down", fill: "#fb2c36", ink: "#ffffff" },
    ])
    const bgp = rows.find((r) => r.label === "BGP session")!
    expect(bgp.stroke).toMatch(/^#[0-9a-f]{6}$/)
    expect(bgp.dash).toBe("3 5")
    // Screen-only entries (the colour-mode note) stay off paper.
    expect(rows.map((r) => r.label)).not.toContain("Color: cable")
  })
})
