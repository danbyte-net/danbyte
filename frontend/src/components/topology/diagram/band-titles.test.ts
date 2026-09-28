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
  titleSpot,
  titleStrip,
} from "./bands"
import type { ArrangeCard } from "./bands"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { elbowBase, obstacles } from "./lanes"
import type { ElbowCable } from "./lanes"
import { boxesOverlap, segHitsRect, turnedBox } from "./spatial"
import type { DiagramMode, Rect } from "./types"

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

describe("row titles on an arranged map", () => {
  const arranged = (mode: DiagramMode) => {
    const opts: DiagramOptions = {
      mode,
      line: "elbow",
      colorMode: "cable",
      measure: approxMeasure,
      direction: "TB",
    }
    const first = buildDiagram(aarhusGraph, opts)
    const cards: ArrangeCard[] = first.nodes
      .filter((n) => n.type === "card")
      .map((n) => {
        const d = n.data as { role?: { name: string } | null }
        return {
          id: n.id,
          box: boxOf(n),
          role: d.role ? { name: d.role.name } : null,
        }
      })
    const { positions, regions } = arrangeBands({ cards, by: "role" })
    const b = buildDiagram(aarhusGraph, {
      ...opts,
      positions,
      rows: bandRows(regions),
    })
    return { b, regions }
  }

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
