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
  it("migrates a v1 flat id array by flowing default spans", () => {
    // Existing users' localStorage is v1; it must upgrade in place, never
    // silently reset to the default dashboard.
    const items = normalizeLayout(["small", "wide", "tall"], metaOf)!
    expect(items.map((i) => i.id)).toEqual(["small", "wide", "tall"])
    expect(items[0]).toMatchObject({ x: 0, y: 0, w: 2, h: 2 })
    expect(items[1]).toMatchObject({ x: 2, y: 0, w: 4, h: 2 })
    expect(items[2]).toMatchObject({ x: 0, y: 2, w: 2, h: 3 }) // wrapped
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
