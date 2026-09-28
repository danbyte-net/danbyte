import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { aarhusId } from "../__fixtures__/aarhus-graph"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import {
  boxOf,
  crowdedRuns,
  drawn,
  labelFaults,
  throughCards,
} from "../__fixtures__/route-checks"
import { segHitsRect } from "./spatial"
import { anchorPoint, leadStart } from "./anchors"
import { leaves, routeThrough } from "./link-geometry"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { PHOTO, withFaces } from "./photo-anchors"
import type { FacedData } from "./photo-anchors"
import type {
  Anchor,
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  Rect,
} from "./types"

// Photo nodes in the Diagram, on the Århus DC map with its real front
// photos: each device is its photo to scale, the photos never overlap,
// every cable starts at its port's marker (or a stub lead) and runs
// straight out of the photo, then keeps clear of every photo - its own
// included - and its port name sits on its own line.

const build = (graph: TopologyGraph, o: Partial<DiagramOptions> = {}) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const photos = withFaces(aarhusPhotoGraph, "photo")

const devices = (nodes: Node[]) => nodes.filter((n) => n.type === "card")
const rects = (nodes: Node[]) =>
  new Map<string, Rect>(devices(nodes).map((n) => [n.id, boxOf(n)]))
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inset = (r: Rect, d: number): Rect => ({
  x: r.x + d,
  y: r.y + d,
  w: r.w - 2 * d,
  h: r.h - 2 * d,
})

const MODES: DiagramMode[] = ["detailed", "simple"]

const runLength = (pts: readonly { x: number; y: number }[]) =>
  pts.reduce(
    (sum, p, i) =>
      i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0,
    0
  )

/** Cables whose line, past the leads over their photos, runs through a
 * photo at either end - the curves sampled every 2px. */
function ownCrossings(
  edges: readonly Edge[],
  boxes: ReadonlyMap<string, Rect>
): string[] {
  const out: string[] = []
  for (const e of edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    d.plan.forEach((p, i) => {
      const route = routeThrough(p.line ?? d.line, p.pts, leaves(p.pts))
      const lead = (a: Anchor | undefined, x: number, y: number) =>
        a?.k === "point"
          ? Math.hypot(p.pts[x].x - p.pts[y].x, p.pts[x].y - p.pts[y].y)
          : 0
      const n = p.pts.length
      const la = lead(d.a[i], 0, 1)
      const lb = lead(d.b[i], n - 1, n - 2)
      const steps = Math.max(2, Math.ceil(route.length / 2))
      const pts = Array.from({ length: steps + 1 }, (_, k) => ({
        at: route.at(k / steps),
        d: (k / steps) * route.length,
      })).filter((q) => q.d > la + 1 && q.d < route.length - lb - 1)
      for (let k = 1; k < pts.length; k++)
        for (const id of [e.source, e.target]) {
          const r = boxes.get(id)
          if (r && segHitsRect(pts[k - 1].at, pts[k].at, inset(r, 1))) {
            out.push(`${e.id}#${i} x ${id}`)
            return
          }
        }
    })
  }
  return out
}

describe("photo nodes", () => {
  for (const mode of MODES) {
    it(`${mode}: every device is its photo, to scale, none overlapping`, () => {
      const b = build(photos, { mode })
      const cards = devices(b.nodes)
      expect(cards).toHaveLength(8)
      for (const n of cards) {
        const d = n.data as DiagramCardData
        expect(d.diagram.photo?.kind).toBe("photo")
        expect(n.width).toBe(PHOTO.W)
        expect(n.height).toBe(
          d.diagram.photo!.imgH + PHOTO.CAPTION_GAP + PHOTO.CAPTION_LH
        )
      }
      const boxes = [...rects(b.nodes).values()]
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          expect(overlap(boxes[i], boxes[j])).toBe(false)
    })

    it(`${mode}: cables start at their ports and keep clear of the photos`, () => {
      const b = build(photos, { mode })
      const boxes = rects(b.nodes)
      const cables = drawn(b.nodes, b.edges, approxMeasure)
      expect(cables.length).toBeGreaterThan(0)
      expect(throughCards(cables, boxes)).toEqual([])
      // Past its lead, no line goes back through its own photo either.
      for (const c of cables)
        for (let k = 1; k < c.pts.length - 2; k++)
          for (const id of [c.source, c.target]) {
            const r = boxes.get(id)
            if (r)
              expect(
                segHitsRect(c.pts[k], c.pts[k + 1], inset(r, 1)),
                `${c.edge}#${c.cable} run ${k} x ${id}`
              ).toBe(false)
          }
      // Each photo end: the plan starts at the port and runs straight to
      // the photo's edge.
      let leads = 0
      for (const e of b.edges) {
        const d = e.data as DiagramEdgeData | undefined
        if (e.type !== "link" || !d?.plan) continue
        d.plan.forEach((p, i) => {
          for (const [end, id] of [
            ["a", e.source],
            ["b", e.target],
          ] as const) {
            const a = d[end][i] as Anchor | undefined
            const box = boxes.get(id)
            const from = box && leadStart(box, a)
            if (!from || !a) continue
            leads++
            const [p0, p1] =
              end === "a"
                ? [p.pts[0], p.pts[1]]
                : [p.pts.at(-1)!, p.pts.at(-2)!]
            expect(p0).toEqual(from)
            expect(p1.x).toBeCloseTo(from.x)
            // Out through its exit edge (a stub on the top edge is already
            // there: no lead).
            const exit = anchorPoint(box, a)
            if (exit.y !== from.y)
              expect(Math.sign(p1.y - p0.y)).toBe(exit.dir[1])
          }
        })
      }
      expect(leads).toBeGreaterThan(10)
      expect(labelFaults(cables)).toEqual([])
    })
  }

  it("lands marked ports on their markers, the servers' on stub leads", () => {
    const b = build(photos)
    const at = (name: string) =>
      (b.nodes.find((n) => n.id === aarhusId(name))!.data as DiagramCardData)
        .diagram.photo!
    // ethernet1/1, 1/4, 1/6 and 1/7 on the firewall, each its own marker.
    expect(at("aarhus-fw1").marks.map((m) => m.port)).toEqual([
      "ethernet1/1",
      "ethernet1/4",
      "ethernet1/6",
      "ethernet1/7",
    ])
    expect(at("aarhus-fw1").stubs).toEqual([])
    // No markers on the servers' type: the cable lands on a stub lead,
    // on the edge facing the switch.
    const srv = at("aarhus-srv1")
    expect(srv.marks).toEqual([])
    expect(srv.stubs).toHaveLength(1)
    expect(srv.stubs[0].port).toBe("eno1")
    // The caption steps clear of the leads running down through it.
    const fw = at("aarhus-fw1")
    for (const mark of fw.marks.filter((m) => m.y >= 0.5)) {
      const x = mark.x * PHOTO.W
      expect(x < fw.caption.x || x > fw.caption.x + fw.caption.w).toBe(true)
    }
  })

  it("mixes photos and cards: a device shown as its card stays a card", () => {
    const fw = aarhusId("aarhus-fw1").slice(4)
    const g = withFaces(aarhusPhotoGraph, "photo", { [fw]: { face: "card" } })
    const b = build(g)
    const kind = (id: string) =>
      (b.nodes.find((n) => n.id === id)!.data as DiagramCardData).diagram.photo
        ?.kind
    expect(kind(aarhusId("aarhus-fw1"))).toBeUndefined()
    expect(kind(aarhusId("aarhus-sw1"))).toBe("photo")
    expect(
      throughCards(drawn(b.nodes, b.edges, approxMeasure), rects(b.nodes))
    ).toEqual([])
  })

  it("draws a type without a photo as its faceplate, else its card", () => {
    const g: TopologyGraph = {
      ...photos,
      nodes: photos.nodes.map((n) => {
        const d = n.data as FacedData
        if (d.name === "aarhus-sw1")
          return {
            ...n,
            data: {
              ...d,
              device_type_id: "t-sw",
              photo: { ...d.photo!, front: null, type_faceplate: true },
            },
          }
        if (d.name === "aarhus-sw2")
          return {
            ...n,
            data: {
              ...d,
              photo: { ...d.photo!, front: null, type_faceplate: false },
            },
          }
        return n
      }),
    }
    const b = build(g)
    const shown = (name: string) =>
      (b.nodes.find((n) => n.id === aarhusId(name))!.data as DiagramCardData)
        .diagram.photo
    const plate = shown("aarhus-sw1")!
    expect(plate.kind).toBe("faceplate")
    expect(plate.typeId).toBe("t-sw")
    // A faceplate's ports have no coordinates: its cable is a stub lead.
    expect(plate.marks).toEqual([])
    expect(plate.stubs.map((s) => s.port)).toEqual(["Te1/1/1"])
    expect(shown("aarhus-sw2")).toBeUndefined()
  })

  it("moves what a photo covers in an arrangement saved with cards", () => {
    // The cards' own arrangement, then the same centres with photos.
    const cards = build(aarhusPhotoGraph)
    const positions = Object.fromEntries(
      devices(cards.nodes).map((n): [string, [number, number]] => [
        n.id,
        [n.position.x, n.position.y],
      ])
    )
    const b = build(photos, { positions })
    const boxes = [...rects(b.nodes).values()]
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(overlap(boxes[i], boxes[j])).toBe(false)
    // A card map's arrangement is left as it was.
    const again = build(aarhusPhotoGraph, { positions })
    for (const n of devices(again.nodes))
      expect([n.position.x, n.position.y]).toEqual(positions[n.id])
    expect(
      throughCards(drawn(b.nodes, b.edges, approxMeasure), rects(b.nodes))
    ).toEqual([])
  })

  // Straight and bendy lines keep the rules the elbows keep: never back
  // across their own photos (a port facing away from its far end hooks
  // round the photo), and each port name on its own line.
  for (const mode of MODES)
    for (const line of ["straight", "bendy"] as const)
      it(`${mode} ${line}: lines leave their photos and keep their labels`, () => {
        const b = build(photos, { mode, line })
        const boxes = rects(b.nodes)
        expect(ownCrossings(b.edges, boxes)).toEqual([])
        expect(labelFaults(drawn(b.nodes, b.edges, approxMeasure))).toEqual([])
      })

  it("runs a breakout's trunk round to its legs when its port faces away", () => {
    // Detailed lays the firewall out level with the switch its legs land
    // on: its port leaves by its nearer edge, away from them.
    {
      const b = build(photos, { mode: "detailed", line: "straight" })
      const fan = b.edges.filter(
        (e) => (e.data as DiagramEdgeData | undefined)?.fan
      )
      const lengths = (role: "trunk" | "leg") =>
        fan
          .filter((e) => (e.data as DiagramEdgeData).fan!.role === role)
          .map((e) => runLength((e.data as DiagramEdgeData).plan![0].pts))
          .sort((x, y) => x - y)
      const [trunk] = lengths("trunk")
      const legs = lengths("leg")
      expect(legs.length).toBeGreaterThan(0)
      // One nub, then the trunk carries the distance; the legs are short.
      expect(trunk).toBeGreaterThan(legs[Math.floor(legs.length / 2)])
      const t = fan.find(
        (e) => (e.data as DiagramEdgeData).fan!.role === "trunk"
      )!.data as DiagramEdgeData
      expect(t.fan!.bent).toBe(true)
      expect(t.plan![0].line).toBe("elbow")
    }
  })

  it("points a breakout's trunk at its legs when they lie above it", () => {
    // Simple puts the switch above the firewall: the trunk's port leaves
    // by the top edge, straight at them, and the trunk is not bent.
    const b = build(photos, { mode: "simple", line: "straight" })
    const fw = boxOf(b.nodes.find((n) => n.id === aarhusId("aarhus-fw1"))!)
    const asw = boxOf(b.nodes.find((n) => n.id === aarhusId("aarhus-asw1"))!)
    expect(asw.y + asw.h).toBeLessThanOrEqual(fw.y)
    const t = b.edges.find(
      (e) => (e.data as DiagramEdgeData | undefined)?.fan?.role === "trunk"
    )!.data as DiagramEdgeData
    expect(t.a[0]).toMatchObject({ k: "point", exit: "T" })
    expect(t.fan!.bent).toBeUndefined()
    expect(ownCrossings(b.edges, rects(b.nodes))).toEqual([])
  })

  // Tree stacks the photos like rack rows: a port leaves towards its far
  // device, over the photo, rather than round it - unless another cabled
  // port is in its column that way. No two cables share a run.
  for (const mode of MODES)
    it(`${mode} tree: ports leave towards their far ends`, () => {
      const b = build(photos, { mode, direction: "TB" })
      const boxes = rects(b.nodes)
      let towards = 0
      for (const e of b.edges) {
        const d = e.data as DiagramEdgeData | undefined
        if (e.type !== "link" || !d || d.fan) continue
        d.a.forEach((a, i) => {
          for (const [end, me, far] of [
            ["a", e.source, e.target],
            ["b", e.target, e.source],
          ] as const) {
            const x = (end === "a" ? a : d.b[i]) as Anchor | undefined
            const r = boxes.get(me)
            const f = boxes.get(far)
            if (x?.k !== "point" || x.stub || !r || !f) continue
            const want = f.y + f.h <= r.y ? "T" : f.y >= r.y + r.h ? "B" : null
            if (!want) continue
            if (x.exit === want) {
              towards++
              continue
            }
            // Only a cabled port in its column on the way turns it back.
            const n = b.nodes.find((q) => q.id === me)!
            const marks = (n.data as DiagramCardData).diagram.photo!.marks
            const own = marks.find(
              (m) => Math.abs(m.x - x.fx) < 1e-9 && x.port === m.port
            )!
            expect(
              marks.some(
                (m) =>
                  m !== own &&
                  Math.abs(m.x - own.x) * PHOTO.W < 8 &&
                  (want === "B" ? m.y > own.y : m.y < own.y)
              ),
              `${e.id}#${i}${end} ${x.port}`
            ).toBe(true)
          }
        })
      }
      expect(towards).toBeGreaterThan(4)
      const cables = drawn(b.nodes, b.edges, approxMeasure)
      expect(crowdedRuns(cables, 6)).toEqual([])
      expect(throughCards(cables, boxes)).toEqual([])
    })

  it("puts no count on a line that is one cable to a photo's port", () => {
    for (const mode of MODES) {
      const b = build(photos, { mode })
      const chips = b.edges.flatMap((e) => {
        const d = e.data as DiagramEdgeData | undefined
        return d?.plan ? (d.labels.mid ?? []) : []
      })
      expect(chips.filter((c) => /\d+x$/.test(c))).toEqual([])
    }
    // The same links between cards keep their count.
    const cards = build(aarhusPhotoGraph, { mode: "simple" })
    const counted = cards.edges.flatMap(
      (e) => (e.data as DiagramEdgeData | undefined)?.labels.mid ?? []
    )
    expect(counted.some((c) => /\d+x$/.test(c))).toBe(true)
  })

  it("re-anchors a moved photo: its ports go with it", () => {
    const b = build(photos)
    const moved = b.nodes.map((n) =>
      n.id === aarhusId("aarhus-sw1")
        ? { ...n, position: { x: n.position.x + 600, y: n.position.y + 300 } }
        : n
    )
    const re = relinkDiagram(b.model, moved)
    const sw1 = moved.find((n) => n.id === aarhusId("aarhus-sw1"))!
    const box = boxOf(sw1)
    const e = re.edges.find((x) => x.source === sw1.id || x.target === sw1.id)!
    const d = e.data as DiagramEdgeData
    const end = e.source === sw1.id ? "a" : "b"
    const from = leadStart(box, d[end][0])!
    const p = d.plan![0]
    expect(end === "a" ? p.pts[0] : p.pts.at(-1)).toEqual(from)
    const cables = drawn(moved, re.edges, approxMeasure)
    expect(throughCards(cables, rects(moved))).toEqual([])
  })
})
