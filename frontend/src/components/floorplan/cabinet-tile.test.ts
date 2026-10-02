import { describe, expect, it } from "vitest"

import type { CabinetSizes } from "@/lib/api"
import {
  cabinetOuterMm,
  cabinetState,
  cabinetTileSize,
  resizedRect,
} from "./cabinet-tile"

// A tile linked to a DIN-rail cabinet reads the cabinet's box: its outer
// size, else what the server draws in its place, laid on the plan's cells.

const box = (patch: Partial<CabinetSizes> = {}): CabinetSizes => ({
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  ...patch,
})

describe("cabinetOuterMm", () => {
  it("reads the outer size", () => {
    expect(cabinetOuterMm(box())).toEqual({
      width: 550,
      height: 650,
      depth: 200,
    })
  })

  it("falls back as the server does: the plate plus 50, 200 deep", () => {
    const c = box({
      outer_width_mm: null,
      outer_height_mm: null,
      outer_depth_mm: null,
    })
    expect(cabinetOuterMm(c)).toEqual({ width: 550, height: 650, depth: 200 })
  })
})

describe("cabinetTileSize", () => {
  it("fits a small cabinet in one cell", () => {
    expect(cabinetTileSize(box(), 600, 0)).toEqual({ width: 1, height: 1 })
  })

  it("takes the width along the front and the depth front to back", () => {
    const wide = box({ outer_width_mm: 1200, outer_depth_mm: 650 })
    expect(cabinetTileSize(wide, 600, 0)).toEqual({ width: 2, height: 2 })
    expect(cabinetTileSize(wide, 600, 180)).toEqual({ width: 2, height: 2 })
    const long = box({ outer_width_mm: 1600, outer_depth_mm: 300 })
    expect(cabinetTileSize(long, 600, 0)).toEqual({ width: 3, height: 1 })
  })

  it("turns the footprint for a tile facing left or right", () => {
    const long = box({ outer_width_mm: 1600, outer_depth_mm: 300 })
    expect(cabinetTileSize(long, 600, 90)).toEqual({ width: 1, height: 3 })
    expect(cabinetTileSize(long, 600, 270)).toEqual({ width: 1, height: 3 })
  })

  it("rounds up, but a whole cell stays one", () => {
    expect(cabinetTileSize(box({ outer_width_mm: 600 }), 600, 0).width).toBe(1)
    expect(cabinetTileSize(box({ outer_width_mm: 601 }), 600, 0).width).toBe(2)
  })

  it("reads the plan's own cell size", () => {
    const c = box({ outer_width_mm: 1200, outer_depth_mm: 400 })
    expect(cabinetTileSize(c, 300, 0)).toEqual({ width: 4, height: 2 })
    expect(cabinetTileSize(c, 1200, 0)).toEqual({ width: 1, height: 1 })
  })
})

describe("resizedRect", () => {
  const grid = { grid_width: 10, grid_height: 6 }

  it("keeps the tile on its corner", () => {
    expect(resizedRect({ x: 2, y: 1 }, { width: 3, height: 2 }, grid)).toEqual({
      x: 2,
      y: 1,
      width: 3,
      height: 2,
    })
  })

  it("pulls a tile back inside the grid", () => {
    expect(resizedRect({ x: 9, y: 5 }, { width: 3, height: 2 }, grid)).toEqual({
      x: 7,
      y: 4,
      width: 3,
      height: 2,
    })
  })

  it("is never larger than the grid", () => {
    expect(resizedRect({ x: 0, y: 0 }, { width: 40, height: 9 }, grid)).toEqual(
      { x: 0, y: 0, width: 10, height: 6 }
    )
  })
})

describe("cabinetState", () => {
  it("is the live state of a cabinet's tile only", () => {
    const cab = {
      kind: "cabinet" as const,
      device_count: 5,
      rail_count: 2,
      check: "down" as const,
    }
    expect(cabinetState(cab)).toBe(cab)
    expect(
      cabinetState({ kind: "device", status: null, check: "up" })
    ).toBeNull()
    expect(cabinetState(undefined)).toBeNull()
  })
})
