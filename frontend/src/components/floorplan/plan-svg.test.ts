// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
} from "@/lib/api"

import { CableRouteCache } from "./cable-draw"
import { PAPER_INK, planPaperScale, planSvg } from "./plan-svg"
import type { PlanSvgCables } from "./plan-svg"

// The plan as the PDF export posts it: plan pixels, light colours written
// out (no theme classes, no currentColor), and only what the PDF sanitiser
// keeps - attributes, never style=.

const tile = (patch: Partial<FloorPlanTile>): FloorPlanTile =>
  ({
    id: "t1",
    x: 2,
    y: 1,
    width: 1,
    height: 2,
    orientation: 0,
    label: "",
    color: "",
    status: "",
    linked: null,
    tile_type: {
      id: "tt",
      name: "Rack",
      color: "#2563eb",
      is_zone: false,
    },
    role_type: null,
    ...patch,
  }) as FloorPlanTile

const plan = { grid_width: 24, grid_height: 16, cell_mm: 600 }

const parse = (svg: string) =>
  new DOMParser().parseFromString(svg, "image/svg+xml").documentElement

describe("planSvg", () => {
  it("is the grid in plan pixels with tiles, labels and zones", () => {
    const root = parse(
      planSvg({
        plan,
        tiles: [
          tile({ label: "R01 <core>", width: 3 }),
          tile({
            id: "z",
            x: 0,
            y: 0,
            width: 6,
            height: 4,
            label: "Cold aisle",
            tile_type: {
              id: "zt",
              name: "Zone",
              color: "#0ea5e9",
              is_zone: true,
            } as FloorPlanTile["tile_type"],
          }),
        ],
      })
    )
    expect(root.getAttribute("viewBox")).toBe("0 0 960 640")
    const texts = Array.from(root.querySelectorAll("text")).map(
      (t) => t.textContent
    )
    expect(texts).toContain("R01 <core>")
    expect(texts).toContain("Cold aisle")
    // The zone is drawn first, under the tile.
    const groups = Array.from(root.children)
    expect(groups[0].querySelector("text")!.textContent).toBe("Cold aisle")
    const rect = root.querySelector('g[transform="translate(80,40)"] rect')!
    expect(rect.getAttribute("fill")).toBe("#2563eb")
  })

  it("writes colours out: no theme classes, styles or currentColor", () => {
    const wall: FloorPlanWall = {
      id: "w",
      points: [
        [0, 0],
        [6, 0],
      ],
      openings: [],
      color: "",
      label: "",
      height_mm: 3000,
    } as unknown as FloorPlanWall
    const svg = planSvg({ plan, tiles: [tile({ label: "R1" })], walls: [wall] })
    expect(svg).not.toMatch(/class=|style=|currentColor|var\(/)
    expect(svg).toContain(`stroke="${PAPER_INK}"`)
  })

  it("leaves trays out when they are hidden", () => {
    const tray = {
      id: "tr",
      name: "Tray A",
      points: [
        [0, 0],
        [4, 0],
      ],
      color: "",
      cables: [],
    } as unknown as Parameters<typeof planSvg>[0]["trays"] extends
      (infer U)[] | undefined
      ? U
      : never
    expect(planSvg({ plan, tiles: [], trays: [tray] })).toContain("Tray A")
    expect(
      planSvg({ plan, tiles: [], trays: [tray], showTrays: false })
    ).not.toContain("Tray A")
  })

  it("draws rooms under the tiles and labels over them, in paper ink", () => {
    const svg = planSvg({
      plan,
      tiles: [tile({ label: "R1" })],
      shapes: [
        {
          kind: "label",
          id: "l1",
          text: "North side\nA-feed",
          x: 1,
          y: 1,
          width: null,
          height: null,
          rotation: 0,
          font_mm: 300,
          weight: "bold",
          align: "left",
          color: "blue",
          plate: true,
          z: 0,
          locked: false,
          created_at: "",
          updated_at: "",
        },
        {
          kind: "area",
          id: "a1",
          shape: "rect",
          x: 1,
          y: 1,
          width: 4,
          height: 3,
          rotation: 30,
          points: [],
          room: { id: "r1", name: "Room 210", code: "210", color: "#0ea5e9" },
          location: null,
          label: "",
          color: "",
          fill_opacity: 15,
          border: "dashed",
          show_name: true,
          z: 0,
          locked: false,
          created_at: "",
          updated_at: "",
        },
      ],
    })
    const order = ["Room 210", "R1", "North side"].map((s) => svg.indexOf(s))
    expect(order.every((i) => i > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const doc = parse(svg)
    const area = doc.querySelector('rect[stroke-dasharray="8 5"]')!
    expect(area.getAttribute("fill")).toBe("#0ea5e9")
    expect(area.parentElement!.getAttribute("transform")).toBe(
      "rotate(30,120,100)"
    )
    const lines = [...doc.querySelectorAll("text")].filter(
      (t) => t.getAttribute("fill") === "#2563eb"
    )
    expect(lines.map((t) => t.textContent)).toEqual(["North side", "A-feed"])
    // 300 mm on a 600 mm cell: half a cell of 40 px.
    expect(lines[0].getAttribute("font-size")).toBe("20")
    expect(svg).not.toContain("class=")
  })
})

describe("planSvg cables", () => {
  const rack = (id: string, x: number) =>
    tile({ id, x, y: 3, width: 1, height: 1 })
  const tiles = [rack("r1", 1), rack("r2", 9)]
  const tray = {
    id: "t1",
    name: "T1",
    kind: "",
    color: "",
    points: [
      [0, 2],
      [12, 2],
    ],
    level: "overhead",
    elevation_mm: null,
    cables: [],
    hidden_cable_count: 0,
  } as unknown as FloorPlanTray
  const planned = {
    id: "s1",
    name: "Planned",
    color: "f59e0b",
    text_color: "#000",
    is_planned: true,
  }
  const cable = (id: string, patch: Partial<FloorPlanCablePath> = {}) =>
    ({
      id,
      label: `C-${id}`,
      color: "",
      type: "",
      a_tiles: ["r1"],
      b_tiles: ["r2"],
      a_points: [],
      b_points: [],
      tray_ids: ["t1"],
      ...patch,
    }) as FloorPlanCablePath
  const paths = [cable("1"), cable("2"), cable("3", { status: planned })]
  const routes = new CableRouteCache().routes(paths, {
    trays: [tray],
    tiles,
    ceilingMm: 3000,
  })
  const draw = (mmPerPx: number, patch: Partial<PlanSvgCables> = {}) =>
    parse(
      planSvg({
        plan,
        tiles,
        trays: [tray],
        cables: {
          paths,
          routes,
          colorBy: "status",
          bundle: true,
          labels: true,
          mmPerPx,
          ...patch,
        },
      })
    ).querySelector("[data-layer=cables]")!

  it("fits the plan to the paper as the server does", () => {
    // A3 landscape: 400 × 251 mm for a 960 × 640 px plan.
    expect(planPaperScale(plan)).toBeCloseTo(251 / 640, 6)
    expect(
      planPaperScale(plan, { size: "a4", orientation: "portrait" })
    ).toBeCloseTo(190 / 960, 6)
  })

  it("bundles the shared tray with its count at a small paper scale", () => {
    const g = draw(0.05) // 2 mm a cell: about 1:300
    const texts = [...g.querySelectorAll("text")].map((t) => t.textContent)
    expect(texts).toContain("3")
    expect(texts).not.toContain("C-1")
  })

  it("draws lanes, labels and the planned dash up close", () => {
    const g = draw(0.5) // 20 mm a cell
    const texts = [...g.querySelectorAll("text")].map((t) => t.textContent)
    expect(texts).not.toContain("3")
    expect(texts).toContain("C-1")
    const dashed = [...g.querySelectorAll("path")].filter((p) =>
      p.getAttribute("stroke-dasharray")
    )
    expect(dashed.length).toBeGreaterThan(0)
    expect(dashed[0].getAttribute("stroke")).toBe("#f59e0b")
    // No status: the paper's muted ink, never a theme variable.
    expect(g.innerHTML).toContain("#71717a")
    expect(g.innerHTML).not.toContain("var(")
  })

  it("draws a traced run as a heavier stroke, nothing animated", () => {
    const plain = draw(0.5)
    const traced = draw(0.5, { highlight: ["1"] })
    const widest = (g: Element) =>
      Math.max(
        ...[...g.querySelectorAll("path")].map((p) =>
          Number(p.getAttribute("stroke-width"))
        )
      )
    expect(widest(traced)).toBeGreaterThan(widest(plain))
    expect(traced.querySelector("animate")).toBeNull()
  })

  it("leaves the cables out when the links are off", () => {
    const svg = planSvg({ plan, tiles, trays: [tray] })
    expect(svg).not.toContain('data-layer="cables"')
  })
})
