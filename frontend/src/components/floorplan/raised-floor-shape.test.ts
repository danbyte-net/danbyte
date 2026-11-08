import { describe, expect, it } from "vitest"

import {
  cellBox,
  outerBoundary,
  outlineContains,
  outlinePath,
  outlinesOverlap,
  raisedContains,
  raisedRegions,
  rectOutline,
  rectUnionPieces,
  regionCaptionAnchor,
  signedArea,
} from "./raised-floor-shape"
import type { Pt } from "./raised-floor-shape"

// Raised floors as outlines; touching ones of one depth and colour merged
// into one region - filled once, outlined only outside.

const row = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: {
    plenum_mm?: number
    color?: string
    points?: [number, number][]
  } = {}
) => ({
  id,
  x,
  y,
  width,
  height,
  plenum_mm: extra.plenum_mm ?? 300,
  color: extra.color ?? "",
  label: "",
  points: extra.points ?? [],
})

/** Total length of polylines. */
const length = (lines: Pt[][]) =>
  lines.reduce(
    (s, l) =>
      s +
      l
        .slice(1)
        .reduce((t, p, i) => t + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0),
    0
  )

const area = (pieces: Pt[][]) =>
  pieces.reduce((s, p) => s + Math.abs(signedArea(p)), 0)

function turned(cx: number, cy: number, w: number, h: number, deg: number) {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ] as Pt[]
  ).map(([dx, dy]) => [cx + dx * c - dy * s, cy + dx * s + dy * c] as Pt)
}

describe("union of rectangles", () => {
  it("strips stacked into a staircase are one region with no seams", () => {
    // Six 2-cell strips, each shifted one cell right: a stepped band.
    const strips = Array.from({ length: 6 }, (_, i) =>
      row(`s${i}`, i, i * 2, 8, 2)
    )
    const [rg, ...rest] = raisedRegions(strips)
    expect(rest).toHaveLength(0)
    expect(rg.rows).toHaveLength(6)
    expect(area(rg.pieces)).toBeCloseTo(6 * 16)
    // One closed outline; its length is the staircase's perimeter:
    // top 8 + bottom 8 + left/right 12 each + five 1-cell steps each side.
    expect(rg.outline).toHaveLength(1)
    expect(length(rg.outline)).toBeCloseTo(8 + 8 + 12 + 12 + 5 + 5)
    // No segment of the outline runs along a seam between strips (y = 2,
    // 4, … inside the band).
    for (const line of rg.outline)
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]]
        if (a[1] === b[1] && a[1] > 0 && a[1] < 12)
          expect(Math.abs(a[0] - b[0])).toBeCloseTo(1)
      }
  })

  it("two abutting rectangles outline as one L, the seam left out", () => {
    const [rg] = raisedRegions([row("a", 0, 0, 4, 2), row("b", 0, 2, 2, 2)])
    expect(rg.outline).toHaveLength(1)
    expect(length(rg.outline)).toBeCloseTo(4 + 2 + 2 + 2 + 2 + 4)
    // An L has six corners (closed: the first repeated).
    expect(rg.outline[0]).toHaveLength(7)
  })

  it("overlapping rectangles fill once", () => {
    const pieces = rectUnionPieces([
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 2, y: 2, width: 4, height: 4 },
    ])
    expect(area(pieces)).toBeCloseTo(16 + 16 - 4)
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++)
        expect(outlinesOverlap(pieces[i], pieces[j])).toBe(false)
    expect(length(outerBoundary(pieces))).toBeCloseTo(24)
  })

  it("a hole stays a hole", () => {
    const ring = [
      row("t", 0, 0, 6, 2),
      row("b", 0, 4, 6, 2),
      row("l", 0, 2, 2, 2),
      row("r", 4, 2, 2, 2),
    ]
    const [rg] = raisedRegions(ring)
    expect(area(rg.pieces)).toBeCloseTo(36 - 4)
    expect(rg.outline).toHaveLength(2)
    expect(length(rg.outline)).toBeCloseTo(24 + 8)
  })

  it("different depths, colours or a gap make separate regions", () => {
    expect(
      raisedRegions([
        row("a", 0, 0, 2, 2),
        row("b", 2, 0, 2, 2, { plenum_mm: 600 }),
      ])
    ).toHaveLength(2)
    expect(
      raisedRegions([
        row("a", 0, 0, 2, 2),
        row("b", 2, 0, 2, 2, { color: "#f00" }),
      ])
    ).toHaveLength(2)
    expect(
      raisedRegions([row("a", 0, 0, 2, 2), row("b", 3, 0, 2, 2)])
    ).toHaveLength(2)
  })

  it("a single rectangle is its own closed outline", () => {
    const [rg] = raisedRegions([row("a", 1, 1, 3, 2)])
    expect(rg.pieces).toHaveLength(1)
    expect(rg.outline[0][0]).toEqual(rg.outline[0].at(-1))
    expect(outlinePath(rg.outline, 10, false)).toMatch(/^M/)
    expect(regionCaptionAnchor(rg.pieces)).toEqual([1, 3])
  })
})

describe("polygons", () => {
  const hall = turned(10, 10, 12, 6, 28)

  it("contains a point inside the turned hall but not its box corner", () => {
    expect(outlineContains(hall, [10, 10])).toBe(true)
    expect(outlineContains(hall, [hall[0][0], hall[0][1]])).toBe(true)
    const box = cellBox(hall)
    expect(outlineContains(hall, [box.x + 0.2, box.y + 0.2])).toBe(false)
    const r = row("h", box.x, box.y, box.width, box.height, {
      points: hall.map(([x, y]) => [x, y] as [number, number]),
    })
    expect(raisedContains(r, [box.x + 0.2, box.y + 0.2])).toBe(false)
    expect(raisedContains(r, [10, 10])).toBe(true)
    // A rectangle row still answers by its box, edges included.
    expect(raisedContains(row("q", 0, 0, 2, 2), [2, 1])).toBe(true)
    expect(raisedContains(row("q", 0, 0, 2, 2), [2.1, 1])).toBe(false)
  })

  it("overlap: shared edges are fine, shared interior is not", () => {
    const sq = rectOutline(0, 0, 4, 4)
    expect(
      outlinesOverlap(sq, [
        [4, 0],
        [8, 2],
        [4, 4],
      ])
    ).toBe(false)
    expect(
      outlinesOverlap(sq, [
        [3, 0],
        [8, 2],
        [3, 4],
      ])
    ).toBe(true)
    expect(outlinesOverlap(sq, rectOutline(1, 1, 1, 1))).toBe(true)
    expect(outlinesOverlap(sq, sq)).toBe(true)
  })

  it("a polygon and the rectangle it abuts merge into one outline", () => {
    const [rg] = raisedRegions([
      row("r", 0, 0, 4, 4),
      row("t", 4, 0, 4, 4, {
        points: [
          [4, 0],
          [8, 2],
          [4, 4],
        ],
      }),
    ])
    expect(rg.rows).toHaveLength(2)
    expect(rg.outline).toHaveLength(1)
    // The shared edge x = 4 is gone: 4 + 4 + 4 + two slopes.
    expect(length(rg.outline)).toBeCloseTo(12 + 2 * Math.hypot(4, 2))
  })

  it("a turned hall's caption starts inside it", () => {
    const [rg] = raisedRegions([
      row("h", 0, 0, 1, 1, {
        points: hall.map(([x, y]) => [x, y] as [number, number]),
      }),
    ])
    expect(outlineContains(hall, regionCaptionAnchor(rg.pieces))).toBe(true)
  })

  it("cellBox covers the polygon in whole cells", () => {
    expect(
      cellBox([
        [1.5, 2.2],
        [4.1, 2.2],
        [3, 6],
      ])
    ).toEqual({
      x: 1,
      y: 2,
      width: 4,
      height: 4,
    })
  })
})
