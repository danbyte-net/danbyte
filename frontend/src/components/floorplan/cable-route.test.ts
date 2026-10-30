import { describe, expect, it } from "vitest"

import cases from "./cable-route.cases.json"
import { routeCable, trayElevationMm, type Pt } from "./cable-route"

const length = (pts: Pt[]) =>
  pts
    .slice(1)
    .reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0)

// The same cases api/tests_pathfinding.py runs through route_through_trays:
// the client and the server route alike.
describe("routeCable shared cases", () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const a = c.a as Pt
      const b = c.b as Pt
      const polys = c.trays.map((t) => t.points as Pt[])
      const elevations = c.levels
        ? c.trays.map((t) => t.elevation_mm)
        : undefined
      const path = routeCable(a, b, polys, undefined, elevations)
      expect(length(path)).toBeCloseTo(c.run, 4)
      if (!c.reachable) expect(path).toEqual([a, b])
    })
  }
})

describe("trayElevationMm", () => {
  const tray = (level: string, elevation_mm: number | null = null) => ({
    level,
    elevation_mm,
    points: [
      [1, 1],
      [4, 1],
    ] as [number, number][],
  })

  it("derives from the level like the server", () => {
    expect(trayElevationMm(tray("overhead"), 3000)).toBe(2700)
    expect(trayElevationMm(tray("floor"), 3000)).toBe(0)
    expect(trayElevationMm(tray("underfloor"), 3000)).toBe(-300)
    expect(trayElevationMm(tray("overhead", 2400), 3000)).toBe(2400)
  })

  it("takes the deepest raised floor under an underfloor run", () => {
    const areas = [
      { x: 0, y: 0, width: 2, height: 2, plenum_mm: 450 },
      { x: 3, y: 0, width: 2, height: 2, plenum_mm: 600 },
    ]
    expect(trayElevationMm(tray("underfloor"), 3000, areas)).toBe(-600)
  })
})
