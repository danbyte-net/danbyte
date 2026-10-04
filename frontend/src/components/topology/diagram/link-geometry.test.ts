import { describe, expect, it } from "vitest"

import {
  BENDY,
  ELBOW_RADIUS,
  STUB,
  bendyArms,
  bendyControls,
  bendyLine,
  curvedPath,
  curvedPolyline,
  linkRoute,
  portStub,
  roundedPath,
  stubbedPts,
} from "./link-geometry"
import type { End, Pt } from "./types"

// One geometry for the canvas and every export. Elbows stay orthogonal;
// curves follow draw.io's curved rule exactly, so a .drawio file with the
// same waypoints draws the same line.

const end = (x: number, y: number, dir: [number, number]): End => ({
  x,
  y,
  dir,
})

/** mxGraph's mxPolyline.paintCurvedLine, re-implemented against a
 * recording canvas - the reference the curved lines must match. */
function paintCurvedLine(pts: Pt[]): (string | number)[][] {
  const cmds: (string | number)[][] = []
  const c = {
    moveTo: (x: number, y: number) => cmds.push(["M", x, y]),
    quadTo: (x1: number, y1: number, x2: number, y2: number) =>
      cmds.push(["Q", x1, y1, x2, y2]),
  }
  const n = pts.length
  c.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < n - 2; i++) {
    const p0 = pts[i]
    const p1 = pts[i + 1]
    c.quadTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2)
  }
  const p0 = pts[n - 2]
  const p1 = pts[n - 1]
  c.quadTo(p0.x, p0.y, p1.x, p1.y)
  return cmds
}

/** Path data as commands with numeric arguments. */
function parse(d: string): (string | number)[][] {
  const out: (string | number)[][] = []
  for (const m of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const nums = m[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    out.push([m[1], ...nums])
  }
  return out
}

function expectSameCommands(
  got: (string | number)[][],
  want: (string | number)[][]
) {
  expect(got.map((c) => c[0])).toEqual(want.map((c) => c[0]))
  got.forEach((c, i) =>
    c.slice(1).forEach((v, j) => {
      expect(v as number).toBeCloseTo(want[i][j + 1] as number, 2)
    })
  )
}

function expectEndpoints(r: ReturnType<typeof linkRoute>, a: End, b: End) {
  const s = r.at(0)
  const t = r.at(1)
  expect(s.x).toBeCloseTo(a.x)
  expect(s.y).toBeCloseTo(a.y)
  expect(t.x).toBeCloseTo(b.x)
  expect(t.y).toBeCloseTo(b.y)
}

describe("straight", () => {
  it("is the two ends", () => {
    const a = end(0, 0, [0, 1])
    const b = end(30, 40, [0, -1])
    const r = linkRoute("straight", a, b)
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 40 },
    ])
    expect(r.d).toBe("M 0,0 L 30,40")
    expect(r.length).toBe(50)
    expectEndpoints(r, a, b)
    expect(r.at(0.5)).toMatchObject({ x: 15, y: 20 })
    expect(r.at(0.5).angle).toBeCloseTo((Math.atan2(40, 30) * 180) / Math.PI)
  })

  it("has a direction even with no length", () => {
    const a = end(5, 5, [1, 0])
    const r = linkRoute("straight", a, end(5, 5, [-1, 0]))
    expect(r.length).toBe(0)
    expect(r.at(0.5)).toEqual({ x: 5, y: 5, angle: 0 })
  })
})

describe("elbow", () => {
  const cases: [string, End, End, Parameters<typeof linkRoute>[3]][] = [
    ["bottom to top", end(0, 0, [0, 1]), end(120, 200, [0, -1]), {}],
    ["right to left", end(0, 0, [1, 0]), end(300, 90, [-1, 0]), {}],
    ["bottom to left", end(0, 0, [0, 1]), end(200, 150, [-1, 0]), {}],
    ["with a lane", end(0, 0, [0, 1]), end(120, 200, [0, -1]), { lane: 9 }],
    [
      "through a vertical channel",
      end(0, 0, [0, 1]),
      end(120, 200, [0, -1]),
      {
        wp: [
          { x: 260, y: 20 },
          { x: 260, y: 180 },
        ],
      },
    ],
    [
      "through a horizontal channel",
      end(0, 0, [1, 0]),
      end(300, 90, [-1, 0]),
      {
        wp: [
          { x: 40, y: -60 },
          { x: 260, y: -60 },
        ],
      },
    ],
  ]

  it.each(cases)("is axis-aligned: %s", (_name, a, b, opts) => {
    const r = linkRoute("elbow", a, b, opts)
    expect(r.pts[0]).toEqual({ x: a.x, y: a.y })
    expect(r.pts[r.pts.length - 1]).toEqual({ x: b.x, y: b.y })
    for (let i = 1; i < r.pts.length; i++) {
      const p = r.pts[i - 1]
      const q = r.pts[i]
      expect(p.x === q.x || p.y === q.y).toBe(true)
    }
    // Leaves and enters along the ends' normals, a stub each at least.
    const first = r.pts[1]
    const last = r.pts[r.pts.length - 2]
    const out = (first.x - a.x) * a.dir[0] + (first.y - a.y) * a.dir[1]
    const inn = (last.x - b.x) * b.dir[0] + (last.y - b.y) * b.dir[1]
    expect(out).toBeGreaterThanOrEqual(STUB)
    expect(inn).toBeGreaterThanOrEqual(STUB)
    expectEndpoints(r, a, b)
  })

  it("rounds its corners and shifts its channel by the lane", () => {
    const a = end(0, 0, [0, 1])
    const b = end(120, 200, [0, -1])
    const r = linkRoute("elbow", a, b)
    expect(r.d).toBe(
      roundedPath(
        r.pts.map((p) => [p.x, p.y]),
        ELBOW_RADIUS
      )
    )
    const shifted = linkRoute("elbow", a, b, { lane: 9 })
    expect(shifted.pts[2].y - r.pts[2].y).toBe(9)
  })

  it("drops corners from an aligned pair: one straight run", () => {
    const r = linkRoute("elbow", end(50, 0, [0, 1]), end(50, 200, [0, -1]))
    expect(r.pts).toEqual([
      { x: 50, y: 0 },
      { x: 50, y: 200 },
    ])
    expect(r.length).toBe(200)
  })

  it("keeps the wiring view's path helpers unchanged", () => {
    expect(
      roundedPath(
        [
          [0, 0],
          [0, 20],
          [30, 20],
        ],
        10
      )
    ).toBe("M 0,0 L 0,10 Q 0,20 10,20 L 30,20")
    expect(stubbedPts(0, 0, [0, 1], 100, 100, [0, -1], 3)).toEqual([
      [0, 0],
      [0, 14],
      [0, 53],
      [100, 53],
      [100, 86],
      [100, 100],
    ])
  })
})

describe("bendy", () => {
  it("puts its control points on the ends' normals", () => {
    const a = end(0, 0, [0, 1])
    const b = end(200, 300, [0, -1])
    const [p1, p2] = bendyControls(a, b)
    const k = Math.min(BENDY.MAX, BENDY.K * Math.hypot(200, 300))
    expect(p1).toEqual({ x: 0, y: k })
    expect(p2).toEqual({ x: 200, y: 300 - k })
  })

  it("keeps the reach within its bounds", () => {
    const near = bendyControls(end(0, 0, [1, 0]), end(20, 0, [-1, 0]))
    expect(near[0].x).toBe(BENDY.MIN)
    const far = bendyControls(end(0, 0, [1, 0]), end(2000, 0, [-1, 0]))
    expect(far[0].x).toBe(BENDY.MAX)
  })

  it("draws draw.io's curved line through its points", () => {
    const a = end(10, 20, [0, 1])
    const b = end(260, 340, [0, -1])
    const r = linkRoute("bendy", a, b)
    expect(r.kind).toBe("bendy")
    expect(r.pts).toEqual([
      { x: 10, y: 20 },
      ...bendyControls(a, b),
      { x: 260, y: 340 },
    ])
    expectSameCommands(parse(r.d), paintCurvedLine(r.pts))
    expectEndpoints(r, a, b)
    // It leaves along the source normal and arrives against the target's.
    expect(r.at(0).angle).toBeCloseTo(90, 0)
    expect(r.at(1).angle).toBeCloseTo(90, 0)
    // The spline passes through the midpoint between its control points.
    const [p1, p2] = bendyControls(a, b)
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const near = Array.from({ length: 101 }, (_, i) => r.at(i / 100)).some(
      (p) => Math.hypot(p.x - mid.x, p.y - mid.y) < 1.5
    )
    expect(near).toBe(true)
  })

  it("matches the curved rule for any number of points", () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 40, y: 80 },
      { x: 120, y: 60 },
      { x: 200, y: 140 },
      { x: 260, y: 30 },
    ]
    expectSameCommands(parse(curvedPath(pts)), paintCurvedLine(pts))
    expectSameCommands(
      parse(curvedPath(pts.slice(0, 3))),
      paintCurvedLine(pts.slice(0, 3))
    )
  })

  it("holds facing ends in line short of the middle of the gap", () => {
    // Straight under, labels asking for long arms: past the middle, the
    // curve would wave back.
    expect(
      bendyArms(end(0, 0, [0, 1]), end(40, 200, [0, -1]), 150, 150)
    ).toEqual([100, 100])
    // Offset as far as the gap, or twice as far: still held, so lines
    // across one tier gap run side by side.
    for (const x of [240, 480])
      expect(bendyArms(end(0, 0, [0, 1]), end(x, 240, [0, -1]))).toEqual([
        120, 120,
      ])
  })

  it("gives facing ends far apart sideways their full reach", () => {
    // The owner's firewall to a server 1000 px across and 240 down.
    const a = end(0, 0, [0, 1])
    const b = end(1000, 240, [0, -1])
    expect(bendyArms(a, b)).toEqual([BENDY.MAX, BENDY.MAX])
    // Further apart the hold eases off, with no jump.
    let last = 0
    for (let x = 440; x <= 640; x += 10) {
      const [k] = bendyArms(a, end(x, 240, [0, -1]))
      expect(k).toBeGreaterThanOrEqual(last)
      expect(k - last).toBeLessThan(last ? 12 : Infinity)
      last = k
    }
  })

  it("shortens an end's reach to its share, never under the least", () => {
    // Far apart: whole reach BENDY.MAX at each end.
    const a = end(0, 0, [0, 1])
    const b = end(600, 900, [0, -1])
    expect(bendyArms(a, b, 0, 0, [0.5, 1])).toEqual([BENDY.MAX / 2, BENDY.MAX])
    expect(bendyArms(a, b, 0, 0, [0.1, 1])[0]).toBe(BENDY.MIN)
    // A labelled end still runs straight past its labels.
    expect(bendyArms(a, b, 100, 0, [0.1, 1])[0]).toBe(portStub(100))
  })

  it("reaches past a labelled end's run and runs straight past it", () => {
    const a = end(0, 0, [0, 1])
    const b = end(600, 900, [0, -1])
    const [ka] = bendyArms(a, b, 180)
    expect(ka).toBe(portStub(180))
    const pts = bendyLine(a, b, 72, 0)
    // A point put in on the first arm: the curve starts straight down
    // for the labels' run and more.
    expect(pts).toHaveLength(5)
    const line = curvedPolyline(pts)
    const straight = line.filter((p) => p.x === 0)
    expect(Math.max(...straight.map((p) => p.y))).toBeGreaterThanOrEqual(74)
    // The unplanned route draws the same points.
    expect(linkRoute("bendy", a, b, { runs: [72, 0] }).pts).toEqual(pts)
  })

  it("is how a cyclical link draws until arcs land", () => {
    const a = end(0, 0, [0, -1])
    const b = end(300, 0, [0, -1])
    const r = linkRoute("cyclical", a, b)
    expect(r.kind).toBe("cyclical")
    expect(r.d).toBe(linkRoute("bendy", a, b).d)
  })
})

describe("at(t)", () => {
  it("walks the drawn path by arc length", () => {
    const r = linkRoute("elbow", end(0, 0, [1, 0]), end(100, 100, [-1, 0]))
    let prev = r.at(0)
    let walked = 0
    for (let i = 1; i <= 400; i++) {
      const p = r.at(i / 400)
      walked += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
    }
    expect(walked).toBeCloseTo(r.length, 0)
    expect(r.at(-1)).toEqual(r.at(0))
    expect(r.at(2)).toEqual(r.at(1))
  })
})
