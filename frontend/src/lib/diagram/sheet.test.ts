import { describe, expect, it } from "vitest"

import { MAX_SCALE, paperLabel, planSheet, printedPt } from "./sheet"

// The same cases as api/tests_topology_export.py SheetTests: the page the
// browser predicts is the page the server draws.

describe("planSheet", () => {
  it("fits A3 landscape under the title block", () => {
    const p = planSheet(
      { w: 2000, h: 1000 },
      { size: "a3", orientation: "landscape" }
    )
    expect(p.page).toEqual({ w: 420, h: 297 })
    expect(p.area).toEqual({ x: 10, y: 10, w: 400, h: 259 })
    expect(p.scale).toBeCloseTo(0.2)
    expect(p.at.x).toBeCloseTo(10)
    // At the top of the area, centred across it.
    expect(p.at.y).toBeCloseTo(10)
    expect(p.at.w).toBeCloseTo(400)
    expect(p.at.h).toBeCloseTo(200)
  })

  it("turns the page for portrait and drops the strip without a title block", () => {
    const p = planSheet(
      { w: 1000, h: 2000 },
      { size: "a4", orientation: "portrait" },
      { titleBlock: false }
    )
    expect(p.page).toEqual({ w: 210, h: 297 })
    expect(p.area).toEqual({ x: 10, y: 10, w: 190, h: 277 })
    expect(p.scale).toBeCloseTo(277 / 2000)
  })

  it("does not blow a small map up", () => {
    const p = planSheet(
      { w: 200, h: 100 },
      { size: "tabloid", orientation: "landscape" }
    )
    expect(p.scale).toBeCloseTo(MAX_SCALE)
    // Centred across the page area.
    expect(p.at.x + p.at.w / 2).toBeCloseTo(10 + p.area.w / 2)
  })

  it("keeps the drawing's shape on every paper", () => {
    for (const size of ["a4", "a3", "letter", "tabloid"] as const)
      for (const orientation of ["landscape", "portrait"] as const) {
        const p = planSheet({ w: 1600, h: 900 }, { size, orientation })
        expect(p.at.w / p.at.h).toBeCloseTo(1600 / 900)
        expect(p.at.x).toBeGreaterThanOrEqual(p.area.x - 1e-9)
        expect(p.at.y + p.at.h).toBeLessThanOrEqual(p.area.y + p.area.h + 1e-9)
      }
  })
})

describe("printedPt", () => {
  it("is 9 pt for 12 px at actual size", () => {
    const p = planSheet(
      { w: 100, h: 100 },
      { size: "a3", orientation: "landscape" }
    )
    expect(printedPt(12, { ...p, scale: 25.4 / 96 })).toBeCloseTo(9)
  })
})

describe("paperLabel", () => {
  it("names the paper", () => {
    expect(paperLabel({ size: "letter", orientation: "portrait" })).toBe(
      "Letter portrait"
    )
  })
})
