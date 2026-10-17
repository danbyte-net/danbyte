import { describe, expect, it } from "vitest"

import {
  clampSelectionDelta,
  moveSelection,
  rotateSelection,
  searchTiles,
} from "./selection"
import type { GridTile } from "./selection"

// A selection of tiles worked as one piece - inside the grid, never onto a
// tile outside it, zones exempt - and finding a tile on the plan.

const grid = { grid_width: 10, grid_height: 8 }
const tile = (
  id: string,
  x: number,
  y: number,
  width = 1,
  height = 2,
  extra: Partial<GridTile> = {}
): GridTile => ({ id, x, y, width, height, orientation: 0, ...extra })

describe("moveSelection", () => {
  const tiles = [tile("a", 1, 1), tile("b", 2, 1), tile("c", 5, 1)]
  const sel = new Set(["a", "b"])

  it("moves every selected tile by the same cells", () => {
    const p = moveSelection(tiles, sel, 1, 2, grid)!
    expect(p.get("a")).toMatchObject({ x: 2, y: 3 })
    expect(p.get("b")).toMatchObject({ x: 3, y: 3 })
    expect(p.has("c")).toBe(false)
  })

  it("refuses the grid's edge and a tile outside the selection", () => {
    expect(moveSelection(tiles, sel, -2, 0, grid)).toBeNull()
    expect(moveSelection(tiles, sel, 0, 6, grid)).toBeNull()
    // b would land on c.
    expect(moveSelection(tiles, sel, 3, 0, grid)).toBeNull()
    // Sliding over a fellow selected tile is fine.
    expect(moveSelection(tiles, sel, 1, 0, grid)).not.toBeNull()
  })

  it("zones are covered freely", () => {
    const zone = tile("z", 0, 4, 10, 4, { tile_type: { is_zone: true } })
    expect(moveSelection([...tiles, zone], sel, 0, 3, grid)).not.toBeNull()
  })

  it("clamps a drag at the grid's edge", () => {
    expect(clampSelectionDelta(tiles, sel, -5, 20, grid)).toEqual({
      dx: -1,
      dy: 5,
    })
  })
})

describe("rotateSelection", () => {
  it("turns the piece a quarter about its middle, facing and all", () => {
    // Two 1x2 racks side by side: a 2x2 block turns into itself, the racks
    // lying down and facing right.
    const tiles = [tile("a", 3, 3), tile("b", 4, 3)]
    const p = rotateSelection(tiles, new Set(["a", "b"]), grid)!
    expect(p.get("a")).toEqual({
      x: 3,
      y: 3,
      width: 2,
      height: 1,
      orientation: 90,
    })
    expect(p.get("b")).toEqual({
      x: 3,
      y: 4,
      width: 2,
      height: 1,
      orientation: 90,
    })
  })

  it("a row becomes a column, centred where it was", () => {
    const tiles = [0, 1, 2, 3].map((i) => tile(`r${i}`, 2 + i, 2, 1, 1))
    const p = rotateSelection(tiles, new Set(tiles.map((t) => t.id)), grid)!
    const xs = new Set([...p.values()].map((v) => v.x))
    const ys = [...p.values()].map((v) => v.y).sort()
    expect(xs.size).toBe(1)
    expect(ys).toEqual([1, 2, 3, 4])
  })

  it("is refused when the turned piece would hit a neighbour or the edge", () => {
    const row = [0, 1, 2, 3].map((i) => tile(`r${i}`, 2 + i, 2, 1, 1))
    const ids = new Set(row.map((t) => t.id))
    expect(
      rotateSelection([...row, tile("n", 4, 4, 1, 1)], ids, grid)
    ).toBeNull()
    const top = [0, 1, 2, 3].map((i) => tile(`t${i}`, 2 + i, 0, 1, 1))
    expect(rotateSelection(top, new Set(top.map((t) => t.id)), grid)).toBeNull()
  })
})

describe("searchTiles", () => {
  const tiles = [
    {
      id: "1",
      label: "",
      linked: { kind: "rack", name: "R12 core" },
      tile_type: { name: "Rack" },
    },
    {
      id: "2",
      label: "Cold aisle A",
      linked: null,
      tile_type: { name: "Zone" },
    },
    {
      id: "3",
      label: "",
      linked: { kind: "device", name: "fw-01" },
      role_type: { name: "Firewall" },
    },
    { id: "4", label: "Rack spare", linked: null, tile_type: { name: "Rack" } },
  ]

  it("finds by label, linked rack or device, and type; best first", () => {
    expect(searchTiles(tiles, "fw").map((h) => h.tile.id)).toEqual(["3"])
    expect(searchTiles(tiles, "core r12").map((h) => h.tile.id)).toEqual(["1"])
    expect(searchTiles(tiles, "FIREWALL")).toEqual([
      { tile: tiles[2], byType: true },
    ])
    // The label "Rack spare" ranks over tiles that are only of type Rack.
    expect(searchTiles(tiles, "rack").map((h) => h.tile.id)).toEqual(["4", "1"])
  })

  it("nothing for an empty query, and a cap", () => {
    expect(searchTiles(tiles, "  ")).toEqual([])
    expect(searchTiles(tiles, "a", 2)).toHaveLength(2)
  })
})
