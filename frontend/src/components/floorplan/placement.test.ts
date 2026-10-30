import { describe, expect, it } from "vitest"

import type { FloorPlan, FloorPlanPlaceable, FloorPlanTile } from "@/lib/api"

import {
  asPhotos,
  droppedRect,
  linkedTile,
  nearScope,
  placedOnFloor,
  placedSize,
  placementRects,
  roomAreaAt,
  roomPrompts,
  withDraftPlacement,
} from "./placement"
import type { AreaShape } from "./shapes"
import { shownLink } from "./shown-link"
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

  it("never asks for a Hidden object", () => {
    const hidden = tile({
      id: "hidden",
      x: 1,
      y: 1,
      linked: { kind: "device", id: null, name: "Hidden", hidden: true },
    })
    expect(roomPrompts([hidden], [area()])).toEqual([])
  })
})

describe("a Hidden link", () => {
  const hidden = tile({
    id: "h",
    linked: { kind: "device", id: null, name: "Hidden", hidden: true },
  })

  it("is not placed on the floor", () => {
    expect([...placedOnFloor([hidden])]).toEqual([])
  })

  it("is not a link to open", () => {
    expect(shownLink(hidden.linked)).toBeNull()
    expect(shownLink(tile({}).linked)?.id).toBe("d1")
    expect(shownLink(null)).toBeNull()
  })
})

describe("on this floor, the draft included", () => {
  const photo = {
    url: "/m/a.png",
    aspect: 0.5,
    source: "type" as const,
    width_mm: null,
  }
  const tiles = [
    tile({ id: "t1" }),
    tile({ id: "new-1", linked: { ...tile({}).linked!, id: "d2" } }),
    tile({ id: "dup", x: 3 }),
    tile({ id: "plain", linked: null, photo }),
  ]

  it("maps each linked object to its first tile", () => {
    expect([...placedOnFloor(tiles)]).toEqual([
      ["device:d1", "t1"],
      ["device:d2", "new-1"],
    ])
  })

  it("rewrites a row's placement from the editor's tiles", () => {
    const p = { id: "p1", name: "Ground", stack: null }
    const saved = row({
      placed_count: 2,
      placed_on: [
        {
          floor_plan: { id: "p1", name: "Ground", stack: "" },
          tile_id: "t0",
          this_floor: true,
        },
        {
          floor_plan: { id: "p2", name: "1", stack: "" },
          tile_id: "t5",
          this_floor: false,
        },
      ],
    })
    // Deleted in the draft: only the other floor is left.
    const gone = withDraftPlacement(saved, new Map(), p)
    expect(gone.placed_count).toBe(1)
    expect(gone.placed_on.map((x) => x.this_floor)).toEqual([false])
    // Placed in the draft: on this floor, on the draft's tile.
    const here = withDraftPlacement(row({ id: "d2" }), placedOnFloor(tiles), p)
    expect(here.placed_count).toBe(1)
    expect(here.placed_on[0]).toMatchObject({
      tile_id: "new-1",
      this_floor: true,
    })
  })

  it("Photos draws a tile with a photo as it, leaving the rest", () => {
    const out = asPhotos(tiles)
    expect(out.map((t) => t.display)).toEqual(["icon", "icon", "icon", "photo"])
    expect(tiles[3].display).toBe("icon")
  })
})

describe("dropping an object already on the floor", () => {
  it("moves its tile to the cell under the drop on a grid, keeping its size", () => {
    const t = tile({ width: 2, height: 1 })
    expect(droppedRect(t, [5.5, 3.5], grid, [t])).toEqual({ x: 4, y: 3 })
    const other = tile({ id: "o", x: 2, y: 2 })
    expect(droppedRect(t, [2.5, 2.5], grid, [t, other])).toBeNull()
  })

  it("centres it on the drop on a free plan", () => {
    const t = tile({ width: 1, height: 0.5 })
    expect(droppedRect(t, [3, 2], free, [t])).toEqual({ x: 2.5, y: 1.75 })
  })
})
