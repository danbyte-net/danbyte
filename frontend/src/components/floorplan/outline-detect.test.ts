import { describe, expect, it } from "vitest"

import {
  cellsToPixels,
  crossesItself,
  detectRegion,
  growByColour,
  mainDirection,
  pixelsToCells,
  polygonArea,
  shapeOutline,
  simplifyClosed,
  squareCorners,
  traceOuter,
} from "./outline-detect"
import type { DetectOptions } from "./outline-detect"
import { blank, lineDrawing, mapTile, paint } from "./outline-detect.fixtures"
import type { Pt } from "./shapes"

const COLOUR: DetectOptions = {
  mode: "colour",
  tolerance: 8,
  threshold: 128,
  gapPx: 0,
}
const ROOM: DetectOptions = { ...COLOUR, mode: "room", gapPx: 14 }

/** The corners' angles, in degrees (each 0-180). */
function cornerAngles(pts: readonly Pt[]): number[] {
  return pts.map((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length]
    const b = pts[(i + 1) % pts.length]
    const u = [a[0] - p[0], a[1] - p[1]]
    const v = [b[0] - p[0], b[1] - p[1]]
    const cos =
      (u[0] * v[0] + u[1] * v[1]) /
      (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]))
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  })
}

/** How far the outline's corners are from the nearest of `truth`'s. */
function cornerError(pts: readonly Pt[], truth: readonly Pt[]): number {
  return Math.max(
    ...pts.map((p) =>
      Math.min(...truth.map((t) => Math.hypot(p[0] - t[0], p[1] - t[1])))
    )
  )
}

describe("traceOuter", () => {
  it("traces one pixel as its four corners", () => {
    const m = new Uint8Array(9)
    m[4] = 1
    const pts = traceOuter(m, 3, 3)
    expect(pts).toHaveLength(4)
    expect(polygonArea(pts)).toBe(1)
  })

  it("leaves holes out", () => {
    // A 5 × 5 square with a 1 × 1 hole: the outer edge only.
    const m = new Uint8Array(49)
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * 7 + x] = 1
    m[3 * 7 + 3] = 0
    const pts = traceOuter(m, 7, 7)
    expect(pts).toHaveLength(4)
    expect(polygonArea(pts)).toBe(25)
  })

  it("follows an L shape", () => {
    const m = new Uint8Array(100)
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) if (x < 4 || y > 5) m[y * 10 + x] = 1
    const pts = traceOuter(m, 10, 10)
    expect(pts).toHaveLength(6)
    expect(polygonArea(pts)).toBe(4 * 6 + 10 * 4)
  })
})

describe("growing a region on a map tile", () => {
  const { raster, turned, ell } = mapTile()

  it("stops at the building's outline", () => {
    const { mask, count } = growByColour(raster, [70, 70], 8)
    // Inside the building, nothing of the land outside it.
    expect(mask[70 * raster.width + 70]).toBe(1)
    expect(mask[5 * raster.width + 5]).toBe(0)
    const truth = polygonArea(turned)
    expect(count).toBeGreaterThan(truth * 0.9)
    expect(count).toBeLessThan(truth * 1.05)
  })

  it("takes in more of the anti-aliased edge as the tolerance rises", () => {
    const sizes = [2, 4, 8].map((tolerance) => {
      const r = detectRegion(raster, [70, 70], { ...COLOUR, tolerance })
      if (!r.ok) throw new Error(r.reason)
      return r.pixels
    })
    expect(sizes[0]).toBeLessThan(sizes[1])
    expect(sizes[1]).toBeLessThan(sizes[2])
    // Even the lowest takes the flat fill whole.
    expect(sizes[0]).toBeGreaterThan(polygonArea(turned) * 0.9)
  })

  it("runs into the land at a high tolerance", () => {
    const r = detectRegion(raster, [70, 70], { ...COLOUR, tolerance: 20 })
    expect(r).toEqual({ ok: false, reason: "large" })
  })

  it("takes the land when the land is clicked", () => {
    const r = detectRegion(raster, [5, 5], COLOUR)
    expect(r).toEqual({ ok: false, reason: "large" })
  })

  it("finds the turned building: four square corners on its outline", () => {
    const r = detectRegion(raster, [70, 70], COLOUR)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pts = shapeOutline(r.contour, { epsilon: 2, square: true })
    expect(pts).toHaveLength(4)
    for (const a of cornerAngles(pts)) expect(a).toBeCloseTo(90, 6)
    expect((mainDirection(pts) * 180) / Math.PI).toBeCloseTo(20, 0)
    // Within a pixel and a half of the drawn corners, and the area
    // within 5 %.
    expect(cornerError(pts, turned)).toBeLessThan(1.5)
    expect(polygonArea(pts) / polygonArea(turned)).toBeGreaterThan(0.95)
    expect(polygonArea(pts) / polygonArea(turned)).toBeLessThan(1.02)
  })

  it("finds the L-shaped building round its house number", () => {
    const r = detectRegion(raster, [200, 40], COLOUR)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pts = shapeOutline(r.contour, { epsilon: 2, square: true })
    expect(pts).toHaveLength(6)
    expect(cornerError(pts, ell)).toBeLessThan(1.2)
  })

  it("keeps the staircase without squaring, fewer corners with more simplify", () => {
    const r = detectRegion(raster, [70, 70], COLOUR)
    if (!r.ok) throw new Error("not found")
    const raw = shapeOutline(r.contour, { epsilon: 0.5, square: false })
    const loose = shapeOutline(r.contour, { epsilon: 3, square: false })
    expect(raw.length).toBeGreaterThan(8)
    expect(loose.length).toBeLessThan(raw.length)
    expect(loose.length).toBeGreaterThanOrEqual(4)
  })
})

describe("filling a room in a line drawing", () => {
  const { raster, left, right } = lineDrawing()

  it("bridges the door between the rooms", () => {
    const r = detectRegion(raster, [50, 80], ROOM)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pts = shapeOutline(r.contour, { epsilon: 1, square: true })
    expect(pts).toHaveLength(4)
    expect(cornerError(pts, left)).toBeLessThan(1.5)
  })

  it("bridges the door out of the building", () => {
    const r = detectRegion(raster, [150, 60], ROOM)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pts = shapeOutline(r.contour, { epsilon: 1, square: true })
    expect(pts).toHaveLength(4)
    expect(cornerError(pts, right)).toBeLessThan(1.5)
  })

  it("runs out through an open door without the gap setting", () => {
    expect(detectRegion(raster, [150, 60], { ...ROOM, gapPx: 0 })).toEqual({
      ok: false,
      reason: "large",
    })
  })

  it("refuses a click on a wall", () => {
    expect(detectRegion(raster, [12, 60], ROOM)).toEqual({
      ok: false,
      reason: "wall",
    })
  })

  it("leaves no bulge in the doorway", () => {
    const r = detectRegion(raster, [50, 80], ROOM)
    if (!r.ok) throw new Error("not found")
    // Every pixel of the room is inside the left room's walls.
    const xs = r.contour.map((p) => p[0])
    expect(Math.max(...xs)).toBe(98)
    expect(Math.min(...xs)).toBe(14)
  })

  it("fills a corridor narrower than the gap", () => {
    const r = blank(60, 40, "#ffffff")
    paint(
      r,
      [
        [0, 0],
        [60, 0],
        [60, 15],
        [0, 15],
      ],
      { fill: "#000000" }
    )
    paint(
      r,
      [
        [0, 23],
        [60, 23],
        [60, 40],
        [0, 40],
      ],
      { fill: "#000000" }
    )
    const found = detectRegion(r, [30, 19], { ...ROOM, maxShare: 1 })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(polygonArea(found.contour)).toBe(60 * 8)
  })
})

describe("squaring", () => {
  it("snaps corners within 8° and keeps a real diagonal", () => {
    // A rectangle drawn a few degrees off at its corners.
    const off: Pt[] = [
      [0, 0],
      [100, 3],
      [102, 60],
      [-2, 58],
    ]
    const sq = squareCorners(off)!
    expect(sq).toHaveLength(4)
    for (const a of cornerAngles(sq)) expect(a).toBeCloseTo(90, 6)
    // A chamfered corner at 45° stays.
    const chamfer: Pt[] = [
      [0, 0],
      [80, 0],
      [100, 20],
      [100, 60],
      [0, 60],
    ]
    expect(squareCorners(chamfer)).toHaveLength(5)
  })

  it("drops a tiny jog and keeps a real step", () => {
    const jog: Pt[] = [
      [0, 0],
      [50, 0],
      [50, 1],
      [100, 1],
      [100, 60],
      [0, 60],
    ]
    expect(squareCorners(jog, { jog: 2 })).toHaveLength(4)
    expect(squareCorners(jog, { jog: 0.5 })).toHaveLength(6)
  })

  it("leaves a shape far from square alone", () => {
    const tri: Pt[] = [
      [0, 0],
      [100, 0],
      [50, 80],
    ]
    const sq = squareCorners(tri)!
    expect(sq).toHaveLength(3)
    expect(crossesItself(sq)).toBe(false)
  })

  it("never gives more corners than an area takes", () => {
    // A circle-ish contour of 400 points.
    const circle: Pt[] = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * Math.PI * 2
      return [100 + 90 * Math.cos(a), 100 + 90 * Math.sin(a)]
    })
    const out = shapeOutline(circle, {
      epsilon: 0.001,
      square: false,
      maxPoints: 200,
    })
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.length).toBeGreaterThan(20)
  })

  it("simplifies a closed outline to its corners", () => {
    const pts: Pt[] = []
    for (let x = 0; x < 10; x++) pts.push([x, 0])
    for (let y = 0; y < 10; y++) pts.push([10, y])
    for (let x = 10; x > 0; x--) pts.push([x, 10])
    for (let y = 10; y > 0; y--) pts.push([0, y])
    expect(simplifyClosed(pts, 0.1)).toHaveLength(4)
  })
})

describe("pixels and cells", () => {
  it("maps the picture onto its frame", () => {
    const size = { width: 400, height: 200 }
    const frame = { x: 0, y: 0, width: 40, height: 20 }
    expect(pixelsToCells([[200, 100]], size, frame)).toEqual([[20, 10]])
    // A live view's frame: the source's grid, shifted by the crop.
    const view = { x: -5, y: -2, width: 40, height: 20 }
    expect(pixelsToCells([[0, 0]], size, view)).toEqual([[-5, -2]])
    expect(cellsToPixels([15, 8], size, view)).toEqual([200, 100])
  })
})

describe("a picture with nothing to find", () => {
  it("a speck is too small", () => {
    const r = blank(20, 20, "#ffffff")
    paint(
      r,
      [
        [9, 9],
        [10, 9],
        [10, 10],
        [9, 10],
      ],
      { fill: "#ff0000" }
    )
    expect(detectRegion(r, [9, 9], { ...COLOUR, tolerance: 1 })).toEqual({
      ok: false,
      reason: "small",
    })
  })
})
