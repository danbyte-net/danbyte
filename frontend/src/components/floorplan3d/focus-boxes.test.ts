import { describe, expect, it } from "vitest"

import type { AreaShape } from "@/components/floorplan/shapes"

import { frameBox, viewDirection } from "./camera-math"
import { areaBox, planBounds, smallestArea, wallBox } from "./focus-boxes"
import type { ScenePayload, SceneWall } from "./world"

const plan: ScenePayload["plan"] = {
  id: "p",
  name: "Site",
  grid_width: 400,
  grid_height: 250,
  cell_mm: 1000,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
}

const area = (over: Partial<AreaShape>): AreaShape =>
  ({
    kind: "area",
    id: "a",
    shape: "rect",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    points: [],
    room: null,
    location: null,
    label: "",
    color: "",
    fill_opacity: 20,
    show_name: true,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...over,
  }) as AreaShape

const wall = (over: Partial<SceneWall>): SceneWall => ({
  id: "w",
  label: "",
  points: [],
  height_mm: null,
  color: "",
  openings: [],
  ...over,
})

describe("areaBox - a building's footprint", () => {
  it("a rectangle in metres, standing rack height", () => {
    expect(
      areaBox(plan, area({ x: 100, y: 40, width: 60, height: 30 }))
    ).toEqual({ min: [100, 0, 40], max: [160, 2.5, 70] })
  })

  it("a turned rectangle takes its turned corners", () => {
    const b = areaBox(
      plan,
      area({ x: 0, y: 0, width: 20, height: 10, rotation: 90 })
    )!
    expect(b.max[0] - b.min[0]).toBeCloseTo(10)
    expect(b.max[2] - b.min[2]).toBeCloseTo(20)
  })

  it("a polygon takes its outline", () => {
    const b = areaBox(
      plan,
      area({
        shape: "polygon",
        points: [
          [5, 5],
          [25, 8],
          [12, 30],
        ],
      })
    )
    expect(b).toEqual({ min: [5, 0, 5], max: [25, 2.5, 30] })
  })
})

describe("wallBox", () => {
  it("spans the polyline at the plan's ceiling when unset", () => {
    expect(
      wallBox(
        plan,
        wall({
          points: [
            [0, 0],
            [10, 0],
            [10, 4],
          ],
        })
      )
    ).toEqual({ min: [0, 0, 0], max: [10, 3, 4] })
  })

  it("its own height when set; nothing for an empty wall", () => {
    expect(
      wallBox(
        plan,
        wall({
          points: [
            [0, 0],
            [1, 0],
          ],
          height_mm: 1200,
        })
      )!.max[1]
    ).toBeCloseTo(1.2)
    expect(wallBox(plan, wall({}))).toBeNull()
  })
})

describe("smallestArea - the room, not the building around it", () => {
  const building = area({ id: "b", width: 100, height: 80 })
  const room = area({ id: "r", x: 10, y: 10, width: 8, height: 6 })
  it("picks the innermost of the areas under the pointer", () => {
    expect(smallestArea([building, room], ["b", "r"], plan)?.id).toBe("r")
    expect(smallestArea([building, room], ["b"], plan)?.id).toBe("b")
    expect(smallestArea([building, room], [], plan)).toBeNull()
  })
})

describe("Fit all", () => {
  it("frames every corner of a site-wide plan", () => {
    const b = planBounds(plan)
    expect(b).toEqual({ min: [0, 0, 0], max: [400, 2.5, 250] })
    const fov = (45 * Math.PI) / 180
    const dir = viewDirection([-0.55, -0.6, -0.45], 0.7)
    const { target, position } = frameBox(b.min, b.max, dir, fov, 1.6)
    expect(target).toEqual([200, 1.25, 125])
    // Far enough out to see 400 m across, not absurdly far.
    const d = Math.hypot(
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2]
    )
    expect(d).toBeGreaterThan(200)
    expect(d).toBeLessThan(1000)
  })
})
