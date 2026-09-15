import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"
import { readFloorHidden, tileHidden, visibleTiles } from "./hidden"

const tile = (over: Partial<FloorPlanTile>): FloorPlanTile =>
  ({
    id: "t",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    orientation: 0,
    label: "",
    color: "",
    status: "",
    tile_type: null,
    role_type: null,
    linked: null,
    ...over,
  }) as unknown as FloorPlanTile

const rack = tile({
  id: "r1",
  tile_type: { id: "tt-rack", name: "Rack", is_zone: false } as never,
})
const zone = tile({
  id: "z1",
  tile_type: { id: "tt-zone", name: "Zone", is_zone: true } as never,
})
const ap = tile({
  id: "d1",
  role_type: { id: "role-ap", name: "Access Point" } as never,
})

describe("floor plan hiding", () => {
  it("hides by tile type, by role type and by one tile", () => {
    const h = readFloorHidden({
      tileTypes: ["tt-rack"],
      roleTypes: [],
      tiles: ["d1"],
    })
    expect(tileHidden(rack, h)).toBe(true)
    expect(tileHidden(ap, h)).toBe(true)
    expect(tileHidden(zone, h)).toBe(false)
    expect(visibleTiles([rack, zone, ap], h).map((t) => t.id)).toEqual(["z1"])
  })

  it("never hides a zone, even by its type", () => {
    const h = readFloorHidden({ tileTypes: ["tt-zone"] })
    expect(tileHidden(zone, h)).toBe(false)
  })

  it("returns the same array when nothing is hidden", () => {
    const all = [rack, zone]
    expect(visibleTiles(all, readFloorHidden(undefined))).toBe(all)
  })
})
