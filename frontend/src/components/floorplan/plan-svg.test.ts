// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { FloorPlanTile, FloorPlanWall } from "@/lib/api"

import { PAPER_INK, planSvg } from "./plan-svg"

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
      | (infer U)[]
      | undefined
      ? U
      : never
    expect(planSvg({ plan, tiles: [], trays: [tray] })).toContain("Tray A")
    expect(
      planSvg({ plan, tiles: [], trays: [tray], showTrays: false })
    ).not.toContain("Tray A")
  })
})
