// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"

import { mutesBasemap } from "./background-look"
import { FloorCanvas } from "./floor-canvas"

// Display > Muted background greys the street map and the floor's own
// picture; satellite imagery keeps its colours (only its opacity).

vi.mock("@/lib/use-me", () => ({ useMe: () => ({}) }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)

const plan = (basemap: "map" | "sat") =>
  ({
    id: "p1",
    name: "Ground",
    grid_width: 12,
    grid_height: 8,
    cell_mm: 600,
    ceiling_mm: 3000,
    background_image: "/media/floor.png",
    background_opacity: 60,
    background_shown: true,
    map_visible: true,
    map_opacity: 80,
    base_map: { id: "m1", image: "/media/site-map.png", basemap },
    state: {},
  }) as unknown as FloorPlan

function layers(basemap: "map" | "sat") {
  const { container } = render(
    <FloorCanvas
      plan={plan(basemap)}
      tiles={[]}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      muteBackground
    />
  )
  const get = (l: string) =>
    container.querySelector(`image[data-layer="${l}"]`)!
  return { map: get("map"), floor: get("floor") }
}

describe("muted background", () => {
  it("mutes the street map, never satellite imagery", () => {
    expect(mutesBasemap("map")).toBe(true)
    expect(mutesBasemap(null)).toBe(true)
    expect(mutesBasemap("sat")).toBe(false)
  })

  it("keeps a satellite map's colours and mutes the floor picture", () => {
    const sat = layers("sat")
    expect(sat.map.getAttribute("filter")).toBeNull()
    expect(sat.map.getAttribute("opacity")).toBe("0.8")
    expect(sat.floor.getAttribute("filter")).toMatch(/fp-bg-mute-p1/)
    cleanup()
    const street = layers("map")
    expect(street.map.getAttribute("filter")).toMatch(/fp-bg-mute-p1/)
  })
})
