import { describe, expect, it } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import { aarhusGraph } from "../__fixtures__/aarhus-graph"
import { boxOf, drawn } from "../__fixtures__/route-checks"
import {
  BAND,
  arrangeBands,
  bandRows,
  chipBand,
  chipWidth,
  mergeDown,
  titleSpot,
  titleStrip,
} from "./bands"
import type { ArrangeCard, Region } from "./bands"
import { buildDiagram, labelRoom } from "./build-diagram"
import type { DiagramBuild, DiagramOptions } from "./build-diagram"
import { elbowBase, obstacles } from "./lanes"
import type { ElbowCable } from "./lanes"
import { boxesOverlap, segHitsRect, turnedBox } from "./spatial"
import type { Anchor, DiagramEdgeData, DiagramMode, Rect } from "./types"

// A layer band's title sits in a strip across the top of its row. Cables
// cross the strip - they have to, to reach the row's cards - but never run
// along it, and the title steps aside from every cable and label that
// crosses it: a title never hides one.

describe("title strips in the elbow planner", () => {
  it("routes the corridor between two cards clear of a strip across it", () => {
    // A card above, a card below, a title strip where the corridor's
    // middle would be.
    const cards: [string, Rect][] = [
      ["a", { x: 0, y: 0, w: 200, h: 60 }],
      ["b", { x: 300, y: 200, w: 200, h: 60 }],
    ]
    const strip: [string, Rect] = ["t", { x: -100, y: 118, w: 800, h: 32 }]
    const cable: ElbowCable = {
      key: "c",
      a: { x: 100, y: 60, dir: [0, 1], node: "a", stub: 14 },
      b: { x: 400, y: 200, dir: [0, -1], node: "b", stub: 14 },
    }
    const free = elbowBase(cable, obstacles(cards))
    const kept = elbowBase(cable, obstacles(cards, [strip]))
    // Unhindered, the corridor runs through the strip; with it, beside it.
    const runY = (pts: { x: number; y: number }[]) =>
      pts.find((p, i) => i > 0 && pts[i - 1].y === p.y && pts[i - 1].x !== p.x)!
        .y
    expect(runY(free.pts)).toBeGreaterThan(118)
    expect(runY(free.pts)).toBeLessThan(150)
    const y = runY(kept.pts)
    expect(y < 118 - 2 || y > 150 + 2).toBe(true)
    // The vertical runs still cross it.
    expect(kept.pts.at(-1)).toEqual({ x: 400, y: 200 })
  })
})

const optsFor = (mode: DiagramMode): DiagramOptions => ({
  mode,
  line: "elbow",
  colorMode: "cable",
  measure: approxMeasure,
  direction: "TB",
})

const cardsOf = (b: DiagramBuild): ArrangeCard[] =>
  b.nodes
    .filter((n) => n.type === "card")
    .map((n) => {
      const d = n.data as { role?: { name: string } | null }
      return {
        id: n.id,
        box: boxOf(n),
        role: d.role ? { id: d.role.name, name: d.role.name } : null,
      }
    })

/** Arrange ▸ Bands by role, as the page runs it: the room for the labels
 * the map shows at its nubs. */
const arranged = (mode: DiagramMode) => {
  const opts = optsFor(mode)
  const first = buildDiagram(aarhusGraph, opts)
  const { positions, regions } = arrangeBands({
    cards: cardsOf(first),
    by: "role",
    room: labelRoom(first.model),
  })
  const b = buildDiagram(aarhusGraph, {
    ...opts,
    positions,
    rows: bandRows(regions),
  })
  return { b, regions, positions }
}

/** The port names a build asks for at its nubs, and the ones it shows. */
function portNames(b: DiagramBuild) {
  const asked: string[] = []
  for (const e of b.edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    d.plan.forEach((_p, i) => {
      for (const end of ["a", "b"] as const) {
        const a = d[end][i] as Anchor | undefined
        if ((a?.k === "side" || a?.k === "point") && a.port) asked.push(a.port)
      }
    })
  }
  const shown = drawn(b.nodes, b.edges, approxMeasure).flatMap((c) =>
    c.labels.filter((l) => !l.ip).map((l) => l.text)
  )
  return { asked: asked.sort(), shown: shown.sort() }
}

describe("port names on an arranged Detailed map", () => {
  it("keeps every one in rows by role", () => {
    const { b } = arranged("detailed")
    const { asked, shown } = portNames(b)
    expect(asked.length).toBe(23)
    expect(shown).toEqual(asked)
  })

  it("keeps every one in a band of two layers", () => {
    const { b, regions, positions } = arranged("detailed")
    const access = regions.find((r) => r.label === "Access")!
    const { regions: merged, moves } = mergeDown({
      regions,
      cards: cardsOf(b),
      id: access.id,
      room: labelRoom(b.model),
    })
    const row = merged.find((r) => r.id === access.id) as Region
    expect(row.label).toBe("Access + Server")
    expect(row.layout).toBe("stack")
    const again = buildDiagram(aarhusGraph, {
      ...optsFor("detailed"),
      positions: { ...positions, ...moves },
      rows: bandRows(merged),
    })
    const { asked, shown } = portNames(again)
    expect(shown).toEqual(asked)
  })

  it("keeps Simple's compact rows", () => {
    const first = buildDiagram(aarhusGraph, optsFor("simple"))
    expect(labelRoom(first.model)).toBeNull()
    const detailed = buildDiagram(aarhusGraph, optsFor("detailed"))
    const room = labelRoom(detailed.model)!
    expect(room.stub).toBeGreaterThan(BAND.PAD_TOP)
    const plain = arrangeBands({ cards: cardsOf(first), by: "role" })
    const roomy = arrangeBands({ cards: cardsOf(first), by: "role", room })
    const height = (rs: readonly Region[]) =>
      Math.max(...rs.map((r) => r.y + r.h)) - Math.min(...rs.map((r) => r.y))
    expect(height(roomy.regions)).toBeGreaterThan(height(plain.regions))
    // No room: the usual spacing.
    expect(
      arrangeBands({ cards: cardsOf(first), by: "role", room: null })
    ).toEqual(plain)
  })
})

describe("row titles on an arranged map", () => {
  for (const mode of ["detailed", "simple"] as const)
    it(`hides no cable, junction or label (${mode})`, () => {
      const { b, regions } = arranged(mode)
      const cables = drawn(b.nodes, b.edges, approxMeasure)
      const rows = b.model.rows!
      expect(rows.length).toBeGreaterThan(2)
      const junctions = b.nodes.filter(
        (n) => n.type === "junction" && !n.hidden
      )
      for (const r of rows) {
        const label = regions.find((x) => x.id === r.id)!.label
        const w = chipWidth(approxMeasure(label, BAND.CHIP_SIZE, 600), r.w)
        const cx = titleSpot(r, w, b.model.titles?.get(r.id))
        const band = chipBand(r)
        const chip = { x: cx - w / 2, y: band.y, w, h: band.h }
        const strip = titleStrip(r)
        for (const c of cables) {
          for (let i = 1; i < c.pts.length; i++) {
            const p = c.pts[i - 1]
            const q = c.pts[i]
            expect(segHitsRect(p, q, chip), `${label}: ${c.edge}`).toBe(false)
            // Nothing runs along the strip.
            if (c.line === "elbow" && p.y === q.y && p.x !== q.x)
              expect(
                p.y > strip.y - 1 &&
                  p.y < strip.y + strip.h + 1 &&
                  Math.max(p.x, q.x) > strip.x &&
                  Math.min(p.x, q.x) < strip.x + strip.w,
                `${label}: ${c.edge} runs along it`
              ).toBe(false)
          }
          for (const l of c.labels)
            expect(
              boxesOverlap(l.box, turnedBox(chip)),
              `${label}: ${l.text}`
            ).toBe(false)
        }
        for (const j of junctions)
          expect(
            segHitsRect(j.position, j.position, chip),
            `${label}: ${j.id}`
          ).toBe(false)
      }
    })
})
