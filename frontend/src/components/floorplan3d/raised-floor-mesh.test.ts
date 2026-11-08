import { describe, expect, it } from "vitest"

import { outlineContains, raisedRegions } from "../floorplan/raised-floor-shape"
import type { Pt } from "../floorplan/raised-floor-shape"
import { tileGrid } from "./raised-floor-mesh"
import { floorTopM, RAISED_FLOOR_TOP_M, underfloorMM } from "./world"
import type { ScenePayload } from "./world"

// The 3D pad: one tile grid over the merged region, cut to it and turned
// with it; the floor-height and plenum lookups read polygons.

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

const segments = (pos: number[]) => {
  const out: [Pt, Pt][] = []
  for (let i = 0; i < pos.length; i += 6)
    out.push([
      [pos[i], pos[i + 2]],
      [pos[i + 3], pos[i + 5]],
    ])
  return out
}

describe("tileGrid", () => {
  it("cuts the grid to a staircase of strips, no line across a step", () => {
    const strips = Array.from({ length: 4 }, (_, i) => ({
      id: `s${i}`,
      x: i,
      y: i * 2,
      width: 6,
      height: 2,
      plenum_mm: 300,
      color: "",
    }))
    const [rg] = raisedRegions(strips)
    const segs = segments(tileGrid(rg.pieces, rg.outline, 1))
    expect(segs.length).toBeGreaterThan(0)
    for (const [a, b] of segs) {
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      expect(rg.pieces.some((p) => outlineContains(p, mid, 1e-6))).toBe(true)
    }
  })

  it("turns with a turned hall", () => {
    const hall = turned(10, 10, 12, 6, 28)
    const [rg] = raisedRegions([
      {
        id: "h",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        points: hall.map(([x, y]) => [x, y] as [number, number]),
        plenum_mm: 300,
        color: "",
      },
    ])
    const segs = segments(tileGrid(rg.pieces, rg.outline, 1))
    expect(segs.length).toBeGreaterThan(10)
    const angle = (28 * Math.PI) / 180
    for (const [a, b] of segs) {
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      // Along or across the hall: the cross product with its long axis is
      // ±len (across) or 0 (along).
      const cross = Math.abs(dx * Math.sin(angle) - dy * Math.cos(angle)) / len
      expect(Math.min(cross, Math.abs(1 - cross))).toBeLessThan(1e-6)
      for (const p of [a, b]) expect(outlineContains(hall, p, 1e-6)).toBe(true)
    }
  })
})

describe("polygon raised floors in the scene math", () => {
  const hall = turned(10, 10, 12, 6, 28).map(
    ([x, y]) => [x, y] as [number, number]
  )
  const area = {
    id: "h",
    x: 3,
    y: 5,
    w: 14,
    h: 11,
    points: hall,
    plenum_mm: 700,
    label: "",
    color: "",
  }
  it("plenum under a run follows the polygon, not its box", () => {
    expect(underfloorMM([area], [[10, 10]])).toBe(700)
    expect(underfloorMM([area], [[3.2, 5.2]])).not.toBe(700)
  })
  it("a tile stands on the pad only inside the polygon", () => {
    const scene = { raised_floors: [area] } as unknown as ScenePayload
    const tile = (x: number, y: number) =>
      ({ x, y, w: 1, h: 1 }) as unknown as Parameters<typeof floorTopM>[1]
    expect(floorTopM(scene, tile(9.5, 9.5))).toBe(RAISED_FLOOR_TOP_M)
    expect(floorTopM(scene, tile(3, 5))).toBe(0)
  })
})
