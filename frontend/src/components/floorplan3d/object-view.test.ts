import { describe, expect, it } from "vitest"

import {
  OBJECT_VIEWS,
  SOLO_PLAN,
  fitDistance,
  objectViewpoint,
  sceneCabinetOf,
  soloTile,
} from "./object-view"
import { cabinetBoxM, cellToWorld } from "./world"

// One object on its own - a rack or a cabinet on its page: the tile it
// stands on, the cabinet's sizes as the room gets them, and where the
// camera looks from.

const cabinet = {
  id: "c1",
  name: "Test cabinet",
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  device_count: 6,
}

describe("soloTile", () => {
  it("stands the object on the origin, its front to −Z", () => {
    const tile = soloTile("c1", { cabinet: sceneCabinetOf(cabinet) })
    expect(
      cellToWorld(SOLO_PLAN, tile.x + tile.w / 2, tile.y + tile.h / 2)
    ).toEqual([0, 0])
    expect(tile.orientation).toBe(0)
    expect(tile.kind).toBe("cabinet")
    expect(tile.rack).toBeNull()
  })

  it("is a rack tile when it carries a rack", () => {
    const rack = {
      id: "r1",
      name: "DCT-B03",
      u_height: 42,
      starting_unit: 1,
      desc_units: false,
      width: 19,
      outer_width_mm: 600,
      outer_depth_mm: 1000,
      devices: [],
    }
    const tile = soloTile("r1", { rack })
    expect(tile.kind).toBe("rack")
    expect(tile.rack).toBe(rack)
    expect(tile.cabinet).toBeNull()
  })
})

describe("sceneCabinetOf", () => {
  it("carries the recorded outer size", () => {
    expect(cabinetBoxM(sceneCabinetOf(cabinet))).toEqual({
      width: 0.55,
      height: 0.65,
      depth: 0.2,
    })
  })

  it("fills an unrecorded one as the server does: plate + 50, 200 deep", () => {
    const solo = sceneCabinetOf({
      ...cabinet,
      outer_width_mm: null,
      outer_height_mm: null,
      outer_depth_mm: null,
    })
    expect(solo.outer_width_mm).toBe(550)
    expect(solo.outer_height_mm).toBe(650)
    expect(solo.outer_depth_mm).toBe(200)
  })
})

describe("objectViewpoint", () => {
  it("looks at the middle of the object's height", () => {
    expect(objectViewpoint(2, 4, 0).target).toEqual([0, 1, 0])
  })

  it("stands in front (−Z), behind (+Z), or off to the viewer's right", () => {
    const { front, rear, angle } = OBJECT_VIEWS
    const f = objectViewpoint(2, 4, front.yaw, front.pitch).position
    const r = objectViewpoint(2, 4, rear.yaw, rear.pitch).position
    const a = objectViewpoint(2, 4, angle.yaw, angle.pitch).position
    expect(f[2]).toBeLessThan(-3.9)
    expect(Math.abs(f[0])).toBeLessThan(1e-9)
    expect(r[2]).toBeGreaterThan(3.9)
    // Facing the front your right is −x.
    expect(a[0]).toBeLessThan(0)
    expect(a[2]).toBeLessThan(0)
    expect(a[1]).toBeGreaterThan(1)
  })

  it("keeps its distance whatever the turn and lift", () => {
    for (const { yaw, pitch } of Object.values(OBJECT_VIEWS)) {
      const { target, position } = objectViewpoint(2, 4, yaw, pitch)
      const d = Math.hypot(
        position[0] - target[0],
        position[1] - target[1],
        position[2] - target[2]
      )
      expect(d).toBeCloseTo(4)
    }
  })

  it("moves the point looked at across the floor with `at`", () => {
    const plain = objectViewpoint(1, 2, 0.5, 0.2)
    const moved = objectViewpoint(1, 2, 0.5, 0.2, [0.1, -0.2])
    expect(moved.target).toEqual([0.1, 0.5, -0.2])
    expect(moved.position[0] - plain.position[0]).toBeCloseTo(0.1)
    expect(moved.position[2] - plain.position[2]).toBeCloseTo(-0.2)
  })
})

describe("fitDistance", () => {
  const half = Math.tan((22.5 * Math.PI) / 180)

  it("fits a tall object by its height, with room around it", () => {
    const rack = { width: 0.6, height: 2, depth: 1 }
    const d = fitDistance(rack)
    // From the front face, the whole height inside the 45° view.
    expect(rack.height / 2).toBeLessThan((d - rack.depth / 2) * half)
  })

  it("fits a wide object by its width in a 4:3 view", () => {
    const wide = { width: 3, height: 0.5, depth: 0.2 }
    const d = fitDistance(wide)
    expect(wide.width / 2).toBeLessThan((d - wide.depth / 2) * half * (4 / 3))
  })
})
