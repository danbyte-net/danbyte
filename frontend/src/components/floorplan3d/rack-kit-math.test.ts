import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  DOOR_OPEN_RAD,
  DOOR_SWING_S,
  LEGACY_LOOK,
  blankingSlots,
  doorInfill,
  doorLeaves,
  mapAxis,
  partMatrix,
  postSegmentMatrices,
  postSpots,
  railPlanesM,
  stepDoor,
  stretchedRepeat,
} from "./rack-kit-math"
import { RACK_BASE_M } from "./world"

const U = 0.04445
const box = (min: [number, number, number], max: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))

describe("mapAxis", () => {
  const ref = [-0.3, 0.3] as const
  const wide = [-0.4, 0.4] as const

  it("keeps a part that isn't stretched with the nearer edge", () => {
    // A corner at the left edge moves out with it, its size kept.
    const corner = mapAxis(-0.3, -0.25, ref, wide, false)
    expect(corner.centre).toBeCloseTo(-0.375)
    expect(corner.scale).toBe(1)
    expect(mapAxis(0.25, 0.3, ref, wide, false).centre).toBeCloseTo(0.375)
  })

  it("stretches a part so both ends keep their distance to the edges", () => {
    const { centre, scale } = mapAxis(-0.28, 0.28, ref, wide, true)
    expect(centre).toBeCloseTo(0)
    // 0.56 m long became 0.76 m.
    expect(scale).toBeCloseTo(0.76 / 0.56)
  })

  it("never inverts a part squeezed past nothing", () => {
    expect(mapAxis(-0.28, 0.28, ref, [-0.01, 0.01], true).scale).toBe(1)
  })
})

describe("partMatrix", () => {
  it("stretches along Blender's axes (z up is three's y)", () => {
    const ref = box([-0.3, 0, 0], [0.3, 2, 1])
    const target = box([-0.3, 0, -0.6], [0.3, 1.2, 0.6])
    // A side panel, stretched in depth and height (Blender "yz").
    const panel = box([-0.3, 0.1, 0], [-0.28, 1.97, 1])
    const m = partMatrix(panel, ref, target, "yz")
    const out = panel.clone().applyMatrix4(m)
    expect(out.min.z).toBeCloseTo(-0.6)
    expect(out.max.z).toBeCloseTo(0.6)
    expect(out.min.y).toBeCloseTo(0.1)
    expect(out.max.y).toBeCloseTo(1.17)
    expect(out.max.x - out.min.x).toBeCloseTo(0.02)
  })
})

describe("stretchedRepeat", () => {
  it("keeps the tile size: the repeat grows with the length", () => {
    // 125 tiles over the 1000 mm reference: 8 mm holes.
    expect(stretchedRepeat(125, 2000, 1000)).toBe(250)
    expect(stretchedRepeat(125, 600, 1000)).toBe(75)
  })
  it("takes the material's tile size without a transform", () => {
    expect(stretchedRepeat(1, 800, 1000, 8)).toBe(100)
  })
})

describe("railPlanesM", () => {
  it("puts the front rail where gear stands and the rear one at the rail depth", () => {
    expect(railPlanesM(1, { frame: "cabinet", rail_depth_mm: null })).toEqual({
      front: -0.45,
      rear: 0.45,
    })
    const r = railPlanesM(1, { frame: "4-post", rail_depth_mm: 740 })
    expect(r.front).toBeCloseTo(-0.45)
    expect(r.rear).toBeCloseTo(0.29)
    expect(railPlanesM(0.6, { frame: "2-post", rail_depth_mm: null })).toEqual({
      front: 0,
      rear: 0,
    })
  })
})

describe("post segments", () => {
  const seg = box([-0.29, 0.1, -0.05], [-0.27, 0.1 + U, -0.03])

  it("repeats once per unit at every post", () => {
    const spots = postSpots("cabinet", 0.6, { front: -0.45, rear: 0.45 }, 0.01)
    expect(spots).toHaveLength(4)
    const mats = postSegmentMatrices(seg, spots, 42)
    expect(mats).toHaveLength(4 * 42)
    // The first unit's bottom on the base, the 42nd 41 units up.
    const p = (m: THREE.Matrix4) => seg.clone().applyMatrix4(m)
    expect(p(mats[0]).min.y).toBeCloseTo(RACK_BASE_M)
    expect(p(mats[41]).min.y).toBeCloseTo(RACK_BASE_M + 41 * U)
    // Its rail face on the front rail, its outer side at the inset.
    expect(p(mats[0]).min.z).toBeCloseTo(-0.45)
    expect(p(mats[0]).min.x).toBeCloseTo(-0.29)
  })

  it("mirrors the right and rear posts", () => {
    const spots = postSpots("cabinet", 0.6, { front: -0.45, rear: 0.45 }, 0.01)
    const [fl, fr, rl, rr] = postSegmentMatrices(seg, spots, 1)
    expect(fl.determinant()).toBeGreaterThan(0)
    expect(fr.determinant()).toBeLessThan(0)
    expect(rl.determinant()).toBeLessThan(0)
    expect(rr.determinant()).toBeGreaterThan(0)
    const right = seg.clone().applyMatrix4(fr)
    expect(right.max.x).toBeCloseTo(0.29)
    const rear = seg.clone().applyMatrix4(rl)
    expect(rear.max.z).toBeCloseTo(0.45)
  })

  it("draws two posts on a 2-post frame", () => {
    expect(postSpots("2-post", 0.6, { front: 0, rear: 0 }, 0)).toHaveLength(2)
  })
})

describe("blankingSlots", () => {
  const rack = { u_height: 10, starting_unit: 1, desc_units: false }

  it("fills the empty front units with 2U then 1U panels", () => {
    const slots = blankingSlots(rack, [
      { position: 1, u_height: 2, face: "front", is_full_depth: true },
      { position: 6, u_height: 1, face: "front", is_full_depth: false },
    ])
    // Units 3-5 (2U + 1U), then 7-10 (2U + 2U).
    expect(slots).toEqual([
      { u: 2, h: 2 },
      { u: 4, h: 1 },
      { u: 6, h: 2 },
      { u: 8, h: 2 },
    ])
  })

  it("leaves rear-only gear's units to the front, and counts descending units", () => {
    expect(
      blankingSlots({ ...rack, u_height: 2 }, [
        { position: 1, u_height: 1, face: "rear", is_full_depth: false },
      ])
    ).toEqual([{ u: 0, h: 2 }])
    expect(
      blankingSlots({ ...rack, u_height: 3, desc_units: true }, [
        { position: 1, u_height: 1, face: "front", is_full_depth: true },
      ])
    ).toEqual([{ u: 0, h: 2 }])
  })

  it("uses only the sizes there are", () => {
    expect(blankingSlots({ ...rack, u_height: 3 }, [], [1])).toHaveLength(3)
  })
})

describe("doors", () => {
  it("lays out one leaf on its hinge side, or two for a split door", () => {
    expect(doorLeaves("perforated", 0.6, "left")).toEqual([
      { x: 0, w: 0.6, hingeX: -0.3, sign: 1 },
    ])
    expect(doorLeaves("glass", 0.6, "right")[0].hingeX).toBe(0.3)
    const split = doorLeaves("split-solid", 0.6, "left")
    expect(split.map((l) => l.hingeX)).toEqual([-0.3, 0.3])
    expect(split.map((l) => l.w)).toEqual([0.3, 0.3])
    expect(doorLeaves("none", 0.6, "left")).toEqual([])
  })

  it("swings at a constant rate and snaps under reduced motion", () => {
    const half = stepDoor(0, true, DOOR_SWING_S / 2, false)
    expect(half).toBeCloseTo(DOOR_OPEN_RAD / 2)
    expect(stepDoor(half, true, 10, false)).toBe(DOOR_OPEN_RAD)
    expect(stepDoor(DOOR_OPEN_RAD, false, DOOR_SWING_S / 4, false)).toBeCloseTo(
      DOOR_OPEN_RAD * 0.75
    )
    expect(stepDoor(0, true, 0.001, true)).toBe(DOOR_OPEN_RAD)
    expect(stepDoor(1, false, 0.001, true)).toBe(0)
  })

  it("draws each door type's infill", () => {
    expect(doorInfill("split-perforated")).toBe("perforated")
    expect(doorInfill("split-solid")).toBe("solid")
    expect(doorInfill("glass")).toBe("glass")
  })

  it("draws an older payload as the cabinet it always was", () => {
    expect(LEGACY_LOOK.front_door).toBe("glass")
    expect(LEGACY_LOOK.kit).toBeNull()
  })
})
