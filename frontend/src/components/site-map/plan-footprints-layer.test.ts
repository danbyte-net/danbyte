// @vitest-environment jsdom
import L from "leaflet"
import { describe, expect, it, vi } from "vitest"

import type { SiteMapPlanFootprint } from "@/lib/api"

import {
  buildPlanFootprintsLayer,
  FOOTPRINT_COLOR,
  footprintName,
} from "./plan-footprints-layer"

// The Site map's "Floor plans" layer: each plan made from the map draws its
// box as a faint dashed rectangle, named on hover; a click opens the plan.

const FP: SiteMapPlanFootprint = {
  id: "fp1",
  name: "Ground",
  stack: "Campus",
  site_id: "s1",
  bbox: [56, 10, 56.001, 10.002],
}

const all = (g: L.LayerGroup) =>
  g.getLayers().filter((l): l is L.Rectangle => l instanceof L.Rectangle)
/** The edges - what a click opens the plan from. */
const rects = (g: L.LayerGroup) => all(g).filter((r) => r.options.stroke)
const fills = (g: L.LayerGroup) => all(g).filter((r) => !r.options.stroke)

describe("plan footprints", () => {
  it("draws each box faint and dashed", () => {
    const g = buildPlanFootprintsLayer(
      [FP, { ...FP, id: "fp2", name: "Yard", stack: "Yard" }],
      { onOpen: vi.fn() }
    )
    const [r] = rects(g)
    expect(rects(g)).toHaveLength(2)
    const b = r.getBounds()
    expect([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]).toEqual(
      FP.bbox
    )
    expect(r.options.dashArray).toBe("4 4")
    expect(r.options.color).toBe(FOOTPRINT_COLOR)
    expect(r.options.fill).toBe(false)
    // The faint fill takes no clicks: inside the box, the map still does.
    const [f] = fills(g)
    expect(fills(g)).toHaveLength(2)
    expect(f.options.fillOpacity).toBeLessThan(0.1)
    expect(f.options.interactive).toBe(false)
  })

  it("names the plan and opens it on a click", () => {
    const onOpen = vi.fn()
    const [r] = rects(buildPlanFootprintsLayer([FP], { onOpen }))
    expect(r.getTooltip()?.getContent()).toBe("Campus · Ground")
    r.fire("click")
    expect(onOpen).toHaveBeenCalledWith("fp1")
  })

  it("is inert while a tool draws", () => {
    const onOpen = vi.fn()
    const [r] = rects(
      buildPlanFootprintsLayer([FP], { onOpen, interactive: false })
    )
    expect(r.options.interactive).toBe(false)
    expect(r.getTooltip()).toBeUndefined()
  })

  it("reads the floor alone when it is the floor plan's name", () => {
    expect(footprintName({ ...FP, stack: "Ground" })).toBe("Ground")
    expect(footprintName({ ...FP, stack: "" })).toBe("Ground")
    expect(footprintName({ ...FP, name: "<b>", stack: "" })).toBe("<b>")
  })
})
