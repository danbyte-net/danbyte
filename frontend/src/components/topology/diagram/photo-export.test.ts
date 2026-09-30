// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import type { DiagramDocument, DiagramLink } from "@/lib/diagram/types"
import { aarhusId } from "../__fixtures__/aarhus-graph"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { withFaces } from "./photo-anchors"
import type { FacedData } from "./photo-anchors"
import { toDocument } from "./to-document"
import type { DocumentOptions } from "./to-document"

// Photo nodes in the exports: the document carries each photo with the
// markers its lines land on and the caption where the canvas put it, and a
// line on a photo port starts at the port - its lead to the photo's edge
// is the first run. The SVG draws the leads again over the photos; draw.io
// draws the photos as cards unless asked for them, then as image cells
// with the lines attached at their ports.

const META: DocumentOptions["meta"] = {
  title: "Århus DC",
  generated_at: "2026-09-27T12:00:00Z",
}

const photos = withFaces(aarhusPhotoGraph, "photo")

function exportOf(
  graph: TopologyGraph = photos,
  o: Partial<DiagramOptions> = {},
  d: Partial<DocumentOptions> = {}
): DiagramDocument {
  const b = buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })
  return toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
    meta: META,
    measure: approxMeasure,
    ...d,
  })
}

/** An inlined photo, as the export menu hands draw.io and the SVG one. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const inlined = (doc: DiagramDocument): DiagramDocument => ({
  ...doc,
  nodes: doc.nodes.map((n) =>
    n.photo ? { ...n, photo: { ...n.photo, href: PNG } } : n
  ),
})

const fwId = aarhusId("aarhus-fw1")
const fwLinks = (doc: DiagramDocument) =>
  doc.links.filter((l) => l.source.node === fwId || l.target.node === fwId)
const fwEnd = (l: DiagramLink) => (l.source.node === fwId ? l.source : l.target)
/** The run from the end on the firewall to the next point. */
const fwLead = (l: DiagramLink) => {
  const pts = [l.source, ...l.points, l.target]
  return l.source.node === fwId ? [pts[0], pts[1]] : [pts.at(-1)!, pts.at(-2)!]
}

describe("photo nodes in the document", () => {
  it("carries the photo, its cabled markers and the caption", () => {
    const doc = exportOf()
    const fw = doc.nodes.find((n) => n.id === fwId)!
    expect(fw.kind).toBe("photo")
    expect(fw.title).toBe("aarhus-fw1")
    expect(fw.lines).toEqual([])
    const ph = fw.photo!
    expect(ph.href).toBe("/media/device-type-images/fw.png")
    expect([ph.x, ph.y, ph.w]).toEqual([fw.x, fw.y, fw.w])
    expect(ph.h).toBeLessThan(fw.h)
    expect(ph.markers.map((m) => m.port)).toEqual([
      "ethernet1/1",
      "ethernet1/4",
      "ethernet1/6",
      "ethernet1/7",
    ])
    for (const m of ph.markers) {
      expect(m.x).toBeGreaterThanOrEqual(ph.x)
      expect(m.y + m.h).toBeLessThanOrEqual(ph.y + ph.h + 0.01)
    }
    // The caption under the image.
    expect(fw.place!.title.y).toBeGreaterThan(ph.y + ph.h)
  })

  it("starts each line on a photo port, its lead straight to the edge", () => {
    const doc = exportOf()
    const fw = doc.nodes.find((n) => n.id === fwId)!
    const links = fwLinks(doc)
    expect(links.length).toBe(4)
    for (const l of links) {
      const end = fwEnd(l)
      expect(end.marker).toBe(true)
      const [p, q] = fwLead(l)
      // At a marker's centre, running straight up or down out of the photo.
      const m = fw.photo!.markers.find(
        (k) => Math.abs(k.x + k.w / 2 - p.x) < 0.01
      )
      expect(m).toBeDefined()
      expect(q.x).toBeCloseTo(p.x)
      expect(q.y <= fw.y || q.y >= fw.y + fw.h).toBe(true)
      expect(end.side === "top" || end.side === "bottom").toBe(true)
      // Its port name on the line.
      const label = l.source.node === fwId ? l.labels.a : l.labels.b
      expect(label?.text).toMatch(/^ethernet1\//)
    }
  })

  it("keeps a photo's lines on their ports in a Simple document", () => {
    const doc = exportOf(photos, {}, { mode: "simple" })
    const toCore2 = fwLinks(doc).filter(
      (l) =>
        l.source.node === aarhusId("aarhus-core2") ||
        l.target.node === aarhusId("aarhus-core2")
    )
    // Two cables, two ports: not folded into one line.
    expect(toCore2).toHaveLength(2)
    expect(toCore2.every((l) => fwEnd(l).marker)).toBe(true)
  })

  it("exports a faceplate node as a card, its lines from its edge", () => {
    const g: TopologyGraph = {
      ...photos,
      nodes: photos.nodes.map((n) => {
        const d = n.data as FacedData
        return d.name === "aarhus-fw1"
          ? {
              ...n,
              data: {
                ...d,
                device_type_id: "t-fw",
                photo: { ...d.photo!, front: null, type_faceplate: true },
              },
            }
          : n
      }),
    }
    const doc = exportOf(g)
    const fw = doc.nodes.find((n) => n.id === fwId)!
    expect(fw.kind).toBe("card")
    expect(fw.photo).toBeUndefined()
    expect(fw.title).toBe("aarhus-fw1")
    for (const l of fwLinks(doc)) {
      const end = fwEnd(l)
      expect(end.marker).toBeUndefined()
      expect(end.y === fw.y || end.y === fw.y + fw.h).toBe(true)
    }
  })
})

describe("photo nodes in the SVG", () => {
  it("draws each lead again over its photo", () => {
    const doc = inlined(exportOf())
    const svg = toSvg(doc, { measure: approxMeasure })
    const dom = new DOMParser().parseFromString(svg, "image/svg+xml")
    expect(dom.querySelector("parsererror")).toBeNull()
    expect(dom.querySelectorAll("symbol image")).toHaveLength(1)
    const leads = dom.querySelectorAll("#leads path")
    // One per photo port, less the stubs on a top edge: they are there.
    const photoEnds = doc.links.flatMap((l) =>
      [l.source, l.target].filter((e) => {
        const n = doc.nodes.find((k) => k.id === e.node)!
        return e.marker && e.y !== n.y
      })
    )
    expect(leads.length).toBe(photoEnds.length)
    expect(leads.length).toBeGreaterThan(10)
    // After the nodes, before the labels.
    const order = [...dom.querySelectorAll("svg > g")].map((g) => g.id)
    expect(order.indexOf("leads")).toBe(order.indexOf("nodes") + 1)
  })

  it("draws no leads for a photo it cannot show", () => {
    const svg = toSvg(exportOf(), { measure: approxMeasure })
    // A same-origin URL is shown; a refused one is drawn as its card.
    expect(svg).toContain('id="leads"')
    const refused = exportOf()
    for (const n of refused.nodes)
      if (n.photo) n.photo = { ...n.photo, href: "javascript:alert(1)" }
    expect(toSvg(refused, { measure: approxMeasure })).not.toContain(
      'id="leads"'
    )
  })
})

describe("photo nodes in draw.io", () => {
  const cells = (xml: string) =>
    new DOMParser().parseFromString(xml, "application/xml")

  it("draws photos as cards by default", () => {
    const xml = toDrawio([inlined(exportOf())], { measure: approxMeasure })
    expect(xml).not.toContain("shape=image;")
    const dom = cells(xml)
    const fw = dom.querySelector(`object[danbyte_id="${fwId}"] mxCell`)!
    expect(fw.getAttribute("style")).toContain("rounded=1;")
  })

  it("draws inlined photos as images, lines attached at their ports", () => {
    const doc = inlined(exportOf())
    const xml = toDrawio([doc], {
      mode: "detailed",
      photos: true,
      measure: approxMeasure,
    })
    const dom = cells(xml)
    expect(dom.querySelector("parsererror")).toBeNull()
    const obj = dom.querySelector(`object[danbyte_id="${fwId}"]`)!
    const style = obj.querySelector("mxCell")!.getAttribute("style")!
    expect(style).toContain("shape=image;")
    // draw.io's own data URI form: no `;base64` inside a style.
    expect(style).toContain("image=data:image/png,iVBOR")
    expect(style).not.toContain(";base64")
    expect(style).toMatch(
      /points=\[\[[\d.]+,[\d.]+,0\](,\[[\d.]+,[\d.]+,0\]){3}\]/
    )
    expect(obj.getAttribute("label")).toBe("aarhus-fw1")
    // The image box, not the caption under it.
    const fw = doc.nodes.find((n) => n.id === fwId)!
    const geo = obj.querySelector("mxGeometry")!
    expect(Number(geo.getAttribute("height"))).toBeCloseTo(fw.photo!.h, 1)
    // Each firewall line leaves its port: a constraint inside the image.
    const id = obj.getAttribute("id")!
    const edges = [...dom.querySelectorAll("mxCell[edge='1']")].filter(
      (c) => c.getAttribute("source") === id || c.getAttribute("target") === id
    )
    expect(edges).toHaveLength(4)
    for (const e of edges) {
      const st = e.getAttribute("style")!
      const out = e.getAttribute("source") === id ? "exit" : "entry"
      const fy = Number(new RegExp(`${out}Y=([\\d.]+);`).exec(st)![1])
      expect(fy).toBeGreaterThan(0)
      expect(fy).toBeLessThan(1)
    }
    // The photo comes before the lines, so their leads show over it.
    expect(xml.indexOf(`danbyte_id="${fwId}"`)).toBeLessThan(
      xml.indexOf('edge="1"')
    )
  })

  it("draws a photo that was not inlined as its card", () => {
    const xml = toDrawio([exportOf()], { photos: true, measure: approxMeasure })
    expect(xml).not.toContain("shape=image;")
  })
})
