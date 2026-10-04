import { describe, expect, it } from "vitest"
import type { Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { aarhusId } from "../__fixtures__/aarhus-graph"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import {
  boxOf,
  drawn,
  labelFaults,
  throughCards,
} from "../__fixtures__/route-checks"
import {
  anchorLinks,
  anchorPoint,
  imageBox,
  leadStart,
  linkEnds,
} from "./anchors"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { NUB } from "./card-layout"
import { anchorOf, captionCap, PHOTO, withFaces } from "./photo-anchors"
import type { FacedData } from "./photo-anchors"
import { toDocument } from "./to-document"
import type {
  Anchor,
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  Rect,
} from "./types"

// Photos taking their cables at their edge (Ports | Edge): the photo is
// anchored like a card on its image - Simple lines meet at the facing
// side's midpoint, Detailed ones leave a nub each, spread along the side,
// with their port names on the line. The ports on the photo are not used
// and not outlined. A line off the bottom leaves under the caption, its
// lead running up to the image.

const build = (graph: TopologyGraph, o: Partial<DiagramOptions> = {}) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const edge = withFaces(aarhusPhotoGraph, "photo", undefined, "edge")

const devices = (nodes: Node[]) => nodes.filter((n) => n.type === "card")
const rects = (nodes: Node[]) =>
  new Map<string, Rect>(devices(nodes).map((n) => [n.id, boxOf(n)]))
const photoOf = (nodes: Node[], name: string) =>
  (nodes.find((n) => n.id === aarhusId(name))!.data as DiagramCardData).diagram

const MODES: DiagramMode[] = ["detailed", "simple"]

type SideAnchor = Extract<Anchor, { k: "side" }>

/** Every drawn end on a photo: its anchor, its node's box, and the
 * planned points from that end. */
function photoEnds(nodes: Node[], edges: readonly { data?: unknown }[]) {
  const boxes = rects(nodes)
  const out: { a: SideAnchor; box: Rect; pts: { x: number; y: number }[] }[] =
    []
  for (const e of edges as {
    source: string
    target: string
    type?: string
    data?: DiagramEdgeData
  }[]) {
    const d = e.data
    if (e.type !== "link" || !d?.plan) continue
    d.plan.forEach((p, i) => {
      for (const [end, id] of [
        ["a", e.source],
        ["b", e.target],
      ] as const) {
        const a = d[end][i] as Anchor | undefined
        const box = boxes.get(id)
        if (!a || !box || a.k !== "side" || !a.cap) continue
        out.push({ a, box, pts: end === "a" ? p.pts : [...p.pts].reverse() })
      }
    })
  }
  return out
}

describe("photo anchors: Ports | Edge", () => {
  it("marks the photos taking their cables at their edge", () => {
    const fw = aarhusId("aarhus-fw1").slice(4)
    const sw1 = aarhusId("aarhus-sw1").slice(4)
    const g = withFaces(
      aarhusPhotoGraph,
      "photo",
      {
        [fw]: { anchor: "ports" },
        [sw1]: { face: "card" },
      },
      "edge"
    )
    const data = (name: string) =>
      g.nodes.find((n) => n.id === aarhusId(name))!.data as FacedData
    expect(data("aarhus-core1").anchor).toBe("edge")
    expect(data("aarhus-fw1").face).toBe("photo")
    expect(data("aarhus-fw1").anchor).toBeUndefined()
    // A card has no anchor to take.
    expect(data("aarhus-sw1").face).toBeUndefined()
    expect(data("aarhus-sw1").anchor).toBeUndefined()
    // Nothing to change: the same graph back, and back to ports.
    expect(
      withFaces(
        g,
        "photo",
        {
          [fw]: { anchor: "ports" },
          [sw1]: { face: "card" },
        },
        "edge"
      )
    ).toBe(g)
    const ports = withFaces(g, "photo")
    expect(ports.nodes.every((n) => !(n.data as FacedData).anchor)).toBe(true)
    expect(anchorOf(fw, "edge", { [fw]: { anchor: "ports" } })).toBe("ports")
    expect(anchorOf(sw1, "edge", {})).toBe("edge")
  })

  it("puts a bottom end under the caption, its lead up to the image", () => {
    const box: Rect = { x: 0, y: 0, w: 480, h: 64 }
    const cap = 20
    const img = imageBox(box, cap)
    expect(img).toEqual({ x: 0, y: 0, w: 480, h: 44 })
    const b: Anchor = { k: "side", side: "B", off: 100, cap }
    expect(anchorPoint(box, b)).toEqual({ x: 100, y: 64, dir: [0, 1] })
    expect(anchorPoint(box, b, NUB.OUT).y).toBe(64)
    expect(leadStart(box, b)).toEqual({ x: 100, y: 44 })
    // Top and sides are the image's own, with no lead.
    const t: Anchor = { k: "side", side: "T", off: 100, cap }
    expect(anchorPoint(box, t, NUB.OUT)).toEqual({
      x: 100,
      y: -NUB.OUT,
      dir: [0, -1],
    })
    expect(leadStart(box, t)).toBeNull()
    const l: Anchor = { k: "side", side: "L", off: 22, cap }
    expect(anchorPoint(box, l)).toEqual({ x: 0, y: 22, dir: [-1, 0] })
    // A card's side has no lead at all.
    expect(leadStart(box, { k: "side", side: "B", off: 100 })).toBeNull()
  })

  it("anchors a capped node on its image, like a card", () => {
    const boxes = new Map<string, Rect>([
      ["p", { x: 0, y: 0, w: 480, h: 64 }],
      ["q", { x: 600, y: 10, w: 120, h: 40 }],
      ["r", { x: 100, y: 400, w: 120, h: 40 }],
    ])
    const links = [
      {
        id: "pq",
        source: "p",
        target: "q",
        cables: [{ a: "e1" }, { a: "e2" }],
      },
      { id: "pr", source: "p", target: "r", cables: [{ a: "e3" }] },
    ]
    const caps = new Map([["p", 20]])
    const det = anchorLinks(boxes, links, "detailed", { caps })
    const pq = det.links.get("pq")!.a
    expect(pq.map((a) => a.k === "side" && [a.side, a.cap])).toEqual([
      ["R", 20],
      ["R", 20],
    ])
    // Spread along the image's height, not the caption's.
    for (const a of pq)
      if (a.k === "side") {
        expect(a.off).toBeGreaterThan(0)
        expect(a.off).toBeLessThan(44)
      }
    expect(det.links.get("pr")!.a[0]).toMatchObject({ side: "B", cap: 20 })
    // The far cards carry no cap.
    expect(det.links.get("pq")!.b[0]).not.toHaveProperty("cap")
    // Simple: one line, at the side's midpoint - kept while it is dragged.
    const simple = anchorLinks(boxes, links, "simple", { caps })
    expect(simple.links.get("pq")!.a).toEqual([
      { k: "side", side: "R", off: 22, port: "e1", cap: 20 },
    ])
    const ends = linkEnds(
      { ...simple.links.get("pr")!, simple: true },
      boxes.get("p")!,
      boxes.get("r")!
    )
    expect(ends[0][0]).toEqual({ x: 240, y: 64, dir: [0, 1] })
  })

  for (const mode of MODES)
    it(`${mode}: no ports used or outlined, lines clear of the photos`, () => {
      const b = build(edge, { mode })
      for (const n of devices(b.nodes)) {
        const d = (n.data as DiagramCardData).diagram
        expect(d.photo?.kind).toBe("photo")
        expect(d.photo!.marks).toEqual([])
        expect(d.photo!.stubs).toEqual([])
      }
      const cables = drawn(b.nodes, b.edges, approxMeasure)
      expect(throughCards(cables, rects(b.nodes))).toEqual([])
      expect(labelFaults(cables)).toEqual([])
      for (const e of b.edges) {
        const d = e.data as DiagramEdgeData | undefined
        if (e.type !== "link" || !d) continue
        for (const a of [...d.a, ...d.b]) expect(a.k).not.toBe("point")
      }
      // Every end on the image's edge; off the bottom, the lead first.
      const ends = photoEnds(b.nodes, b.edges)
      expect(ends.length).toBeGreaterThan(8)
      for (const { a, box, pts } of ends) {
        const img = imageBox(box, a.cap)
        const [p0, p1] = pts
        if (a.side === "B") {
          expect(p0).toEqual({ x: box.x + a.off, y: img.y + img.h })
          expect(p1).toEqual({ x: p0.x, y: box.y + box.h })
        } else if (a.side === "T") expect(p0.y).toBeLessThanOrEqual(img.y)
        else {
          expect(p0.y).toBeGreaterThanOrEqual(img.y)
          expect(p0.y).toBeLessThanOrEqual(img.y + img.h)
        }
      }
    })

  it("simple: a side's lines meet at its midpoint, one line per pair", () => {
    const b = build(edge, { mode: "simple" })
    for (const { a, box } of photoEnds(b.nodes, b.edges)) {
      const len = a.side === "T" || a.side === "B" ? box.w : box.h - a.cap!
      expect(a.off).toBeCloseTo(len / 2)
    }
    // The core pair's two cables are one line with its count again.
    const chips = b.edges.flatMap(
      (e) => (e.data as DiagramEdgeData | undefined)?.labels.mid ?? []
    )
    expect(chips.some((c) => /2x$/.test(c))).toBe(true)
    const ports = build(withFaces(aarhusPhotoGraph, "photo"), {
      mode: "simple",
    })
    expect(b.edges.filter((e) => e.type === "link").length).toBeLessThanOrEqual(
      ports.edges.filter((e) => e.type === "link").length
    )
  })

  it("detailed: a nub per cable on the image, the caption clear of them", () => {
    const b = build(edge)
    const core1 = photoOf(b.nodes, "aarhus-core1")
    expect(core1.nubs.length).toBeGreaterThan(3)
    const cap = captionCap({ h: core1.box.h, imgH: core1.photo!.imgH })
    expect(cap).toBe(PHOTO.CAPTION_GAP + PHOTO.CAPTION_LH)
    const offs = new Set(core1.nubs.map((n) => `${n.side}${n.off}`))
    expect(offs.size).toBe(core1.nubs.length)
    for (const n of core1.nubs)
      if (n.side === "L" || n.side === "R") {
        expect(n.off).toBeGreaterThan(0)
        expect(n.off).toBeLessThan(core1.photo!.imgH)
      }
    // The caption steps round the nubs on the bottom edge.
    for (const name of ["aarhus-core1", "aarhus-asw1", "aarhus-fw1"]) {
      const d = photoOf(b.nodes, name)
      const c = d.photo!.caption
      for (const n of d.nubs.filter((x) => x.side === "B"))
        expect(
          n.off + NUB.ALONG / 2 <= c.x || n.off - NUB.ALONG / 2 >= c.x + c.w
        ).toBe(true)
    }
    // Moved, its lines go with it and stay clear.
    const moved = b.nodes.map((n) =>
      n.id === aarhusId("aarhus-sw1")
        ? { ...n, position: { x: n.position.x + 700, y: n.position.y + 200 } }
        : n
    )
    const re = relinkDiagram(b.model, moved)
    expect(
      throughCards(drawn(moved, re.edges, approxMeasure), rects(moved))
    ).toEqual([])
  })

  it("exports the edge nubs, the lines leaving them", () => {
    const b = build(edge)
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "Århus DC", generated_at: "2026-09-28T12:00:00Z" },
      measure: approxMeasure,
    })
    const core1 = doc.nodes.find((n) => n.id === aarhusId("aarhus-core1"))!
    expect(core1.kind).toBe("photo")
    expect(core1.photo!.markers).toEqual([])
    expect(core1.nubs!.length).toBe(
      photoOf(b.nodes, "aarhus-core1").nubs.length
    )
    const img = core1.photo!
    for (const n of core1.nubs!) {
      if (n.side === "bottom") expect(n.y).toBeCloseTo(img.y + img.h)
      if (n.side === "top") expect(n.y + n.h).toBeCloseTo(img.y)
    }
    // Every end on core1 leaves its own nub or its lead's foot.
    const ends = doc.links.flatMap((l) =>
      [l.source, l.target].filter((e) => e.node === core1.id)
    )
    expect(ends.length).toBe(core1.nubs!.length)
    for (const e of ends) expect(e.nub !== undefined || e.marker).toBe(true)
    // draw.io: the nubs are cells the lines attach to.
    const xml = toDrawio([doc], { mode: "detailed", measure: approxMeasure })
    expect(xml).toContain(`-nub-${core1.nubs!.length - 1}`)
    // Simple folds the pair's cables like a card's.
    const simple = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "Århus DC", generated_at: "2026-09-28T12:00:00Z" },
      mode: "simple",
      measure: approxMeasure,
    })
    expect(simple.links.length).toBeLessThan(doc.links.length)
    expect(simple.nodes.every((n) => !n.nubs?.length)).toBe(true)
  })
})
