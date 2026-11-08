import { describe, expect, it } from "vitest"

import type { AreaShape, Pt } from "./shapes"
import {
  areaOutline,
  areasFollowingWalls,
  keepRingClosed,
  moveSegment,
  outlineWalls,
  wallsFollowingArea,
} from "./structure"
import type { WallRow } from "./structure"

// An area follows its linked walls on every edit, the walls follow the
// area's reshape, and a closed wall edited at its seam stays closed.

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
    locked: false,
    ...p,
  }) as AreaShape

const sq: Pt[] = [
  [2, 2],
  [6, 2],
  [6, 5],
  [2, 5],
]
const closedSq: Pt[] = [...sq, sq[0]]
const GRID = { w: 40, h: 40 }

const linkedWall = (points: Pt[], openings: WallRow["openings"] = []) =>
  ({
    part: "wall",
    id: "w1",
    label: "",
    points,
    height_mm: null,
    thickness_mm: null,
    color: "",
    openings,
    source_area: "a1",
    created_at: "",
    updated_at: "",
  }) as WallRow

describe("an area following its linked walls", () => {
  it("a moved segment moves the area's side", () => {
    // The top side (segment 0, from the seam) pushed up a cell.
    const moved = keepRingClosed(
      closedSq,
      moveSegment(closedSq, 0, 0, -1, GRID)
    )
    expect(moved[0]).toEqual(moved[moved.length - 1])
    const { shapes, changed } = areasFollowingWalls(
      [rect()],
      [linkedWall(moved)],
      ["a1"]
    )
    expect(changed).toEqual(["a1"])
    expect(shapes[0]).toMatchObject({ shape: "rect", y: 1, height: 4 })
  })

  it("a vertex dragged at the seam keeps the ring and reshapes the area", () => {
    const dragged = keepRingClosed(
      closedSq,
      closedSq.map((p, i): Pt => (i === 0 ? [1, 1] : p))
    )
    expect(dragged.at(-1)).toEqual([1, 1])
    const { shapes } = areasFollowingWalls(
      [rect()],
      [linkedWall(dragged)],
      ["a1"]
    )
    expect(shapes[0]).toMatchObject({ shape: "polygon" })
    expect(shapes[0].points).toContainEqual([1, 1])
  })

  it("a bend dragged out is a corner; one on a straight stretch is not", () => {
    const bent: Pt[] = [sq[0], [4, 2], sq[1], sq[2], sq[3], sq[0]]
    expect(
      areasFollowingWalls([rect()], [linkedWall(bent)], ["a1"]).changed
    ).toEqual([])
    const out: Pt[] = [sq[0], [4, 1], sq[1], sq[2], sq[3], sq[0]]
    const { shapes } = areasFollowingWalls([rect()], [linkedWall(out)], ["a1"])
    expect(shapes[0].points).toHaveLength(5)
    expect(shapes[0].points).toContainEqual([4, 1])
  })

  it("a vertex taken out is taken out of the area", () => {
    const five: Pt[] = [sq[0], sq[1], sq[2], [4, 6], sq[3], sq[0]]
    const four = five.filter((_, i) => i !== 3)
    const poly = rect({
      shape: "polygon",
      points: five.slice(0, -1),
    })
    const { shapes } = areasFollowingWalls([poly], [linkedWall(four)], ["a1"])
    expect(shapes[0]).toMatchObject({ shape: "polygon" })
    expect(shapes[0].points).toHaveLength(4)
  })

  it("an open loop or a locked area leaves the area as it is", () => {
    const open = closedSq.slice(0, -1)
    const a = [rect()]
    expect(areasFollowingWalls(a, [linkedWall(open)], ["a1"]).shapes).toBe(a)
    const pushed: Pt[] = [
      [2, 2],
      [9, 2],
      [9, 5],
      [2, 5],
      [2, 2],
    ]
    expect(
      areasFollowingWalls(
        [rect({ locked: true })],
        [linkedWall(pushed)],
        ["a1"]
      ).changed
    ).toEqual([])
  })

  it("only the areas asked about follow", () => {
    const pushed: Pt[] = [
      [2, 2],
      [9, 2],
      [9, 5],
      [2, 5],
      [2, 2],
    ]
    expect(
      areasFollowingWalls([rect()], [linkedWall(pushed)], []).changed
    ).toEqual([])
  })

  it("round trip: walls made from an area give back the same area", () => {
    const poly = rect({
      shape: "polygon",
      points: [
        [2.125, 2.5],
        [6.333, 2.1],
        [7, 5.25],
        [4.5, 6.75],
        [2, 5],
      ],
    })
    const turned = rect({ id: "a2", rotation: 30 })
    for (const a of [poly, turned]) {
      const runs = outlineWalls([areaOutline(a)], [], GRID)
      expect(runs).toHaveLength(1)
      const wall = { ...linkedWall(runs[0].points), source_area: a.id }
      expect(areasFollowingWalls([a], [wall], [a.id]).changed).toEqual([])
    }
  })
})

describe("walls following their area's reshape", () => {
  const door = {
    seg: 0,
    from: 1,
    to: 2.5,
    height_mm: null,
    hinge: "start",
    side: "left",
  } as WallRow["openings"][number]

  it("rebuilds walls that ran along the old outline, doors kept", () => {
    const w = linkedWall(closedSq, [door])
    const wider = areaOutline(rect({ width: 8 }))
    const next = wallsFollowingArea(sq, wider, [w], [], GRID)
    expect(next).not.toBeNull()
    expect(next![0].id).toBe("w1")
    expect(next![0].points).toContainEqual([10, 2])
    expect(next![0].openings).toHaveLength(1)
  })

  it("leaves walls already off the old outline, or a door that won't fit", () => {
    const wider = areaOutline(rect({ width: 8 }))
    const off = linkedWall([sq[0], sq[1], [7, 5], sq[3], sq[0]])
    expect(wallsFollowingArea(sq, wider, [off], [], GRID)).toBeNull()
    const tiny = areaOutline(rect({ width: 1, height: 1 }))
    expect(
      wallsFollowingArea(sq, tiny, [linkedWall(closedSq, [door])], [], GRID)
    ).toBeNull()
  })
})

describe("a closed wall edited at its seam", () => {
  it("moves its first and last point together", () => {
    const moved = closedSq.map((p, i): Pt => (i === 4 ? [1, 1] : p))
    const kept = keepRingClosed(closedSq, moved)
    expect(kept[0]).toEqual([1, 1])
    expect(kept[4]).toEqual([1, 1])
  })

  it("leaves a run that is not closed as it is", () => {
    const open: Pt[] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]
    const moved = open.map((p, i): Pt => (i === 0 ? [1, 1] : p))
    expect(keepRingClosed(open, moved)).toBe(moved)
  })
})
