// @vitest-environment jsdom
import L from "leaflet"
import { describe, expect, it, vi } from "vitest"

import type { SiteMapOutline } from "@/lib/api"

import type { Pt } from "./outline-geometry"
import {
  OUTLINE_NEUTRAL,
  buildOutlineReshapeLayer,
  buildOutlinesLayer,
  outlineColor,
} from "./outlines-layer"

// The outline on the map and its reshape handles - the same moves the
// Cables mode's route editing has: drag a point, "+" on an edge, right-click
// a point to remove it.

const SQUARE: Pt[] = [
  [56, 10],
  [56, 10.001],
  [56.001, 10.001],
  [56.001, 10],
]

function outline(over: Partial<SiteMapOutline> = {}): SiteMapOutline {
  return {
    id: "o1",
    site_id: "s1",
    location_id: "l1",
    location: {
      id: "l1",
      name: "Building A",
      code: "A1",
      color: "",
      icon: "",
      location_type: null,
    },
    points: SQUARE,
    label: "",
    color: "",
    z: 0,
    locked: false,
    display_label: "A1",
    display_color: "#2563eb",
    created_at: "",
    updated_at: "",
    ...over,
  }
}

function layers(group: L.LayerGroup) {
  const out: L.Layer[] = []
  group.eachLayer((l) => void out.push(l))
  return out
}

describe("outline layer", () => {
  it("draws the polygon in its colour, neutral without one, and selects", () => {
    expect(outlineColor({ display_color: "" })).toBe(OUTLINE_NEUTRAL)
    const onSelect = vi.fn()
    const group = buildOutlinesLayer([outline()], {
      selectedId: null,
      showLabels: true,
      onSelect,
    })
    const [poly, label] = layers(group)
    expect(poly).toBeInstanceOf(L.Polygon)
    expect((poly as L.Polygon).options.fillColor).toBe("#2563eb")
    expect(label).toBeInstanceOf(L.Marker)
    poly.fire("click", { originalEvent: new MouseEvent("click") })
    expect(onSelect).toHaveBeenCalledWith("o1")
  })

  it("shows the label on hover only when Labels is off", () => {
    const group = buildOutlinesLayer([outline()], {
      selectedId: null,
      showLabels: false,
      onSelect: () => {},
    })
    expect(layers(group)).toHaveLength(1)
    layers(group)[0].fire("mouseover")
    expect(layers(group)).toHaveLength(2)
    layers(group)[0].fire("mouseout")
    expect(layers(group)).toHaveLength(1)
  })
})

describe("outline reshape handles", () => {
  const handles = (onChange: (p: Pt[]) => void) => {
    const all = layers(buildOutlineReshapeLayer(SQUARE, onChange))
    // One handle per point, then one "+" per edge (closing edge included).
    return { points: all.slice(0, 4), plus: all.slice(4) }
  }

  it("adds a point on an edge", () => {
    const onChange = vi.fn()
    const { plus } = handles(onChange)
    expect(plus).toHaveLength(4)
    plus[3].fire("click", { originalEvent: new MouseEvent("click") })
    expect(onChange).toHaveBeenCalledWith([...SQUARE, [56.0005, 10]])
  })

  it("removes a point on right-click, keeping three", () => {
    const onChange = vi.fn()
    const { points } = handles(onChange)
    points[1].fire("contextmenu", {
      originalEvent: new MouseEvent("contextmenu"),
    })
    expect(onChange).toHaveBeenCalledWith([SQUARE[0], SQUARE[2], SQUARE[3]])

    const three = vi.fn()
    const all = layers(buildOutlineReshapeLayer(SQUARE.slice(0, 3), three))
    all[0].fire("contextmenu", { originalEvent: new MouseEvent("contextmenu") })
    expect(three).not.toHaveBeenCalled()
  })

  it("moves a dragged point", () => {
    const onChange = vi.fn()
    const { points } = handles(onChange)
    const m = points[2] as L.Marker
    m.setLatLng([56.002, 10.002])
    m.fire("dragend")
    expect(onChange).toHaveBeenCalledWith([
      SQUARE[0],
      SQUARE[1],
      [56.002, 10.002],
      SQUARE[3],
    ])
  })
})
