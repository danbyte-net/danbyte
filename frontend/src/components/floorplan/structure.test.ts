import { describe, expect, it } from "vitest"

import type { FloorPlanWallOpening } from "@/lib/api"

import type { AreaShape, Pt } from "./shapes"
import {
  areaOutline,
  doorFromDrag,
  doorLeaf,
  dropRepeats,
  fitOpenings,
  flipDoor,
  joinRuns,
  lengthText,
  moveSegment,
  resizeDoor,
  slideDoor,
  snapRect,
  snapStructPoint,
  linkedWallLabel,
  outlineShift,
  outlineWalls,
  rebuildWalls,
  runsMatch,
  splitRun,
  wallsAround,
} from "./structure"

const grid = { w: 20, h: 12 }
const door = (p: Partial<FloorPlanWallOpening> = {}): FloorPlanWallOpening => ({
  seg: 0,
  from: 2,
  to: 3.5,
  height_mm: null,
  ...p,
})
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

describe("walls from an outline", () => {
  it("goes round a rectangle as one closed wall, joined at its corners", () => {
    const runs = wallsAround([areaOutline(rect())], [], grid)
    expect(runs).toEqual([
      [
        [2, 2],
        [6, 2],
        [6, 5],
        [2, 5],
        [2, 2],
      ],
    ])
  })

  it("leaves out an edge a wall already runs along", () => {
    // A wall along the top edge, a hair off it.
    const existing = [
      {
        points: [
          [1, 2.1],
          [7, 2.1],
        ] as Pt[],
      },
    ]
    const runs = wallsAround([areaOutline(rect())], existing, grid)
    // One wall round the other three sides, still joined at its corners.
    expect(runs).toEqual([
      [
        [6, 2],
        [6, 5],
        [2, 5],
        [2, 2],
      ],
    ])
  })

  it("walls only the stretch of an edge left uncovered", () => {
    const existing = [
      {
        points: [
          [2, 2],
          [4, 2],
        ] as Pt[],
      },
    ]
    const runs = wallsAround([areaOutline(rect())], existing, grid)
    expect(runs).toEqual([
      [
        [4, 2],
        [6, 2],
        [6, 5],
        [2, 5],
        [2, 2],
      ],
    ])
  })

  it("draws an edge two areas share once", () => {
    const runs = wallsAround(
      [areaOutline(rect()), areaOutline(rect({ id: "a2", x: 6 }))],
      [],
      grid
    )
    expect(runs).toHaveLength(2)
    // The second room's wall leaves out the side the first one walled.
    expect(runs[1]).toEqual([
      [6, 2],
      [10, 2],
      [10, 5],
      [6, 5],
    ])
  })

  it("follows a turned rectangle and a polygon exactly", () => {
    const turned = wallsAround(
      [areaOutline(rect({ x: 4, y: 4, width: 4, height: 2, rotation: 90 }))],
      [],
      grid
    )[0]
    expect(turned).toEqual([
      [7, 3],
      [7, 7],
      [5, 7],
      [5, 3],
      [7, 3],
    ])
    const poly = wallsAround(
      [
        areaOutline(
          rect({
            shape: "polygon",
            points: [
              [1, 1],
              [5.2, 1],
              [3, 4],
            ],
          })
        ),
      ],
      [],
      grid
    )[0]
    expect(poly).toEqual([
      [1, 1],
      [5.2, 1],
      [3, 4],
      [1, 1],
    ])
  })

  it("puts a rectangle turned off the quarter on its own corners", () => {
    const area = rect({ x: 4, y: 3, width: 4, height: 2, rotation: 30 })
    const corners = areaOutline(area)
    const [run] = wallsAround([corners], [], grid)
    expect(run).toHaveLength(5)
    corners.forEach((c, i) => {
      expect(run[i][0]).toBeCloseTo(c[0], 3)
      expect(run[i][1]).toBeCloseTo(c[1], 3)
    })
    // Off the half-cell lattice: no corner was pulled onto it.
    expect(run.some(([x]) => Math.abs(x * 2 - Math.round(x * 2)) > 0.01)).toBe(
      true
    )
    expect(run[4]).toEqual(run[0])
  })

  it("names the outline each run follows", () => {
    const runs = outlineWalls(
      [areaOutline(rect()), areaOutline(rect({ id: "a2", x: 6 }))],
      [],
      grid
    )
    expect(runs.map((r) => r.outline)).toEqual([0, 1])
  })

  it("makes nothing when walls already run all the way round", () => {
    const first = wallsAround([areaOutline(rect())], [], grid)
    const again = wallsAround(
      [areaOutline(rect())],
      first.map((points) => ({ points })),
      grid
    )
    expect(again).toEqual([])
  })
})

describe("doors along a wall", () => {
  const pts: Pt[] = [
    [0, 0],
    [10, 0],
  ]

  it("a drag spans the door, a click makes a standard one", () => {
    expect(doorFromDrag(pts, [], 0, 2, 4.5, 600)).toEqual({ from: 2, to: 4.5 })
    expect(doorFromDrag(pts, [], 0, 4.5, 2, 600)).toEqual({ from: 2, to: 4.5 })
    // 900 mm on a 600 mm grid, centred on the click.
    expect(doorFromDrag(pts, [], 0, 5, 5, 600)).toEqual({
      from: 4.25,
      to: 5.75,
    })
  })

  it("stays inside the wall and clear of the other doors", () => {
    expect(doorFromDrag(pts, [], 0, 8, 14, 600)).toEqual({ from: 8, to: 10 })
    const others = [door({ from: 6, to: 7 })]
    expect(doorFromDrag(pts, others, 0, 4, 9, 600)).toEqual({ from: 4, to: 6 })
    // Pressed inside another door: none.
    expect(doorFromDrag(pts, others, 0, 6.5, 9, 600)).toBeNull()
  })

  it("resizes from either end, no narrower than the narrowest door", () => {
    const list = [door(), door({ from: 6, to: 7 })]
    expect(resizeDoor(pts, list, 0, "to", 9, 600).to).toBe(6)
    expect(resizeDoor(pts, list, 0, "from", -3, 600).from).toBe(0)
    const min = resizeDoor(pts, list, 0, "to", 1, 600)
    expect(min.to - min.from).toBeCloseTo(100 / 600, 2)
  })

  it("slides along the wall and stops at its ends and neighbours", () => {
    const list = [door(), door({ from: 6, to: 7 })]
    expect(slideDoor(pts, list, 0, 1)).toMatchObject({ from: 3, to: 4.5 })
    expect(slideDoor(pts, list, 0, 9)).toMatchObject({ from: 4.5, to: 6 })
    expect(slideDoor(pts, list, 0, -9)).toMatchObject({ from: 0, to: 1.5 })
  })

  it("flips through the four swings", () => {
    let o = door()
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      o = flipDoor(o)
      seen.push(`${o.hinge}-${o.side}`)
    }
    expect(seen).toEqual([
      "start-left",
      "start-right",
      "end-right",
      "end-left",
      "start-left",
    ])
  })

  it("draws the leaf square to the wall on its side", () => {
    const leaf = doorLeaf(pts, door({ hinge: "start", side: "left" }))!
    expect(leaf.hinge).toEqual([2, 0])
    expect(leaf.open[0]).toBeCloseTo(2)
    expect(leaf.open[1]).toBeCloseTo(-1.5)
    expect(doorLeaf(pts, door())).toBeNull()
  })

  it("keeps doors inside a wall made shorter", () => {
    const fitted = fitOpenings(
      [
        [0, 0],
        [4, 0],
      ],
      [door({ from: 3, to: 4.5 }), door({ from: 8, to: 9 })]
    )
    expect(fitted).toEqual([
      door({ from: 1.5, to: 3 }),
      door({ from: 3, to: 4 }),
    ])
  })

  it("reads widths in centimetres and metres", () => {
    expect(lengthText(1.5, 600)).toBe("90 cm")
    expect(lengthText(2, 600)).toBe("1.2 m")
  })
})

describe("splitting and joining runs", () => {
  const pts: Pt[] = [
    [0, 0],
    [10, 0],
    [10, 6],
  ]

  it("cuts a run in two and shares out its doors", () => {
    const parts = splitRun(
      pts,
      [door({ from: 1, to: 2 }), door({ from: 7, to: 8 }), door({ seg: 1 })],
      0,
      5,
      grid
    )!
    expect(parts.a.points).toEqual([
      [0, 0],
      [5, 0],
    ])
    expect(parts.b.points).toEqual([
      [5, 0],
      [10, 0],
      [10, 6],
    ])
    expect(parts.a.openings).toEqual([door({ from: 1, to: 2 })])
    expect(parts.b.openings).toEqual([
      door({ from: 2, to: 3 }),
      door({ seg: 1 }),
    ])
  })

  it("never cuts a door or at an end", () => {
    expect(splitRun(pts, [door()], 0, 3, grid)).toBeNull()
    expect(splitRun(pts, [], 0, 0, grid)).toBeNull()
    expect(splitRun(pts, [], 1, 6, grid)).toBeNull()
  })

  it("joins what a split made, doors and all", () => {
    const parts = splitRun(pts, [door({ from: 7, to: 8 })], 0, 5, grid)!
    expect(joinRuns(parts.a, parts.b)).toEqual({
      points: [
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 6],
      ],
      openings: [door({ seg: 1, from: 2, to: 3 })],
    })
  })

  it("joins end to end either way round, turning a door with its run", () => {
    const a = {
      points: [
        [0, 0],
        [4, 0],
      ] as Pt[],
    }
    const b = {
      points: [
        [8, 0],
        [4, 0],
      ] as Pt[],
      openings: [door({ from: 1, to: 2, hinge: "start", side: "left" })],
    }
    const j = joinRuns(a, b)!
    expect(j.points).toEqual([
      [0, 0],
      [4, 0],
      [8, 0],
    ])
    expect(j.openings).toEqual([
      door({ seg: 1, from: 2, to: 3, hinge: "end", side: "right" }),
    ])
    expect(
      joinRuns(a, {
        points: [
          [9, 9],
          [10, 9],
        ],
      })
    ).toBeNull()
  })

  it("moves one segment, its neighbours following", () => {
    expect(moveSegment(pts, 1, 2, 0, grid)).toEqual([
      [0, 0],
      [12, 0],
      [12, 6],
    ])
  })

  it("drops a point left on its neighbour, its doors kept", () => {
    const r = dropRepeats(
      [
        [0, 0],
        [4, 0],
        [4, 0],
        [4, 4],
      ],
      [door({ seg: 2, from: 1, to: 2 })]
    )
    expect(r.points).toHaveLength(3)
    expect(r.openings).toEqual([door({ seg: 1, from: 1, to: 2 })])
  })
})

describe("snapping a dragged point", () => {
  const runs = [
    {
      id: "w2",
      points: [
        [4, 4],
        [10, 4],
      ] as Pt[],
    },
  ]
  const opts = { grid, reach: 0.4 }

  it("pulls onto another run's end, and names it", () => {
    const s = snapStructPoint([4.2, 3.8], runs, opts)
    expect(s.p).toEqual([4, 4])
    expect(s.end).toEqual({ id: "w2", index: 0 })
  })

  it("pulls onto another run's edge", () => {
    expect(snapStructPoint([7.1, 4.3], runs, opts).p).toEqual([7, 4])
  })

  it("lines up with another run's point, and draws the guide", () => {
    const s = snapStructPoint([4.3, 8.2], runs, opts)
    expect(s.p).toEqual([4, 8])
    expect(s.guides).toEqual({ x: 4 })
  })

  it("places a point exactly where it is with Alt", () => {
    const s = snapStructPoint([4.2, 3.8], runs, { ...opts, free: true })
    expect(s.p).toEqual([4.2, 3.8])
    expect(s.end).toBeUndefined()
    expect(
      snapStructPoint([7.1234, 4.3], runs, { ...opts, free: true }).p
    ).toEqual([7.123, 4.3])
  })

  it("lands on a wall off the lattice exactly, not beside it", () => {
    const slanted = [
      {
        id: "s",
        points: [
          [1.3, 1],
          [1.3, 9],
        ] as Pt[],
      },
    ]
    const s = snapStructPoint([1.4, 5.1], slanted, opts)
    expect(s.p[0]).toBeCloseTo(1.3, 6)
  })

  it("pulls a raised floor's edge onto another's, on whole cells", () => {
    const r = snapRect(
      { x: 4.3, y: 0.2, width: 2, height: 2 },
      [{ x: 0, y: 0, width: 4, height: 4 }],
      grid,
      0.4
    )
    expect(r.rect).toEqual({ x: 4, y: 0, width: 2, height: 2 })
    expect(r.guides.x).toBe(4)
  })
})

describe("walls linked to an area", () => {
  it("are named after it, numbered per stretch", () => {
    expect(linkedWallLabel("Cage", 0, 1)).toBe("Cage walls")
    expect(linkedWallLabel("Cage", 1, 3)).toBe("Cage walls 2")
    expect(linkedWallLabel("", 0, 1)).toBe("Area walls")
  })

  it("tell a move from a reshape", () => {
    const a = areaOutline(rect())
    const moved = areaOutline(rect({ x: 3.25, y: 2.5 }))
    const wider = areaOutline(rect({ width: 6 }))
    const turned = areaOutline(rect({ rotation: 15 }))
    expect(outlineShift(a, moved)).toEqual([1.25, 0.5])
    expect(outlineShift(a, wider)).toBeNull()
    expect(outlineShift(a, turned)).toBeNull()
    expect(outlineShift(a, a)).toBeNull()
  })

  it("match runs in any order, either way round", () => {
    const r: Pt[] = [
      [0, 0],
      [4, 0],
      [4, 2],
    ]
    expect(runsMatch([{ points: [...r].reverse() }], [r])).toBe(true)
    expect(runsMatch([{ points: r }], [r, r])).toBe(false)
    expect(
      runsMatch(
        [
          {
            points: [
              [0, 0],
              [4, 0],
              [4, 3],
            ],
          },
        ],
        [r]
      )
    ).toBe(false)
  })

  it("keep each door at its place along the stretch when rebuilt", () => {
    // A 4x3 room grown to 8x3: a door half-way along the top edge (2 of 14
    // cells round) lands at the same share of the new 22-cell run.
    const old = wallsAround([areaOutline(rect())], [], grid)[0]
    const grown = wallsAround([areaOutline(rect({ width: 8 }))], [], grid)[0]
    const wall = {
      points: old,
      openings: [door({ seg: 0, from: 1.5, to: 2.5 })],
    }
    const { openings, dropped } = rebuildWalls([wall], [grown])
    expect(dropped).toEqual([])
    expect(openings[0]).toHaveLength(1)
    const o = openings[0][0]
    expect(o.to - o.from).toBeCloseTo(1, 6)
    const share = 2 / 14
    expect(o.seg).toBe(0)
    expect((o.from + o.to) / 2).toBeCloseTo(share * 22, 2)
  })

  it("drop a door that no longer fits, and say which", () => {
    const old = wallsAround([areaOutline(rect())], [], grid)[0]
    const tiny = wallsAround(
      [areaOutline(rect({ width: 1, height: 1 }))],
      [],
      grid
    )[0]
    const wall = {
      points: old,
      openings: [door({ seg: 0, from: 0.5, to: 3.5 })],
    }
    const { openings, dropped } = rebuildWalls([wall], [tiny])
    expect(openings[0]).toEqual([])
    expect(dropped).toEqual([{ wall: 0, index: 0 }])
  })

  it("drop the doors of a wall the rebuild has no run for", () => {
    const old = wallsAround([areaOutline(rect())], [], grid)[0]
    const wall = { points: old, openings: [door()] }
    const { dropped } = rebuildWalls([wall, wall], [old])
    expect(dropped).toEqual([{ wall: 1, index: 0 }])
  })
})
