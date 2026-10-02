// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { FloorPlan, FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import { FloorCanvas } from "./floor-canvas"

// A tile linked to a DIN-rail cabinet on the 2D plan: named after the
// cabinet unless labelled, its device count from the live state in its
// corner, and its border red the moment one of its devices goes down - the
// same read a rack tile gives.

afterEach(cleanup)

const plan = {
  id: "p1",
  name: "Serverrum A",
  grid_width: 12,
  grid_height: 8,
  cell_mm: 600,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
} as unknown as FloorPlan

const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile => ({
  id: "t1",
  x: 2,
  y: 2,
  width: 3,
  height: 1,
  orientation: 0,
  tile_type: {
    id: "tt1",
    name: "Cabinet",
    slug: "cabinet",
    color: "#64748b",
    icon: "",
    default_width: 1,
    default_height: 1,
    is_zone: false,
    has_fov: false,
  },
  role_type: null,
  label: "",
  color: "",
  status: "",
  link_kind: "cabinet",
  linked: { kind: "cabinet", id: "c1", name: "K1", route: "/cabinets/c1" },
  fov_deg: null,
  fov_distance: null,
  fov_direction: null,
  fov_anchor: "",
  fov_ptz: false,
  created_at: "",
  updated_at: "",
  ...patch,
})

const live = (
  check: "up" | "down" | null,
  devices = 5
): FloorPlanLiveState => ({
  as_of: "",
  tiles: {
    t1: { kind: "cabinet", device_count: devices, rail_count: 2, check },
  },
})

function draw(t: FloorPlanTile, state: FloorPlanLiveState | null) {
  return render(
    <FloorCanvas
      plan={plan}
      tiles={[t]}
      selectedId={null}
      editable={false}
      showGrid
      armed={null}
      liveState={state}
    />
  )
}

/** The tile's own group - the one the canvas names for screen readers. */
const tileGroup = (c: HTMLElement) =>
  c.querySelector<SVGGElement>('g[role="img"]')!

describe("a cabinet tile", () => {
  it("is named after its cabinet, unless labelled", () => {
    const { container } = draw(tile(), live("up"))
    expect(tileGroup(container).textContent).toContain("K1")
    cleanup()
    const labelled = draw(tile({ label: "North" }), live("up"))
    const g = tileGroup(labelled.container)
    expect(g.textContent).toContain("North")
    expect(g.textContent).not.toContain("K1")
  })

  it("counts its devices in the corner", () => {
    const { container } = draw(tile(), live("up", 5))
    const count = container.querySelector('[data-part="device-count"]')
    expect(count?.textContent).toBe("5")
    expect(count?.querySelector("svg.lucide-server")).toBeTruthy()
    expect(tileGroup(container).getAttribute("aria-label")).toContain(
      "5 devices, 2 rails"
    )
  })

  it("counts nothing before the live state lands", () => {
    const { container } = draw(tile(), null)
    expect(container.querySelector('[data-part="device-count"]')).toBeNull()
  })

  it("turns its border red when a device is down", () => {
    const up = draw(tile(), live("up"))
    const calm = tileGroup(up.container).querySelector("rect")!
    expect(calm.getAttribute("stroke")).toBe("#64748b")
    cleanup()
    const down = draw(tile(), live("down"))
    const red = tileGroup(down.container).querySelector("rect")!
    expect(red.getAttribute("stroke")).toBe("#ef4444")
    expect(red.getAttribute("stroke-width")).toBe("2")
  })

  it("draws no utilization bar - a cabinet has no units", () => {
    const { container } = draw(tile(), live("up"))
    expect(tileGroup(container).textContent).not.toContain("%")
  })
})
