import { describe, expect, it } from "vitest"

import {
  GRID_COLS,
  clampItem,
  fromRglLayout,
  normalizeLayout,
  placeIds,
  toRglLayout,
  type WidgetMeta,
} from "./dashboard-layout"

const META: Record<string, WidgetMeta> = {
  small: { span: { w: 2, h: 2 }, min: { w: 1, h: 1 }, max: { w: 3, h: 3 } },
  wide: { span: { w: 4, h: 2 }, min: { w: 2, h: 2 }, max: { w: 6, h: 6 } },
  tall: { span: { w: 2, h: 3 }, min: { w: 2, h: 2 }, max: { w: 6, h: 6 } },
}
const metaOf = (id: string) => META[id]

describe("normalizeLayout", () => {
  it("migrates a v1 flat id array by packing default spans", () => {
    // Existing users' localStorage is v1; it must upgrade in place, never
    // silently reset to the default dashboard.
    const items = normalizeLayout(["small", "wide", "tall"], metaOf)!
    expect(items.map((i) => i.id)).toEqual(["small", "wide", "tall"])
    expect(items[0]).toMatchObject({ x: 0, y: 0, w: 2, h: 2 })
    expect(items[1]).toMatchObject({ x: 2, y: 0, w: 4, h: 2 })
    // A lone trailing widget stretches to close its row (up to its max) -
    // partial rows were the last surviving gap class.
    expect(items[2]).toMatchObject({ x: 0, y: 2, h: 3 })
    expect(items[2].w).toBe(6) // tall's max.w is 6
  })

  it("drops unknown ids rather than wedging the dashboard", () => {
    const items = normalizeLayout(["small", "deleted-widget"], metaOf)!
    expect(items.map((i) => i.id)).toEqual(["small"])
    expect(normalizeLayout(["only-unknown"], metaOf)).toBeNull()
  })

  it("accepts v2 and reclamps spans against current constraints", () => {
    const items = normalizeLayout(
      { v: 2, items: [{ id: "small", x: 0, y: 0, w: 99, h: 0 }] },
      metaOf
    )!
    expect(items[0]).toMatchObject({ w: 3, h: 1 }) // max.w=3, min.h=1
  })

  it("rejects garbage", () => {
    expect(normalizeLayout(null, metaOf)).toBeNull()
    expect(normalizeLayout({ v: 3, items: [] }, metaOf)).toBeNull()
    expect(normalizeLayout({ v: 2, items: "x" }, metaOf)).toBeNull()
    expect(normalizeLayout(42, metaOf)).toBeNull()
  })

  it("fills missing spans from the catalog default", () => {
    const items = normalizeLayout(
      { v: 2, items: [{ id: "wide", x: 1, y: 1 }] },
      metaOf
    )!
    expect(items[0]).toMatchObject({ w: 4, h: 2 })
  })
})

describe("clampItem", () => {
  it("keeps x inside the grid for the clamped width", () => {
    const it_ = clampItem({ id: "wide", x: 5, y: 0, w: 4, h: 2 }, META.wide)
    expect(it_.x + it_.w).toBeLessThanOrEqual(GRID_COLS)
  })
})

describe("placeIds", () => {
  it("never places a widget past the right edge", () => {
    const items = placeIds(["wide", "wide", "small", "tall", "wide"], metaOf)
    for (const it_ of items) expect(it_.x + it_.w).toBeLessThanOrEqual(GRID_COLS)
  })
})

describe("rgl round trip", () => {
  it("attaches constraints going out and survives coming back", () => {
    const items = normalizeLayout(["small"], metaOf)!
    const rgl = toRglLayout(items, metaOf)
    expect(rgl[0]).toMatchObject({ i: "small", minW: 1, maxW: 3 })
    expect(fromRglLayout(rgl)).toEqual(items)
  })
})

function overlaps(a: { x: number; y: number; w: number; h: number },
                  b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe("placeIdsCurated", () => {
  const CURATED = [
    { id: "wide", x: 0, y: 0, w: 4, h: 2 },
    { id: "small", x: 4, y: 0, w: 2, h: 2 },
  ]
  it("uses the template sizes and fills the row", async () => {
    const { placeIdsCurated } = await import("./dashboard-layout")
    const items = placeIdsCurated(["small", "wide"], CURATED, metaOf)
    expect(items).toEqual(CURATED) // full set packs back into the template
  })
  it("a SUBSET repacks dense - a missing widget leaves no hole", async () => {
    // The exact regression that shipped twice: a tenant default lacking
    // template widgets inherited the holes their absence left.
    const { placeIdsCurated } = await import("./dashboard-layout")
    const big = [
      { id: "wide", x: 0, y: 0, w: 3, h: 3 },
      { id: "gone", x: 3, y: 0, w: 3, h: 3 },
      { id: "small", x: 0, y: 3, w: 2, h: 2 },
    ]
    const items = placeIdsCurated(["wide", "small"], big, metaOf)
    // "small" must slot beside "wide" where "gone" used to sit, not below.
    expect(items.find((i) => i.id === "small")).toMatchObject({ x: 3, y: 0 })
  })
  it("packs unknown ids too, without overlap or overflow", async () => {
    const { GRID_COLS, placeIdsCurated } = await import("./dashboard-layout")
    const items = placeIdsCurated(["wide", "tall", "small"], CURATED, metaOf)
    for (const a of items) {
      expect(a.x + a.w).toBeLessThanOrEqual(GRID_COLS)
      for (const b of items) {
        if (a.id !== b.id) expect(overlaps(a, b)).toBe(false)
      }
    }
  })
  it("normalizeLayout routes v1 arrays through it", async () => {
    const { normalizeLayout } = await import("./dashboard-layout")
    const items = normalizeLayout(["small", "wide"], metaOf, CURATED)!
    expect(items).toEqual(CURATED)
  })
})

describe("packItems shrink-to-fit", () => {
  it("a chart happy at one column shrinks into a remainder", async () => {
    const { packItems } = await import("./dashboard-layout")
    const items = packItems([
      { id: "big", w: 5, h: 2, maxW: 5 },
      { id: "donut", w: 2, h: 2, maxW: 3, minW: 1 },
    ])
    // Without shrink the donut can't fit the 1-column remainder and "big"
    // can't stretch past its max - the row would end short.
    expect(items.find((i) => i.id === "donut")).toMatchObject({
      x: 5,
      y: 0,
      w: 1,
    })
  })
})
