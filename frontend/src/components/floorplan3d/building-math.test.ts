import { describe, expect, it } from "vitest"

import type { FloorPlanFloor } from "@/lib/api"

import { EXPLODE_M, placeLevels, slabOutline } from "./building-math"
import type { SceneWall } from "./world"

const floor = (
  id: string,
  elevation: number,
  extra: Partial<FloorPlanFloor> = {}
): FloorPlanFloor => ({
  id,
  numid: null,
  name: id,
  floor_order: 0,
  location_id: null,
  kind: "plan",
  elevation,
  grid_width: 20,
  grid_height: 10,
  cell_mm: 500,
  ...extra,
})

const floors = [floor("b1", -3300), floor("g", 0), floor("1", 3300)]

const wall = (points: [number, number][], exterior = true): SceneWall => ({
  id: String(Math.random()),
  label: "",
  points,
  height_mm: null,
  color: "",
  openings: [],
  exterior,
})

describe("placeLevels", () => {
  it("puts levels at their elevations around the active one", () => {
    const lv = placeLevels(floors, "g", "all")
    expect(lv.map((l) => l.look)).toEqual(["solid", "active", "ghost"])
    expect(lv.map((l) => l.y)).toEqual([-3.3, 0, 3.3])
  })

  it("hides above in Up to and everything else in Only", () => {
    expect(placeLevels(floors, "g", "upto").map((l) => l.look)).toEqual([
      "solid",
      "active",
      "hidden",
    ])
    expect(placeLevels(floors, "g", "only").map((l) => l.look)).toEqual([
      "hidden",
      "active",
      "hidden",
    ])
  })

  it("explodes and offsets", () => {
    const lv = placeLevels(
      [floors[0], floors[1], floor("1", 3300, { align_dx: 2, align_rot: 90 })],
      "g",
      "all",
      0.5
    )
    expect(lv[2].y).toBeCloseTo(3.3 + 0.5 * EXPLODE_M)
    expect(lv[0].y).toBeCloseTo(-3.3 - 0.5 * EXPLODE_M)
    expect(lv[2].rotY).toBeCloseTo(-Math.PI / 2)
    // (0, 0) of the turned level: the grid's centre (10, 5) is the pivot.
    expect(lv[2].x).toBeCloseTo((10 + 5 + 2) * 0.5)
    expect(lv[2].z).toBeCloseTo((5 - 10) * 0.5)
  })
})

describe("slabOutline", () => {
  const grid = { grid_width: 20, grid_height: 10 }
  it("takes one closed exterior wall as drawn", () => {
    const ring: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 10],
      [0, 10],
      [0, 0],
    ]
    expect(slabOutline([wall(ring)], grid)).toEqual(ring.slice(0, -1))
  })
  it("hulls several exterior walls, else the grid box", () => {
    const sides = [
      wall([
        [1, 1],
        [9, 1],
      ]),
      wall([
        [9, 1],
        [9, 8],
      ]),
      wall([
        [1, 8],
        [1, 1],
      ]),
    ]
    expect(slabOutline(sides, grid)).toHaveLength(4)
    expect(
      slabOutline(
        [
          wall(
            [
              [0, 0],
              [4, 4],
            ],
            false
          ),
        ],
        grid
      )
    ).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ])
  })
})
