import { describe, expect, it } from "vitest"

import type { FloorPlan, FloorPlanPlaceable, FloorPlanTile } from "@/lib/api"

import {
  linkedTile,
  nearScope,
  placedSize,
  placementRects,
  roomAreaAt,
  roomPrompts,
} from "./placement"
import type { AreaShape } from "./shapes"
import { tileFill, tileRoleIcon } from "./tile-paint"

const grid = {
  layout_mode: "grid",
  cell_mm: 600,
  grid_width: 6,
  grid_height: 4,
} as Pick<FloorPlan, "layout_mode" | "cell_mm" | "grid_width" | "grid_height">
const free = { ...grid, layout_mode: "free" } as typeof grid

const room210 = { id: "r210", name: "Room 210", code: "210", color: "#22c55e" }
const lab = { id: "lab", name: "Lab", code: "", color: "#f97316" }

const row = (patch: Partial<FloorPlanPlaceable> = {}): FloorPlanPlaceable => ({
  kind: "device",
  id: "d1",
  name: "sw1",
  rank: 1,
  room: null,
  location: null,
  status: null,
  role: { id: "role1", name: "Access", color: "#0ea5e9", icon: "router" },
  photo: null,
  placed_count: 0,
  placed_on: [],
  ...patch,
})

const area = (patch: Partial<AreaShape> = {}): AreaShape => ({
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 0,
  y: 0,
  width: 3,
  height: 3,
  rotation: 0,
  points: [],
  room: room210,
  location: null,
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
  ...patch,
})

const tile = (patch: Partial<FloorPlanTile>): FloorPlanTile => ({
  ...linkedTile(row(), { x: 0, y: 0, width: 1, height: 1 }, "t1", "icon"),
  ...patch,
})

describe("near", () => {
  const shapes = [
    area(),
    area({ id: "a2", x: 3, room: lab }),
    area({
      id: "loc",
      x: 0,
      y: 3,
      height: 1,
      width: 6,
      room: null,
      location: { id: "l1", name: "Hall", color: "" },
    }),
  ]
  it("is the room under the pointer first", () => {
    expect(nearScope(shapes, [4, 1], [1, 1])?.room?.id).toBe("lab")
  })
  it("falls back to the middle of the view", () => {
    expect(nearScope(shapes, null, [1, 1])?.room?.id).toBe("r210")
    expect(nearScope(shapes, [10, 10], [1, 1])?.room?.id).toBe("r210")
  })
  it("names a location area's location", () => {
    expect(nearScope(shapes, [1, 3.5], null)).toEqual({
      room: null,
      location: { id: "l1", name: "Hall", color: "" },
    })
  })
  it("is none away from every area", () => {
    expect(nearScope(shapes, [10, 10], null)).toBeNull()
  })
  it("takes the topmost room", () => {
    const nested = [
      area({ z: 0 }),
      area({ id: "inner", z: 2, room: lab, width: 1, height: 1 }),
    ]
    expect(roomAreaAt(nested, [0.5, 0.5])?.id).toBe("inner")
    expect(roomAreaAt(nested, [2, 2])?.id).toBe("a1")
  })
})

describe("where placed objects go", () => {
  it("takes the cell under the drop on a grid plan", () => {
    const [r] = placementRects([row()], [2.7, 1.2], grid, [])
    expect(r).toMatchObject({
      x: 2,
      y: 1,
      width: 1,
      height: 1,
      display: "icon",
    })
  })

  it("never lands on a tile, and several follow along the row", () => {
    const taken = [tile({ id: "x", x: 2, y: 1 })]
    const rects = placementRects(
      [row(), row({ id: "d2" }), row({ id: "d3" })],
      [2.5, 1.5],
      grid,
      taken
    )
    expect(rects.map((r) => [r.x, r.y])).toEqual([
      [3, 1],
      [4, 1],
      [5, 1],
    ])
  })

  it("wraps to the next row at the edge", () => {
    const rects = placementRects(
      [row(), row({ id: "d2" })],
      [5.5, 0.5],
      grid,
      []
    )
    expect(rects.map((r) => [r.x, r.y])).toEqual([
      [5, 0],
      [0, 1],
    ])
  })

  it("is exact on a free plan, side by side", () => {
    const rects = placementRects([row(), row({ id: "d2" })], [2.3, 1.7], free, [
      tile({ x: 1.5, y: 1.2 }),
    ])
    expect(rects[0]).toMatchObject({ x: 1.8, y: 1.2, width: 1, height: 1 })
    expect(rects[1]).toMatchObject({ x: 3.05, y: 1.2 })
  })

  it("places a photo at the device's true width with its aspect, free only", () => {
    const withPhoto = row({
      photo: { url: "/m/a.png", aspect: 0.25, source: "type", width_mm: 480 },
    })
    expect(placedSize(withPhoto, free)).toEqual({
      width: 0.8,
      height: 0.2,
      display: "photo",
    })
    expect(placedSize(withPhoto, grid).display).toBe("icon")
  })
})

describe("a placed object's tile", () => {
  it("has no type and draws in its role's colour and icon", () => {
    const t = linkedTile(
      row(),
      { x: 1, y: 1, width: 1, height: 1 },
      "t9",
      "icon"
    )
    expect(t.tile_type).toBeNull()
    expect(t.role_type).toBeNull()
    expect(t.linked).toMatchObject({
      kind: "device",
      id: "d1",
      route: "/devices/d1",
    })
    expect(tileFill(t)).toBe("#0ea5e9")
    expect(tileRoleIcon(t)).toBe("router")
  })

  it("keeps a type's colour when it has one", () => {
    const t = tile({
      tile_type: {
        id: "tt",
        name: "Box",
        slug: "box",
        color: "#111111",
        icon: "box",
        default_width: 1,
        default_height: 1,
        is_zone: false,
        has_fov: false,
      },
    })
    expect(tileFill(t)).toBe("#111111")
    expect(tileRoleIcon(t)).toBe("")
  })
})

describe("the room prompt", () => {
  it("asks only for objects in another room's area", () => {
    const placed = [
      tile({ id: "in-other", x: 1, y: 1 }),
      tile({
        id: "same",
        x: 0,
        y: 0,
        linked: { ...tile({}).linked!, id: "d2", name: "sw2", room: room210 },
      }),
      tile({
        id: "outside",
        x: 5,
        y: 3,
        linked: { ...tile({}).linked!, id: "d3", name: "sw3" },
      }),
    ]
    const prompts = roomPrompts(placed, [area()])
    expect(prompts).toEqual([
      { room: room210, objects: [{ kind: "device", id: "d1", name: "sw1" }] },
    ])
  })

  it("is nothing when there are no room areas", () => {
    expect(roomPrompts([tile({})], [])).toEqual([])
  })
})
