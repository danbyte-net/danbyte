import { describe, expect, it } from "vitest"

import type { FloorPlanFloor } from "@/lib/api"

import {
  elevationLabel,
  frameMmToLevel,
  levelToFrameMm,
  levelToLevel,
  neighbours,
  nextBasementName,
  nextFloorName,
} from "./levels"

const floor = (
  id: string,
  extra: Partial<FloorPlanFloor> = {}
): FloorPlanFloor => ({
  id,
  numid: null,
  name: id,
  floor_order: 0,
  location_id: null,
  kind: "plan",
  grid_width: 20,
  grid_height: 10,
  cell_mm: 500,
  ...extra,
})

describe("levels", () => {
  it("labels elevations", () => {
    expect(elevationLabel(7200)).toBe("+7.2 m")
    expect(elevationLabel(-2800)).toBe("−2.8 m")
    expect(elevationLabel(0)).toBe("0.0 m")
    expect(elevationLabel(null)).toBe("")
  })

  it("names the next floor and basement", () => {
    expect(nextBasementName([{ name: "B1" }, { name: "G" }])).toBe("B2")
    expect(nextFloorName([{ name: "G" }, { name: "1" }, { name: "2" }])).toBe(
      "3"
    )
    expect(nextFloorName([{ name: "Ground" }])).toBe("1")
  })

  it("maps through the align offset and turn, both ways", () => {
    const g = { grid_width: 20, grid_height: 10, cell_mm: 500 }
    const a = { dx: 2, dy: -1, rot: 90 }
    const f = levelToFrameMm([12, 5], g, a)
    // (12, 5) is 2 cells right of the centre; turned 90° it is 2 below.
    expect(f[0]).toBeCloseTo((10 + 2) * 500)
    expect(f[1]).toBeCloseTo((5 + 2 - 1) * 500)
    const back = frameMmToLevel(f, g, a)
    expect(back[0]).toBeCloseTo(12)
    expect(back[1]).toBeCloseTo(5)
  })

  it("maps a point between offset levels", () => {
    const a = floor("a")
    const b = floor("b", { align_dx: 2, align_dy: -1 })
    const p = levelToLevel([4, 3], a, b)
    expect(p[0]).toBeCloseTo(2)
    expect(p[1]).toBeCloseTo(4)
  })

  it("finds the levels around one, views left out", () => {
    const fl = [
      floor("b1"),
      floor("v", { kind: "view" }),
      floor("g"),
      floor("1"),
    ]
    expect(neighbours(fl, "g").below?.id).toBe("b1")
    expect(neighbours(fl, "g").above?.id).toBe("1")
    expect(neighbours(fl, "1").above).toBeNull()
  })
})
