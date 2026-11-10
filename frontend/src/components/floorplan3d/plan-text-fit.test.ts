import { describe, expect, it } from "vitest"

import { boxCorners, rotatePoint } from "@/components/floorplan/shapes"
import type { Pt } from "@/components/floorplan/shapes"

import {
  MIN_FIT_SCALE,
  boxFits,
  fitPlanText,
  mainAxis,
  readableAngle,
  segmentHitsRect,
  segmentsNear,
  standingPlace,
  standingSpan,
  wallSegments,
} from "./plan-text-fit"
import type { FitBox, FitRegion, PlacedText } from "./plan-text-fit"

// A room's name stays inside its room: a margin in from the edges, clear
// of the walls, shrunk to fit and left out when that is too small.

const region = (outline: Pt[], margin = 0.3, obstacles = []): FitRegion => ({
  outline,
  margin,
  obstacles,
})

const rect = (x: number, y: number, w: number, h: number, rot = 0) =>
  boxCorners({ x, y, width: w, height: h, rotation: rot })

/** The placed quad as a box. */
function placedBox(p: PlacedText, w: number, h: number, grow = 1): FitBox {
  const s = p.scale * grow
  const c = rotatePoint(
    [
      p.at[0] + (0.5 - p.pivot[0]) * w * s,
      p.at[1] + (0.5 - p.pivot[1]) * h * s,
    ],
    p.at,
    p.rotation
  )
  return { c, hw: (w * s) / 2, hh: (h * s) / 2, rot: p.rotation }
}

describe("segmentHitsRect", () => {
  it("finds a segment through, inside and outside the box", () => {
    expect(segmentHitsRect([-5, 0], [5, 0], 1, 1)).toBe(true)
    expect(segmentHitsRect([0, 0], [0.5, 0.5], 1, 1)).toBe(true)
    expect(segmentHitsRect([2, -5], [2, 5], 1, 1)).toBe(false)
    expect(segmentHitsRect([-3, 2], [3, 1.5], 1, 1)).toBe(false)
  })
})

describe("boxFits", () => {
  const room = region(rect(0, 0, 10, 4))
  it("holds a box well inside and refuses one over the margin", () => {
    expect(boxFits(room, { c: [5, 2], hw: 2, hh: 0.5, rot: 0 })).toBe(true)
    expect(boxFits(room, { c: [5, 2], hw: 4.8, hh: 0.5, rot: 0 })).toBe(false)
    expect(boxFits(room, { c: [0.5, 2], hw: 0.3, hh: 0.3, rot: 0 })).toBe(false)
  })
  it("keeps clear of a wall through the room", () => {
    const walled: FitRegion = {
      ...room,
      obstacles: [{ a: [5, 0], b: [5, 4], clear: 0.2 }],
    }
    expect(boxFits(walled, { c: [5, 2], hw: 1, hh: 0.5, rot: 0 })).toBe(false)
    expect(boxFits(walled, { c: [2.5, 2], hw: 1, hh: 0.5, rot: 0 })).toBe(true)
  })
})

describe("fitPlanText", () => {
  it("keeps the 2D place where it fits", () => {
    const room = region(rect(0, 0, 20, 10))
    const place = {
      at: [1, 1] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 4, 0.5)!
    expect(p.at).toEqual([1, 1])
    expect(p.scale).toBe(1)
    // Readable may grow it, but only as far as the room.
    expect(p.maxGrow).toBeGreaterThan(1)
    expect(boxFits(room, placedBox(p, 4, 0.5, p.maxGrow))).toBe(true)
    expect(boxFits(room, placedBox(p, 4, 0.5, p.maxGrow * 1.02))).toBe(false)
  })

  it("slides a name off the edge it was placed against", () => {
    const room = region(rect(0, 0, 20, 10), 0.4)
    const place = {
      at: [0.1, 0.1] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 4, 0.5)!
    expect(p.scale).toBe(1)
    expect(p.at[0]).toBeCloseTo(0.4, 3)
    expect(p.at[1]).toBeCloseTo(0.4, 3)
  })

  it("follows a turned rectangle in its own frame", () => {
    const outline = rect(10, 10, 12, 4, 30)
    const room = region(outline)
    const corner = rotatePoint([10.05, 10.05], [16, 12], 30)
    const place = {
      at: corner,
      pivot: [0, 0] as [number, number],
      rotation: 30,
    }
    const p = fitPlanText(room, place, 5, 0.6)!
    expect(p.rotation).toBe(30)
    expect(p.scale).toBe(1)
    expect(boxFits(room, placedBox(p, 5, 0.6))).toBe(true)
  })

  it("shrinks a name too long for its room, centred and inside", () => {
    const room = region(rect(0, 0, 6, 3), 0.3)
    const place = {
      at: [0.2, 0.2] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 8, 0.6)!
    expect(p.scale).toBeLessThan(1)
    expect(p.scale).toBeGreaterThan(0.6)
    expect(p.maxGrow).toBe(1)
    expect(boxFits(room, placedBox(p, 8, 0.6))).toBe(true)
    // About as wide as the room leaves.
    expect(8 * p.scale).toBeGreaterThan(5.2)
  })

  it("leaves a name out of a room too small to read it in", () => {
    const room = region(rect(0, 0, 2, 1.2), 0.3)
    const place = {
      at: [0, 0] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    expect(fitPlanText(room, place, 8, 0.6)).toBeNull()
    // Nor at a quarter turn: the room is no roomier that way.
    expect(fitPlanText({ ...room, angles: [90] }, place, 8, 0.6)).toBeNull()
  })

  it("turns along a narrow room when that holds the name whole", () => {
    const room: FitRegion = { ...region(rect(0, 0, 2, 12), 0.2), angles: [90] }
    const place = {
      at: [0, 0] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 5, 0.5)!
    expect(Math.abs(p.rotation)).toBe(90)
    expect(p.scale).toBe(1)
    expect(boxFits(room, placedBox(p, 5, 0.5))).toBe(true)
  })

  it("finds the room in an L whose centroid lies outside it", () => {
    // An L: a 10 × 2 leg along the top, a 2 × 10 leg down the left.
    const L: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 10],
      [0, 10],
    ]
    const room = region(L, 0.2)
    const place = {
      at: [3.2, 3.2] as Pt,
      pivot: [0.5, 0.5] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 4, 0.5)!
    expect(p).not.toBeNull()
    expect(p.scale).toBe(1)
    expect(boxFits(room, placedBox(p, 4, 0.5))).toBe(true)
  })

  it("moves a name off a wall that crosses its corner", () => {
    const room: FitRegion = {
      ...region(rect(0, 0, 20, 10), 0.3),
      obstacles: [{ a: [3, -1], b: [3, 11], clear: 0.15 }],
    }
    const place = {
      at: [0.3, 0.3] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 4, 0.5)!
    expect(p.scale).toBe(1)
    expect(boxFits(room, placedBox(p, 4, 0.5))).toBe(true)
  })

  it("never shrinks below the readable share", () => {
    const room = region(rect(0, 0, 3, 3), 0.3)
    const place = {
      at: [0, 0] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 5, 0.5)
    if (p) expect(p.scale).toBeGreaterThanOrEqual(MIN_FIT_SCALE)
  })
})

describe("roomiest spot", () => {
  it("ignores the 2D place and finds the middle of the room", () => {
    const room = region(rect(0, 0, 10, 4), 0.3)
    const place = {
      at: [1, 1] as Pt,
      pivot: [0, 0] as [number, number],
      rotation: 0,
    }
    const p = fitPlanText(room, place, 2, 0.5, { anywhere: true })!
    expect(p.at[0]).toBeCloseTo(5, 0)
  })
})

describe("standing names", () => {
  const room = region(rect(0, 0, 10, 4), 0.5)
  it("measures the line a standing name has inside its room", () => {
    const span = standingSpan(room, [2, 2], 0)
    expect(span.back).toBeCloseTo(1.5, 2)
    expect(span.ahead).toBeCloseTo(7.5, 2)
    // Across the room it is shorter.
    const across = standingSpan(room, [2, 2], 90)
    expect(across.back + across.ahead).toBeCloseTo(3, 2)
  })
  it("gives none outside the room", () => {
    expect(standingSpan(room, [20, 2], 0)).toEqual({ back: 0, ahead: 0 })
  })
  it("slides a name near a wall back inside, whole", () => {
    // From x = 2 the room runs 1.5 back: a 2-wide half slides 0.5 ahead.
    expect(standingPlace({ back: 1.5, ahead: 7.5 }, 2)).toEqual({
      offset: 0.5,
      half: 2,
    })
    expect(standingPlace({ back: 5, ahead: 5 }, 2)).toEqual({
      offset: 0,
      half: 2,
    })
  })
  it("narrows one wider than its room, centred on the span", () => {
    expect(standingPlace({ back: 1, ahead: 3 }, 5)).toEqual({
      offset: 1,
      half: 2,
    })
  })
})

describe("helpers", () => {
  it("reads angles left to right", () => {
    expect(readableAngle(0)).toBe(0)
    expect(readableAngle(118)).toBeCloseTo(-62)
    expect(readableAngle(-90)).toBe(90)
    expect(readableAngle(270)).toBe(90)
  })
  it("takes a polygon's longest edge as its axis", () => {
    expect(mainAxis(rect(0, 0, 10, 2))).toBeCloseTo(0)
    expect(Math.abs(mainAxis(rect(0, 0, 2, 10)))).toBeCloseTo(90)
  })
  it("turns walls into legs and keeps those near a room", () => {
    const segs = wallSegments(
      [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
          thickness_mm: 150,
        },
        {
          points: [
            [50, 50],
            [60, 50],
          ],
        },
      ],
      600,
      100,
      60
    )
    expect(segs).toHaveLength(3)
    expect(segs[0].clear).toBeCloseTo((75 + 60) / 600)
    expect(segs[2].clear).toBeCloseTo((50 + 60) / 600)
    expect(segmentsNear(segs, rect(5, 0.1, 4.8, 5))).toHaveLength(2)
  })
})
