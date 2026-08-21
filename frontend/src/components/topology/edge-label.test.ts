import { describe, expect, it } from "vitest"

import { labelPoint } from "./routed-edge"

// A cable's label must stay readable while panning: it sits at the cable's
// natural midpoint when that is on screen, and rides the visible stretch
// when it isn't.

const VIEW = { x0: 0, y0: 0, x1: 1000, y1: 600 }

describe("labelPoint", () => {
  it("keeps the natural point when it is in view", () => {
    const pts: [number, number][] = [
      [100, 100],
      [500, 300],
      [900, 500],
    ]
    expect(labelPoint(pts, [500, 300], VIEW)).toEqual([500, 300])
  })

  it("moves onto the visible stretch when the midpoint is panned away", () => {
    // A long horizontal run whose middle is far to the right of the window.
    const pts: [number, number][] = [
      [200, 300],
      [4000, 300],
    ]
    const [x, y] = labelPoint(pts, [2100, 300], VIEW)
    expect(y).toBe(300)
    expect(x).toBeGreaterThan(VIEW.x0)
    expect(x).toBeLessThan(VIEW.x1)
  })

  it("picks the longest visible stretch of a bent cable", () => {
    // Short visible stub on the left, long visible run along the bottom.
    const pts: [number, number][] = [
      [-50, 20],
      [20, 20],
      [20, 550],
      [900, 550],
    ]
    const [x, y] = labelPoint(pts, [-500, -500], VIEW)
    expect(y).toBe(550)
    expect(x).toBeGreaterThan(100)
  })

  it("falls back to the natural point when nothing is in view", () => {
    const pts: [number, number][] = [
      [5000, 5000],
      [6000, 5000],
    ]
    expect(labelPoint(pts, [5500, 5000], VIEW)).toEqual([5500, 5000])
  })

  it("is a no-op without a viewport", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 10],
    ]
    expect(labelPoint(pts, [5, 5], null)).toEqual([5, 5])
  })
})
