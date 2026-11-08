// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"

// Pinch zoom on a touch screen: two fingers zoom the plan, and a second
// finger landing stops what the first one began - a tile drag ends where it
// is rather than following the pinch around.

beforeAll(() => {
  // jsdom has no pointer capture; the canvas only asks for it.
  Element.prototype.setPointerCapture = () => {}
})
afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Hall",
  grid_width: 20,
  grid_height: 10,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
} as unknown as FloorPlan

const tile = {
  id: "t1",
  x: 2,
  y: 2,
  width: 1,
  height: 1,
  orientation: 0,
  tile_type: {
    id: "tt1",
    name: "Rack",
    slug: "rack",
    color: "#64748b",
    icon: "",
    default_width: 1,
    default_height: 1,
    is_zone: false,
    has_fov: false,
  },
  role_type: null,
  label: "R1",
  color: "",
  status: "",
  link_kind: "",
  linked: null,
  fov_deg: null,
  fov_distance: null,
  fov_direction: null,
  fov_anchor: "",
  fov_ptz: false,
  created_at: "",
  updated_at: "",
} as FloorPlanTile

const touch = (pointerId: number, x: number, y: number) => ({
  pointerId,
  pointerType: "touch",
  button: 0,
  clientX: x,
  clientY: y,
})

/** The pan/zoom group's scale. */
const scale = (c: HTMLElement) => {
  const g = c.querySelector("svg > g")!
  return Number(/scale\(([\d.]+)\)/.exec(g.getAttribute("transform")!)![1])
}

describe("pinch zoom on the plan", () => {
  it("zooms with two fingers and stops the first finger's drag", () => {
    const onChangeTile = vi.fn()
    const onGestureStart = vi.fn()
    const onGestureEnd = vi.fn()
    const { container } = render(
      <FloorCanvas
        plan={plan}
        tiles={[tile]}
        selectedId={null}
        editable
        showGrid
        armed={null}
        onSelect={() => {}}
        onChangeTile={onChangeTile}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
      />
    )
    const svg = container.querySelector("svg")!
    const tileG = container.querySelector('g[role="img"]')!
    const before = scale(container)

    // One finger on a tile starts its drag…
    fireEvent.pointerDown(tileG, touch(1, 100, 100))
    expect(onGestureStart).toHaveBeenCalledTimes(1)
    // …the second turns it into a pinch and ends the drag.
    fireEvent.pointerDown(svg, touch(2, 300, 100))
    expect(onGestureEnd).toHaveBeenCalledTimes(1)

    // Spread to twice the distance: twice the zoom (within the limits).
    fireEvent.pointerMove(svg, touch(1, 0, 100))
    fireEvent.pointerMove(svg, touch(2, 400, 100))
    expect(scale(container)).toBeCloseTo(Math.min(4, before * 2))
    expect(onChangeTile).not.toHaveBeenCalled()

    // Lift both; nothing else is committed.
    fireEvent.pointerUp(svg, touch(2, 400, 100))
    fireEvent.pointerUp(svg, touch(1, 0, 100))
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
    expect(onChangeTile).not.toHaveBeenCalled()
  })
})
