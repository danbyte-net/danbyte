// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { planSvg } from "./plan-svg"

// A free plan's export turns every tile kind - zones too - by what its angle
// has beyond its quarter turn, about its centre, exactly as the canvas does.

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
    tile_type: { id: "tt", name: "Rack", color: "#2563eb", is_zone: false },
    role_type: null,
    ...patch,
  }) as FloorPlanTile

const aisle = (patch: Partial<FloorPlanTile> = {}) =>
  tile({
    id: "z",
    x: 1.5,
    y: 2.25,
    width: 12,
    height: 2,
    orientation: 28,
    label: "Hot aisle",
    tile_type: {
      id: "zt",
      name: "Hot aisle",
      color: "#ef4444",
      is_zone: true,
    } as FloorPlanTile["tile_type"],
    ...patch,
  })

const parse = (svg: string) =>
  new DOMParser().parseFromString(svg, "image/svg+xml").documentElement

const base = { grid_width: 40, grid_height: 30, cell_mm: 600 }

describe("planSvg on a free plan", () => {
  it("turns a zone about its centre, as the canvas draws it", () => {
    const root = parse(
      planSvg({
        plan: { ...base, layout_mode: "free" },
        tiles: [aisle()],
      })
    )
    // Centre (7.5, 3.25) cells at 40 px a cell.
    const turned = root.querySelector('g[transform="rotate(28,300,130)"]')
    expect(turned).not.toBeNull()
    expect(
      turned!.querySelector('g[transform="translate(60,90)"] rect')
    ).not.toBeNull()
    expect(turned!.textContent).toContain("Hot aisle")
  })

  it("turns a zone and a rack by the same transform", () => {
    const svg = planSvg({
      plan: { ...base, layout_mode: "free" },
      tiles: [
        aisle({ x: 0, y: 0, width: 4, height: 2 }),
        tile({ id: "r", x: 1.5, y: 0.5, width: 1, height: 1, orientation: 28 }),
      ],
    })
    // Both stand centred on (2, 1) cells: one turn each, the same one.
    expect(svg.match(/transform="rotate\(28,80,40\)"/g)).toHaveLength(2)
  })

  it("leaves a grid plan's zones unturned", () => {
    const svg = planSvg({
      plan: base,
      tiles: [aisle({ orientation: 90 })],
    })
    expect(svg).not.toContain("rotate(")
  })
})
