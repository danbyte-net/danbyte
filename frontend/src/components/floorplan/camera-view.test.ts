// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"

import type { FloorPlanTile, FloorPlanWall } from "@/lib/api"

import {
  cacheStats,
  cameraSpec,
  cameraViews,
  clearViewCache,
  coverage,
  polygonArea,
  visibilityPolygon,
  wallQuads,
} from "./camera-view"
import type { CameraSpec, Quad, Seg } from "./camera-view"
import { planSvg } from "./plan-svg"
import { pointInPolygon } from "./shapes"
import type { Pt } from "./shapes"

const CELL_MM = 500

const cam = (p: Partial<FloorPlanTile> = {}): FloorPlanTile =>
  ({
    id: "c1",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    tile_type: { has_fov: true, color: "#2563eb" },
    role_type: null,
    orientation: 0,
    label: "",
    color: "",
    status: "active",
    link_kind: "",
    linked: null,
    fov_deg: 90,
    fov_distance: 10,
    fov_direction: 90,
    fov_anchor: "",
    fov_ptz: false,
    ...p,
  }) as unknown as FloorPlanTile

const wall = (points: Pt[], p: Partial<FloorPlanWall> = {}): FloorPlanWall =>
  ({
    id: `w${points.flat().join("_")}`,
    label: "",
    points,
    height_mm: null,
    thickness_mm: 100,
    color: "",
    openings: [],
    created_at: "",
    updated_at: "",
    ...p,
  })

const sectorArea = (r: number, deg: number) => (Math.PI * r * r * deg) / 360

/** One camera's polygon against these walls. */
const viewOf = (
  tile: FloorPlanTile,
  walls: FloorPlanWall[] = [],
  extra: FloorPlanTile[] = [],
  racksBlock = false
) => cameraViews([tile, ...extra], walls, { cellMm: CELL_MM, racksBlock })[0]

const inside = (poly: Pt[], p: Pt) => pointInPolygon(p, poly)

beforeEach(() => clearViewCache())

describe("cameraSpec", () => {
  it("emits from the anchor, 0° up and clockwise", () => {
    const s = cameraSpec(cam({ x: 4, y: 6, fov_direction: 0 }))!
    expect(s.origin).toEqual([4.5, 6.5])
    expect(Math.cos(s.dir)).toBeCloseTo(0)
    expect(Math.sin(s.dir)).toBeCloseTo(-1)
    const tl = cameraSpec(cam({ x: 4, y: 6, fov_anchor: "tl" }))!
    expect(tl.origin).toEqual([4, 6])
  })

  it("is null for a tile with no field of view", () => {
    expect(cameraSpec(cam({ tile_type: null }))).toBeNull()
    expect(cameraSpec(cam({ fov_distance: null }))).toBeNull()
    expect(cameraSpec(cam({ fov_deg: null }))).toBeNull()
    expect(cameraSpec(cam({ fov_deg: null, fov_ptz: true }))).not.toBeNull()
  })
})

describe("visibilityPolygon", () => {
  it("is the full sector with nothing in the way, arcs smooth", () => {
    const v = viewOf(cam({ x: 10, y: 10 }))
    expect(polygonArea(v.polygon) / sectorArea(10, 90)).toBeCloseTo(1, 3)
    // Smooth: no arc step wider than 2°.
    const o = v.origin
    const angles = v.polygon
      .slice(1)
      .map(([x, y]) => Math.atan2(y - o[1], x - o[0]))
    for (let i = 1; i < angles.length; i++)
      expect(angles[i] - angles[i - 1]).toBeLessThanOrEqual(
        (2 * Math.PI) / 180 + 1e-9
      )
  })

  it("is a ring for a PTZ camera", () => {
    const v = viewOf(cam({ x: 10, y: 10, fov_ptz: true, fov_distance: 5 }))
    expect(v.ring).toBe(true)
    expect(polygonArea(v.polygon)).toBeCloseTo(Math.PI * 25, 1)
  })

  it("stops at a wall across the cone", () => {
    // Camera at (10.5, 10.5) looking right (+x); a wall at x = 14.
    const v = viewOf(cam({ x: 10, y: 10 }), [
      wall([
        [14, 0],
        [14, 30],
      ]),
    ])
    const face = 14 - 0.1 // half of 100 mm on a 500 mm cell
    const maxX = Math.max(...v.polygon.map((p) => p[0]))
    expect(maxX).toBeCloseTo(face, 6)
    expect(inside(v.polygon, [13.5, 10.5])).toBe(true)
    expect(inside(v.polygon, [15, 10.5])).toBe(false)
    // The cut region: a triangle-ish cap of the 90° sector.
    expect(polygonArea(v.polygon)).toBeLessThan(sectorArea(10, 90))
    expect(polygonArea(v.polygon)).toBeCloseTo((face - 10.5) ** 2, 4)
  })

  it("sees through a doorway in the wall", () => {
    const blocked = viewOf(cam({ x: 10, y: 10 }), [
      wall([
        [14, 0],
        [14, 30],
      ]),
    ])
    const doored = viewOf(cam({ x: 10, y: 10 }), [
      wall(
        [
          [14, 0],
          [14, 30],
        ],
        { openings: [{ seg: 0, from: 10, to: 11, height_mm: null }] }
      ),
    ])
    // Straight through the gap (y 10-11).
    expect(inside(doored.polygon, [18, 10.5])).toBe(true)
    expect(inside(blocked.polygon, [18, 10.5])).toBe(false)
    // Beside the gap's shadow, still blocked.
    expect(inside(doored.polygon, [18, 13])).toBe(false)
    expect(polygonArea(doored.polygon)).toBeGreaterThan(
      polygonArea(blocked.polygon)
    )
  })

  it("closes a corner: nothing leaks round its outer side", () => {
    // An L wall the camera looks into the corner of, from inside.
    const v = viewOf(cam({ x: 10, y: 10, fov_direction: 135, fov_deg: 120 }), [
      wall([
        [14, 6],
        [14, 14],
        [6, 14],
      ]),
    ])
    expect(inside(v.polygon, [13.5, 13.5])).toBe(true)
    expect(inside(v.polygon, [14.5, 14.5])).toBe(false)
    expect(inside(v.polygon, [16, 16])).toBe(false)
  })

  it("a camera on a wall sees the room it faces, not through the wall", () => {
    // Centred on the wall's centreline, looking down (+y) into the room.
    const v = viewOf(
      cam({
        x: 9.5,
        y: 8.5,
        fov_anchor: "",
        fov_direction: 180,
        fov_deg: 120,
        fov_distance: 5,
      }),
      [
        wall([
          [0, 9],
          [30, 9],
        ]),
      ]
    )
    expect(v.origin[1]).toBeGreaterThan(9.1 - 1e-9)
    expect(polygonArea(v.polygon)).toBeGreaterThan(sectorArea(5, 120) * 0.95)
    expect(inside(v.polygon, [10, 12])).toBe(true)
    expect(Math.min(...v.polygon.map((p) => p[1]))).toBeGreaterThan(9.09)
  })

  it("ignores a wall beyond its reach", () => {
    const v = viewOf(cam({ x: 10, y: 10, fov_distance: 3 }), [
      wall([
        [20, 0],
        [20, 30],
      ]),
    ])
    expect(polygonArea(v.polygon)).toBeCloseTo(sectorArea(3, 90), 2)
  })

  it("a thicker wall stops sight at its nearer face", () => {
    const thick = viewOf(cam({ x: 10, y: 10 }), [
      wall(
        [
          [14, 0],
          [14, 30],
        ],
        { thickness_mm: 1000 }
      ),
    ])
    expect(Math.max(...thick.polygon.map((p) => p[0]))).toBeCloseTo(13, 6)
  })

  it("turns with the plan: a rotated scene gives the same area", () => {
    const base = viewOf(cam({ x: 10, y: 10 }), [
      wall(
        [
          [14, 0],
          [14, 30],
        ],
        { openings: [{ seg: 0, from: 9.5, to: 11, height_mm: null }] }
      ),
    ])
    // Same scene turned 37° about the camera.
    const o: Pt = [10.5, 10.5]
    const r = (37 * Math.PI) / 180
    const turn = ([x, y]: Pt): Pt => [
      o[0] + (x - o[0]) * Math.cos(r) - (y - o[1]) * Math.sin(r),
      o[1] + (x - o[0]) * Math.sin(r) + (y - o[1]) * Math.cos(r),
    ]
    const turned = viewOf(cam({ x: 10, y: 10, fov_direction: 90 + 37 }), [
      wall([turn([14, 0]), turn([14, 30])], {
        openings: [{ seg: 0, from: 9.5, to: 11, height_mm: null }],
      }),
    ])
    expect(polygonArea(turned.polygon)).toBeCloseTo(
      polygonArea(base.polygon),
      3
    )
  })

  it("racks block only when asked", () => {
    const rack = cam({
      id: "r1",
      x: 13,
      y: 10,
      width: 1,
      height: 1,
      tile_type: null,
      linked: { kind: "rack", id: "x", name: "R1" },
    })
    const open = viewOf(cam({ x: 10, y: 10 }), [], [rack], false)
    const shut = viewOf(cam({ x: 10, y: 10 }), [], [rack], true)
    expect(inside(open.polygon, [16, 10.5])).toBe(true)
    expect(inside(shut.polygon, [16, 10.5])).toBe(false)
  })

  it("takes raw segments too (no walls needed)", () => {
    const spec: CameraSpec = {
      id: "x",
      origin: [0, 0],
      dir: 0,
      span: Math.PI / 2,
      range: 10,
      home: [0, 0],
    }
    const segs: Seg[] = [
      [
        [5, -10],
        [5, 10],
      ],
    ]
    const quads: Quad[] = []
    const { polygon } = visibilityPolygon(spec, segs, quads)
    expect(Math.max(...polygon.map((p) => p[0]))).toBeCloseTo(5, 9)
    expect(polygonArea(polygon)).toBeCloseTo(25, 6)
  })
})

describe("wallQuads", () => {
  it("leaves a gap for each opening, closes outer corners", () => {
    const qs = wallQuads(
      wall(
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        { openings: [{ seg: 0, from: 2, to: 3, height_mm: null }] }
      ),
      CELL_MM
    )
    expect(qs).toHaveLength(3)
    // The span into the corner runs on by half the thickness.
    const xs = qs[1].map((p) => p[0])
    expect(Math.max(...xs)).toBeCloseTo(10.1, 9)
    // The doorway's jambs are not extended.
    expect(Math.max(...qs[0].map((p) => p[0]))).toBeCloseTo(2, 9)
  })
})

describe("cameraViews cache", () => {
  it("recomputes only what moved", () => {
    const tiles = [cam({ id: "a", x: 2, y: 2 }), cam({ id: "b", x: 40, y: 40 })]
    const walls = [
      wall([
        [6, 0],
        [6, 10],
      ]),
      wall([
        [45, 30],
        [45, 50],
      ]),
    ]
    cameraViews(tiles, walls, { cellMm: CELL_MM })
    expect(cacheStats.misses).toBe(2)
    cameraViews(tiles, walls, { cellMm: CELL_MM })
    expect(cacheStats.misses).toBe(2)
    expect(cacheStats.hits).toBe(2)
    // Move the wall near b: a is found, b recomputed.
    const moved = [
      walls[0],
      wall([
        [46, 30],
        [46, 50],
      ]),
    ]
    cameraViews(tiles, moved, { cellMm: CELL_MM })
    expect(cacheStats.misses).toBe(3)
    // Turn camera a: only a recomputed.
    cameraViews([{ ...tiles[0], fov_direction: 100 }, tiles[1]], moved, {
      cellMm: CELL_MM,
    })
    expect(cacheStats.misses).toBe(4)
  })
})

describe("coverage", () => {
  const room: Pt[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]

  it("a corner camera reaching past the far corner sees all of it", () => {
    const v = viewOf(
      cam({
        x: 0,
        y: 0,
        fov_anchor: "tl",
        fov_direction: 135,
        fov_distance: 15,
      })
    )
    expect(coverage([v.polygon], [room]).regions[0]).toBeCloseTo(1, 2)
  })

  it("a ring in the middle covers its circle's share", () => {
    const v = viewOf(cam({ x: 4.5, y: 4.5, fov_ptz: true, fov_distance: 3 }))
    const c = coverage([v.polygon], [room])
    expect(c.regions[0]).toBeCloseTo((Math.PI * 9) / 100, 2)
  })

  it("a wall down the middle halves it", () => {
    const v = viewOf(cam({ x: 2, y: 4.5, fov_ptz: true, fov_distance: 30 }), [
      wall(
        [
          [5, 0],
          [5, 10],
        ],
        { thickness_mm: 1 }
      ),
    ])
    expect(coverage([v.polygon], [room]).regions[0]).toBeCloseTo(0.5, 2)
  })

  it("counts overlaps once, per region and over the level", () => {
    const left: Pt[] = [
      [0, 0],
      [5, 0],
      [5, 10],
      [0, 10],
    ]
    const right: Pt[] = [
      [5, 0],
      [10, 0],
      [10, 10],
      [5, 10],
    ]
    const c = coverage([left, left, room.slice(0, 4)], [left, right, []])
    expect(c.regions[0]).toBeCloseTo(1, 3)
    expect(c.regions[1]).toBeCloseTo(1, 3)
    expect(c.regions[2]).toBeNull()
    expect(coverage([left], [left, right]).total).toBeCloseTo(0.5, 2)
    expect(coverage([], [room]).total).toBe(0)
    expect(coverage([left], []).total).toBeNull()
  })
})

describe("performance", () => {
  it("hundreds of walls and dozens of cameras stay quick", () => {
    // A 40 x 20 grid of rooms 5 cells square: 400+ walls, one door each.
    const walls: FloorPlanWall[] = []
    for (let x = 0; x <= 200; x += 5)
      walls.push(
        wall(
          [
            [x, 0],
            [x, 100],
          ],
          {
            openings: Array.from({ length: 20 }, (_, i) => ({
              seg: 0,
              from: i * 5 + 2,
              to: i * 5 + 3,
              height_mm: null,
            })),
          }
        )
      )
    for (let y = 0; y <= 100; y += 5)
      walls.push(
        wall(
          [
            [0, y],
            [200, y],
          ],
          {
            openings: Array.from({ length: 40 }, (_, i) => ({
              seg: 0,
              from: i * 5 + 2,
              to: i * 5 + 3,
              height_mm: null,
            })),
          }
        )
      )
    const tiles = Array.from({ length: 60 }, (_, i) =>
      cam({
        id: `c${i}`,
        x: 1 + (i % 12) * 16,
        y: 1 + Math.floor(i / 12) * 19,
        fov_direction: (i * 47) % 360,
        fov_distance: 20,
        fov_ptz: i % 5 === 0,
      })
    )
    const t0 = performance.now()
    const views = cameraViews(tiles, walls, { cellMm: CELL_MM })
    const cold = performance.now() - t0
    const t1 = performance.now()
    cameraViews(tiles, walls, { cellMm: CELL_MM })
    const warm = performance.now() - t1
    expect(views).toHaveLength(60)
    // Generous bounds for a slow CI box; the numbers are logged.
    console.info(
      `camera views: ${walls.length * 21} wall spans, 60 cameras - cold ${cold.toFixed(1)} ms, cached ${warm.toFixed(1)} ms`
    )
    expect(cold).toBeLessThan(1500)
    expect(warm).toBeLessThan(150)
  })
})

describe("planSvg", () => {
  it("prints each camera's view cut by the walls, only when asked", () => {
    const plan = { grid_width: 30, grid_height: 30, cell_mm: CELL_MM }
    const walls = [
      wall([
        [14, 0],
        [14, 30],
      ]),
    ]
    const tiles = [cam({ x: 10, y: 10 })]
    const svg = planSvg({ plan, tiles, walls, cameras: { racksBlock: false } })
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
    const path = doc.querySelector('[data-fov="c1"]')
    expect(path).not.toBeNull()
    const xs = [...path!.getAttribute("d")!.matchAll(/[ML](-?[\d.]+) /g)].map(
      (m) => Number(m[1]) / 40
    )
    expect(Math.max(...xs)).toBeCloseTo(13.9, 2)
    expect(planSvg({ plan, tiles, walls })).not.toContain("data-fov")
  })
})
