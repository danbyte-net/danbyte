import { describe, expect, it } from "vitest"

import type { AreaShape, Pt } from "./shapes"
import {
  areaFromRing,
  areaOutline,
  joinChains,
  outlineIsRing,
  runsMatch,
  syncOffer,
  wallRing,
} from "./structure"

// "Update area": an area's outline redrawn from its linked walls, joined
// end to end into one ring - and what the card over the plan offers.

const rect = (p: Partial<AreaShape> = {}) =>
  ({
    kind: "area",
    id: "a1",
    shape: "rect",
    x: 2,
    y: 2,
    width: 4,
    height: 3,
    rotation: 0,
    points: [],
    ...p,
  }) as AreaShape

const sq: Pt[] = [
  [2, 2],
  [6, 2],
  [6, 5],
  [2, 5],
]

describe("an area from its linked walls", () => {
  it("joins walls end to end, either way round, into one ring", () => {
    const walls = [
      { points: [sq[0], sq[1], sq[2]] },
      { points: [sq[0], sq[3]] },
      { points: [sq[2], sq[3]] },
    ]
    expect(joinChains(walls)).toHaveLength(1)
    const r = wallRing(walls)
    expect("ring" in r).toBe(true)
    if ("ring" in r) {
      expect(r.ring).toHaveLength(4)
      expect(outlineIsRing(sq, r.ring)).toBe(true)
    }
  })

  it("drops points on a straight stretch and the closing repeat", () => {
    const r = wallRing([
      { points: [sq[0], [4, 2], sq[1], sq[2], sq[3], sq[0]] },
    ])
    expect(r).toEqual({ ring: sq })
  })

  it("says so when the walls don't close or cross", () => {
    expect(wallRing([{ points: [...sq] }])).toEqual({ error: "open" })
    expect(
      wallRing([{ points: [sq[0], sq[1]] }, { points: [sq[2], sq[3]] }])
    ).toEqual({ error: "open" })
    // A bow tie.
    expect(wallRing([{ points: [sq[0], sq[1], sq[3], sq[2], sq[0]] }])).toEqual(
      { error: "crossed" }
    )
  })

  it("keeps a rectangle a rectangle, at its old turn", () => {
    const area = rect({ rotation: 30 })
    const grown = areaOutline(rect({ rotation: 30, width: 6 }))
    // The ring from another corner, the other way round.
    const ring = [grown[2], grown[1], grown[0], grown[3]]
    const patch = areaFromRing(area, ring)
    expect(patch.shape).toBe("rect")
    expect(patch.rotation).toBeCloseTo(30, 3)
    expect(patch.width).toBeCloseTo(6, 3)
    expect(patch.height).toBeCloseTo(3, 3)
    expect(outlineIsRing(areaOutline({ ...area, ...patch }), grown)).toBe(true)
  })

  it("makes anything else a polygon of the ring's corners", () => {
    const ring: Pt[] = [sq[0], sq[1], [6, 4], [4, 5], sq[3]]
    expect(areaFromRing(rect(), ring)).toMatchObject({
      shape: "polygon",
      rotation: 0,
      points: ring,
      x: 2,
      y: 2,
      width: 4,
      height: 3,
    })
  })

  it("matches closed walls from any corner, split or with straight points", () => {
    const run = [...sq, sq[0]]
    expect(
      runsMatch([{ points: [sq[2], sq[3], sq[0], sq[1], sq[2]] }], [run])
    ).toBe(true)
    expect(
      runsMatch(
        [
          { points: [sq[0], [4, 2], sq[1], sq[2]] },
          { points: [sq[2], sq[3], sq[0]] },
        ],
        [run]
      )
    ).toBe(true)
    expect(
      runsMatch([{ points: [sq[0], sq[1], [6, 6], sq[3], sq[0]] }], [run])
    ).toBe(false)
  })
})

describe("the linked-walls card's offer", () => {
  const ring = { ring: sq }
  const open = { error: "open" as const }

  it("leads with Update area when a wall is selected", () => {
    expect(
      syncOffer({
        wallsOff: true,
        fromWalls: ring,
        from: "wall",
        locked: false,
      })
    ).toEqual({ walls: true, area: "update", lead: "area" })
  })

  it("leads with Update walls when the area is selected", () => {
    expect(
      syncOffer({
        wallsOff: true,
        fromWalls: ring,
        from: "area",
        locked: false,
      })
    ).toEqual({ walls: true, area: "update", lead: "walls" })
  })

  it("says why there is no Update area, asked from a wall", () => {
    expect(
      syncOffer({
        wallsOff: true,
        fromWalls: open,
        from: "wall",
        locked: false,
      })
    ).toEqual({ walls: true, area: "open", lead: "walls" })
    expect(
      syncOffer({
        wallsOff: true,
        fromWalls: open,
        from: "area",
        locked: false,
      })
    ).toEqual({ walls: true, area: null, lead: "walls" })
  })

  it("offers nothing when the two agree, and never reshapes a locked area", () => {
    expect(
      syncOffer({
        wallsOff: false,
        fromWalls: null,
        from: "wall",
        locked: false,
      })
    ).toBeNull()
    expect(
      syncOffer({
        wallsOff: false,
        fromWalls: open,
        from: "wall",
        locked: false,
      })
    ).toBeNull()
    expect(
      syncOffer({ wallsOff: true, fromWalls: ring, from: "wall", locked: true })
    ).toEqual({ walls: true, area: null, lead: "walls" })
  })
})
