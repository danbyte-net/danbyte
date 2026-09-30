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

/** The photo graph with the firewall's card lines: its IP and serial. */
const withLines = (fields = ["monitor", "primary_ip", "serial"]) => ({
  ...photos,
  nodes: photos.nodes.map((n) => {
    const d = n.data as FacedData
    return d.name === "aarhus-fw1"
      ? {
          ...n,
          data: {
            ...d,
            card: {
              fields,
              source: "default" as const,
              values: {
                primary_ip: {
                  id: "ip1",
                  address: "10.196.227.1",
                  cidr: "10.196.227.1/24",
                },
                serial: "FOC1234",
              },
            },
          },
        }
      : n
  }),
})

describe("photo captions in the exports", () => {
  it("carries the card lines, drawn after the name on the caption line", () => {
    const doc = exportOf(withLines())
    const fw = doc.nodes.find((n) => n.id === fwId)!
    expect(fw.kind).toBe("photo")
    expect(fw.lines).toEqual(["10.196.227.1", "SN FOC1234"])
    const place = fw.place!
    expect(place.lines).toEqual([])
    expect(place.tail?.text).toBe("· 10.196.227.1 · SN FOC1234")
    expect(place.full).toBeUndefined()
    // Right of the name, on the caption line.
    const nameW = approxMeasure("aarhus-fw1", 12, 700)
    expect(place.tail!.x).toBeGreaterThan(place.title.x + nameW / 2)
    expect(Math.abs(place.tail!.y - place.title.y)).toBeLessThan(2)
    expect(place.tail!.y).toBeGreaterThan(fw.photo!.y + fw.photo!.h)
  })

  it("draws them in the SVG, muted, from where the canvas put them", () => {
    const doc = inlined(exportOf(withLines()))
    const svg = toSvg(doc, { measure: approxMeasure })
    const dom = new DOMParser().parseFromString(svg, "image/svg+xml")
    const t = [...dom.querySelectorAll("text")].find(
      (e) => e.textContent === "· 10.196.227.1 · SN FOC1234"
    )!
    expect(t).toBeDefined()
    expect(t.getAttribute("text-anchor")).toBeNull()
    expect(t.getAttribute("font-size")).toBe("10")
    const tail = doc.nodes.find((n) => n.id === fwId)!.place!.tail!
    expect(Number(t.getAttribute("x"))).toBeCloseTo(tail.x, 1)
  })

  it("keeps them on a photo the SVG draws as its card", () => {
    const doc = exportOf(withLines())
    for (const n of doc.nodes)
      if (n.photo) n.photo = { ...n.photo, href: "javascript:alert(1)" }
    const svg = toSvg(doc, { measure: approxMeasure })
    expect(svg).toContain("· 10.196.227.1 · SN FOC1234")
  })

  it("puts them in the draw.io image's label after the bold name", () => {
    const doc = inlined(exportOf(withLines()))
    const xml = toDrawio([doc], { photos: true, measure: approxMeasure })
    const dom = new DOMParser().parseFromString(xml, "application/xml")
    const obj = dom.querySelector(`object[danbyte_id="${fwId}"]`)!
    const label = obj.getAttribute("label")!
    expect(label).toMatch(
      /^<b>aarhus-fw1<\/b> <span style="[^"]*font-size:10px/
    )
    expect(label).toContain("· 10.196.227.1 · SN FOC1234</span>")
    expect(obj.querySelector("mxCell")!.getAttribute("style")).toContain(
      "fontStyle=0;"
    )
  })

  it("draws a photo drawn as its card with the lines its height holds", () => {
    const g = withLines([
      "primary_ip",
      "serial",
      "cf_a",
      "cf_b",
      "cf_c",
      "cf_d",
    ])
    for (const n of g.nodes) {
      const d = n.data as FacedData
      if (d.card)
        Object.assign(d.card.values, {
          cf_a: "one",
          cf_b: "two",
          cf_c: "three",
          cf_d: "four",
        })
    }
    const doc = inlined(exportOf(g))
    const fw = doc.nodes.find((n) => n.id === fwId)!
    expect(fw.lines).toHaveLength(6)
    const xml = toDrawio([doc], { measure: approxMeasure })
    const dom = new DOMParser().parseFromString(xml, "application/xml")
    const label = dom
      .querySelector(`object[danbyte_id="${fwId}"]`)!
      .getAttribute("label")!
    // The card is the photo's box: the name, then two lines.
    const shown = label.split("<br>").length - 1
    const room = Math.floor((fw.h - 2 * 6 - 16 - 1) / 14)
    expect(shown).toBe(room)
    expect(room).toBeLessThan(6)
    expect(label).toContain("10.196.227.1")
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
