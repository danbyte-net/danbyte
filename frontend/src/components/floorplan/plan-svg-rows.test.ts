// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { planSvg } from "./plan-svg"
import type { AreaShape } from "./shapes"

// The export names rows as the canvas does (Callouts: Auto): a turned row
// of racks whose names will not fit in them gets one name along it - never
// "DH1…" cut short in every rack - and from afar a room's rows sum up on
// the room.

const rack = (id: string, x: number, y: number, orientation = 28) =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 2,
    orientation,
    label: "",
    color: "#6366f1",
    status: "",
    linked: { kind: "rack", id: `o-${id}`, name: id, route: "/r" },
    tile_type: null,
    role_type: null,
  }) as unknown as FloorPlanTile

/** `rows` rows of 12 racks turned 28°, 4.5 cells apart. */
function hall(rows: number, x0 = 10, y0 = 10) {
  const r = (28 * Math.PI) / 180
  const tiles: FloorPlanTile[] = []
  for (let k = 0; k < rows; k++)
    for (let i = 0; i < 12; i++) {
      const name = `DH1-${String.fromCharCode(65 + k)}${String(i + 1).padStart(2, "0")}`
      tiles.push(
        rack(
          name,
          x0 + Math.cos(r) * i - Math.sin(r) * k * 4.5,
          y0 + Math.sin(r) * i + Math.cos(r) * k * 4.5
        )
      )
    }
  return tiles
}

const room = {
  kind: "area",
  id: "dh1",
  label: "Data Hall 1",
  shape: "rect",
  x: 0,
  y: 0,
  width: 40,
  height: 50,
  rotation: 0,
  points: [],
  show_name: true,
  room: null,
  location: null,
  area_type: null,
} as unknown as AreaShape

const parse = (svg: string) =>
  new DOMParser().parseFromString(svg, "image/svg+xml").documentElement

const plan = {
  grid_width: 60,
  grid_height: 60,
  cell_mm: 600,
  layout_mode: "free" as const,
}

describe("rows on paper", () => {
  it("names a turned row along it, not cut short in each rack", () => {
    const tiles = hall(3)
    // A close-up: racks drawn, their names too long to sit in them.
    const svg = planSvg({
      plan,
      tiles,
      shapes: [room],
      mmPerPx: 0.1,
      callouts: true,
    })
    const root = parse(svg)
    const rows = [...root.querySelectorAll("[data-row-name]")].map(
      (g) => g.textContent
    )
    expect(rows).toEqual(
      expect.arrayContaining([
        "Row A · A01–A12",
        "Row B · B01–B12",
        "Row C · C01–C12",
      ])
    )
    expect(svg).not.toContain("DH1…")
    expect(svg).not.toMatch(/>DH1-A0\d</)
    // Along the row, at its angle.
    expect(
      root.querySelector("[data-row-name]")!.getAttribute("transform")
    ).toMatch(/rotate\(28\)/)
    // Without callouts the names stay in their tiles, as before.
    expect(
      planSvg({ plan, tiles, shapes: [room], mmPerPx: 0.1 })
    ).not.toContain("data-row-name")
  })

  it("draws rows from afar as bars, and a hall as one summary", () => {
    const tiles = hall(6)
    // Icons on paper: a bar per row.
    const near = parse(
      planSvg({
        plan,
        tiles,
        shapes: [room],
        mmPerPx: 0.07,
        iconTiles: true,
        callouts: true,
      })
    )
    expect(near.querySelectorAll("[data-row-symbol]").length).toBe(6)
    expect(near.querySelectorAll("[data-icon-cluster]").length).toBe(0)
    // Further out: the hall's summary on it, the room's own name gone.
    const far = planSvg({
      plan,
      tiles,
      shapes: [room],
      mmPerPx: 0.02,
      iconTiles: true,
      callouts: true,
    })
    const root = parse(far)
    expect(root.querySelectorAll("[data-hall-symbol]").length).toBe(1)
    expect(root.querySelector("[data-hall-symbol]")!.textContent).toBe(
      "Data Hall 1 · 72 racks"
    )
    expect(root.querySelectorAll("[data-row-symbol]").length).toBe(0)
  })
})
