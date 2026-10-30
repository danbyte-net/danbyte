import { describe, expect, it, vi } from "vitest"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import {
  CableRouteCache,
  bundledGroups,
  cableColor,
  cableLegend,
  cableLegendEntries,
  cableLod,
  cableRouteState,
  endText,
  hasSharedRuns,
  laneOrder,
  lanePolylines,
  laneSegments,
  layoutCables,
  paperLod,
  routeLengthM,
  storedLengthM,
  typePalette,
} from "./cable-draw"
import type { CableRoute, RouteContext } from "./cable-draw"
import { routeCable } from "./cable-route"
import type { Pt } from "./cable-route"

// The 2D cable drawing's geometry and looks: routes square off, runs in one
// tray get lanes in one order, shared stretches bundle by zoom, colours
// come from data, line styles from the route's state - and a route is
// worked out again only when what it depends on changed.

const tile = (id: string, x: number, y: number): FloorPlanTile =>
  ({ id, x, y, width: 1, height: 1 }) as FloorPlanTile

const tray = (
  id: string,
  points: Pt[],
  patch: Partial<FloorPlanTray> = {}
): FloorPlanTray =>
  ({
    id,
    name: id.toUpperCase(),
    points,
    level: "overhead",
    elevation_mm: null,
    cables: [],
    hidden_cable_count: 0,
    ...patch,
  }) as FloorPlanTray

const cable = (
  id: string,
  a: string,
  b: string,
  trayIds: string[] = [],
  patch: Partial<FloorPlanCablePath> = {}
): FloorPlanCablePath => ({
  id,
  label: id,
  color: "",
  type: "",
  a_tiles: [a],
  b_tiles: [b],
  a_points: [],
  b_points: [],
  tray_ids: trayIds,
  ...patch,
})

// Two racks under one straight overhead tray, a third rack round a corner.
const tiles = [tile("r1", 1, 3), tile("r2", 9, 3), tile("r3", 12, 8)]
const t1 = tray("t1", [
  [0, 2],
  [12, 2],
])
const t2 = tray("t2", [
  [12, 2],
  [12, 9],
])
const ctx: RouteContext = { trays: [t1, t2], tiles, ceilingMm: 3000 }

const routesOf = (cps: FloorPlanCablePath[], c: RouteContext = ctx) =>
  new CableRouteCache().routes(cps, c)

const diagonal = (r: CableRoute) =>
  r.segs.some(
    (s) => Math.abs(s.a[0] - s.b[0]) > 1e-6 && Math.abs(s.a[1] - s.b[1]) > 1e-6
  )

describe("routes", () => {
  it("draws an untrayed cable as an orthogonal elbow, never a diagonal", () => {
    const r = routesOf([cable("c1", "r1", "r3")]).get("c1")!
    expect(r.routed).toBe(false)
    expect(diagonal(r)).toBe(false)
    expect(r.points[0]).toEqual([1.5, 3.5])
    expect(r.points[r.points.length - 1]).toEqual([12.5, 8.5])
    expect(r.trayIds).toEqual([])
  })

  it("follows the trays it rides and squares off the hops to them", () => {
    const r = routesOf([cable("c1", "r1", "r3", ["t1", "t2"])]).get("c1")!
    expect(r.routed).toBe(true)
    expect(r.trayIds).toEqual(["t1", "t2"])
    expect(diagonal(r)).toBe(false)
    // Along the tray at y = 2, then down the second at x = 12.
    expect(r.segs.filter((s) => s.group?.startsWith("t:t1")).length).toBe(1)
    expect(r.segs.filter((s) => s.group?.startsWith("t:t2")).length).toBe(1)
    // Rack tops are not known here: the drops are the full tray height.
    expect(r.dropsMm).toEqual([2700, 2700])
  })

  it("leaves out a cable whose end is not on the plan", () => {
    const cps = [cable("c1", "r1", "gone"), cable("c2", "r1", "r1")]
    expect(routesOf(cps).size).toBe(0)
  })

  it("works out the route's length as the server does", () => {
    const r = routesOf([
      cable("c1", "r1", "r2", ["t1"], { a_top_mm: 2000, b_top_mm: 2000 }),
    ]).get("c1")!
    // Run: 1.5 down-and-across hops + 8 cells of tray; drops 700 mm each.
    const mm = r.runCells * 600 + 700 + 700
    expect(routeLengthM(r, 600)).toBeCloseTo(Math.round(mm * 1.1) / 1000, 1)
  })
})

describe("the route cache", () => {
  const counting = () => {
    const router = vi.fn(routeCable)
    return { router, cache: new CableRouteCache(router) }
  }
  const cps = [
    cable("c1", "r1", "r2", ["t1"]),
    cable("c2", "r2", "r3", ["t1", "t2"]),
  ]

  it("routes nothing again for the same plan contents", () => {
    const { router, cache } = counting()
    const first = cache.routes(cps, ctx)
    expect(router).toHaveBeenCalledTimes(2)
    // A pan re-renders the canvas: the same inputs, rebuilt arrays.
    const again = cache.routes([...cps], { ...ctx, tiles: [...tiles] })
    expect(router).toHaveBeenCalledTimes(2)
    expect(again.get("c1")).toBe(first.get("c1"))
  })

  it("routes again only the cables a moved tile or tray touches", () => {
    const { router, cache } = counting()
    cache.routes(cps, ctx)
    const moved = [tiles[0], tiles[1], tile("r3", 11, 8)]
    cache.routes(cps, { ...ctx, tiles: moved })
    expect(router).toHaveBeenCalledTimes(3) // c2 only
    const t2b = tray("t2", [
      [12, 2],
      [12, 10],
    ])
    cache.routes(cps, { ...ctx, tiles: moved, trays: [t1, t2b] })
    expect(router).toHaveBeenCalledTimes(4) // c2 again: it rides t2
  })

  it("routes again when a tray's elevation changes", () => {
    const { router, cache } = counting()
    cache.routes(cps, ctx)
    cache.routes(cps, { ...ctx, ceilingMm: 3600 })
    expect(router).toHaveBeenCalledTimes(4)
  })
})

describe("lanes", () => {
  const cps = [
    cable("b", "r1", "r3", ["t1", "t2"]),
    cable("a", "r1", "r3", ["t1", "t2"]),
    cable("c", "r1", "r2", ["t1"]),
  ]
  const routes = routesOf(cps)
  const layout = layoutCables(routes, laneOrder(cps, routes))

  it("orders lanes by label everywhere", () => {
    expect(layout.order).toEqual(["a", "b", "c"])
    const g = layout.groups.get("t:t1:0")!
    expect(g.members).toEqual(["a", "b", "c"])
    expect(layout.groups.get("t:t2:0")!.members).toEqual(["a", "b"])
  })

  it("spreads a shared tray segment into parallel lanes inside the tray", () => {
    const off = (id: string, group: string) =>
      layout.cables.get(id)!.find((s) => s.group === group)!.offset
    const [a, b, c] = ["a", "b", "c"].map((id) => off(id, "t:t1:0"))
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    expect(b).toBeCloseTo(0)
    // Within the tray's 10 px channel (cells).
    expect(Math.abs(a)).toBeLessThanOrEqual(0.125)
    // On the next segment the two left keep their order.
    expect(off("a", "t:t2:0")).toBeLessThan(off("b", "t:t2:0"))
  })

  it("joins lanes at a turn where they cross, with no diagonal", () => {
    const lines = lanePolylines(layout.cables.get("a")!)
    expect(lines).toHaveLength(1)
    const pts = lines[0]
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i][0] - pts[i + 1][0])
      const dy = Math.abs(pts[i][1] - pts[i + 1][1])
      expect(Math.min(dx, dy)).toBeLessThan(1e-6)
    }
    const segs = laneSegments(layout.cables.get("a")!)
    for (let i = 0; i < segs.length - 1; i++)
      expect(segs[i].b).toEqual(segs[i + 1].a)
  })

  it("shares one route between cables of the same two tiles, either way", () => {
    const pair = [cable("x", "r1", "r3"), cable("y", "r3", "r1")]
    const rs = routesOf(pair)
    const keys = (id: string) =>
      rs
        .get(id)!
        .segs.map((s) => s.group)
        .sort()
    expect(keys("x")).toEqual(keys("y"))
    expect(hasSharedRuns(rs)).toBe(true)
  })

  it("leaves out the stretches a bundle draws", () => {
    const skip = (s: { group: string | null }) => s.group === "t:t1:0"
    const pieces = lanePolylines(layout.cables.get("a")!, skip)
    // The hop to the tray, then the run down the second tray.
    expect(pieces).toHaveLength(2)
  })
})

describe("bundles and level of detail", () => {
  const cps = [
    cable("a", "r1", "r2", ["t1"]),
    cable("b", "r1", "r2", ["t1"]),
    cable("c", "r1", "r3"),
  ]
  const routes = routesOf(cps)
  const layout = layoutCables(routes, laneOrder(cps, routes))

  it("switches detail by the size of a cell on screen", () => {
    expect(cableLod(10)).toBe("far")
    expect(cableLod(30)).toBe("mid")
    expect(cableLod(60)).toBe("near")
    expect(paperLod(3)).toBe("mid") // 1:200 on A3
    expect(paperLod(12)).toBe("near")
  })

  it("bundles every shared stretch below near detail", () => {
    const b = bundledGroups(layout, {
      lod: "mid",
      bundle: true,
      minGapCells: 0,
    })
    expect([...b]).toEqual(["t:t1:0"])
  })

  it("draws lanes up close where they are far enough apart", () => {
    const g = layout.groups.get("t:t1:0")!
    expect(
      bundledGroups(layout, {
        lod: "near",
        bundle: true,
        minGapCells: g.gap / 2,
      }).size
    ).toBe(0)
    expect(
      bundledGroups(layout, {
        lod: "near",
        bundle: true,
        minGapCells: g.gap * 2,
      }).size
    ).toBe(1)
  })

  it("never bundles with bundling off, or a bundle fanned out", () => {
    expect(
      bundledGroups(layout, { lod: "mid", bundle: false, minGapCells: 1 }).size
    ).toBe(0)
    expect(
      bundledGroups(layout, {
        lod: "mid",
        bundle: true,
        minGapCells: 1,
        fanned: new Set(["t:t1:0"]),
      }).size
    ).toBe(0)
  })
})

describe("colour and style from data", () => {
  const active = {
    id: "s1",
    name: "Active",
    color: "22c55e",
    text_color: "#000",
    is_planned: false,
  }
  const planned = { ...active, id: "s2", name: "Planned", is_planned: true }
  const cps = [
    cable("a", "r1", "r2", [], {
      status: active,
      type: "cat6",
      type_display: "Cat6",
      color: "#ff0000",
    }),
    cable("b", "r1", "r2", [], {
      status: planned,
      type: "smf",
      type_display: "Singlemode fiber",
    }),
    cable("c", "r1", "r2", [], {
      type: "smf",
      type_display: "Singlemode fiber",
    }),
  ]

  it("colours by status, jacket and type - never by name", () => {
    const pal = typePalette(cps)
    expect(cableColor(cps[0], "status", pal)).toBe("#22c55e")
    expect(cableColor(cps[2], "status", pal)).toBeNull()
    expect(cableColor(cps[0], "jacket", pal)).toBe("#ff0000")
    expect(cableColor(cps[1], "jacket", pal)).toBeNull()
    // The most common type takes the palette's first hue.
    expect([...pal.keys()]).toEqual(["smf", "cat6"])
    expect(cableColor(cps[1], "type", pal)).toBe(pal.get("smf"))
  })

  it("styles a planned status planned, a stored path documented, else inferred", () => {
    expect(cableRouteState(cps[1])).toBe("planned")
    expect(cableRouteState(cps[0])).toBe("inferred")
    expect(cableRouteState(cps[0], { stale: false })).toBe("documented")
    expect(cableRouteState(cps[0], { stale: true })).toBe("stale")
  })

  it("keys the colours and the styles in use", () => {
    const pal = typePalette(cps)
    const byType = cableLegend(cps, "type", pal, { bundles: true })
    expect(byType.colors.map((c) => c.label)).toEqual([
      "Singlemode fiber",
      "Cat6",
    ])
    expect(byType.states).toEqual(["planned", "inferred"])
    const byStatus = cableLegend(cps, "status", pal)
    expect(byStatus.colors.map((c) => c.label)).toEqual([
      "Active",
      "Planned",
      "No status",
    ])
    const pdf = cableLegendEntries(byType)
    expect(pdf.items.at(-1)).toEqual({
      label: "Bundle",
      color: "#71717a",
      line: "bundle",
    })
    expect(pdf.items.find((i) => i.label === "Planned")?.line).toBe("dashed")
  })
})

describe("ends and lengths", () => {
  it("names an end Hidden when its device is not the reader's to see", () => {
    expect(endText([{ device: null, port: null, hidden: true }])).toBe("Hidden")
    expect(
      endText([
        { device: "d1", port: "eth1", device_name: "sw1" },
        { device: "d2", port: "eth2", device_name: "sw2" },
      ])
    ).toBe("sw1 · eth1 +1")
    expect(endText([])).toBe("-")
  })

  it("reads a stored length in metres", () => {
    const c = cable("a", "r1", "r2", [], { length: 250, length_unit: "cm" })
    expect(storedLengthM(c)).toBeCloseTo(2.5)
    expect(storedLengthM(cable("b", "r1", "r2"))).toBeNull()
  })
})
