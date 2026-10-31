import { describe, expect, it } from "vitest"

import { mercX, mercY } from "@/components/site-map/plan-from-map"

import {
  cellsFromMetres,
  expandFrame,
  grownBbox,
  NO_GROWTH,
  roomOn,
  sideFromDrag,
  sidesOf,
} from "./plan-geo"
import type { AnchoredPlan } from "./plan-geo"

// Expand's sums: a plan's box grows in whole cells that keep their size in
// Mercator units (what is drawn is never resampled), the same sums the
// server does in api/floor_plan_geo.py.

const PLAN: AnchoredPlan = {
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

const cx = (mercX(10.002) - mercX(10)) / 124
const cy = (mercY(56) - mercY(56.001)) / 111

describe("growing a plan's box", () => {
  it("adds whole cells of the plan's own size on each side", () => {
    const b = grownBbox(PLAN, { north: 3, east: 2, south: 1, west: 5 })
    expect(mercX(b.west)).toBeCloseTo(mercX(10) - 5 * cx, 12)
    expect(mercX(b.east)).toBeCloseTo(mercX(10.002) + 2 * cx, 12)
    expect(mercY(b.north)).toBeCloseTo(mercY(56.001) - 3 * cy, 12)
    expect(mercY(b.south)).toBeCloseTo(mercY(56) + 1 * cy, 12)
  })

  it("reads a box back as the cells it adds", () => {
    const s = { north: 7, east: 0, south: 12, west: 4 }
    expect(sidesOf(PLAN, grownBbox(PLAN, s))).toEqual(s)
    // A box a little short of a whole cell takes the whole cell.
    const b = grownBbox(PLAN, { ...NO_GROWTH, west: 1 })
    expect(sidesOf(PLAN, { ...b, west: (b.west + 10) / 2 }).west).toBe(1)
    // A box inside the plan's adds nothing: Expand only grows.
    expect(
      sidesOf(PLAN, {
        south: 56.0002,
        west: 10.0005,
        north: 56.0008,
        east: 10.001,
      })
    ).toEqual(NO_GROWTH)
  })

  it("turns a dragged handle into cells out from that side", () => {
    const west = grownBbox(PLAN, { ...NO_GROWTH, west: 9 }).west
    expect(sideFromDrag(PLAN, "west", { lat: 56.0005, lng: west })).toBe(9)
    const north = grownBbox(PLAN, { ...NO_GROWTH, north: 20 }).north
    expect(sideFromDrag(PLAN, "north", { lat: north, lng: 10.001 })).toBe(20)
    // Dragged inwards: nothing.
    expect(sideFromDrag(PLAN, "east", { lat: 56.0005, lng: 10.001 })).toBe(0)
  })

  it("rounds metres up to whole cells", () => {
    expect(cellsFromMetres(PLAN, 10)).toBe(10)
    expect(cellsFromMetres(PLAN, 10.4)).toBe(11)
    expect(cellsFromMetres({ cell_mm: 500 }, 10)).toBe(20)
    expect(cellsFromMetres(PLAN, 0)).toBe(0)
    expect(cellsFromMetres(PLAN, -3)).toBe(0)
    expect(cellsFromMetres(PLAN, Number.NaN)).toBe(0)
  })

  it("previews the grid and refuses more than 512 cells a side", () => {
    const ok = expandFrame(PLAN, { north: 10, east: 0, south: 0, west: 20 })
    expect(ok.error).toBeUndefined()
    expect([ok.gridWidth, ok.gridHeight]).toEqual([144, 121])
    expect([ok.widthM, ok.heightM]).toEqual([144, 121])
    expect(expandFrame(PLAN, NO_GROWTH).error).toMatch(/Move an edge out/)
    const big = expandFrame(PLAN, { ...NO_GROWTH, east: 512 - 124 + 1 })
    expect(big.error).toMatch(/513 × 111 cells/)
    expect(big.error).toMatch(/at most 512/)
    expect(roomOn(PLAN, { ...NO_GROWTH, west: 8 }, "east")).toBe(512 - 132)
    expect(roomOn(PLAN, NO_GROWTH, "north")).toBe(512 - 111)
  })
})
