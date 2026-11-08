import { describe, expect, it } from "vitest"

import {
  centroid,
  dedupe,
  edgeMidpoints,
  insertVertex,
  isSimple,
  moveVertex,
  outlineProblem,
  removeVertex,
} from "./outline-geometry"
import type { Pt } from "./outline-geometry"

// The Outline tool's rules, as the server applies them: 3 to 500 points, no
// edge crossing another, an area. Drawing is clicks then a double-click,
// whose two clicks land on one spot; reshaping is drag, "+" on an edge and
// right-click to remove.

const SQUARE: Pt[] = [
  [56, 10],
  [56, 10.001],
  [56.001, 10.001],
  [56.001, 10],
]

describe("outline geometry", () => {
  it("accepts a square and refuses a bow tie", () => {
    expect(outlineProblem(SQUARE)).toBeNull()
    const bow: Pt[] = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]]
    expect(isSimple(bow)).toBe(false)
    expect(outlineProblem(bow)).toMatch(/crosses itself/)
  })

  it("needs three points and an area", () => {
    expect(outlineProblem(SQUARE.slice(0, 2))).toMatch(/at least 3/)
    expect(
      outlineProblem([
        [0, 0],
        [0, 1],
        [0, 2],
      ])
    ).not.toBeNull()
  })

  it("drops the double-click's repeated point and a closing point", () => {
    const drawn: Pt[] = [...SQUARE, SQUARE[3], SQUARE[3], SQUARE[0]]
    expect(dedupe(drawn)).toEqual(SQUARE)
  })

  it("adds a point on any edge, the closing one included", () => {
    expect(edgeMidpoints(SQUARE)).toHaveLength(4)
    const closing = insertVertex(SQUARE, 3)
    expect(closing).toHaveLength(5)
    expect(closing[4]).toEqual([56.0005, 10])
    const first = insertVertex(SQUARE, 0)
    expect(first[1][0]).toBe(56)
    expect(first[1][1]).toBeCloseTo(10.0005, 9)
    expect(outlineProblem(first)).toBeNull()
  })

  it("removes a point but keeps three", () => {
    const five = insertVertex(SQUARE, 0)
    expect(removeVertex(five, 1)).toEqual(SQUARE)
    expect(removeVertex(SQUARE.slice(0, 3), 0)).toBeNull()
  })

  it("moves a point and finds the middle for the label", () => {
    const moved = moveVertex(SQUARE, 2, [56.002, 10.002])
    expect(moved[2]).toEqual([56.002, 10.002])
    const [lat, lng] = centroid(SQUARE)
    expect(lat).toBeCloseTo(56.0005, 6)
    expect(lng).toBeCloseTo(10.0005, 6)
  })
})
