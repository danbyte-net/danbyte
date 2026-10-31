import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import type { CableStub } from "./cable-draw"
import {
  READABLE_SYMBOL_PX,
  clipName,
  fontGrow,
  growFactor,
  growStubs,
  grownBox,
  readObjectSize,
  readableHit,
  readableOrder,
  thinNames,
} from "./readable"

// Display > Object size: Readable grows what is too small on screen to a
// least size about its centre, names at a constant size thinned where they
// would overlap - the saved geometry never changes.

const tile = (
  id: string,
  x: number,
  y: number,
  patch: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 1,
    orientation: 0,
    label: id,
    linked: null,
    tile_type: null,
    role_type: null,
    ...patch,
  }) as unknown as FloorPlanTile

describe("Object size", () => {
  it("reads Real unless the plan stored Readable", () => {
    expect(readObjectSize(undefined)).toBe("real")
    expect(readObjectSize("weird")).toBe("real")
    expect(readObjectSize("readable")).toBe("readable")
  })
})

describe("growFactor", () => {
  it("grows a one-cell tile to the least size at a low zoom", () => {
    // 3.5 px a cell: a 512-cell plan fitted to a laptop.
    const g = growFactor(1, 1, 3.5)
    expect(g * 3.5).toBeCloseTo(READABLE_SYMBOL_PX)
  })

  it("leaves a tile alone once it is that big on screen", () => {
    expect(growFactor(1, 1, 28)).toBe(1)
    expect(growFactor(1, 1, 40)).toBe(1)
    // The longer side counts: a 4 x 1 row at 8 px a cell is 32 px.
    expect(growFactor(4, 1, 8)).toBe(1)
  })

  it("works in paper mm the same way", () => {
    // 0.02 mm per plan px: 0.8 mm a cell, grown to 5 mm.
    expect(growFactor(1, 1, 0.8, 5)).toBeCloseTo(6.25)
  })

  it("keeps the aspect, centred on the tile", () => {
    const b = grownBox(tile("a", 10, 20, { width: 2, height: 1 }), 4)
    expect(b).toEqual({ x: 7, y: 18.5, w: 8, h: 4 })
  })
})

describe("readableHit", () => {
  const a = tile("a", 10, 10)
  const b = tile("b", 30, 30)
  it("hits the grown symbol outside the real footprint", () => {
    // 4 px a cell: grown 7x, so 3 cells out of the centre still hits.
    expect(readableHit([a, b], 13.4, 10.5, 4)?.id).toBe("a")
    expect(readableHit([a, b], 14.5, 10.5, 4)).toBeNull()
  })

  it("is the real footprint once nothing grows", () => {
    expect(readableHit([a, b], 13.4, 10.5, 40)).toBeNull()
    expect(readableHit([a, b], 10.5, 10.5, 40)?.id).toBe("a")
  })

  it("prefers the last drawn where symbols overlap, and skips zones", () => {
    const c = tile("c", 11, 10)
    const zone = tile("z", 0, 0, {
      width: 50,
      height: 50,
      tile_type: { is_zone: true } as FloorPlanTile["tile_type"],
    })
    expect(readableHit([zone, a, c], 10.9, 10.5, 4)?.id).toBe("c")
    expect(readableHit([zone], 1, 1, 4)).toBeNull()
  })
})

describe("readableOrder", () => {
  it("draws the grown symbols over the rest, the selection last", () => {
    const big = tile("big", 0, 0, { width: 10, height: 10 })
    const s1 = tile("s1", 20, 0)
    const s2 = tile("s2", 22, 0)
    const order = readableOrder([s1, big, s2], 4, new Set(["s1"]))
    expect(order.map((t) => t.id)).toEqual(["big", "s2", "s1"])
    // Real: as given.
    expect(readableOrder([s1, big, s2], null).map((t) => t.id)).toEqual([
      "s1",
      "big",
      "s2",
    ])
  })
})

describe("growStubs", () => {
  it("moves a stub out to its grown tile's edge", () => {
    const t = tile("a", 10, 10)
    const stub: CableStub = {
      id: "c1",
      end: "A",
      tile: "a",
      from: [11, 10.5],
      dir: [1, 0],
      far: [],
    }
    const [grown] = growStubs([stub], [t], 4)
    // Grown 7x: the edge is 3.5 cells from the centre.
    expect(grown.from[0]).toBeCloseTo(14)
    expect(grown.from[1]).toBeCloseTo(10.5)
    // Zoomed in, the same array.
    const same = [stub]
    expect(growStubs(same, [t], 40)).toBe(same)
  })
})

describe("thinNames", () => {
  const box = (id: string, x: number, priority: number) => ({
    id,
    x,
    y: 0,
    w: 50,
    h: 14,
    priority,
  })

  it("hides the lower ranked of two overlapping names", () => {
    const kept = thinNames([box("low", 0, 1), box("high", 20, 5)])
    expect([...kept]).toEqual(["high"])
  })

  it("keeps names that do not overlap", () => {
    const kept = thinNames([box("a", 0, 1), box("b", 60, 1), box("c", 200, 1)])
    expect(kept.size).toBe(3)
  })

  it("always keeps the selected or hovered one", () => {
    const kept = thinNames([
      box("rack", 0, 1000),
      box("hovered", 10, Infinity),
      box("selected", 20, Infinity),
    ])
    expect(kept.has("hovered")).toBe(true)
    expect(kept.has("selected")).toBe(true)
    expect(kept.has("rack")).toBe(false)
  })

  it("thins thousands of names in a blink", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      box(`n${i}`, (i % 100) * 10, i % 7)
    ).map((b, i) => ({ ...b, y: Math.floor(i / 100) * 10 }))
    const t0 = performance.now()
    const kept = thinNames(many)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(kept.size).toBeGreaterThan(0)
    expect(kept.size).toBeLessThan(many.length)
  })
})

describe("names", () => {
  it("cut long names with an ellipsis", () => {
    expect(clipName("a".repeat(30))).toHaveLength(24)
    expect(clipName("a".repeat(30)).endsWith("…")).toBe(true)
    expect(clipName("short")).toBe("short")
  })

  it("grow a font only below the least size", () => {
    expect(fontGrow(12, 0.25)).toBeCloseTo(11 / 3)
    expect(fontGrow(12, 1)).toBe(1)
  })
})
