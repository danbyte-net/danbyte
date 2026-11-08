import { describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { glyphsAlong } from "@/lib/diagram/geometry"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import { bandedFabric } from "../__fixtures__/banded-fabric"
import { boxOf, drawn, labelFaults } from "../__fixtures__/route-checks"
import { leadAroundNub } from "./anchors"
import { arrangeBands, bandRows } from "./bands"
import type { ArrangeCard } from "./bands"
import { buildDiagram, labelRoom } from "./build-diagram"
import type { DiagramBuild, DiagramOptions } from "./build-diagram"
import { leaves, routeThrough } from "./link-geometry"
import { withFaces } from "./photo-anchors"
import { toDocument } from "./to-document"
import type { Anchor, DiagramEdgeData, DiagramMode, Pt } from "./types"

// Bendy lines on a map arranged in layer bands (Arrange ▸ Bands by role):
// a tall spine/leaf gap full of cables, with every label on. A Bendy line
// is a smooth curve - or, where no curve gets clear, a rounded Elbow - and
// the same curve with its labels or without: the labels follow the curve,
// glyph by glyph, rather than the curve running straight for them, which
// made it a straight run, a kink, a straight diagonal and another kink.

const cardsOf = (b: DiagramBuild): ArrangeCard[] =>
  b.nodes
    .filter((n) => n.type === "card" || n.type === "photo")
    .map((n) => {
      const d = n.data as { role?: { name: string } | null }
      return {
        id: n.id,
        box: boxOf(n),
        role: d.role ? { id: d.role.name, name: d.role.name } : null,
      }
    })

/** The map as Arrange ▸ Bands by role leaves it (arranged once, with the
 * labels on), then built with `o`. */
function banded(
  graph: TopologyGraph,
  mode: DiagramMode,
  o: Partial<DiagramOptions> = {}
) {
  const opts: DiagramOptions = {
    mode,
    line: "bendy",
    colorMode: "cable",
    measure: approxMeasure,
    direction: "TB",
  }
  const first = buildDiagram(graph, opts)
  const { positions, regions } = arrangeBands({
    cards: cardsOf(first),
    by: "role",
    room: labelRoom(first.model),
  })
  const rows = bandRows(regions)
  return {
    b: buildDiagram(graph, { ...opts, positions, rows, ...o }),
    regions,
  }
}

const MAPS: [string, () => TopologyGraph][] = [
  ["fabric", bandedFabric],
  ["photos", () => withFaces(aarhusPhotoGraph, "photo")],
]
const MODES: DiagramMode[] = ["simple", "detailed"]

/** Each planned cable: its line as drawn and its points. */
function cables(b: DiagramBuild) {
  return b.edges.flatMap((e) => {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) return []
    return d.plan.map((p, i) => ({
      key: `${e.id}#${i}`,
      line: p.line ?? d.line,
      pts: p.pts,
      plan: p,
      d,
      i,
    }))
  })
}

/** The sharpest turn the drawn line makes within any 4 px of it,
 * degrees. A rounded Elbow corner turns about 49 there; a curve stays
 * gentler. */
function sharpest(line: string, pts: Pt[]): number {
  const r = routeThrough(line as "bendy", pts, leaves(pts))
  const n = Math.ceil(r.length)
  let most = 0
  for (let d = 0; d + 4 <= n; d++) {
    const p = r.at(d / r.length).angle
    const q = r.at(Math.min(1, (d + 4) / r.length)).angle
    most = Math.max(most, Math.abs(((q - p + 540) % 360) - 180))
  }
  return most
}

/** Does every run of an elbow go straight across or straight down? */
const square = (pts: Pt[]) =>
  pts.every(
    (p, i) =>
      i === 0 ||
      Math.abs(p.x - pts[i - 1].x) < 0.01 ||
      Math.abs(p.y - pts[i - 1].y) < 0.01
  )

describe("Bendy lines in layer bands", () => {
  for (const [name, graph] of MAPS)
    for (const mode of MODES) {
      it(`${name} · ${mode}: a curve or a rounded elbow, never a kink`, () => {
        const { b } = banded(graph(), mode)
        const all = cables(b)
        expect(all.length).toBeGreaterThan(5)
        for (const c of all) {
          // A breakout's trunk is straight.
          if (c.d.fan?.role === "trunk") continue
          expect(["bendy", "elbow"], c.key).toContain(c.line)
          if (c.line === "elbow") expect(square(c.pts), c.key).toBe(true)
          else expect(sharpest(c.line, c.pts), c.key).toBeLessThan(45)
        }
      })

      it(`${name} · ${mode}: the same lines with labels or without`, () => {
        const on = cables(banded(graph(), mode).b)
        const off = cables(banded(graph(), mode, { labels: [] }).b)
        expect(off.map((c) => c.key)).toEqual(on.map((c) => c.key))
        let same = 0
        on.forEach((c, k) => {
          expect(off[k].line, c.key).toBe(c.line)
          // A breakout's split point makes room for its trunk's label;
          // from the same ends, the same curve.
          const [p, q] = [c.pts[0], c.pts.at(-1)!]
          const [u, v] = [off[k].pts[0], off[k].pts.at(-1)!]
          if (c.line !== "bendy" || p.x !== u.x || p.y !== u.y) return
          if (q.x !== v.x || q.y !== v.y) return
          expect(off[k].pts, c.key).toEqual(c.pts)
          same++
        })
        expect(same).toBeGreaterThan(on.length / 2)
      })

      it(`${name} · ${mode}: labels on their own curve, none over another`, () => {
        const { b } = banded(graph(), mode)
        expect(labelFaults(drawn(b.nodes, b.edges, approxMeasure))).toEqual([])
      })

      it(`${name} · ${mode}: text on a curve never reads upside down`, () => {
        const { b } = banded(graph(), mode)
        let bent = 0
        for (const c of cables(b))
          for (const place of [
            c.plan.a,
            c.plan.b,
            ...(c.plan.ips?.a ?? []),
            ...(c.plan.ips?.b ?? []),
          ]) {
            if (!place?.path) continue
            bent++
            const g = glyphsAlong(place.path, "Ethernet1/1", approxMeasure)
            for (const r of g.rotate) {
              // Read left to right, or bottom to top: never past either.
              expect(r).toBeGreaterThanOrEqual(-120)
              expect(r).toBeLessThanOrEqual(100)
            }
            // The glyphs run along the curve the way it reads.
            const [p, q] = [place.path[0], place.path.at(-1)!]
            expect(q.x - p.x).toBeGreaterThan(-Math.abs(q.y - p.y) * 0.2)
          }
        if (mode === "detailed") expect(bent).toBeGreaterThan(0)
      })
    }

  it("names every port of a spine's row of nubs", () => {
    // Ten cables leave each spine's bottom edge, 16 px apart, for the
    // leafs and CE routers: each port name and address fits on its own
    // curve, staggered along it where a neighbour's is in the way.
    const { b } = banded(bandedFabric(), "detailed")
    let asked = 0
    let shown = 0
    let addrs = 0
    let addrsShown = 0
    for (const c of cables(b)) {
      for (const end of ["a", "b"] as const) {
        const anchor = c.d[end][c.i] as Anchor | undefined
        if (anchor?.k === "side" && anchor.port) {
          asked++
          if (c.plan[end]) shown++
        }
        const lines = c.d.labels.ends?.[c.i]?.[end] ?? []
        addrs += lines.length
        addrsShown += c.plan.ips?.[end]?.length ?? 0
      }
    }
    expect(asked).toBe(2 * 56)
    expect(shown).toBe(asked)
    // Addresses are best effort, after every port name.
    expect(addrsShown).toBeGreaterThanOrEqual(addrs * 0.7)
  })

  it("exports the curve and its labels as the canvas draws them", () => {
    const { b, regions } = banded(bandedFabric(), "detailed")
    const doc = toDocument(
      b.model,
      { nodes: b.nodes, edges: b.edges },
      regions,
      {
        meta: { title: "Fabric", generated_at: "2026-11-04T00:00:00Z" },
        measure: approxMeasure,
      }
    )
    const svg = toSvg(doc, { measure: approxMeasure })
    // The labels on curves: their glyphs placed one by one, as plain SVG
    // text the PDF renderer draws too (no textPath).
    expect(svg).toMatch(
      /<text x="[-\d.]+ [-\d.]+[^"]*" y="[^"]+" rotate="[^"]+"/
    )
    expect(svg).not.toContain("textPath")
    // Bendy links are curves, drawn as quadratic pieces, never polylines
    // with corners.
    for (const l of doc.links)
      if (l.kind === "bendy") expect(l.points.length).toBeLessThanOrEqual(4)
  })
})

describe("a photo port's lead and its nub", () => {
  it("stops at the nub on the image's bottom edge and goes on past it", () => {
    const from = { x: 50, y: 40 }
    const to = { x: 50, y: 100 }
    expect(leadAroundNub(from, to, 80)).toEqual([
      [from, { x: 50, y: 80 }],
      [{ x: 50, y: 86 }, to],
    ])
    // Going up, clear of the nub: whole.
    expect(leadAroundNub(from, { x: 50, y: 0 }, 80)).toEqual([
      [from, { x: 50, y: 0 }],
    ])
  })

  it("is drawn round the photos' nubs in the SVG", () => {
    const graph = withFaces(aarhusPhotoGraph, "photo")
    const b = buildDiagram(graph, {
      mode: "detailed",
      line: "bendy",
      colorMode: "cable",
      measure: approxMeasure,
      direction: "TB",
    })
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "Photos", generated_at: "2026-11-04T00:00:00Z" },
      measure: approxMeasure,
    })
    // Photos inlined as they would be for the PDF.
    for (const n of doc.nodes)
      if (n.photo) n.photo.href = "data:image/png;base64,AAAA"
    const svg = toSvg(doc, { measure: approxMeasure })
    const leads = svg.split('<g id="leads">')[1]?.split("</g>")[0] ?? ""
    expect(leads).toContain("<path")
    const runs = [
      ...leads.matchAll(/d="M ([-\d.]+),([-\d.]+) L ([-\d.]+),([-\d.]+)"/g),
    ]
    const nubs = doc.nodes.flatMap((n) => n.nubs ?? [])
    for (const [, x0, y0, x1, y1] of runs) {
      const [ax, ay, bx, by] = [x0, y0, x1, y1].map(Number)
      if (Math.abs(ax - bx) > 0.01) continue
      for (const r of nubs)
        if (ax > r.x && ax < r.x + r.w)
          expect(
            Math.min(ay, by) >= r.y + r.h - 0.01 ||
              Math.max(ay, by) <= r.y + 0.01,
            `${ax},${ay}-${by} over a nub`
          ).toBe(true)
    }
  })
})
