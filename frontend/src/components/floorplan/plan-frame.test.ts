import { describe, expect, it } from "vitest"

import {
  EARTH_CIRCUMFERENCE_M,
  latOf,
  lngOf,
  mercX,
  mercY,
} from "@/components/site-map/plan-from-map"

import {
  centreInner,
  frameAround,
  frameBbox,
  frameError,
  frameOfPlan,
  handleAt,
  innerBbox,
  moveFrame,
  frameOffset,
  moveInner,
  resizeFrame,
  sidesOfFrame,
  snapshotFrame,
} from "./plan-geo"
import type { AnchoredPlan, CellFrame } from "./plan-geo"

// The frame shared by Expand and From site map: handles resize it in whole
// cells, never smaller than the grid it holds; the dashed grid moves inside
// it in whole cells.

const at = (f: CellFrame, cellsX: number, cellsY: number) => ({
  lng: lngOf(f.x + cellsX * f.cx),
  lat: latOf(f.y + cellsY * f.cy),
})

describe("a frame in whole cells", () => {
  const f0 = frameAround({ lat: 56, lng: 10 }, 30, 20, 600)

  it("starts at the grid's real size", () => {
    const b = frameBbox(f0)
    const per = EARTH_CIRCUMFERENCE_M * Math.cos((56 * Math.PI) / 180)
    expect((mercX(b.east) - mercX(b.west)) * per).toBeCloseTo(18, 3)
    expect((mercY(b.south) - mercY(b.north)) * per).toBeCloseTo(12, 3)
    expect(innerBbox(f0)).toEqual(b)
  })

  it("snaps a dragged edge or corner to whole cells", () => {
    const e = resizeFrame(f0, "e", at(f0, 41.4, 3))
    expect([e.w, e.h, e.ix]).toEqual([41, 20, 0])
    const se = resizeFrame(f0, "se", at(f0, 35.6, 27.7))
    expect([se.w, se.h]).toEqual([36, 28])
    // West and north move the frame's corner; the grid keeps its place.
    const nw = resizeFrame(f0, "nw", at(f0, -5.3, -2.6))
    expect([nw.w, nw.h, nw.ix, nw.iy]).toEqual([35, 23, 5, 3])
    expect(innerBbox(nw).west).toBeCloseTo(innerBbox(f0).west, 12)
    expect(mercX(frameBbox(nw).west)).toBeCloseTo(f0.x - 5 * f0.cx, 12)
    expect(handleAt(nw, "nw").lat).toBeCloseTo(frameBbox(nw).north, 12)
  })

  it("never gets smaller than the grid", () => {
    const e = resizeFrame(f0, "e", at(f0, 10, 0))
    expect(e.w).toBe(30)
    const w = resizeFrame(f0, "w", at(f0, 12, 0))
    expect([w.w, w.ix]).toEqual([30, 0])
    const grown = resizeFrame(f0, "w", at(f0, -6, 0))
    // Pulled back in past the grid: stops at it.
    expect(resizeFrame(grown, "w", at(grown, 20, 0)).w).toBe(30)
  })

  it("moves the grid inside in whole cells, kept inside", () => {
    const big = centreInner(resizeFrame(f0, "se", at(f0, 40, 30)))
    expect([big.ix, big.iy]).toEqual([5, 5])
    const m = moveInner(big, 2.4 * big.cx, -1.6 * big.cy)
    expect([m.ix, m.iy]).toEqual([7, 3])
    expect(moveInner(big, 99 * big.cx, 99 * big.cy)).toMatchObject({
      ix: 10,
      iy: 10,
    })
    expect(sidesOfFrame(m)).toEqual({ west: 7, north: 3, east: 3, south: 7 })
  })

  it("keeps its cells real-sized when moved", () => {
    const moved = moveFrame(f0, 0, mercY(50) - mercY(56))
    const b = frameBbox(moved)
    const mid = (b.north + b.south) / 2
    const per = EARTH_CIRCUMFERENCE_M * Math.cos((mid * Math.PI) / 180)
    expect((mercX(b.east) - mercX(b.west)) * per).toBeCloseTo(18, 1)
  })

  it("refuses more than 512 cells a side", () => {
    expect(frameError(f0)).toBeUndefined()
    expect(frameError({ ...f0, w: 513 })).toMatch(/512/)
  })

  it("is Expand's box on an anchored plan", () => {
    const plan: AnchoredPlan = {
      grid_width: 124,
      grid_height: 111,
      cell_mm: 1000,
      geo: {
        bbox: [56, 10, 56.001, 10.002],
        mpc: 1,
        zoom: 18,
        basemap: "map",
        captured_at: null,
        attribution: "",
      },
    }
    const s = { north: 2, east: 3, south: 0, west: 1 }
    const f = frameOfPlan(plan, s)
    expect(sidesOfFrame(f)).toEqual(s)
    expect(innerBbox(f).west).toBeCloseTo(10, 12)
    expect(innerBbox(f).north).toBeCloseTo(56.001, 12)
  })
})

describe("From site map's free frame", () => {
  const plan = { grid_width: 30, grid_height: 20, cell_mm: 600 }
  const extent = { x: 2, y: 3, w: 10, h: 8 }

  it("puts the dashed box on what is drawn, where it is", () => {
    const f = snapshotFrame(plan, { lat: 56, lng: 10 }, extent)
    expect([f.w, f.h, f.ix, f.iy, f.iw, f.ih]).toEqual([30, 20, 2, 3, 10, 8])
    expect(frameOffset(f)).toEqual([0, 0])
    // Unknown: the whole grid; an empty plan: nothing to hold.
    expect(snapshotFrame(plan, { lat: 56, lng: 10 }, undefined).iw).toBe(30)
    expect(snapshotFrame(plan, { lat: 56, lng: 10 }, null).iw).toBe(0)
  })

  it("shrinks to what is drawn, never past it, and trims the west", () => {
    const f = snapshotFrame(plan, { lat: 56, lng: 10 }, extent)
    const e = resizeFrame(f, "e", at(f, 5, 0))
    expect(e.w).toBe(12)
    const w = resizeFrame(e, "w", at(e, 9, 0))
    expect([w.w, w.ix]).toEqual([10, 0])
    // Everything moves two cells west with the trimmed cells.
    expect(frameOffset(w)).toEqual([-2, 0])
    const empty = snapshotFrame(plan, { lat: 56, lng: 10 }, null)
    expect(resizeFrame(empty, "e", at(empty, -9, 0)).w).toBe(1)
  })

  it("starts on an anchored plan's corner at the cells' real size", () => {
    // A stale anchor: 30 cells over a 9 m box. The frame is the grid's
    // real size, 18 m, from the same corner.
    const s = 56
    const per = EARTH_CIRCUMFERENCE_M * Math.cos((s * Math.PI) / 180)
    const east = lngOf(mercX(10) + 9 / per)
    const geo = {
      bbox: [s, 10, s + 0.0001, east] as [number, number, number, number],
    }
    const f = snapshotFrame({ ...plan, geo }, { lat: 0, lng: 0 }, extent)
    const b = frameBbox(f)
    expect(b.west).toBeCloseTo(10, 9)
    expect(b.north).toBeCloseTo(s + 0.0001, 9)
    expect((mercX(b.east) - mercX(b.west)) * per).toBeCloseTo(18, 1)
  })
})
