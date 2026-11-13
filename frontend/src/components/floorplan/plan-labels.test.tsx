// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import {
  CableRouteCache,
  bundledGroups,
  laneOrder,
  layoutCables,
} from "./cable-draw"
import { CableLayer } from "./cable-layer"
import type { Pt } from "./cable-route"
import { layoutPlanLabels, preferInside } from "./plan-label-pass"
import type { PlanLabelInput } from "./plan-label-pass"
import {
  Occupancy,
  alongSlots,
  boxesHit,
  endChipSpots,
  insideWalls,
  placeLabels,
  polylineLegs,
  tileExit,
  uprightAngle,
} from "./plan-labels"
import { planSvg } from "./plan-svg"
import { readableShape } from "./readable"
import type { AreaShape, LabelShape } from "./shapes"

// The plan's one label pass: cable names along their runs like road names
// on a map - on the tray, upright, repeated along a long run, the focus
// always shown with its ends' ports beside the tiles - then the trays',
// the tiles', the areas' and the raised floors' texts, each moved or
// hidden where it would cover a higher ranked one; the export lays out the
// same at paper scale.

afterEach(cleanup)

const tile = (id: string, x: number, y: number, name = ""): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: name,
    color: "#2563eb",
    status: "",
    linked: name ? { kind: "rack", id: `r-${id}`, name, route: "/r" } : null,
  }) as unknown as FloorPlanTile

const tray = {
  id: "t1",
  name: "OH-A1",
  color: "",
  points: [
    [0, 2],
    [12, 2],
  ] as Pt[],
  level: "overhead",
  elevation_mm: null,
  cables: ["1"],
  hidden_cable_count: 0,
} as unknown as FloorPlanTray

const cable = (id: string, patch: Partial<FloorPlanCablePath> = {}) =>
  ({
    id,
    label: `FPT-C0${id}`,
    color: "",
    type: "cat6",
    type_display: "Cat6",
    a_tiles: ["r1"],
    b_tiles: ["r2"],
    a_points: [{ device: "d1", port: "ethernet1/1", device_name: "fw1" }],
    b_points: [{ device: "d2", port: "Gi1/0/1", device_name: "sw1" }],
    tray_ids: ["t1"],
    ...patch,
  }) as FloorPlanCablePath

const tiles = [tile("r1", 1, 3, "R-A01"), tile("r2", 9, 3, "R-A02")]

function input(
  paths: FloorPlanCablePath[],
  patch: Partial<PlanLabelInput> = {},
  cables: Partial<NonNullable<PlanLabelInput["cables"]>> = {},
  k = 1
): PlanLabelInput {
  const routes = new CableRouteCache().routes(paths, {
    trays: [tray],
    tiles,
    ceilingMm: 3000,
  })
  const layout = layoutCables(routes, laneOrder(paths, routes))
  return {
    scale: 40 * k,
    unitsPerPx: k,
    font: 11,
    chipFont: 10,
    repeat: 280,
    gap: 4,
    tiles,
    trays: [tray],
    trayWidth: 10 * k,
    cellMm: 600,
    cables: {
      paths,
      routes,
      layout,
      bundled: new Set(),
      names: true,
      focus: new Set(),
      lengths: true,
      ends: true,
      ...cables,
    },
    ...patch,
  }
}

describe("along a line", () => {
  it("keeps text upright: never upside down, a vertical run read upwards", () => {
    expect(uprightAngle([0, 0], [1, 0])).toBe(0)
    expect(uprightAngle([1, 0], [0, 0])).toBe(0)
    expect(uprightAngle([0, 0], [0, 1])).toBe(-90)
    expect(uprightAngle([0, 1], [0, 0])).toBe(-90)
    expect(uprightAngle([0, 0], [-1, -1])).toBeCloseTo(45)
  })

  it("repeats a name along a long run, only where it is in view", () => {
    const legs = polylineLegs([
      [0, 0],
      [100, 0],
    ])
    const all = alongSlots(legs, { w: 60, h: 14 }, { scale: 40, repeat: 280 })
    // 4000 px of run: a name every ~280 px.
    expect(all.length).toBeGreaterThanOrEqual(13)
    const seen = alongSlots(
      legs,
      { w: 60, h: 14 },
      {
        scale: 40,
        repeat: 280,
        view: { x: 1000, y: -50, w: 600, h: 100 },
      }
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThan(5)
  })

  it("skips a stretch too short to hold the name", () => {
    const legs = polylineLegs([
      [0, 0],
      [1, 0],
    ])
    expect(
      alongSlots(legs, { w: 60, h: 14 }, { scale: 40, repeat: 280 })
    ).toEqual([])
  })
})

describe("placeLabels", () => {
  const box = (x: number) => ({ x, y: 0, w: 10, h: 10 })

  it("places the higher ranked first; the other moves on, or hides", () => {
    const got = placeLabels([
      { id: "low", priority: 1, spots: [{ box: box(0), data: "a" }] },
      {
        id: "mid",
        priority: 2,
        spots: [
          { box: box(5), data: "b" },
          { box: box(30), data: "c" },
        ],
      },
      { id: "high", priority: 3, spots: [{ box: box(0), data: "d" }] },
    ])
    expect(got.get("high")?.data).toBe("d")
    expect(got.get("mid")?.data).toBe("c")
    expect(got.has("low")).toBe(false)
  })

  it("always shows a forced one, and keeps clear of `avoid` when it can", () => {
    const occ = new Occupancy()
    occ.add(box(0))
    const got = placeLabels(
      [
        {
          id: "f",
          priority: 1,
          force: true,
          spots: [{ box: box(0), data: 1 }],
        },
        {
          id: "a",
          priority: 0,
          spots: [
            { box: box(40), data: 1 },
            { box: box(80), data: 2 },
          ],
          avoid: [box(40)],
        },
      ],
      occ
    )
    expect(got.has("f")).toBe(true)
    expect(got.get("a")?.data).toBe(2)
  })
})

describe("a cable's ends", () => {
  const rect = { x: 1, y: 3, w: 1, h: 1 }
  const run: Pt[] = [
    [1.5, 3.5],
    [1.5, 2],
    [9.5, 2],
  ]

  it("sits where the run leaves its tile, not mid-tile", () => {
    const e = tileExit(run, rect)
    expect(e.edge).toBe("top")
    expect(e.at[0]).toBeCloseTo(1.5)
    expect(e.at[1]).toBeCloseTo(3)
  })

  it("puts its chip outside the tile, beside the run", () => {
    const e = tileExit(run, rect)
    const spots = endChipSpots(e, rect, { w: 80, h: 16 }, 4, 40)
    const tileBox = { x: 40, y: 120, w: 40, h: 40 }
    for (const s of spots) {
      expect(boxesHit(s.box, tileBox)).toBe(false)
      expect(s.box.y + s.box.h).toBeLessThanOrEqual(120)
    }
  })
})

describe("layoutPlanLabels", () => {
  it("names a cable along its tray leg, not on a drop, with its length muted", () => {
    const got = layoutPlanLabels(input([cable("4")]))
    expect(got.cables.length).toBeGreaterThan(0)
    const l = got.cables[0]
    expect(l.text).toBe("FPT-C04")
    expect(l.suffix).toMatch(/^ · \d+\.\d m$/)
    // On the tray (y = 2), running along it.
    expect(l.at[1]).toBeCloseTo(2)
    expect(l.angle).toBe(0)
  })

  it("keeps the length off from afar and only the focus at far detail", () => {
    const off = layoutPlanLabels(input([cable("4")], {}, { lengths: false }))
    expect(off.cables[0].suffix).toBeUndefined()
    const far = layoutPlanLabels(
      input(
        [cable("4"), cable("5")],
        {},
        { focusOnly: true, focus: new Set(["5"]) }
      )
    )
    expect(new Set(far.cables.map((c) => c.id))).toEqual(new Set(["5"]))
  })

  it("never lets two cable names overlap; the focus always shows", () => {
    const paths = ["1", "2", "3", "4", "5", "6"].map((id) => cable(id))
    const got = layoutPlanLabels(
      input(paths, {}, { focus: new Set(["6"]) }, 0.5)
    )
    const boxes = got.cables.map((c) => ({
      x: c.at[0] * 20 - 30,
      y: c.at[1] * 20 - 7,
      w: 60,
      h: 14,
    }))
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(boxesHit(boxes[i], boxes[j])).toBe(false)
    expect(got.cables.some((c) => c.id === "6")).toBe(true)
    // Not every name fits on the short tray at this zoom: some hide.
    expect(new Set(got.cables.map((c) => c.id)).size).toBeLessThan(6)
  })

  it("names a bundle by its count along the tray", () => {
    const paths = [cable("1"), cable("2"), cable("3")]
    const base = input(paths)
    const bundled = bundledGroups(base.cables!.layout, {
      lod: "mid",
      bundle: true,
      minGapCells: 1,
    })
    const got = layoutPlanLabels(input(paths, {}, { bundled, names: false }))
    expect(got.bundles.map((b) => b.text)).toContain("3 cables")
  })

  it("gives the focus its ports, outside its tiles", () => {
    const got = layoutPlanLabels(
      input([cable("4")], {}, { focus: new Set(["4"]) })
    )
    expect(got.ends.map((e) => e.text).sort()).toEqual([
      "fw1 · ethernet1/1",
      "sw1 · Gi1/0/1",
    ])
    for (const e of got.ends)
      for (const t of tiles) {
        const inside =
          e.at[0] > t.x &&
          e.at[0] < t.x + 1 &&
          e.at[1] > t.y &&
          e.at[1] < t.y + 1
        expect(inside).toBe(false)
      }
  })

  it("names the tray along it, beside the channel", () => {
    const got = layoutPlanLabels(input([], {}, { names: false }))
    expect(got.trays[0].text).toBe("OH-A1 · 1")
    expect(got.trays[0].angle).toBe(0)
    expect(Math.abs(got.trays[0].at[1] - 2)).toBeGreaterThan(0.1)
  })

  it("ranks cables over tile names, keeps plan labels, hides what is covered", () => {
    // Readable from afar: the racks grow and their names are the pass's.
    const k = 0.15
    const shapeOf = (t: FloorPlanTile) => readableShape(t, 40 * k)
    // The grown R-A01 reaches y 5.83; a plan label right under it.
    const label = {
      kind: "label",
      id: "l1",
      text: "North side",
      x: -2,
      y: 5.9,
      width: 7,
      height: 3,
      rotation: 0,
      font_mm: 600,
      align: "center",
    } as unknown as LabelShape
    const got = layoutPlanLabels(
      input([cable("4")], { shapeOf, planLabels: [label] }, {}, k)
    )
    // R-A01's name gives way: not under its symbol, where the label is.
    expect(got.tileNamesHere.has("r1")).toBe(true)
    const r1 = got.tiles.find((t) => t.id === "r1")
    if (r1) expect(r1.at[1]).toBeLessThan(5.9)
    // R-A02's, with nothing in its way, hugs the bottom of its symbol.
    const r2 = got.tiles.find((t) => t.id === "r2")!
    expect(r2.at[1]).toBeGreaterThan(5.83)
    expect(r2.at[1]).toBeLessThan(5.83 + 20 / 6)
  })

  it("moves an area's name off the racks, hides a covered raised-floor caption", () => {
    const area = {
      kind: "area",
      id: "a1",
      shape: "rect",
      x: 0,
      y: 0,
      width: 12,
      height: 6,
      rotation: 0,
      label: "Server room A",
      show_name: true,
      points: [],
      fill_opacity: 10,
      border: "solid",
    } as unknown as AreaShape
    const rack = tile("rk", 0, 0)
    const got = layoutPlanLabels({
      ...input([], {}, { names: false }),
      tiles: [rack],
      trays: [],
      areas: [area],
      raised: [
        {
          id: "rf",
          box: { x: 0, y: 0, w: 12, h: 6 },
          text: "Raised floor · 600 mm",
          fontPx: 10,
        },
      ],
    })
    const at = got.areas.get("a1")
    expect(at).toBeTruthy()
    // Not on the rack in the top-left corner.
    expect(at![0] >= 1 || at![1] >= 1).toBe(true)
    expect(got.hiddenRaised.size).toBe(0)
  })

  it("starts an area's name inside the walls along its edges, at every zoom", () => {
    const area = {
      kind: "area",
      id: "a1",
      shape: "rect",
      x: 2,
      y: 2,
      width: 10,
      height: 6,
      rotation: 0,
      label: "Server room",
      show_name: true,
      points: [],
      fill_opacity: 10,
      border: "solid",
    } as unknown as AreaShape
    // A 300 mm wall round it, on its outline (cell 600 mm: 20 plan px, a
    // half of 0.25 cell), and an inner one a little inside its left edge.
    const ring: Pt[] = [
      [2, 2],
      [12, 2],
      [12, 8],
      [2, 8],
      [2, 2],
    ]
    const inner: Pt[] = [
      [2.25, 2],
      [2.25, 8],
    ]
    const walls = [
      { points: ring, thickness_mm: 300 },
      { points: inner, thickness_mm: 200 },
    ]
    for (const k of [0.5, 1, 3]) {
      const got = layoutPlanLabels({
        ...input([], {}, { names: false }, k),
        tiles: [],
        trays: [],
        areas: [area],
        walls,
        cellMm: 600,
      })
      const at = got.areas.get("a1")!
      expect(at).toBeTruthy()
      // Past the walls' inner faces (the top's 2.25, the inner wall's
      // 2.25 + 1/6), with the pad (6 plan px) on top.
      expect(at[1]).toBeGreaterThanOrEqual(2.25 + 6 / 40 - 1e-6)
      expect(at[0]).toBeGreaterThanOrEqual(2.25 + 1 / 6 + 6 / 40 - 1e-6)
    }
    // No walls: its corner, as before.
    const bare = layoutPlanLabels({
      ...input([], {}, { names: false }),
      tiles: [],
      trays: [],
      areas: [area],
      cellMm: 600,
    }).areas.get("a1")!
    expect(bare[0]).toBeCloseTo(2 + 6 / 40)
    expect(bare[1]).toBeCloseTo(2 + 6 / 40)
  })
})

describe("insideWalls", () => {
  it("takes off what the walls along each edge reach in, not a wall mid-room", () => {
    const r = insideWalls({ x: 0, y: 0, w: 10, h: 10 }, [
      // Top, centred on the edge.
      {
        points: [
          [0, 0],
          [10, 0],
        ],
        half: 0.25,
      },
      // Right, just outside it: only its inner half's overlap.
      {
        points: [
          [10.1, 0],
          [10.1, 10],
        ],
        half: 0.25,
      },
      // Across the middle: not an edge's.
      {
        points: [
          [0, 5],
          [10, 5],
        ],
        half: 0.5,
      },
      // Beyond the bottom edge's reach.
      {
        points: [
          [0, 11],
          [10, 11],
        ],
        half: 0.25,
      },
    ])
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(0.25)
    expect(r.w).toBeCloseTo(10 - 0.15)
    expect(r.h).toBeCloseTo(10 - 0.25)
  })
})

describe("Readable thin tiles", () => {
  it("grows a 1U switch's short side and draws it as its symbol", () => {
    const flat = {
      ...tile("sw", 0, 0),
      width: 2,
      height: 0.05,
    }
    const s = readableShape(flat, 40)
    expect(s.box.h * 40).toBeCloseTo(14)
    expect(s.symbol).toBe(true)
    // Centred on the tile.
    expect(s.box.y + s.box.h / 2).toBeCloseTo(0.025)
  })

  it("draws a photo too small to read as its symbol, the photo once it reads", () => {
    const photo = {
      ...tile("p", 0, 0),
      width: 1,
      height: 0.4,
      display: "photo",
      photo: { url: "/x.png" },
    } as unknown as FloorPlanTile
    expect(readableShape(photo, 40).symbol).toBe(true)
    expect(readableShape(photo, 200).symbol).toBe(false)
  })

  it("draws the symbol on paper too", () => {
    const flat = {
      ...tile("sw", 2, 2, "edge1"),
      width: 2,
      height: 0.05,
      tile_type: { id: "tt", name: "Switch", color: "#16a34a", is_zone: false },
    } as unknown as FloorPlanTile
    const svg = planSvg({
      plan: { grid_width: 24, grid_height: 16, cell_mm: 600 },
      tiles: [flat],
      objectSize: "readable",
      mmPerPx: 0.02,
    })
    expect(svg).toContain('data-symbol="sw"')
  })
})

describe("the canvas and the export", () => {
  it("dots a traced cable's ends where it leaves its tiles", () => {
    const paths = [cable("4")]
    const routes = new CableRouteCache().routes(paths, {
      trays: [tray],
      tiles,
      ceilingMm: 3000,
    })
    const { container } = render(
      <svg>
        <CableLayer
          cablePaths={paths}
          routes={routes}
          k={2}
          cellMm={600}
          colorBy="status"
          bundle
          showLabels
          highlightIds={["4"]}
          interactive
          onSelect={() => {}}
          onHover={() => {}}
          tiles={tiles}
        />
      </svg>
    )
    const dots = [...container.querySelectorAll("[data-lifted='4'] circle")]
    expect(dots.map((d) => +d.getAttribute("cy")!)).toEqual([120, 120])
    expect(dots.map((d) => +d.getAttribute("cx")!)).toEqual([60, 380])
  })

  it("lays the export's names out by the same pass, at paper scale", () => {
    const paths = [cable("4")]
    const routes = new CableRouteCache().routes(paths, {
      trays: [tray],
      tiles,
      ceilingMm: 3000,
    })
    const mmPerPx = 0.5
    const svg = planSvg({
      plan: { grid_width: 24, grid_height: 16, cell_mm: 600 },
      tiles,
      trays: [tray],
      cables: {
        paths,
        routes,
        colorBy: "status",
        bundle: true,
        labels: true,
        mmPerPx,
      },
    })
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
    const names = [
      ...doc.querySelectorAll("[data-layer=plan-labels] text"),
    ].filter((t) => t.getAttribute("fill") !== "#ffffff")
    const name = names.find((t) => t.textContent.startsWith("FPT-C04"))!
    expect(name).toBeTruthy()
    const layout = layoutCables(routes, laneOrder(paths, routes))
    const want = layoutPlanLabels({
      scale: 40 * mmPerPx,
      unitsPerPx: mmPerPx,
      font: 2,
      chipFont: 1.8,
      repeat: 70,
      gap: 0.6,
      tiles,
      trays: [tray],
      trayWidth: 10 * mmPerPx,
      areas: [],
      planLabels: [],
      cellMm: 600,
      cables: {
        paths,
        routes,
        layout,
        bundled: new Set(),
        names: true,
        focus: new Set(),
        lengths: true,
        ends: true,
      },
    })
    const first = want.cables[0]
    expect(name.getAttribute("transform")).toBe(
      `translate(${+(first.at[0] * 40).toFixed(2)},${+(first.at[1] * 40).toFixed(2)})`
    )
  })
})

describe("names by the plan's edge", () => {
  const spot = (x: number, y: number, id: string) => ({
    box: { x, y, w: 20, h: 10 },
    data: id,
  })
  const bounds = { x: 0, y: 0, w: 100, h: 100 }
  const view = { x: -50, y: -50, w: 200, h: 200 }

  it("go inside first, in their own order", () => {
    const out = preferInside(
      [spot(-15, 0, "out"), spot(10, 0, "in1"), spot(30, 0, "in2")],
      bounds,
      view
    )
    expect(out.map((s) => s.data)).toEqual(["in1", "in2", "out"])
  })

  it("never off-screen while a spot on screen exists", () => {
    const out = preferInside(
      [spot(-80, 0, "off"), spot(-15, 0, "out")],
      bounds,
      view
    )
    expect(out.map((s) => s.data)).toEqual(["out"])
  })

  it("only inside on paper", () => {
    const out = preferInside(
      [spot(-15, 0, "out"), spot(10, 0, "in")],
      bounds,
      null,
      true
    )
    expect(out.map((s) => s.data)).toEqual(["in"])
  })

  it("place an icon's name inside the plan where one fits", () => {
    // An icon by the left edge: its name never goes past it.
    const t = {
      id: "a",
      x: 0,
      y: 5,
      width: 1,
      height: 1,
      orientation: 0,
      tile_type: null,
      role_type: null,
      label: "",
      linked: { kind: "rack", id: "r", name: "R-A03", route: "/r" },
    } as never
    const scale = 10
    const box = { x: 0, y: 4.1, w: 2.8, h: 2.8 }
    const labels = layoutPlanLabels({
      scale,
      unitsPerPx: 0.25,
      font: 11,
      chipFont: 10,
      repeat: 400,
      gap: 4,
      bounds: { x: 0, y: 0, w: 200, h: 200 },
      tiles: [t],
      shapeOf: () => ({ box, grow: 2.8, changed: true, symbol: true }),
      iconIds: new Set(["a"]),
      cellMm: 600,
    })
    expect(labels.tiles.map((l) => l.id)).toEqual(["a"])
    expect(labels.taken.every((b) => b.x >= 0 && b.y >= 0)).toBe(true)
  })
})
